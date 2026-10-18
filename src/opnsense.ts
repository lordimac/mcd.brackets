// OPNsense integration: pushes the attendees' DNS names to Unbound as host overrides.
// Pure planning logic plus a small HTTP client for the OPNsense API (checked against 26.7).

import http from 'http';
import https from 'https';
import { describeAttendee, hostnamesFor, RANGE_LABELS, ValidationError, type Attendee, type LanEvent } from './lan';

/* Settings (one record in the "opnsense" table)
   ========================================================================== */

export interface OpnsenseSettings {
  id: number;
  url: string;          // e.g. "https://192.168.120.1" (without /api)
  api_key: string;
  api_secret: string;   // never sent to the browser
  insecure_tls: boolean; // accept self-signed certificates
}

// What the browser gets to see
export interface OpnsenseSettingsView {
  url: string;
  api_key: string;
  has_secret: boolean;
  insecure_tls: boolean;
  configured: boolean;
}

export interface OpnsenseSettingsInput {
  url?: unknown;
  api_key?: unknown;
  api_secret?: unknown;
  insecure_tls?: unknown;
}

export const EMPTY_SETTINGS: Omit<OpnsenseSettings, 'id'> = { url: '', api_key: '', api_secret: '', insecure_tls: false };

export function isConfigured(settings: Omit<OpnsenseSettings, 'id'>): boolean {
  return Boolean(settings.url && settings.api_key && settings.api_secret);
}

export function settingsView(settings: Omit<OpnsenseSettings, 'id'>): OpnsenseSettingsView {
  return {
    url: settings.url,
    api_key: settings.api_key,
    has_secret: settings.api_secret.length > 0,
    insecure_tls: settings.insecure_tls,
    configured: isConfigured(settings),
  };
}

// An empty secret keeps the stored one, so the browser never needs to know it
export function validateSettings(input: OpnsenseSettingsInput, current: Omit<OpnsenseSettings, 'id'>): Omit<OpnsenseSettings, 'id'> {
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
  let url = text(input.url).replace(/\/+$/, '').replace(/\/api$/i, '');
  if (url) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !/^https?:\/\//i.test(url)) {
      throw new ValidationError('Die OPNsense-Adresse muss mit https:// beginnen');
    }
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new ValidationError('Ungültige OPNsense-Adresse');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new ValidationError('Die OPNsense-Adresse muss mit https:// beginnen');
    url = `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`;
  }
  const secret = text(input.api_secret);
  return {
    url,
    api_key: text(input.api_key),
    api_secret: secret || current.api_secret,
    insecure_tls: input.insecure_tls === true,
  };
}

/* Host overrides
   ========================================================================== */

// Fields of a Unbound host override as the API returns them (OPNsense 26.7, model hosts.host)
export interface HostOverrideRow {
  uuid: string;
  enabled?: string;
  hostname?: string;
  domain?: string;
  rr?: string;        // "A" or its label "A (IPv4 address)"
  server?: string;
  description?: string;
  isAlias?: boolean;
  _children?: HostOverrideRow[];
}

// What we write for every DNS name of an attendee
export interface HostRecord {
  hostname: string;
  domain: string;
  server: string;
  description: string;
}

// Our entries carry this marker in the description; everything else is left alone
const MARKER = 'mcd-brackets';
const MARKER_PATTERN = /^mcd-brackets #(\d+)\b/;

export function ownerEventId(description: string | undefined): number | null {
  const match = MARKER_PATTERN.exec(description ?? '');
  return match ? Number(match[1]) : null;
}

export function desiredRecords(event: LanEvent, attendees: Attendee[]): HostRecord[] {
  if (!event.domain) throw new ValidationError('Für OPNsense muss beim Event eine Domain eingestellt sein');
  const records: HostRecord[] = [];
  for (const attendee of [...attendees].sort((a, b) => a.slot - b.slot)) {
    const view = describeAttendee(event, attendee);
    hostnamesFor(attendee.hostname).forEach((hostname, i) => records.push({
      hostname,
      domain: event.domain.toLowerCase(),
      server: view.ips[i],
      description: `${MARKER} #${event.id}: ${view.display_name} (${RANGE_LABELS[i]})`,
    }));
  }
  return records;
}

const recordKey = (hostname: string | undefined, domain: string | undefined) =>
  `${(hostname ?? '').toLowerCase()}.${(domain ?? '').toLowerCase()}`;

const isARecord = (rr: string | undefined) => /^A(\s|$)/.test(rr ?? 'A');

export interface PlanItem {
  action: 'create' | 'update' | 'delete' | 'conflict' | 'unchanged';
  name: string;          // FQDN
  server: string;        // target IP (delete: current IP)
  uuid?: string;
  record?: HostRecord;   // what gets written (create/update)
  note?: string;         // e.g. old IP or the reason for a conflict
}

export interface SyncPlan {
  items: PlanItem[];
  counts: Record<PlanItem['action'], number>;
}

function countItems(items: PlanItem[]): SyncPlan['counts'] {
  const counts = { create: 0, update: 0, delete: 0, conflict: 0, unchanged: 0 };
  for (const item of items) counts[item.action]++;
  return counts;
}

// Compare what Unbound has with what the event needs.
// mode "sync": create/update the event's names, delete our entries that are no longer needed.
// mode "remove": delete every entry of this event.
export function planSync(eventId: number, desired: HostRecord[], rows: HostOverrideRow[], mode: 'sync' | 'remove'): SyncPlan {
  const items: PlanItem[] = [];
  const wanted = new Map(mode === 'sync' ? desired.map(r => [recordKey(r.hostname, r.domain), r]) : []);

  // Names taken by entries we don't manage (incl. aliases), per name
  const foreign = new Map<string, HostOverrideRow>();
  // Our entries (any event) per name; the first one is kept, duplicates are removed
  const ours = new Map<string, HostOverrideRow>();
  const duplicates: HostOverrideRow[] = [];

  for (const row of rows) {
    const children = row._children ?? [];
    for (const entry of [row, ...children]) {
      const key = recordKey(entry.hostname, entry.domain);
      const owner = entry.isAlias ? null : ownerEventId(entry.description);
      if (owner === null) {
        if (!foreign.has(key)) foreign.set(key, entry);
      } else if (ours.has(key)) {
        if (owner === eventId) duplicates.push(entry);
      } else {
        ours.set(key, entry);
      }
    }
  }

  for (const [key, record] of wanted) {
    const name = `${record.hostname}.${record.domain}`;
    const existing = ours.get(key);
    const clash = foreign.get(key);
    if (clash && !existing) {
      items.push({ action: 'conflict', name, server: record.server, note: `Vorhandener Eintrag ohne MCD-Markierung (${clash.server || clash.rr || 'Alias'}) — wird nicht überschrieben` });
      continue;
    }
    if (!existing) {
      items.push({ action: 'create', name, server: record.server, record });
      continue;
    }
    const owner = ownerEventId(existing.description);
    const changed = existing.server !== record.server || existing.enabled !== '1' || !isARecord(existing.rr) || existing.description !== record.description;
    if (!changed) {
      items.push({ action: 'unchanged', name, server: record.server, uuid: existing.uuid });
      continue;
    }
    const notes: string[] = [];
    if (owner !== eventId) notes.push(`von Event #${owner} übernommen`);
    if (existing.server !== record.server) notes.push(`bisher ${existing.server || '–'}`);
    if (existing.enabled !== '1') notes.push('war deaktiviert');
    items.push({ action: 'update', name, server: record.server, uuid: existing.uuid, record, note: notes.join(', ') || 'Beschreibung aktualisiert' });
  }

  // Our entries of this event that are no longer wanted, plus duplicates
  for (const [key, row] of ours) {
    if (ownerEventId(row.description) === eventId && !wanted.has(key)) {
      items.push({ action: 'delete', name: `${row.hostname}.${row.domain}`, server: row.server ?? '', uuid: row.uuid });
    }
  }
  for (const row of duplicates) {
    items.push({ action: 'delete', name: `${row.hostname}.${row.domain}`, server: row.server ?? '', uuid: row.uuid, note: 'doppelter Eintrag' });
  }

  return { items, counts: countItems(items) };
}

/* Applying a plan
   ========================================================================== */

export interface OpnsenseClient {
  searchHosts(): Promise<HostOverrideRow[]>;
  addHost(record: HostRecord): Promise<void>;
  setHost(uuid: string, record: HostRecord): Promise<void>;
  delHost(uuid: string): Promise<void>;
  reconfigure(): Promise<void>;
}

export interface ApplyResult {
  created: number;
  updated: number;
  deleted: number;
  conflicts: number;
  errors: { name: string; error: string }[];
  reconfigured: boolean;
}

export async function applyPlan(client: OpnsenseClient, plan: SyncPlan): Promise<ApplyResult> {
  const result: ApplyResult = { created: 0, updated: 0, deleted: 0, conflicts: plan.counts.conflict, errors: [], reconfigured: false };
  for (const item of plan.items) {
    try {
      if (item.action === 'create') {
        await client.addHost(item.record!);
        result.created++;
      } else if (item.action === 'update') {
        await client.setHost(item.uuid!, item.record!);
        result.updated++;
      } else if (item.action === 'delete') {
        await client.delHost(item.uuid!);
        result.deleted++;
      }
    } catch (error) {
      result.errors.push({ name: item.name, error: (error as Error).message });
    }
  }
  // Changes only take effect in Unbound after applying the configuration
  if (result.created + result.updated + result.deleted > 0) {
    await client.reconfigure();
    result.reconfigured = true;
  }
  return result;
}

/* HTTP client for the OPNsense API
   ========================================================================== */

export class OpnsenseError extends Error {}

const TIMEOUT_MS = 15000;

function hostPayload(record: HostRecord) {
  return { host: { enabled: '1', hostname: record.hostname, domain: record.domain, rr: 'A', server: record.server, description: record.description } };
}

// "validations": {"host.server": "..."} → readable text
function describeFailure(body: Record<string, unknown>): string {
  const validations = body.validations as Record<string, string | string[]> | undefined;
  if (validations) return Object.values(validations).flat().join('; ');
  return typeof body.message === 'string' ? body.message : 'OPNsense hat die Änderung abgelehnt';
}

export function createOpnsenseClient(settings: Omit<OpnsenseSettings, 'id'>): OpnsenseClient {
  if (!isConfigured(settings)) throw new ValidationError('OPNsense ist nicht eingerichtet (Adresse, API-Key und Secret fehlen)');
  const auth = 'Basic ' + Buffer.from(`${settings.api_key}:${settings.api_secret}`).toString('base64');

  function call(path: string, body: unknown = {}): Promise<Record<string, unknown>> {
    const url = new URL(`${settings.url}/api/${path}`);
    const payload = JSON.stringify(body);
    const transport = url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const req = transport.request(url, {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Accept: 'application/json' },
        timeout: TIMEOUT_MS,
        rejectUnauthorized: !settings.insecure_tls,
      }, res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          const status = res.statusCode ?? 0;
          if (status === 401) return reject(new OpnsenseError('OPNsense: API-Key oder Secret ist falsch'));
          if (status === 403) return reject(new OpnsenseError('OPNsense: Dem API-Benutzer fehlt die Berechtigung „Services: Unbound“'));
          if (status === 404) return reject(new OpnsenseError(`OPNsense: Endpunkt nicht gefunden (${url.pathname}) — Adresse prüfen`));
          if (status < 200 || status >= 300) return reject(new OpnsenseError(`OPNsense antwortet mit HTTP ${status}`));
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new OpnsenseError('OPNsense: unerwartete Antwort (kein JSON) — ist die Adresse die Weboberfläche der Firewall?'));
          }
        });
      });
      req.on('timeout', () => req.destroy(new OpnsenseError('OPNsense antwortet nicht (Zeitüberschreitung)')));
      req.on('error', error => reject(error instanceof OpnsenseError ? error : new OpnsenseError(networkMessage(error as NodeJS.ErrnoException))));
      req.end(payload);
    });
  }

  return {
    async searchHosts() {
      const body = await call('unbound/settings/search_host_override', { current: 1, rowCount: -1 });
      if (!Array.isArray(body.rows)) throw new OpnsenseError('OPNsense: unerwartete Antwort beim Lesen der Host Overrides');
      return body.rows as HostOverrideRow[];
    },
    async addHost(record) {
      const body = await call('unbound/settings/add_host_override', hostPayload(record));
      if (body.result !== 'saved') throw new OpnsenseError(describeFailure(body));
    },
    async setHost(uuid, record) {
      const body = await call(`unbound/settings/set_host_override/${encodeURIComponent(uuid)}`, hostPayload(record));
      if (body.result !== 'saved') throw new OpnsenseError(describeFailure(body));
    },
    async delHost(uuid) {
      const body = await call(`unbound/settings/del_host_override/${encodeURIComponent(uuid)}`);
      if (body.result !== 'deleted') throw new OpnsenseError(describeFailure(body));
    },
    async reconfigure() {
      const body = await call('unbound/service/reconfigure');
      if (body.status !== 'ok') throw new OpnsenseError('OPNsense: Unbound konnte nicht neu geladen werden');
    },
  };
}

function networkMessage(error: NodeJS.ErrnoException): string {
  const code = error.code ?? '';
  if (code === 'ECONNREFUSED') return 'OPNsense nicht erreichbar (Verbindung abgelehnt) — Adresse und Port prüfen';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'OPNsense-Adresse kann nicht aufgelöst werden';
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'ETIMEDOUT') return 'OPNsense nicht erreichbar — läuft der Container im selben Netz?';
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/.test(code)) return 'Zertifikat der OPNsense wird nicht vertraut — „Zertifikat nicht prüfen“ aktivieren';
  return `OPNsense-Verbindung fehlgeschlagen: ${error.message}`;
}
