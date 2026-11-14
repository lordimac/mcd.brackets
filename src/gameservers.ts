import crypto from 'crypto';
import { getAppStore } from './db';
import { describeAttendee, displayName, isValidDomain, normalizeDomain, parseIPv4, ValidationError, type Attendee, type LanEvent } from './lan';
import {
  GameServerError, parseCs2RconStatus, parseQ3RconStatus, q3Rcon, queryA2S, queryGameSpy, queryQ3, queryUt2, sourceRcon, webAdminCommand,
  type QueryPlayer, type QueryResult,
} from './gameserver-protocols';

// Game servers of an event (one record per event in the table "gameservers"): status with the
// current players for everyone, administration (RCON console and quick actions) for admins.
// Passwords never leave the server (serverView); an empty password on saving keeps the stored one.
// Players are linked to attendees by IP address (from RCON status) or else by name.

export const GAMES = {
  ut99: { label: 'Unreal Tournament', short: 'UT99', port: 7777, queryOffset: 1, query: 'gamespy', admin: 'webadmin' },
  ut2004: { label: 'Unreal Tournament 2004', short: 'UT2004', port: 7777, queryOffset: 1, query: 'ut2', admin: 'webadmin' },
  cod2: { label: 'Call of Duty 2', short: 'CoD2', port: 28960, queryOffset: 0, query: 'q3', admin: 'q3' },
  cod4: { label: 'Call of Duty 4', short: 'CoD4', port: 28960, queryOffset: 0, query: 'q3', admin: 'q3' },
  cs2: { label: 'Counter-Strike 2', short: 'CS2', port: 27015, queryOffset: 0, query: 'a2s', admin: 'source' },
  q3: { label: 'Quake III Arena', short: 'Q3', port: 27960, queryOffset: 0, query: 'q3', admin: 'q3' },
} as const;
export type GameId = keyof typeof GAMES;
const isGame = (value: unknown): value is GameId => typeof value === 'string' && Object.hasOwn(GAMES, value);

export interface GameServer {
  id: string;
  name: string;
  game: GameId;
  host: string;               // IPv4 or DNS name
  port: number;               // game port (players connect here)
  query_port: number | null;  // null = default of the game (UT: game port + 1)
  rcon_password: string;      // Quake 3 engine and CS2; '' = no administration
  webadmin_port: number | null; // UT99/UT2004
  webadmin_path: string;
  webadmin_user: string;
  webadmin_password: string;
  info: string;               // optional note, e.g. mod or map pool
  container?: { id: string; name: string } | null; // Docker container via Dockhand (dockhand.ts); missing = none
}

export interface GameServerRecord {
  id: number;
  event_id: number;
  servers: GameServer[];
}

export const MAX_SERVERS = 30;
const ID_PATTERN = /^[\w-]{1,40}$/;
const CONTROL = /[\x00-\x1F\x7F]/;

const text = (value: unknown) => (typeof value === 'string' ? value : '');

function port(value: unknown, label: string, fallback: number | null): number | null {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 65535) throw new ValidationError(`${label}: Port 1–65535 angeben`);
  return number;
}

function secret(value: unknown, label: string): string {
  const result = text(value);
  if (result.length > 128) throw new ValidationError(`${label} ist zu lang (max. 128 Zeichen)`);
  if (CONTROL.test(result) || result.includes('"')) throw new ValidationError(`${label} darf keine Steuerzeichen und kein " enthalten`);
  return result;
}

// Stored passwords are kept when the input leaves them empty; clear_* removes them
export function validateServers(input: unknown, stored: GameServer[] = []): GameServer[] {
  const list = input ?? [];
  if (!Array.isArray(list)) throw new ValidationError('Server: Liste erwartet');
  if (list.length > MAX_SERVERS) throw new ValidationError(`Höchstens ${MAX_SERVERS} Server`);
  const ids = new Set<string>();
  return list.map((raw, i): GameServer => {
    const entry = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const label = `Server ${i + 1}`;
    if (!isGame(entry.game)) throw new ValidationError(`${label}: Spiel wählen`);
    const game = GAMES[entry.game];

    const name = text(entry.name).trim() || game.label;
    if (name.length > 60) throw new ValidationError(`${label}: Name ist zu lang (max. 60 Zeichen)`);

    const rawHost = text(entry.host).trim();
    const host = parseIPv4(rawHost) !== null ? rawHost : normalizeDomain(rawHost);
    if (!host) throw new ValidationError(`${name}: Adresse fehlt`);
    if (parseIPv4(host) === null && !isValidDomain(host)) throw new ValidationError(`${name}: ungültige Adresse ${rawHost}`);

    let id = typeof entry.id === 'string' && ID_PATTERN.test(entry.id) ? entry.id : crypto.randomUUID();
    if (ids.has(id)) id = crypto.randomUUID();
    ids.add(id);
    const before = stored.find(s => s.id === id);

    const keep = (field: 'rcon_password' | 'webadmin_password', clear: unknown, title: string) => {
      const value = secret(entry[field], title);
      if (value) return value;
      return clear === true ? '' : before?.[field] ?? '';
    };

    const webadminPath = text(entry.webadmin_path).trim() || '/ServerAdmin';
    if (!/^\/[\w\-/.]{0,60}$/.test(webadminPath)) throw new ValidationError(`${name}: ungültiger WebAdmin-Pfad`);
    const webadminUser = text(entry.webadmin_user).trim();
    if (webadminUser.length > 64 || CONTROL.test(webadminUser) || webadminUser.includes(':')) throw new ValidationError(`${name}: ungültiger WebAdmin-Benutzer`);

    const info = text(entry.info).trim();
    if (info.length > 200) throw new ValidationError(`${name}: Hinweis ist zu lang (max. 200 Zeichen)`);

    const isUnreal = game.admin === 'webadmin';
    // Link to a Docker container (set by the Dockhand import, the browser sends it back unchanged)
    const rawContainer = entry.container as { id?: unknown; name?: unknown } | null | undefined;
    const container = rawContainer && typeof rawContainer.name === 'string' && /^[\w.-]{1,128}$/.test(rawContainer.name)
      && typeof rawContainer.id === 'string' && /^[0-9a-f]{12,64}$/.test(rawContainer.id)
      ? { id: rawContainer.id, name: rawContainer.name }
      : null;
    return {
      id,
      name,
      game: entry.game,
      host,
      port: port(entry.port, name, game.port)!,
      query_port: port(entry.query_port, `${name}: Query-Port`, null),
      rcon_password: isUnreal ? '' : keep('rcon_password', entry.clear_rcon_password, `${name}: RCON-Passwort`),
      webadmin_port: isUnreal ? port(entry.webadmin_port, `${name}: WebAdmin-Port`, null) : null,
      webadmin_path: webadminPath,
      webadmin_user: isUnreal ? webadminUser : '',
      webadmin_password: isUnreal ? keep('webadmin_password', entry.clear_webadmin_password, `${name}: WebAdmin-Passwort`) : '',
      info,
      container,
    };
  });
}

export const queryPortOf = (server: GameServer) => server.query_port ?? server.port + GAMES[server.game].queryOffset;

// Whether the app can administer the server (passwords are set)
export function canAdminister(server: GameServer): boolean {
  return GAMES[server.game].admin === 'webadmin'
    ? server.webadmin_port !== null && !!server.webadmin_user && !!server.webadmin_password
    : !!server.rcon_password;
}

// What the browser gets: never the passwords; without admin session also no WebAdmin access
export function serverView(server: GameServer, admin: boolean) {
  const { rcon_password, webadmin_password, webadmin_user, webadmin_port, webadmin_path, ...rest } = server;
  const base = { ...rest, container: server.container ?? null, game_label: GAMES[server.game].label, game_short: GAMES[server.game].short, query_port: queryPortOf(server), manageable: canAdminister(server) };
  if (!admin) return base;
  return { ...base, has_rcon_password: !!rcon_password, has_webadmin_password: !!webadmin_password, webadmin_user, webadmin_port, webadmin_path };
}

/* Storage
   ========================================================================== */

async function stored(eventId: number): Promise<GameServerRecord | null> {
  return ((await getAppStore().select('gameservers', { event_id: eventId })) ?? [])[0] ?? null;
}

export async function listServers(eventId: number): Promise<GameServer[]> {
  return (await stored(eventId))?.servers ?? [];
}

export async function saveServers(eventId: number, input: unknown): Promise<GameServer[]> {
  const record = await stored(eventId);
  const servers = validateServers(input, record?.servers ?? []);
  if (record) await getAppStore().update('gameservers', record.id, { ...record, servers });
  else await getAppStore().insert('gameservers', { event_id: eventId, servers });
  statusCache.clear();
  return servers;
}

export async function findServer(eventId: number, serverId: string): Promise<GameServer> {
  const server = (await listServers(eventId)).find(s => s.id === serverId);
  if (!server) throw new GameServerNotFound();
  return server;
}

export class GameServerNotFound extends Error {}

// A new event runs on the same servers: copy the list (with passwords) from the last event
export async function copyServers(fromEventId: number, toEventId: number): Promise<void> {
  const servers = await listServers(fromEventId);
  if (servers.length) await getAppStore().insert('gameservers', { event_id: toEventId, servers: servers.map(s => ({ ...s, id: crypto.randomUUID() })) });
}

/* Linking players to attendees
   ========================================================================== */

const normalize = (name: string) => name.toLocaleLowerCase('de').replace(/[^\p{L}\p{N}]/gu, '');
// "[ABC]Nick", "|ABC|Nick", "Nick (ABC)" → also try without the tag
const withoutTags = (name: string) => name.replace(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}|<[^>]*>|\|[^|]*\|/g, '');

export interface PlayerMatcher {
  (player: Pick<QueryPlayer, 'name' | 'ip'>): Attendee | null;
}

export function playerMatcher(event: LanEvent, attendees: Attendee[]): PlayerMatcher {
  const byIp = new Map<string, Attendee>();
  const byName = new Map<string, Attendee | null>(); // null = several attendees share the name
  const addName = (key: string, attendee: Attendee) => {
    if (key.length < 2) return;
    const existing = byName.get(key);
    byName.set(key, existing === undefined || existing === attendee ? attendee : null);
  };
  for (const attendee of attendees) {
    for (const ip of describeAttendee(event, attendee).ips) byIp.set(ip, attendee);
    const clan = attendee.clan ?? '';
    for (const key of new Set([attendee.nickname, displayName({ clan, nickname: attendee.nickname }), clan + attendee.nickname, attendee.nickname + clan])) {
      addName(normalize(key), attendee);
    }
  }
  return ({ name, ip }) => {
    if (ip && byIp.has(ip)) return byIp.get(ip)!;
    for (const key of new Set([normalize(name), normalize(withoutTags(name))])) {
      const attendee = byName.get(key);
      if (attendee) return attendee;
    }
    return null;
  };
}

/* Status: query + optional RCON status (IPs and slots), cached for a few seconds
   ========================================================================== */

export interface ServerStatus {
  id: string;
  online: boolean;
  error: string | null;
  hostname: string;
  map: string;
  gametype: string;
  max_players: number | null;
  players: QueryPlayer[];
  rcon: 'ok' | 'error' | 'none';
  rcon_error: string | null;
  queried_at: string;
}

const STATUS_TTL_MS = 4000;
const statusCache = new Map<string, { at: number; promise: Promise<ServerStatus> }>();
const cacheKey = (server: GameServer) => `${server.id}:${server.game}:${server.host}:${server.port}:${server.query_port}`;

export interface Protocols {
  queryQ3: typeof queryQ3;
  queryA2S: typeof queryA2S;
  queryGameSpy: typeof queryGameSpy;
  queryUt2: typeof queryUt2;
  q3Rcon: typeof q3Rcon;
  sourceRcon: typeof sourceRcon;
  webAdminCommand: typeof webAdminCommand;
}

export const defaultProtocols: Protocols = { queryQ3, queryA2S, queryGameSpy, queryUt2, q3Rcon, sourceRcon, webAdminCommand };

async function query(server: GameServer, protocols: Protocols): Promise<QueryResult> {
  const queryPort = queryPortOf(server);
  switch (GAMES[server.game].query) {
    case 'q3': return protocols.queryQ3(server.host, queryPort);
    case 'a2s': return protocols.queryA2S(server.host, queryPort);
    case 'gamespy': return protocols.queryGameSpy(server.host, queryPort);
    case 'ut2': return protocols.queryUt2(server.host, queryPort);
  }
}

// RCON status brings IP addresses and slot numbers (for kicking); the query brings scores
async function rconPlayers(server: GameServer, protocols: Protocols): Promise<QueryPlayer[] | null> {
  const kind = GAMES[server.game].admin;
  if (!server.rcon_password || kind === 'webadmin') return null;
  if (kind === 'q3') return parseQ3RconStatus(await protocols.q3Rcon(server.host, server.port, server.rcon_password, 'status'));
  return parseCs2RconStatus(await protocols.sourceRcon(server.host, server.port, server.rcon_password, 'status'));
}

function mergePlayers(queried: QueryPlayer[], fromRcon: QueryPlayer[]): QueryPlayer[] {
  const scores = new Map(queried.map(p => [p.name, p]));
  return fromRcon.map(p => ({ ...p, score: p.score ?? scores.get(p.name)?.score ?? null, team: p.team ?? scores.get(p.name)?.team ?? null }));
}

export async function fetchStatus(server: GameServer, protocols: Protocols = defaultProtocols): Promise<ServerStatus> {
  const base = { id: server.id, queried_at: new Date().toISOString() };
  const [queried, rcon] = await Promise.allSettled([query(server, protocols), rconPlayers(server, protocols)]);
  if (queried.status === 'rejected') {
    return { ...base, online: false, error: errorText(queried.reason), hostname: '', map: '', gametype: '', max_players: null, players: [], rcon: 'none', rcon_error: null };
  }
  const result = queried.value;
  let players = result.players;
  let rconState: ServerStatus['rcon'] = 'none';
  let rconError: string | null = null;
  if (rcon.status === 'fulfilled' && rcon.value) {
    players = mergePlayers(result.players, rcon.value);
    rconState = 'ok';
  } else if (rcon.status === 'rejected') {
    rconState = 'error';
    rconError = errorText(rcon.reason);
  }
  return { ...base, online: true, error: null, hostname: result.hostname, map: result.map, gametype: result.gametype, max_players: result.max_players, players, rcon: rconState, rcon_error: rconError };
}

export function cachedStatus(server: GameServer, protocols: Protocols = defaultProtocols, now = Date.now()): Promise<ServerStatus> {
  const key = cacheKey(server);
  const hit = statusCache.get(key);
  if (hit && now - hit.at < STATUS_TTL_MS) return hit.promise;
  const promise = fetchStatus(server, protocols);
  statusCache.set(key, { at: now, promise });
  if (statusCache.size > 200) statusCache.delete(statusCache.keys().next().value!);
  return promise;
}

export const clearStatusCache = () => statusCache.clear();

function errorText(error: unknown): string {
  if (error instanceof GameServerError) return error.message;
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'Server nicht erreichbar';
  return 'Abfrage fehlgeschlagen';
}

// Status for the browser: players linked to attendees; IPs, slots and RCON errors only for admins
export function statusView(status: ServerStatus, match: PlayerMatcher, admin: boolean) {
  const players = status.players.map(p => {
    const attendee = p.bot ? null : match(p);
    const linked = attendee ? { attendee_id: attendee.id, nickname: attendee.nickname, clan: attendee.clan ?? '', display_name: displayName({ clan: attendee.clan ?? '', nickname: attendee.nickname }) } : { attendee_id: null, nickname: null, clan: null, display_name: null };
    return { name: p.name, score: p.score, ping: p.ping, team: p.team, bot: p.bot, ...linked, ...(admin ? { num: p.num, ip: p.ip } : {}) };
  }).sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity) || a.name.localeCompare(b.name, 'de'));
  return {
    id: status.id,
    online: status.online,
    error: status.error,
    hostname: status.hostname,
    map: status.map,
    gametype: status.gametype,
    max_players: status.max_players,
    player_count: players.filter(p => !p.bot).length,
    bot_count: players.filter(p => p.bot).length,
    players,
    queried_at: status.queried_at,
    ...(admin ? { rcon: status.rcon, rcon_error: status.rcon_error } : {}),
  };
}

/* Administration: free console command or quick action
   ========================================================================== */

export const ACTIONS = ['say', 'map', 'restart', 'next', 'kick'] as const;
export type ActionId = typeof ACTIONS[number];

const MAP_NAME = /^[\w\-[\]().]{1,64}$/;

// The commands of each engine; null = not available there
const COMMANDS: Record<GameId, Record<ActionId, ((value: string) => string) | null>> = {
  q3: { say: m => `say ${m}`, map: m => `map ${m}`, restart: () => 'map_restart', next: () => 'vstr nextmap', kick: n => `clientkick ${n}` },
  cod2: { say: m => `say ${m}`, map: m => `map ${m}`, restart: () => 'map_restart', next: () => 'map_rotate', kick: n => `clientkick ${n}` },
  cod4: { say: m => `say ${m}`, map: m => `map ${m}`, restart: () => 'map_restart', next: () => 'map_rotate', kick: n => `clientkick ${n}` },
  cs2: { say: m => `say ${m}`, map: m => `changelevel ${m}`, restart: () => 'mp_restartgame 1', next: null, kick: n => `kickid ${n}` },
  // Unreal: console commands of the engine; kicking needs the player page of the WebAdmin
  ut99: { say: m => `say ${m}`, map: m => `servertravel ${m}`, restart: () => 'servertravel ?restart', next: null, kick: null },
  ut2004: { say: m => `say ${m}`, map: m => `servertravel ${m}`, restart: () => 'servertravel ?restart', next: null, kick: null },
};

export function availableActions(game: GameId): ActionId[] {
  return ACTIONS.filter(action => COMMANDS[game][action] !== null);
}

export function actionCommand(game: GameId, action: unknown, value: unknown): string {
  if (!ACTIONS.includes(action as ActionId)) throw new ValidationError('Unbekannte Aktion');
  const build = COMMANDS[game][action as ActionId];
  if (!build) throw new ValidationError(`${GAMES[game].short} kann das nicht über die App`);
  const input = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  switch (action as ActionId) {
    case 'say': {
      // ";" would start a second command on Quake 3 and Source, quotes break the argument
      const message = input.replace(/[;"]/g, ',').replace(CONTROL, ' ');
      if (!message) throw new ValidationError('Nachricht fehlt');
      if (message.length > 150) throw new ValidationError('Nachricht ist zu lang (max. 150 Zeichen)');
      return build(message);
    }
    case 'map':
      if (!MAP_NAME.test(input)) throw new ValidationError('Ungültiger Mapname');
      return build(input);
    case 'kick':
      if (!/^\d{1,5}$/.test(input)) throw new ValidationError('Spieler fehlt');
      return build(input);
    default:
      return build('');
  }
}

export function validateCommand(value: unknown): string {
  const command = typeof value === 'string' ? value.trim() : '';
  if (!command) throw new ValidationError('Befehl fehlt');
  if (command.length > 300) throw new ValidationError('Befehl ist zu lang (max. 300 Zeichen)');
  if (CONTROL.test(command)) throw new ValidationError('Befehl darf keine Zeilenumbrüche enthalten');
  return command;
}

export async function runCommand(server: GameServer, command: string, protocols: Protocols = defaultProtocols): Promise<string> {
  if (!canAdminister(server)) {
    throw new GameServerError(GAMES[server.game].admin === 'webadmin' ? 'WebAdmin-Zugang fehlt (Port, Benutzer, Passwort)' : 'RCON-Passwort fehlt');
  }
  statusCache.delete(cacheKey(server)); // the next status shows the effect
  switch (GAMES[server.game].admin) {
    case 'q3': return protocols.q3Rcon(server.host, server.port, server.rcon_password, command);
    case 'source': return protocols.sourceRcon(server.host, server.port, server.rcon_password, command);
    case 'webadmin': return protocols.webAdminCommand({
      host: server.host, port: server.webadmin_port!, path: server.webadmin_path, username: server.webadmin_user, password: server.webadmin_password,
    }, command);
  }
}
