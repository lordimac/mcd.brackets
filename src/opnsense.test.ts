import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Attendee, LanEvent } from './lan';
import {
  applyPlan, createOpnsenseClient, desiredRecords, EMPTY_SETTINGS, planSync, settingsView, validateSettings,
  type HostOverrideRow,
} from './opnsense';

const event: LanEvent = {
  id: 3, name: 'Demo-LAN', domain: 'lan.example', dns_server: '', netmask: '', gateway: '', logo: '', starts_on: '', ends_on: '', wifi_enabled: false, wifi_ssid: '', wifi_password: '', memorial: [],
  ranges: [
    { start: '192.168.120.100', end: '192.168.120.149' },
    { start: '192.168.120.150', end: '192.168.120.199' },
    { start: '192.168.120.200', end: '192.168.120.249' },
  ],
};

const attendee = (id: number, nickname: string, slot: number, clan = ''): Attendee =>
  ({ id, event_id: event.id, first_name: '', last_name: '', clan, nickname, hostname: nickname.toLowerCase(), slot });

test('settings: address is normalized, the secret is kept and never shown', () => {
  const saved = validateSettings({ url: '192.168.120.1/api/', api_key: ' key ', api_secret: 'secret', insecure_tls: true }, EMPTY_SETTINGS);
  assert.deepEqual(saved, { url: 'https://192.168.120.1', api_key: 'key', api_secret: 'secret', insecure_tls: true });

  const again = validateSettings({ url: 'https://fw.lan:8443', api_key: 'key', api_secret: '' }, saved);
  assert.equal(again.api_secret, 'secret', 'an empty secret keeps the stored one');
  assert.equal(again.url, 'https://fw.lan:8443');

  const view = settingsView(again);
  assert.equal('api_secret' in view, false);
  assert.equal(view.has_secret, true);
  assert.equal(view.configured, true);

  assert.throws(() => validateSettings({ url: 'ftp://fw' }, EMPTY_SETTINGS), /https/);
});

test('desired records: three names per attendee with the event marker', () => {
  const records = desiredRecords(event, [attendee(1, 'Maxi', 0, 'MCD')]);
  assert.deepEqual(records.map(r => [r.hostname, r.domain, r.server]), [
    ['maxi', 'lan.example', '192.168.120.100'],
    ['maxi2', 'lan.example', '192.168.120.150'],
    ['maxi3', 'lan.example', '192.168.120.200'],
  ]);
  assert.equal(records[0].description, 'mcd-brackets #3: MCD-Maxi (Haupt-PC)');
  assert.throws(() => desiredRecords({ ...event, domain: '' }, []), /Domain/);
});

test('plan: create, keep, update, delete, take over and leave foreign entries alone', () => {
  const desired = desiredRecords(event, [attendee(1, 'Maxi', 0), attendee(2, 'Nova', 1)]);
  const ours = (uuid: string, hostname: string, server: string, eventId = 3, label = 'Haupt-PC', name = 'Maxi'): HostOverrideRow =>
    ({ uuid, enabled: '1', hostname, domain: 'lan.example', rr: 'A', server, description: `mcd-brackets #${eventId}: ${name} (${label})` });

  const rows: HostOverrideRow[] = [
    ours('u1', 'maxi', '192.168.120.100'),                                  // unchanged
    ours('u2', 'maxi2', '192.168.120.199', 3, 'Zweiter PC'),                // wrong IP → update
    ours('u3', 'oldnick', '192.168.120.120'),                               // no longer wanted → delete
    ours('u4', 'nova', '192.168.120.101', 1, 'Haupt-PC', 'Nova'),           // last year's event → take over
    ours('u5', 'gonzo', '192.168.120.130', 1),                              // other event, not wanted → untouched
    { uuid: 'f1', enabled: '1', hostname: 'nova2', domain: 'lan.example', rr: 'A', server: '10.0.0.5', description: 'Drucker' }, // foreign → conflict
    { uuid: 'f2', enabled: '1', hostname: 'router', domain: 'lan.example', rr: 'A', server: '192.168.120.1', description: '',
      _children: [{ uuid: 'a1', isAlias: true, hostname: 'nova3', domain: 'lan.example', description: '' }] }, // alias → conflict
    ours('u6', 'maxi', '192.168.120.100'),                                  // duplicate → delete
  ];
  // Fix the description of u1 so it is really unchanged
  rows[0].description = desired[0].description;

  const plan = planSync(event.id, desired, rows, 'sync');
  const byName = (name: string) => plan.items.filter(i => i.name === `${name}.lan.example`).map(i => i.action);

  assert.deepEqual(byName('maxi'), ['unchanged', 'delete']);
  assert.deepEqual(byName('maxi2'), ['update']);
  assert.deepEqual(byName('maxi3'), ['create']);
  assert.deepEqual(byName('oldnick'), ['delete']);
  assert.deepEqual(byName('nova'), ['update']);
  assert.match(plan.items.find(i => i.name === 'nova.lan.example')!.note!, /Event #1/);
  assert.deepEqual(byName('nova2'), ['conflict']);
  assert.deepEqual(byName('nova3'), ['conflict']);
  assert.deepEqual(byName('gonzo'), []);
  assert.deepEqual(byName('router'), []);
  assert.deepEqual(plan.counts, { create: 1, update: 2, delete: 2, conflict: 2, unchanged: 1 });

  // Remove mode deletes only this event's entries
  const removal = planSync(event.id, [], rows, 'remove');
  assert.deepEqual(removal.items.map(i => i.uuid).sort(), ['u1', 'u2', 'u3', 'u6']);
});

// Minimal stand-in for the OPNsense API (paths, payloads and answers as in OPNsense 26.7)
function fakeOpnsense() {
  const hosts = new Map<string, HostOverrideRow>();
  const calls: string[] = [];
  let nextId = 1;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      const send = (status: number, data: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (req.headers.authorization !== 'Basic ' + Buffer.from('key:secret').toString('base64')) return send(401, { status: 401 });
      const path = req.url ?? '';
      calls.push(path);
      const input = body ? JSON.parse(body) : {};
      if (path === '/api/unbound/settings/search_host_override') return send(200, { rows: [...hosts.values()], rowCount: hosts.size, total: hosts.size, current: 1 });
      if (path === '/api/unbound/settings/add_host_override') {
        if (!input.host?.server) return send(200, { result: 'failed', validations: { 'host.server': 'The field IP address is required.' } });
        const uuid = `uuid-${nextId++}`;
        hosts.set(uuid, { uuid, ...input.host });
        return send(200, { result: 'saved', uuid });
      }
      const set = path.match(/^\/api\/unbound\/settings\/set_host_override\/(.+)$/);
      if (set) { hosts.set(set[1], { ...hosts.get(set[1]), uuid: set[1], ...input.host }); return send(200, { result: 'saved' }); }
      const del = path.match(/^\/api\/unbound\/settings\/del_host_override\/(.+)$/);
      if (del) return send(200, { result: hosts.delete(del[1]) ? 'deleted' : 'not found' });
      if (path === '/api/unbound/service/reconfigure') return send(200, { status: 'ok' });
      send(404, {});
    });
  });
  return { server, hosts, calls };
}

test('client: full sync against the API, second run changes nothing', async () => {
  const fake = fakeOpnsense();
  fake.hosts.set('manual', { uuid: 'manual', enabled: '1', hostname: 'maxi', domain: 'lan.example', rr: 'A', server: '10.0.0.9', description: 'von Hand' });
  await new Promise<void>(resolve => fake.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
  try {
    await assert.rejects(createOpnsenseClient({ url, api_key: 'key', api_secret: 'wrong', insecure_tls: false }).searchHosts(), /API-Key oder Secret/);

    const client = createOpnsenseClient({ url, api_key: 'key', api_secret: 'secret', insecure_tls: false });
    const desired = desiredRecords(event, [attendee(1, 'Maxi', 0), attendee(2, 'Nova', 1)]);

    const first = await applyPlan(client, planSync(event.id, desired, await client.searchHosts(), 'sync'));
    assert.deepEqual({ ...first, errors: first.errors.length }, { created: 5, updated: 0, deleted: 0, conflicts: 1, errors: 0, reconfigured: true });
    assert.equal(fake.hosts.get('manual')!.server, '10.0.0.9', 'manual entries stay untouched');
    assert.equal(fake.calls.at(-1), '/api/unbound/service/reconfigure');

    const second = planSync(event.id, desired, await client.searchHosts(), 'sync');
    assert.deepEqual(second.counts, { create: 0, update: 0, delete: 0, conflict: 1, unchanged: 5 });
    const callsBefore = fake.calls.length;
    const noop = await applyPlan(client, second);
    assert.equal(noop.reconfigured, false);
    assert.equal(fake.calls.length, callsBefore, 'nothing to do → no API calls');

    // Removing the event's entries leaves only the manual one
    await applyPlan(client, planSync(event.id, [], await client.searchHosts(), 'remove'));
    assert.deepEqual([...fake.hosts.keys()], ['manual']);

    // Validation errors of OPNsense are reported per entry
    const broken = await applyPlan(client, { items: [{ action: 'create', name: 'x.lan.example', server: '', record: { hostname: 'x', domain: 'lan.example', server: '', description: '' } }], counts: { create: 1, update: 0, delete: 0, conflict: 0, unchanged: 0 } });
    assert.deepEqual(broken.errors, [{ name: 'x.lan.example', error: 'The field IP address is required.' }]);
  } finally {
    fake.server.close();
  }
});
