import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RANGES, toHostname, validateEventSettings, type Attendee, type LanEvent } from './lan';
import { clientIPv4, expectedSettings, identify, networkChecks, preferredEvents } from './welcome';

const base: LanEvent = { id: 1, name: 'mcd.lan 2025', domain: 'lan.example.org', dns_server: '192.168.120.1', netmask: '255.255.255.0', gateway: '192.168.120.1', logo: '', starts_on: '', ends_on: '', wifi_enabled: false, wifi_ssid: '', wifi_password: '', memorial: [], ip_identification: true, ranges: DEFAULT_RANGES };
const event2026: LanEvent = { ...base, id: 2, name: 'mcd.lan 2026' };

function attendee(id: number, eventId: number, nickname: string, slot: number): Attendee {
  return { id, event_id: eventId, first_name: 'Max', last_name: 'Muster', clan: 'MCD', nickname, hostname: toHostname(nickname), slot };
}

const attendees = [attendee(1, 1, 'Alt', 5), attendee(2, 2, 'Joy', 5), attendee(3, 2, 'Rex', 0)];
const now = new Date('2026-10-31T12:00:00Z');

test('clientIPv4 strips the IPv4-mapped prefix and rejects IPv6', () => {
  assert.equal(clientIPv4('::ffff:192.168.120.105'), '192.168.120.105');
  assert.equal(clientIPv4('10.0.0.1'), '10.0.0.1');
  assert.equal(clientIPv4('::1'), null);
  assert.equal(clientIPv4(undefined), null);
});

test('IP identifies the attendee of the newest event, on every range', () => {
  const main = identify('192.168.120.105', [base, event2026], attendees, now);
  assert.equal(main.status, 'identified');
  assert.equal(main.event?.id, 2);
  assert.equal(main.attendee?.display_name, 'MCD-Joy');
  assert.equal(main.range_index, 0);

  const third = identify('192.168.120.205', [base, event2026], attendees, now);
  assert.equal(third.attendee?.id, 2);
  assert.equal(third.range_index, 2);
  assert.deepEqual(expectedSettings(third), { ip: '192.168.120.205', netmask: '255.255.255.0', gateway: '192.168.120.1', dns_server: '192.168.120.1', dns_name: 'joy3.lan.example.org' });
});

test('a running event wins over a newer one, switched-off events are skipped', () => {
  const running = { ...base, starts_on: '2026-10-30', ends_on: '2026-11-01' };
  assert.deepEqual(preferredEvents([running, event2026], now).map(e => e.id), [1, 2]);
  assert.equal(identify('192.168.120.105', [running, event2026], attendees, now).attendee?.nickname, 'Alt');

  const off = { ...event2026, ip_identification: false };
  assert.equal(identify('192.168.120.105', [base, off], attendees, now).attendee?.nickname, 'Alt');
  assert.equal(identify('192.168.120.105', [{ ...base, ip_identification: false }, off], attendees, now).status, 'disabled');
  assert.equal(identify('192.168.120.105', [], attendees, now).status, 'no-event');
});

test('free and foreign addresses', () => {
  const free = identify('192.168.120.140', [event2026], attendees, now);
  assert.equal(free.status, 'unassigned');
  assert.equal(free.attendee, null);
  assert.equal(networkChecks('192.168.120.140', free)[0].status, 'warn');

  const foreign = identify('10.1.2.3', [event2026], attendees, now);
  assert.equal(foreign.status, 'unknown');
  assert.equal(foreign.event?.id, 2);
  assert.deepEqual(networkChecks('10.1.2.3', foreign).map(c => [c.id, c.status]), [['ip', 'error']]);
  assert.equal(networkChecks(null, foreign)[0].status, 'error');
});

test('network checks: subnet of the gateway and DNS name', () => {
  const id = identify('192.168.120.105', [event2026], attendees, now);
  const ok = networkChecks('192.168.120.105', id, { name: 'joy.lan.example.org', addresses: ['192.168.120.105'] });
  assert.deepEqual(ok.map(c => [c.id, c.status]), [['ip', 'ok'], ['subnet', 'ok'], ['dns', 'ok']]);

  const otherNet = { ...id, event: { ...event2026, gateway: '192.168.121.1' } };
  assert.equal(networkChecks('192.168.120.105', otherNet).find(c => c.id === 'subnet')?.status, 'warn');
  assert.equal(networkChecks('192.168.120.105', id, { name: 'joy.lan.example.org', addresses: null }).find(c => c.id === 'dns')?.status, 'warn');
  assert.equal(networkChecks('192.168.120.105', id, { name: 'joy.lan.example.org', addresses: ['192.168.120.9'] }).find(c => c.id === 'dns')?.status, 'warn');
  // Not checked (no DNS server reachable): no DNS entry at all
  assert.equal(networkChecks('192.168.120.105', id).some(c => c.id === 'dns'), false);
});

test('IP identification is on by default and can be switched off', () => {
  assert.equal(validateEventSettings({ name: 'x', ranges: DEFAULT_RANGES }).ip_identification, true);
  assert.equal(validateEventSettings({ name: 'x', ip_identification: false, ranges: DEFAULT_RANGES }).ip_identification, false);
});

test('the identified attendee carries the admin flag (used for the login by IP)', () => {
  const orga = { ...attendee(4, 2, 'Orga', 7), admin: true };
  assert.equal(identify('192.168.120.107', [event2026], [...attendees, orga], now).attendee?.admin, true);
  assert.equal(identify('192.168.120.105', [event2026], [...attendees, orga], now).attendee?.admin, false);
  // Switched-off IP identification also means no admin by IP
  assert.equal(identify('192.168.120.107', [{ ...event2026, ip_identification: false }], [orga], now).attendee, null);
});
