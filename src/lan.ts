// LAN party data: events with IP ranges/domain and their attendees.
// Pure functions only — persistence lives in lan-store.ts.

export const RANGE_LABELS = ['Haupt-PC', 'Zweiter PC', 'Dritter PC'] as const;
export const RANGE_COUNT = RANGE_LABELS.length;

export interface IpRange {
  start: string;
  end: string;
}

export interface LanEvent {
  id: number;
  name: string;
  domain: string;      // e.g. "lan.example.org"; DNS names are <hostname><n>.<domain>
  dns_server: string;  // optional IPv4 of the DNS server, used for NS/SOA in the BIND zone
  netmask: string;     // optional, printed on the IP slips
  gateway: string;     // optional, printed on the IP slips
  logo: string;        // optional PNG/JPEG data URL, printed on the IP slips
  ranges: IpRange[];   // one range per RANGE_LABELS entry
}

export interface Attendee {
  id: number;
  event_id: number;
  first_name: string;
  last_name: string;
  clan: string;        // optional; shown as "Clan-Nickname"
  nickname: string;
  hostname: string;    // DNS-safe form of the nickname (without clan)
  slot: number;        // offset into every IP range
}

export interface AttendeeView extends Attendee {
  display_name: string;
  ips: string[];
  dns_names: string[];
}

// Logo as data URL (the browser converts uploads to PNG); ~1.5 MB is plenty for a print logo
export const MAX_LOGO_LENGTH = 2_000_000;
const LOGO_PATTERN = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+=*$/;

export const DEFAULT_RANGES: IpRange[] = [
  { start: '192.168.120.100', end: '192.168.120.149' },
  { start: '192.168.120.150', end: '192.168.120.199' },
  { start: '192.168.120.200', end: '192.168.120.249' },
];

export class ValidationError extends Error {}

/* IPv4 helpers
   ========================================================================== */

export function parseIPv4(value: string): number | null {
  const parts = value.trim().split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    result = result * 256 + n;
  }
  return result;
}

export function formatIPv4(value: number): string {
  return [24, 16, 8, 0].map(shift => Math.floor(value / 2 ** shift) % 256).join('.');
}

// A netmask has contiguous one bits, e.g. 255.255.255.0
export function isValidNetmask(value: string): boolean {
  const mask = parseIPv4(value);
  if (mask === null || mask === 0) return false;
  const inverted = 0xFFFFFFFF - mask;
  return (inverted & (inverted + 1)) === 0;
}

export function rangeSize(range: IpRange): number {
  const start = parseIPv4(range.start);
  const end = parseIPv4(range.end);
  return start === null || end === null || end < start ? 0 : end - start + 1;
}

// Number of attendees an event can hold: the smallest of its ranges
export function eventCapacity(event: Pick<LanEvent, 'ranges'>): number {
  return Math.min(...event.ranges.map(rangeSize));
}

/* Names
   ========================================================================== */

const DOMAIN_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
}

export function isValidDomain(domain: string): boolean {
  return domain.length <= 253 && domain.split('.').every(label => DOMAIN_LABEL.test(label));
}

// DNS-safe hostname from a nickname: lowercase a-z, 0-9 and '-', umlauts transliterated.
// Leaves room for the trailing "2"/"3" of the additional names.
export function toHostname(nickname: string): string {
  return nickname
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
    .replace(/-$/, '');
}

// Hostnames of all addresses of an attendee: nick, nick2, nick3
export function hostnamesFor(hostname: string): string[] {
  return Array.from({ length: RANGE_COUNT }, (_, i) => (i === 0 ? hostname : `${hostname}${i + 1}`));
}

/* Event settings
   ========================================================================== */

export interface EventSettingsInput {
  name?: unknown;
  domain?: unknown;
  dns_server?: unknown;
  netmask?: unknown;
  gateway?: unknown;
  logo?: unknown;
  ranges?: unknown;
}

// Validates and normalizes event settings; usedSlots ensures existing attendees still fit
export function validateEventSettings(input: EventSettingsInput, usedSlots: number[] = []): Omit<LanEvent, 'id'> {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) throw new ValidationError('Event-Name fehlt');

  const domain = typeof input.domain === 'string' ? normalizeDomain(input.domain) : '';
  if (domain && !isValidDomain(domain)) throw new ValidationError(`Ungültige Domain: ${domain}`);

  const dnsServer = typeof input.dns_server === 'string' ? input.dns_server.trim() : '';
  if (dnsServer && parseIPv4(dnsServer) === null) throw new ValidationError(`Ungültige IP für DNS-Server: ${dnsServer}`);

  const netmask = typeof input.netmask === 'string' ? input.netmask.trim() : '';
  if (netmask && !isValidNetmask(netmask)) throw new ValidationError(`Ungültige Subnetzmaske: ${netmask}`);

  const gateway = typeof input.gateway === 'string' ? input.gateway.trim() : '';
  if (gateway && parseIPv4(gateway) === null) throw new ValidationError(`Ungültige IP für Gateway: ${gateway}`);

  const logo = typeof input.logo === 'string' ? input.logo.trim() : '';
  if (logo.length > MAX_LOGO_LENGTH) throw new ValidationError('Das Logo ist zu groß (max. ca. 1,5 MB)');
  if (logo && !LOGO_PATTERN.test(logo)) throw new ValidationError('Das Logo muss ein PNG- oder JPEG-Bild sein');

  if (!Array.isArray(input.ranges) || input.ranges.length !== RANGE_COUNT) {
    throw new ValidationError(`Es müssen genau ${RANGE_COUNT} IP-Bereiche angegeben werden`);
  }
  const ranges: IpRange[] = input.ranges.map((range, i) => {
    const start = typeof range?.start === 'string' ? range.start.trim() : '';
    const end = typeof range?.end === 'string' ? range.end.trim() : '';
    if (parseIPv4(start) === null || parseIPv4(end) === null) {
      throw new ValidationError(`${RANGE_LABELS[i]}: ungültige IP-Adresse`);
    }
    if (rangeSize({ start, end }) === 0) {
      throw new ValidationError(`${RANGE_LABELS[i]}: Ende liegt vor dem Start`);
    }
    return { start, end };
  });

  // Ranges must not overlap, otherwise two attendees could share an address
  for (let i = 0; i < ranges.length; i++) {
    for (let j = i + 1; j < ranges.length; j++) {
      const a = ranges[i], b = ranges[j];
      if (parseIPv4(a.start)! <= parseIPv4(b.end)! && parseIPv4(b.start)! <= parseIPv4(a.end)!) {
        throw new ValidationError(`${RANGE_LABELS[i]} und ${RANGE_LABELS[j]} überschneiden sich`);
      }
    }
  }

  const capacity = eventCapacity({ ranges });
  const highestSlot = Math.max(-1, ...usedSlots);
  if (highestSlot >= capacity) {
    throw new ValidationError(`Die Bereiche bieten nur ${capacity} Plätze, vergeben ist aber bereits Platz ${highestSlot + 1}`);
  }

  return { name, domain, dns_server: dnsServer, netmask, gateway, logo, ranges };
}

/* Attendees
   ========================================================================== */

export interface AttendeeInput {
  first_name?: unknown;
  clan?: unknown;
  last_name?: unknown;
  nickname?: unknown;
}

// Name shown everywhere and used as player name in tournaments: "Clan-Nickname" or just the nickname
export function displayName(attendee: Pick<Attendee, 'clan' | 'nickname'>): string {
  return attendee.clan ? `${attendee.clan}-${attendee.nickname}` : attendee.nickname;
}

export function validateAttendee(input: AttendeeInput): Pick<Attendee, 'first_name' | 'last_name' | 'clan' | 'nickname' | 'hostname'> {
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
  const nickname = text(input.nickname);
  if (!nickname) throw new ValidationError('Nickname fehlt');
  const hostname = toHostname(nickname);
  if (!hostname) throw new ValidationError(`Aus dem Nickname „${nickname}“ lässt sich kein DNS-Name bilden`);
  return { first_name: text(input.first_name), last_name: text(input.last_name), clan: text(input.clan), nickname, hostname };
}

// "Clan-Nickname" is split at the first hyphen ("G3.SQUAD-joy" → clan "G3.SQUAD", nickname "joy");
// without hyphen there is no clan
export function splitClanNickname(value: string): { clan: string; nickname: string } {
  const hyphen = value.indexOf('-');
  const clan = hyphen > 0 ? value.slice(0, hyphen).trim() : '';
  const nickname = hyphen > 0 ? value.slice(hyphen + 1).trim() : value.trim();
  return clan && nickname ? { clan, nickname } : { clan: '', nickname: value.trim() };
}

// One line of a bulk import: "Nachname, Vorname // Clan-Nickname" (names may be empty: "// Nick")
export function parseBulkLine(text: string): { first_name: string; last_name: string; clan: string; nickname: string } {
  const separator = text.indexOf('//');
  if (separator === -1) throw new ValidationError('„//“ vor dem Nickname fehlt');

  const names = text.slice(0, separator).trim();
  const player = text.slice(separator + 2).trim();
  if (!player) throw new ValidationError('Nickname fehlt');
  const { clan, nickname } = splitClanNickname(player);
  if (!names) return { last_name: '', first_name: '', clan, nickname };

  const comma = names.indexOf(',');
  if (comma === -1) throw new ValidationError('Komma zwischen Nachname und Vorname fehlt');
  return { last_name: names.slice(0, comma).trim(), first_name: names.slice(comma + 1).trim(), clan, nickname };
}

// Throws if nickname, display name or any derived DNS name collides with another attendee of the event
export function assertUniqueAttendee(candidate: Pick<Attendee, 'clan' | 'nickname' | 'hostname'>, others: Attendee[]): void {
  const nickname = candidate.nickname.toLowerCase();
  const display = displayName(candidate).toLowerCase();
  const names = new Set(hostnamesFor(candidate.hostname));
  for (const other of others) {
    if (other.nickname.toLowerCase() === nickname) {
      throw new ValidationError(`Nickname „${candidate.nickname}“ ist in diesem Event schon vergeben (${displayName(other)})`);
    }
    if (displayName(other).toLowerCase() === display) {
      throw new ValidationError(`„${displayName(candidate)}“ ist in diesem Event schon vergeben`);
    }
    const clash = hostnamesFor(other.hostname).find(name => names.has(name));
    if (clash) {
      throw new ValidationError(`DNS-Name „${clash}“ kollidiert mit Teilnehmer „${other.nickname}“`);
    }
  }
}

// Lowest free slot, or null if the event is full
export function nextFreeSlot(usedSlots: number[], capacity: number): number | null {
  const used = new Set(usedSlots);
  for (let slot = 0; slot < capacity; slot++) {
    if (!used.has(slot)) return slot;
  }
  return null;
}

export function describeAttendee(event: LanEvent, attendee: Attendee): AttendeeView {
  const ips = event.ranges.map(range => formatIPv4(parseIPv4(range.start)! + attendee.slot));
  const dnsNames = hostnamesFor(attendee.hostname).map(name => (event.domain ? `${name}.${event.domain}` : name));
  return { ...attendee, clan: attendee.clan ?? '', display_name: displayName({ clan: attendee.clan ?? '', nickname: attendee.nickname }), ips, dns_names: dnsNames };
}

/* Exports
   ========================================================================== */

function sortedViews(event: LanEvent, attendees: Attendee[]): AttendeeView[] {
  return [...attendees].sort((a, b) => a.slot - b.slot).map(a => describeAttendee(event, a));
}

function csvCell(value: string): string {
  return /[";\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

// Semicolon-separated with BOM, so Excel (German locale) opens it correctly
export function exportCsv(event: LanEvent, attendees: Attendee[]): string {
  const header = ['Clan-Nickname', 'Clan', 'Nickname', 'Vorname', 'Name', ...RANGE_LABELS.map(l => `IP ${l}`), ...RANGE_LABELS.map(l => `DNS ${l}`)];
  const rows = sortedViews(event, attendees).map(a => [a.display_name, a.clan, a.nickname, a.first_name, a.last_name, ...a.ips, ...a.dns_names]);
  return '﻿' + [header, ...rows].map(row => row.map(csvCell).join(';')).join('\r\n') + '\r\n';
}

export function exportHosts(event: LanEvent, attendees: Attendee[]): string {
  const lines = [`# ${event.name} — generiert von MCD Brackets`];
  for (const a of sortedViews(event, attendees)) {
    a.ips.forEach((ip, i) => {
      const short = hostnamesFor(a.hostname)[i];
      lines.push(event.domain ? `${ip}\t${a.dns_names[i]}\t${short}` : `${ip}\t${short}`);
    });
  }
  return lines.join('\n') + '\n';
}

export function exportBindZone(event: LanEvent, attendees: Attendee[], now: Date = new Date()): string {
  if (!event.domain) throw new ValidationError('Für die BIND-Zone muss eine Domain eingestellt sein');

  const serial = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}01`;
  const lines = [
    `; ${event.name} — generiert von MCD Brackets`,
    `$ORIGIN ${event.domain}.`,
    '$TTL 3600',
  ];

  if (event.dns_server) {
    lines.push(
      `@\tIN\tSOA\tns.${event.domain}. hostmaster.${event.domain}. (`,
      `\t\t${serial} ; serial`,
      '\t\t3600 ; refresh',
      '\t\t900 ; retry',
      '\t\t604800 ; expire',
      '\t\t300 ) ; negative TTL',
      `@\tIN\tNS\tns.${event.domain}.`,
      `ns\tIN\tA\t${event.dns_server}`,
    );
  } else {
    lines.push('; Ohne eingetragenen DNS-Server nur A-Records (z.B. per $INCLUDE einbinden)');
  }

  lines.push('');
  for (const a of sortedViews(event, attendees)) {
    a.ips.forEach((ip, i) => lines.push(`${hostnamesFor(a.hostname)[i]}\tIN\tA\t${ip}`));
  }
  return lines.join('\n') + '\n';
}
