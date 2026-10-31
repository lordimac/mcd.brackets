// Welcome page: who is this device and is its network set up correctly?
// The client IP identifies the attendee: IP i of an attendee is ranges[i].start + slot (lan.ts).
// Pure functions only — the route in welcome-routes.ts collects the data.

import { describeAttendee, parseIPv4, RANGE_LABELS, type Attendee, type AttendeeView, type LanEvent } from './lan';

export type CheckStatus = 'ok' | 'warn' | 'error' | 'info';

export interface NetworkCheck {
  id: 'ip' | 'subnet' | 'dns';
  status: CheckStatus;
  title: string;
  detail: string;
}

export type WelcomeStatus =
  | 'identified'  // IP belongs to an attendee
  | 'unassigned'  // IP lies in a range of the event, but no attendee has it
  | 'unknown'     // IP outside all ranges (DHCP, typo, other network)
  | 'disabled'    // IP identification switched off for the event
  | 'no-event';

export interface Identification {
  event: LanEvent | null;
  status: WelcomeStatus;
  attendee: AttendeeView | null;
  range_index: number | null;
}

// Express gives IPv4 clients of a dual-stack socket as "::ffff:192.168.1.5"; IPv6 can't match a range
export function clientIPv4(ip: string | undefined): string | null {
  if (!ip) return null;
  const plain = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  return parseIPv4(plain) === null ? null : plain;
}

const today = (now: Date) => now.toISOString().slice(0, 10);
const isRunning = (event: LanEvent, day: string) => !!event.starts_on && event.starts_on <= day && day <= event.ends_on;

// Event shown on the welcome page: a running one first, else the newest
export function preferredEvents(events: LanEvent[], now: Date = new Date()): LanEvent[] {
  const day = today(now);
  return [...events].sort((a, b) => Number(isRunning(b, day)) - Number(isRunning(a, day)) || b.id - a.id);
}

// Position of the IP in the event's ranges, or null
export function locateInRanges(event: LanEvent, ip: string): { range_index: number; slot: number } | null {
  const value = parseIPv4(ip);
  if (value === null) return null;
  for (const [i, range] of event.ranges.entries()) {
    const start = parseIPv4(range.start), end = parseIPv4(range.end);
    if (start !== null && end !== null && value >= start && value <= end) return { range_index: i, slot: value - start };
  }
  return null;
}

// The first event (running/newest first) with IP identification whose ranges contain the IP decides
export function identify(ip: string | null, events: LanEvent[], attendees: Attendee[], now: Date = new Date()): Identification {
  const ordered = preferredEvents(events, now);
  const enabled = ordered.filter(e => e.ip_identification !== false);
  if (!ordered.length) return { event: null, status: 'no-event', attendee: null, range_index: null };
  if (!enabled.length) return { event: ordered[0], status: 'disabled', attendee: null, range_index: null };

  for (const event of ip ? enabled : []) {
    const position = locateInRanges(event, ip!);
    if (!position) continue;
    const attendee = attendees.find(a => a.event_id === event.id && a.slot === position.slot);
    return attendee
      ? { event, status: 'identified', attendee: describeAttendee(event, attendee), range_index: position.range_index }
      : { event, status: 'unassigned', attendee: null, range_index: position.range_index };
  }
  return { event: enabled[0], status: 'unknown', attendee: null, range_index: null };
}

function sameSubnet(a: string, b: string, mask: string): boolean {
  const m = parseIPv4(mask)!;
  return (parseIPv4(a)! & m) >>> 0 === (parseIPv4(b)! & m) >>> 0;
}

// DNS lookup result of the attendee's name for this device: the resolved addresses, or null if
// the name is unknown; undefined = not checked (no domain/DNS server or lookup failed)
export type DnsLookup = { name: string; addresses: string[] | null } | undefined;

// What the server can tell about the device's network setup. The netmask, gateway and DNS server
// configured on the device itself are invisible to the server — they are shown as values to compare.
export function networkChecks(ip: string | null, id: Identification, dns?: DnsLookup): NetworkCheck[] {
  const event = id.event;
  const checks: NetworkCheck[] = [];
  const rangeLabel = id.range_index != null ? RANGE_LABELS[id.range_index] : '';
  if (id.status === 'disabled' || id.status === 'no-event') return checks;

  if (!ip) {
    checks.push({ id: 'ip', status: 'error', title: 'Keine IPv4-Adresse erkannt', detail: 'Die Verbindung kommt nicht über IPv4 an. Feste IPv4-Adresse laut IP-Zettel eintragen.' });
    return checks;
  }
  if (id.status === 'identified') {
    checks.push({ id: 'ip', status: 'ok', title: 'IP-Adresse passt', detail: `${ip} ist deine Adresse für „${rangeLabel}“.` });
  } else if (id.status === 'unassigned') {
    checks.push({ id: 'ip', status: 'warn', title: 'IP-Adresse ist niemandem zugeordnet', detail: `${ip} liegt im Bereich „${rangeLabel}“, gehört aber keinem Teilnehmer. Bitte die Adresse vom IP-Zettel eintragen.` });
  } else if (id.status === 'unknown' && event) {
    checks.push({ id: 'ip', status: 'error', title: 'IP-Adresse gehört nicht zum Event', detail: `${ip} liegt in keinem IP-Bereich von „${event.name}“ — vermutlich ist noch DHCP eingestellt oder die Adresse falsch eingetippt.` });
  }
  if (!event || (id.status !== 'identified' && id.status !== 'unassigned')) return checks;

  if (event.netmask && event.gateway) {
    checks.push(sameSubnet(ip, event.gateway, event.netmask)
      ? { id: 'subnet', status: 'ok', title: 'Gateway im selben Netz', detail: `Mit der Maske ${event.netmask} ist ${event.gateway} direkt erreichbar.` }
      : { id: 'subnet', status: 'warn', title: 'Gateway liegt in einem anderen Netz', detail: `Mit der Maske ${event.netmask} ist ${event.gateway} von ${ip} aus nicht direkt erreichbar — bitte die Orga ansprechen.` });
  }

  if (dns && id.attendee) {
    const expected = id.attendee.ips[id.range_index!];
    if (dns.addresses === null) {
      checks.push({ id: 'dns', status: 'warn', title: 'DNS-Name noch nicht eingetragen', detail: `Der DNS-Server ${event.dns_server} kennt ${dns.name} (noch) nicht.` });
    } else if (dns.addresses.includes(expected)) {
      checks.push({ id: 'dns', status: 'ok', title: 'DNS-Name eingetragen', detail: `${dns.name} zeigt auf ${expected}.` });
    } else {
      checks.push({ id: 'dns', status: 'warn', title: 'DNS-Name zeigt woanders hin', detail: `${dns.name} zeigt auf ${dns.addresses.join(', ')} statt ${expected}.` });
    }
  }
  return checks;
}

// Expected settings for the device (what the IP slip says)
export function expectedSettings(id: Identification): { ip: string; netmask: string; gateway: string; dns_server: string; dns_name: string } | null {
  if (!id.event || !id.attendee || id.range_index == null) return null;
  return {
    ip: id.attendee.ips[id.range_index],
    netmask: id.event.netmask,
    gateway: id.event.gateway,
    dns_server: id.event.dns_server,
    dns_name: id.attendee.dns_names[id.range_index],
  };
}
