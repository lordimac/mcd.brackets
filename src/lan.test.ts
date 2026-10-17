import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertUniqueAttendee, DEFAULT_RANGES, describeAttendee, eventCapacity, exportBindZone, exportCsv,
  displayName, exportHosts, formatIPv4, isValidNetmask, nextFreeSlot, parseBulkLine, parseIPv4, splitClanNickname, toHostname, validateAttendee, validateEventSettings,
  ValidationError, type Attendee, type LanEvent,
} from './lan';

const event: LanEvent = { id: 1, name: 'mcd.lan 2026', domain: 'lan.example.org', dns_server: '192.168.120.1', netmask: '255.255.255.0', gateway: '192.168.120.1', logo: '', ranges: DEFAULT_RANGES };

function attendee(nickname: string, slot: number, extra: Partial<Attendee> = {}): Attendee {
  return { id: slot, event_id: 1, first_name: 'Max', last_name: 'Muster', clan: '', nickname, hostname: toHostname(nickname), slot, ...extra };
}

test('IPv4 parsing and formatting', () => {
  assert.equal(parseIPv4('192.168.120.100'), 3232266340);
  assert.equal(formatIPv4(3232266340), '192.168.120.100');
  assert.equal(formatIPv4(parseIPv4('10.0.0.255')! + 1), '10.0.1.0');
  for (const invalid of ['192.168.1', '256.1.1.1', '1.2.3.x', '', '1.2.3.4.5']) {
    assert.equal(parseIPv4(invalid), null, invalid);
  }
});

test('default ranges give 50 slots: .100/.150/.200 for the first attendee', () => {
  assert.equal(eventCapacity(event), 50);
  const view = describeAttendee(event, attendee('lordimac', 0));
  assert.deepEqual(view.ips, ['192.168.120.100', '192.168.120.150', '192.168.120.200']);
  assert.deepEqual(view.dns_names, ['lordimac.lan.example.org', 'lordimac2.lan.example.org', 'lordimac3.lan.example.org']);
  assert.deepEqual(describeAttendee(event, attendee('x', 49)).ips, ['192.168.120.149', '192.168.120.199', '192.168.120.249']);
});

test('DNS names without domain are plain hostnames', () => {
  assert.deepEqual(describeAttendee({ ...event, domain: '' }, attendee('nick', 0)).dns_names, ['nick', 'nick2', 'nick3']);
});

test('toHostname makes nicknames DNS-safe', () => {
  assert.equal(toHostname('LordiMac'), 'lordimac');
  assert.equal(toHostname('Größenwahn'), 'groessenwahn');
  assert.equal(toHostname('[MCD] Frag Master!'), 'mcd-frag-master');
  assert.equal(toHostname('Zoë_99'), 'zoe-99');
  assert.equal(toHostname('---'), '');
  assert.ok(toHostname('a'.repeat(80)).length <= 60);
});

test('validateAttendee requires a nickname that yields a hostname', () => {
  assert.deepEqual(validateAttendee({ first_name: ' Max ', last_name: 'Muster', nickname: ' Frag ' }),
    { first_name: 'Max', last_name: 'Muster', clan: '', nickname: 'Frag', hostname: 'frag' });
  assert.equal(validateAttendee({ clan: ' M4E ', nickname: 'lordimac' }).clan, 'M4E');
  assert.throws(() => validateAttendee({ nickname: '  ' }), ValidationError);
  assert.throws(() => validateAttendee({ nickname: '!!!' }), ValidationError);
});

test('nicknames and derived DNS names must be unique within an event', () => {
  const others = [attendee('Frag', 0)];
  assert.throws(() => assertUniqueAttendee({ clan: 'M4E', nickname: 'frag', hostname: 'frag' }, others), /schon vergeben/);
  // "frag2" would collide with the second name of "Frag"
  assert.throws(() => assertUniqueAttendee({ clan: '', nickname: 'Frag2', hostname: 'frag2' }, others), /kollidiert/);
  assert.doesNotThrow(() => assertUniqueAttendee({ clan: '', nickname: 'Fragger', hostname: 'fragger' }, others));
  // Same display name from a different clan/nickname split
  const clanned = [attendee('b-c', 0, { clan: 'A', hostname: 'b-c' })];
  assert.throws(() => assertUniqueAttendee({ clan: 'A-b', nickname: 'c', hostname: 'c' }, clanned), /A-b-c/);
});

test('nextFreeSlot fills gaps first and reports a full event', () => {
  assert.equal(nextFreeSlot([], 50), 0);
  assert.equal(nextFreeSlot([0, 1, 3], 50), 2);
  assert.equal(nextFreeSlot([0, 1], 2), null);
});

test('validateEventSettings normalizes and rejects invalid settings', () => {
  const ok = validateEventSettings({ name: ' LAN ', domain: 'LAN.Example.org.', dns_server: '', ranges: DEFAULT_RANGES });
  assert.equal(ok.name, 'LAN');
  assert.equal(ok.domain, 'lan.example.org');

  const ranges = (r: [string, string][]) => r.map(([start, end]) => ({ start, end }));
  assert.throws(() => validateEventSettings({ name: '', ranges: DEFAULT_RANGES }), /Name/);
  assert.throws(() => validateEventSettings({ name: 'x', domain: 'bad_domain', ranges: DEFAULT_RANGES }), /Domain/);
  assert.throws(() => validateEventSettings({ name: 'x', ranges: DEFAULT_RANGES.slice(0, 2) }), /genau 3/);
  assert.throws(() => validateEventSettings({ name: 'x', ranges: ranges([['10.0.0.10', '10.0.0.5'], ['10.0.1.1', '10.0.1.9'], ['10.0.2.1', '10.0.2.9']]) }), /Ende/);
  assert.throws(() => validateEventSettings({ name: 'x', ranges: ranges([['10.0.0.1', '10.0.0.50'], ['10.0.0.40', '10.0.0.90'], ['10.0.2.1', '10.0.2.9']]) }), /überschneiden/);
  // Shrinking below an already used slot is rejected
  assert.throws(() => validateEventSettings({ name: 'x', ranges: ranges([['10.0.0.1', '10.0.0.5'], ['10.0.1.1', '10.0.1.5'], ['10.0.2.1', '10.0.2.5']]) }, [7]), /nur 5 Plätze/);
});

test('exports contain all three addresses per attendee', () => {
  const attendees = [attendee('B; "x"', 1), attendee('lordimac', 0)];

  const csv = exportCsv(event, attendees);
  assert.ok(csv.startsWith('\uFEFFClan-Nickname;Clan;Nickname;Vorname;Name;'));
  const lines = csv.trim().split('\r\n');
  assert.equal(lines.length, 3);
  assert.ok(lines[1].startsWith('lordimac;;lordimac;Max;Muster;192.168.120.100;192.168.120.150;192.168.120.200;lordimac.lan.example.org'));
  assert.ok(lines[2].startsWith('"B; ""x""";'));

  const hosts = exportHosts(event, attendees);
  assert.match(hosts, /^192\.168\.120\.100\tlordimac\.lan\.example\.org\tlordimac$/m);
  assert.match(hosts, /^192\.168\.120\.200\tlordimac3\.lan\.example\.org\tlordimac3$/m);

  const zone = exportBindZone(event, attendees, new Date(2026, 9, 17));
  assert.match(zone, /^\$ORIGIN lan\.example\.org\.$/m);
  assert.match(zone, /2026101701 ; serial/);
  assert.match(zone, /^ns\tIN\tA\t192\.168\.120\.1$/m);
  assert.match(zone, /^lordimac2\tIN\tA\t192\.168\.120\.150$/m);
  assert.match(zone, /^b-x3\tIN\tA\t192\.168\.120\.201$/m);

  assert.doesNotMatch(exportBindZone({ ...event, dns_server: '' }, attendees), /SOA/);
  assert.throws(() => exportBindZone({ ...event, domain: '' }, attendees), /Domain/);
});

test('parseBulkLine reads "Nachname, Vorname // Clan-Nickname"', () => {
  assert.deepEqual(parseBulkLine('Imhoff, Marc // M4E-lordimac'), { last_name: 'Imhoff', first_name: 'Marc', clan: 'M4E', nickname: 'lordimac' });
  assert.deepEqual(parseBulkLine('  von Berg ,  Anna-Lena//CML-anna '), { last_name: 'von Berg', first_name: 'Anna-Lena', clan: 'CML', nickname: 'anna' });
  assert.deepEqual(parseBulkLine('// Gast'), { last_name: '', first_name: '', clan: '', nickname: 'Gast' });
  assert.throws(() => parseBulkLine('Imhoff, Marc M4E-lordimac'), /„\/\/“/);
  assert.throws(() => parseBulkLine('Imhoff Marc // lordimac'), /Komma/);
  assert.throws(() => parseBulkLine('Imhoff, Marc //  '), /Nickname fehlt/);
});

test('clan and nickname: split at the first hyphen, shown as "Clan-Nickname"', () => {
  assert.deepEqual(splitClanNickname('G3.SQUAD-joy'), { clan: 'G3.SQUAD', nickname: 'joy' });
  assert.deepEqual(splitClanNickname('M4E-n00b-slayer'), { clan: 'M4E', nickname: 'n00b-slayer' });
  assert.deepEqual(splitClanNickname('Pixel'), { clan: '', nickname: 'Pixel' });
  assert.deepEqual(splitClanNickname('-weird'), { clan: '', nickname: '-weird' });
  assert.deepEqual(splitClanNickname('trailing-'), { clan: '', nickname: 'trailing-' });

  assert.equal(displayName({ clan: 'M4E', nickname: 'lordimac' }), 'M4E-lordimac');
  assert.equal(displayName({ clan: '', nickname: 'Pixel' }), 'Pixel');
  // DNS names come from the nickname only
  const view = describeAttendee(event, attendee('lordimac', 0, { clan: 'M4E' }));
  assert.equal(view.display_name, 'M4E-lordimac');
  assert.equal(view.dns_names[0], 'lordimac.lan.example.org');
});

test('netmask and gateway are optional and validated', () => {
  for (const mask of ['255.255.255.0', '255.255.0.0', '255.255.255.252', '255.255.254.0', '255.255.255.255']) {
    assert.ok(isValidNetmask(mask), mask);
  }
  for (const mask of ['255.0.255.0', '255.255.255.1', '0.0.0.0', '24', '255.255.255']) {
    assert.ok(!isValidNetmask(mask), mask);
  }
  const ok = validateEventSettings({ name: 'x', netmask: ' 255.255.255.0 ', gateway: '192.168.120.1', ranges: DEFAULT_RANGES });
  assert.equal(ok.netmask, '255.255.255.0');
  assert.equal(ok.gateway, '192.168.120.1');
  assert.equal(validateEventSettings({ name: 'x', ranges: DEFAULT_RANGES }).netmask, '');
  assert.throws(() => validateEventSettings({ name: 'x', netmask: '255.0.255.0', ranges: DEFAULT_RANGES }), /Subnetzmaske/);
  assert.throws(() => validateEventSettings({ name: 'x', gateway: '192.168.1', ranges: DEFAULT_RANGES }), /Gateway/);
});

test('logo is an optional PNG/JPEG data URL', () => {
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  assert.equal(validateEventSettings({ name: 'x', logo: png, ranges: DEFAULT_RANGES }).logo, png);
  assert.equal(validateEventSettings({ name: 'x', logo: '', ranges: DEFAULT_RANGES }).logo, '');
  assert.throws(() => validateEventSettings({ name: 'x', logo: 'data:image/svg+xml;base64,PHN2Zz4=', ranges: DEFAULT_RANGES }), /PNG/);
  assert.throws(() => validateEventSettings({ name: 'x', logo: 'https://example.org/logo.png', ranges: DEFAULT_RANGES }), /PNG/);
  assert.throws(() => validateEventSettings({ name: 'x', logo: 'data:image/png;base64,' + 'A'.repeat(2_000_000), ranges: DEFAULT_RANGES }), /zu groß/);
});
