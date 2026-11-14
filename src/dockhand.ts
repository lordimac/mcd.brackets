// Dockhand integration (Docker management UI, github.com/Finsys/dockhand): reads the game server
// containers of one Docker environment and creates/updates the event's game servers from them
// (IP address from the macvlan network, port, RCON password from the environment variables),
// shows the container state on the server cards and lets admins start/stop/restart containers.
// API: Bearer token "dh_…", GET /api/environments, GET /api/containers?env=, GET
// /api/containers/:id/inspect?env=, POST /api/containers/:id/start|stop|restart?env=.

import http from 'http';
import https from 'https';
import { isValidDomain, normalizeDomain, parseIPv4, ValidationError } from './lan';
import { GAMES, type GameId, type GameServer } from './gameservers';

export class DockhandError extends Error {}

/* Settings (one record in the "dockhand" table)
   ========================================================================== */

export interface DockhandSettings {
  id: number;
  url: string;            // e.g. "http://192.168.120.2:3000"
  token: string;          // API token "dh_…", never sent to the browser
  env_id: number | null;  // Docker environment with the game servers
  insecure_tls: boolean;
}

export type DockhandSettingsData = Omit<DockhandSettings, 'id'>;

export const EMPTY_DOCKHAND: DockhandSettingsData = { url: '', token: '', env_id: null, insecure_tls: false };

export const isDockhandConfigured = (s: DockhandSettingsData) => Boolean(s.url && s.token && s.env_id !== null);

export function dockhandView(s: DockhandSettingsData) {
  return { url: s.url, has_token: s.token.length > 0, env_id: s.env_id, insecure_tls: s.insecure_tls, configured: isDockhandConfigured(s) };
}

// An empty token keeps the stored one
export function validateDockhandSettings(input: Record<string, unknown>, current: DockhandSettingsData): DockhandSettingsData {
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
  let url = text(input.url).replace(/\/+$/, '').replace(/\/api$/i, '');
  if (url) {
    if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new ValidationError('Ungültige Dockhand-Adresse');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new ValidationError('Die Dockhand-Adresse muss mit http:// oder https:// beginnen');
    url = `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`;
  }
  const token = text(input.token);
  if (token && !/^dh_[\w-]{10,200}$/.test(token)) throw new ValidationError('Der API-Token von Dockhand beginnt mit dh_');
  const rawEnv = input.env_id;
  const envId = rawEnv == null || rawEnv === '' ? null : Number(rawEnv);
  if (envId !== null && (!Number.isInteger(envId) || envId < 0)) throw new ValidationError('Ungültige Docker-Umgebung');
  return { url, token: token || current.token, env_id: envId, insecure_tls: input.insecure_tls === true };
}

/* HTTP client
   ========================================================================== */

export interface DockhandContainer {
  id: string;
  name: string;
  image: string;
  state: string;        // running, exited, …
  status: string;       // "Up 2 hours"
  ports: { PrivatePort?: number; PublicPort?: number; Type?: string }[];
  networks: Record<string, { ipAddress: string }>;
  labels: Record<string, string>;
  command?: string;
}

export interface DockhandEnvironment {
  id: number;
  name: string;
}

export type ContainerAction = 'start' | 'stop' | 'restart';

export interface DockhandClient {
  environments(): Promise<DockhandEnvironment[]>;
  containers(): Promise<DockhandContainer[]>;
  environment(id: string): Promise<Record<string, string> | null>; // env variables, null = no permission
  action(id: string, action: ContainerAction): Promise<void>;
}

const TIMEOUT_MS = 6000;

function networkMessage(error: NodeJS.ErrnoException): string {
  const code = error.code ?? '';
  if (code === 'ECONNREFUSED') return 'Dockhand nicht erreichbar (Verbindung abgelehnt) — Adresse und Port prüfen';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'Dockhand-Adresse kann nicht aufgelöst werden';
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'ETIMEDOUT') return 'Dockhand nicht erreichbar — läuft der Container im selben Netz?';
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/.test(code)) return 'Zertifikat von Dockhand wird nicht vertraut — „Zertifikat nicht prüfen“ aktivieren';
  return `Dockhand-Verbindung fehlgeschlagen: ${error.message}`;
}

// envId may be null only for environments(); everything else needs the chosen environment
export function createDockhandClient(settings: DockhandSettingsData, envOverride?: number | null): DockhandClient {
  if (!settings.url || !settings.token) throw new ValidationError('Dockhand ist nicht eingerichtet (Adresse und API-Token fehlen)');
  const envId = envOverride === undefined ? settings.env_id : envOverride;

  function call(method: 'GET' | 'POST', path: string, query: Record<string, string> = {}): Promise<{ status: number; body: unknown }> {
    const url = new URL(`${settings.url}/api/${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const transport = url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const req = transport.request(url, {
        method,
        headers: { Authorization: `Bearer ${settings.token}`, Accept: 'application/json', ...(method === 'POST' ? { 'Content-Length': 0 } : {}) },
        timeout: TIMEOUT_MS,
        rejectUnauthorized: !settings.insecure_tls,
      }, res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          const text = Buffer.concat(chunks).toString('utf-8');
          let body: unknown = null;
          try {
            body = text ? JSON.parse(text) : null;
          } catch {
            if (status >= 200 && status < 300) return reject(new DockhandError('Dockhand: unerwartete Antwort (kein JSON) — ist die Adresse die Weboberfläche von Dockhand?'));
          }
          if (status === 401) return reject(new DockhandError('Dockhand: API-Token ungültig oder abgelaufen'));
          resolve({ status, body });
        });
      });
      req.on('timeout', () => req.destroy(new DockhandError('Dockhand antwortet nicht (Zeitüberschreitung)')));
      req.on('error', error => reject(error instanceof DockhandError ? error : new DockhandError(networkMessage(error as NodeJS.ErrnoException))));
      req.end();
    });
  }

  const message = (body: unknown) => (body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string' ? (body as { error: string }).error : '');
  const needEnv = () => {
    if (envId === null || envId === undefined) throw new ValidationError('In den Dockhand-Einstellungen ist keine Docker-Umgebung gewählt');
    return String(envId);
  };

  return {
    async environments() {
      const { status, body } = await call('GET', 'environments');
      if (status === 403) throw new DockhandError('Dockhand: dem Token fehlt die Berechtigung, Umgebungen zu sehen');
      if (status !== 200 || !Array.isArray(body)) throw new DockhandError(`Dockhand antwortet mit HTTP ${status}`);
      return body.map(e => ({ id: Number(e.id), name: String(e.name ?? `Umgebung ${e.id}`) }));
    },
    async containers() {
      const { status, body } = await call('GET', 'containers', { env: needEnv(), all: 'true' });
      if (status === 403) throw new DockhandError('Dockhand: dem Token fehlt die Berechtigung „Container ansehen“');
      if (status === 404) throw new DockhandError('Dockhand: die gewählte Docker-Umgebung gibt es nicht mehr');
      if (status !== 200 || !Array.isArray(body)) throw new DockhandError(`Dockhand antwortet mit HTTP ${status}`);
      return body as DockhandContainer[];
    },
    async environment(id) {
      const { status, body } = await call('GET', `containers/${encodeURIComponent(id)}/inspect`, { env: needEnv() });
      if (status === 403) return null; // token without the "inspect" permission: work without env variables
      if (status !== 200) throw new DockhandError(`Dockhand: Container nicht lesbar (HTTP ${status})`);
      const env = ((body as { Config?: { Env?: unknown } })?.Config?.Env ?? []) as unknown[];
      return Object.fromEntries(env.filter((e): e is string => typeof e === 'string' && e.includes('=')).map(e => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]));
    },
    async action(id, action) {
      const { status, body } = await call('POST', `containers/${encodeURIComponent(id)}/${action}`, { env: needEnv() });
      if (status === 403) throw new DockhandError(`Dockhand: dem Token fehlt die Berechtigung, Container zu ${action === 'start' ? 'starten' : action === 'stop' ? 'stoppen' : 'neu zu starten'}`);
      if (status === 404) throw new DockhandError('Dockhand: Container nicht gefunden');
      if (status < 200 || status >= 300) throw new DockhandError(message(body) || `Dockhand antwortet mit HTTP ${status}`);
    },
  };
}

/* Recognizing game server containers
   ========================================================================== */

// Labels on the container win over everything the app guesses:
//   mcd.game (ut99, ut2004, cod2, cod4, cs2, q3), mcd.name, mcd.host, mcd.port, mcd.query_port,
//   mcd.webadmin_port, mcd.webadmin_user
const LABEL = (labels: Record<string, string>, key: string) => labels[`mcd.${key}`] ?? labels[`mcd-brackets.${key}`];

const IMAGE_PATTERNS: [GameId, RegExp][] = [
  ['cs2', /\bcs2\b|counter-?strike-?2|cs2-?server/],
  ['ut2004', /ut2004|ut2k4|unreal-?tournament-?2004/],
  ['ut99', /ut99|ut-?goty|unreal-?tournament(?!-?20)|\but-?server\b|\butserver\b/],
  ['cod4', /cod4|cod-?4|call-?of-?duty-?4|codmw/],
  ['cod2', /cod2|cod-?2|call-?of-?duty-?2/],
  ['q3', /quake-?3|quake-?iii|quake3|ioquake3?|ioq3|\bq3a?\b|q3-?server/],
];

const isGameId = (value: unknown): value is GameId => typeof value === 'string' && Object.hasOwn(GAMES, value);

// Game by label, else by image name, else by container name
export function detectGame(container: Pick<DockhandContainer, 'image' | 'name' | 'labels'>): { game: GameId; by: 'label' | 'image' | 'name' } | null {
  const label = LABEL(container.labels ?? {}, 'game')?.toLowerCase();
  if (isGameId(label)) return { game: label, by: 'label' };
  const image = (container.image ?? '').toLowerCase(); // with "owner/": some images only name the game there
  for (const [game, pattern] of IMAGE_PATTERNS) if (pattern.test(image)) return { game, by: 'image' };
  const name = (container.name ?? '').toLowerCase();
  for (const [game, pattern] of IMAGE_PATTERNS) if (pattern.test(name)) return { game, by: 'name' };
  return null;
}

// Docker's default bridge networks live in 172.16.0.0/12; the macvlan has a LAN address
const inDockerRange = (ip: string) => {
  const value = parseIPv4(ip);
  return value !== null && value >>> 20 === (172 << 4 | 1); // 172.16.0.0/12
};

// Address of the container in the LAN: label mcd.host, else the macvlan/ipvlan network, else an
// address outside the Docker bridge range, else the first address
export function containerHost(container: Pick<DockhandContainer, 'networks' | 'labels'>): string {
  const label = LABEL(container.labels ?? {}, 'host')?.trim();
  if (label && (parseIPv4(label) !== null || isValidDomain(normalizeDomain(label)))) return label;
  const networks = Object.entries(container.networks ?? {})
    .map(([name, data]) => ({ name, ip: data?.ipAddress ?? '' }))
    .filter(n => parseIPv4(n.ip) !== null);
  const pick = networks.find(n => /macvlan|ipvlan/i.test(n.name))
    ?? networks.find(n => !inDockerRange(n.ip))
    ?? networks[0];
  return pick?.ip ?? '';
}

const portNumber = (value: unknown): number | null => {
  const number = Number(String(value ?? '').trim());
  return Number.isInteger(number) && number >= 1 && number <= 65535 ? number : null;
};

const PORT_ENV = ['CS2_PORT', 'GAME_PORT', 'SERVER_PORT', 'SRCDS_PORT', 'NET_PORT', 'PORT'];
const RCON_ENV = ['RCON_PASSWORD', 'CS2_RCONPW', 'SRCDS_RCONPW', 'RCONPASSWORD', 'RCON_PASS', 'RCON_PW', 'CS2_RCON_PASSWORD'];
const WEBADMIN_PASSWORD_ENV = ['WEBADMIN_PASSWORD', 'UT_ADMINPWD', 'ADMIN_PASSWORD', 'ADMINPASSWORD'];
const WEBADMIN_USER_ENV = ['WEBADMIN_USER', 'UT_ADMINNAME', 'ADMIN_NAME', 'ADMIN_USER'];
const WEBADMIN_PORT_ENV = ['WEBADMIN_PORT', 'UT_WEBADMINPORT', 'WEB_PORT'];

const fromEnv = (env: Record<string, string>, keys: string[]) => keys.map(k => env[k]).find(v => v !== undefined && v !== '');
// Passwords the app can't send safely (quotes, control characters) are left out
const usableSecret = (value: string | undefined) => (value && value.length <= 128 && !/["\x00-\x1F\x7F]/.test(value) ? value : '');

export interface ImportCandidate {
  container_id: string;
  container_name: string;
  image: string;
  state: string;
  status: string;
  game: GameId | null;
  detected_by: 'label' | 'image' | 'name' | null;
  name: string;
  host: string;
  port: number | null;          // null = default of the game
  query_port: number | null;
  rcon_password: string;        // internal, never sent to the browser
  webadmin_port: number | null;
  webadmin_user: string;
  webadmin_password: string;    // internal
  env_read: boolean;            // env variables could be read (inspect permission)
}

// env: environment variables from inspect (null = not readable)
export function importCandidate(container: DockhandContainer, env: Record<string, string> | null, gameOverride?: GameId): ImportCandidate {
  const labels = container.labels ?? {};
  const detected = detectGame(container);
  const game = gameOverride ?? detected?.game ?? null;
  const vars = env ?? {};
  const command = container.command ?? '';

  // Port: label, env variable, start parameter (+set net_port / -port), the container's UDP port
  let port = portNumber(LABEL(labels, 'port')) ?? portNumber(fromEnv(vars, PORT_ENV))
    ?? portNumber(/(?:net_port|[-+]port)[\s=]+(\d{2,5})/i.exec(command)?.[1]);
  if (port === null && game) {
    const udp = [...new Set((container.ports ?? []).filter(p => (p.Type ?? 'udp') === 'udp').map(p => p.PrivatePort).filter((p): p is number => !!p))].sort((a, b) => a - b);
    port = udp.includes(GAMES[game].port) ? GAMES[game].port : udp.length === 1 || GAMES[game].queryOffset ? udp[0] ?? null : null;
  }
  if (game && port === GAMES[game].port) port = null;

  const rcon = usableSecret(fromEnv(vars, RCON_ENV) ?? /rcon_password\s+"?([^"\s]+)"?/i.exec(command)?.[1]);
  const unreal = game ? GAMES[game].admin === 'webadmin' : false;
  const webadminPassword = unreal ? usableSecret(fromEnv(vars, WEBADMIN_PASSWORD_ENV)) : '';
  const webadminUser = unreal ? (LABEL(labels, 'webadmin_user') ?? fromEnv(vars, WEBADMIN_USER_ENV) ?? (webadminPassword ? 'admin' : '')).trim().slice(0, 64) : '';

  return {
    container_id: container.id,
    container_name: container.name,
    image: container.image,
    state: container.state,
    status: container.status,
    game,
    detected_by: gameOverride ? null : detected?.by ?? null,
    name: (LABEL(labels, 'name') ?? container.name).trim().slice(0, 60),
    host: containerHost(container),
    port,
    query_port: portNumber(LABEL(labels, 'query_port')),
    rcon_password: unreal ? '' : rcon,
    webadmin_port: unreal ? portNumber(LABEL(labels, 'webadmin_port')) ?? portNumber(fromEnv(vars, WEBADMIN_PORT_ENV)) : null,
    webadmin_user: webadminUser,
    webadmin_password: webadminPassword,
    env_read: env !== null,
  };
}

/* Import plan: which servers get created or updated
   ========================================================================== */

export type ImportAction = 'create' | 'update' | 'unchanged' | 'unknown' | 'no-host';

export interface ImportItem {
  candidate: ImportCandidate;
  action: ImportAction;
  server_id: string | null;   // existing server it belongs to
  changes: string[];          // readable list for the preview
}

// Linked by container name (stays the same when compose re-creates a container), then by the
// container ID, then by address + port of a server that isn't linked yet
export function findServerFor(candidate: ImportCandidate, servers: GameServer[]): GameServer | null {
  return servers.find(s => s.container?.name === candidate.container_name)
    ?? servers.find(s => s.container?.id === candidate.container_id)
    ?? (candidate.game && candidate.host
      ? servers.find(s => !s.container && s.game === candidate.game && s.host === candidate.host && s.port === (candidate.port ?? GAMES[candidate.game!].port))
      : undefined)
    ?? null;
}

export function planItem(candidate: ImportCandidate, servers: GameServer[]): ImportItem {
  const server = findServerFor(candidate, servers);
  if (!candidate.game) return { candidate, action: 'unknown', server_id: server?.id ?? null, changes: [] };
  if (!candidate.host) return { candidate, action: 'no-host', server_id: server?.id ?? null, changes: [] };
  const port = candidate.port ?? GAMES[candidate.game].port;
  if (!server) {
    const changes = [`neu: ${candidate.host}:${port}`];
    if (candidate.rcon_password) changes.push('RCON-Passwort aus dem Container');
    if (candidate.webadmin_password) changes.push('WebAdmin-Passwort aus dem Container');
    return { candidate, action: 'create', server_id: null, changes };
  }
  const changes: string[] = [];
  if (server.game !== candidate.game) changes.push(`Spiel ${GAMES[server.game].short} → ${GAMES[candidate.game].short}`);
  if (server.host !== candidate.host) changes.push(`Adresse ${server.host} → ${candidate.host}`);
  if (server.port !== port) changes.push(`Port ${server.port} → ${port}`);
  if (candidate.query_port !== null && server.query_port !== candidate.query_port) changes.push(`Query-Port → ${candidate.query_port}`);
  if (candidate.rcon_password && candidate.rcon_password !== server.rcon_password) changes.push('RCON-Passwort aus dem Container');
  if (candidate.webadmin_password && candidate.webadmin_password !== server.webadmin_password) changes.push('WebAdmin-Passwort aus dem Container');
  if (candidate.webadmin_port !== null && candidate.webadmin_port !== server.webadmin_port) changes.push(`WebAdmin-Port → ${candidate.webadmin_port}`);
  if (server.container?.name !== candidate.container_name || server.container?.id !== candidate.container_id) changes.push('mit Container verknüpft');
  return { candidate, action: changes.length ? 'update' : 'unchanged', server_id: server.id, changes };
}

// New server list (raw form for validateServers): chosen candidates applied, the rest kept
export function applyImport(items: ImportItem[], servers: GameServer[]): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = servers.map(s => ({ ...s }));
  for (const { candidate: c, action, server_id } of items) {
    if (!c.game || (action !== 'create' && action !== 'update')) continue;
    const fields = {
      game: c.game,
      host: c.host,
      port: c.port ?? GAMES[c.game].port,
      container: { id: c.container_id, name: c.container_name },
    };
    const secrets = {
      ...(c.rcon_password ? { rcon_password: c.rcon_password } : {}),
      ...(c.webadmin_password ? { webadmin_password: c.webadmin_password } : {}),
      ...(c.webadmin_user ? { webadmin_user: c.webadmin_user } : {}),
      ...(c.webadmin_port !== null ? { webadmin_port: c.webadmin_port } : {}),
      ...(c.query_port !== null ? { query_port: c.query_port } : {}),
    };
    const existing = server_id ? result.find(s => s.id === server_id) : undefined;
    if (existing) Object.assign(existing, fields, secrets);
    else result.push({ name: c.name, info: '', query_port: null, webadmin_path: '/ServerAdmin', ...fields, ...secrets });
  }
  return result;
}

// What the browser sees of a plan item (no passwords)
export function itemView(item: ImportItem) {
  const { rcon_password, webadmin_password, ...candidate } = item.candidate;
  return { ...item, candidate: { ...candidate, has_rcon_password: !!rcon_password, has_webadmin_password: !!webadmin_password } };
}

/* Container state for the server cards (cached briefly, one list call per environment)
   ========================================================================== */

const STATE_TTL_MS = 8000;
let stateCache: { key: string; at: number; promise: Promise<DockhandContainer[]> } | null = null;

export function cachedContainers(settings: DockhandSettingsData, now = Date.now()): Promise<DockhandContainer[]> {
  const key = `${settings.url}|${settings.env_id}|${settings.token.slice(0, 12)}`;
  if (stateCache && stateCache.key === key && now - stateCache.at < STATE_TTL_MS) return stateCache.promise;
  const promise = createDockhandClient(settings).containers();
  promise.catch(() => { if (stateCache?.promise === promise) stateCache = null; });
  stateCache = { key, at: now, promise };
  return promise;
}

export const clearContainerCache = () => { stateCache = null; };

export function containerFor(server: Pick<GameServer, 'container'>, containers: DockhandContainer[]): DockhandContainer | null {
  if (!server.container) return null;
  return containers.find(c => c.name === server.container!.name) ?? containers.find(c => c.id === server.container!.id) ?? null;
}
