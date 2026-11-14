import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import type { AddressInfo } from 'net';
import {
  applyImport, containerFor, containerHost, createDockhandClient, detectGame, dockhandView, EMPTY_DOCKHAND, importCandidate, itemView, planItem,
  validateDockhandSettings, type DockhandContainer,
} from './dockhand';
import { validateServers } from './gameservers';

const container = (fields: Partial<DockhandContainer> & { name: string; image: string }): DockhandContainer => ({
  id: 'a1b2c3d4e5f6a1b2c3d4e5f6', state: 'running', status: 'Up 2 hours', ports: [], networks: {}, labels: {}, command: '', ...fields,
});

test('settings: token kept, never shown, must look like a Dockhand token', () => {
  const saved = validateDockhandSettings({ url: '192.168.120.2:3000/', token: 'dh_abcdefghijklmnopqrstuvwxyz', env_id: '1' }, EMPTY_DOCKHAND);
  assert.deepEqual(saved, { url: 'http://192.168.120.2:3000', token: 'dh_abcdefghijklmnopqrstuvwxyz', env_id: 1, insecure_tls: false });
  const again = validateDockhandSettings({ url: 'https://dockhand.lan', token: '', env_id: 2, insecure_tls: true }, saved);
  assert.equal(again.token, saved.token);
  const view = dockhandView(again);
  assert.equal(JSON.stringify(view).includes('dh_'), false);
  assert.equal(view.configured, true);
  assert.throws(() => validateDockhandSettings({ url: 'x', token: 'secret' }, EMPTY_DOCKHAND), /dh_/);
});

test('game detection: label wins, then image, then container name', () => {
  assert.deepEqual(detectGame(container({ name: 'x', image: 'joedwards32/cs2:latest' })), { game: 'cs2', by: 'image' });
  assert.deepEqual(detectGame(container({ name: 'x', image: 'nginx', labels: { 'mcd.game': 'cod4' } })), { game: 'cod4', by: 'label' });
  assert.equal(detectGame(container({ name: 'x', image: 'someone/ut2004-server' }))?.game, 'ut2004');
  assert.equal(detectGame(container({ name: 'x', image: 'roemer/ut99-server' }))?.game, 'ut99');
  assert.equal(detectGame(container({ name: 'x', image: 'oitc/ioquake3' }))?.game, 'q3');
  assert.equal(detectGame(container({ name: 'cod2-sd', image: 'ghcr.io/me/gameserver' }))?.game, 'cod2');
  assert.equal(detectGame(container({ name: 'dockhand', image: 'fnsys/dockhand' })), null);
});

test('host: label, else macvlan network, else outside the Docker bridge range', () => {
  assert.equal(containerHost(container({ name: 'x', image: 'y', networks: { bridge: { ipAddress: '172.17.0.5' }, lan_macvlan: { ipAddress: '192.168.120.31' } } })), '192.168.120.31');
  assert.equal(containerHost(container({ name: 'x', image: 'y', networks: { games: { ipAddress: '172.18.0.2' }, lan: { ipAddress: '10.10.0.40' } } })), '10.10.0.40');
  assert.equal(containerHost(container({ name: 'x', image: 'y', networks: { lan: { ipAddress: '10.10.0.40' } }, labels: { 'mcd.host': 'cs2.lan.example' } })), 'cs2.lan.example');
  assert.equal(containerHost(container({ name: 'x', image: 'y', networks: { host: { ipAddress: '' } } })), '');
});

test('candidate: port and RCON password from env, start parameters, UDP ports', () => {
  const cs2 = importCandidate(container({ name: 'cs2-wingman', image: 'joedwards32/cs2', networks: { macvlan: { ipAddress: '192.168.120.31' } } }), { CS2_PORT: '27016', CS2_RCONPW: 'geheim' });
  assert.equal(cs2.game, 'cs2');
  assert.equal(cs2.port, 27016);
  assert.equal(cs2.rcon_password, 'geheim');
  assert.equal(cs2.name, 'cs2-wingman');

  const cod = importCandidate(container({ name: 'cod4', image: 'me/cod4x', command: '/cod4x +set net_port 28961 +set rcon_password "pw1" +map_rotate' }), null);
  assert.equal(cod.port, 28961);
  assert.equal(cod.rcon_password, 'pw1');
  assert.equal(cod.env_read, false);

  const q3 = importCandidate(container({ name: 'q3', image: 'ioquake3', ports: [{ PrivatePort: 27960, Type: 'udp' }] }), {});
  assert.equal(q3.port, null, 'default port stays the default');

  const ut = importCandidate(container({ name: 'ut', image: 'ut2004-server', ports: [{ PrivatePort: 7787, Type: 'udp' }, { PrivatePort: 7777, Type: 'udp' }, { PrivatePort: 7778, Type: 'udp' }], labels: { 'mcd.webadmin_port': '8075' } }), { ADMIN_PASSWORD: 'utpw', RCON_PASSWORD: 'ignored' });
  assert.equal(ut.port, null);
  assert.equal(ut.rcon_password, '', 'UT has no RCON');
  assert.equal(ut.webadmin_password, 'utpw');
  assert.equal(ut.webadmin_user, 'admin');
  assert.equal(ut.webadmin_port, 8075);

  assert.equal(importCandidate(container({ name: 'q', image: 'ioquake3' }), { RCON_PASSWORD: 'with"quote' }).rcon_password, '', 'unusable passwords are left out');
});

test('plan: create, update by container name, unchanged, unknown; apply keeps the rest', () => {
  const [linked, manual] = validateServers([
    { id: 'cod', game: 'cod4', name: 'CoD4 Promod', host: '192.168.120.30', container: { id: '0123456789ab', name: 'cod4' }, info: 'S&D' },
    { id: 'old', game: 'q3', host: '192.168.120.40', rcon_password: 'keep' },
  ]);
  const servers = [linked, manual];

  // compose re-created the container: new ID and new IP, same name
  const moved = importCandidate(container({ id: 'ffffffffffff', name: 'cod4', image: 'cod4x', networks: { macvlan: { ipAddress: '192.168.120.33' } } }), { RCON_PASSWORD: 'neu' });
  const update = planItem(moved, servers);
  assert.equal(update.action, 'update');
  assert.equal(update.server_id, 'cod');
  assert.ok(update.changes.includes('Adresse 192.168.120.30 → 192.168.120.33'));
  assert.ok(update.changes.includes('RCON-Passwort aus dem Container'));

  // A manually created server is found by address + port and gets linked
  const q3 = planItem(importCandidate(container({ id: 'eeeeeeeeeeee', name: 'quake', image: 'ioquake3', networks: { macvlan: { ipAddress: '192.168.120.40' } } }), {}), servers);
  assert.equal(q3.action, 'update');
  assert.deepEqual(q3.changes, ['mit Container verknüpft']);

  const fresh = planItem(importCandidate(container({ id: 'dddddddddddd', name: 'cs2', image: 'joedwards32/cs2', networks: { macvlan: { ipAddress: '192.168.120.31' } } }), { CS2_RCONPW: 'x' }), servers);
  assert.equal(fresh.action, 'create');
  assert.equal(planItem(importCandidate(container({ name: 'nginx', image: 'nginx' }), null), servers).action, 'unknown');
  assert.equal(planItem(importCandidate(container({ name: 'cs2b', image: 'cs2' }), null), servers).action, 'no-host');

  const view = itemView(fresh);
  assert.equal(JSON.stringify(view).includes('"x"'), false, 'no passwords in the preview');
  assert.equal(view.candidate.has_rcon_password, true);

  const next = validateServers(applyImport([update, q3, fresh], servers), servers);
  assert.equal(next.length, 3);
  const cod = next.find(s => s.id === 'cod')!;
  assert.equal(cod.host, '192.168.120.33');
  assert.equal(cod.rcon_password, 'neu');
  assert.equal(cod.name, 'CoD4 Promod', 'own name and note stay');
  assert.equal(cod.info, 'S&D');
  assert.deepEqual(cod.container, { id: 'ffffffffffff', name: 'cod4' });
  assert.equal(next.find(s => s.id === 'old')!.rcon_password, 'keep', 'no password in the container keeps the stored one');
  const created = next.find(s => s.game === 'cs2')!;
  assert.equal(created.name, 'cs2');
  assert.equal(created.rcon_password, 'x');

  assert.equal(containerFor(cod, [container({ id: 'ffffffffffff', name: 'cod4', image: 'cod4x' })])?.id, 'ffffffffffff');
});

test('client: bearer token, environments, containers, inspect, actions, errors', async () => {
  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    calls.push(`${req.method} ${req.url} ${req.headers.authorization}`);
    if (req.headers.authorization !== 'Bearer dh_validtoken123') {
      res.writeHead(401).end(JSON.stringify({ error: 'Authentication required' }));
      return;
    }
    const url = new URL(req.url!, 'http://x');
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/api/environments') res.end(JSON.stringify([{ id: 1, name: 'gamehost' }]));
    else if (url.pathname === '/api/containers' && url.searchParams.get('env') === '1') res.end(JSON.stringify([{ id: 'abc123abc123', name: 'cs2', image: 'joedwards32/cs2', state: 'running', status: 'Up', ports: [], networks: { macvlan: { ipAddress: '192.168.120.31' } }, labels: {} }]));
    else if (url.pathname === '/api/containers/abc123abc123/inspect') res.end(JSON.stringify({ Config: { Env: ['CS2_RCONPW=geheim', 'PATH=/usr/bin', 'EMPTY='] } }));
    else if (url.pathname === '/api/containers/locked/inspect') res.writeHead(403).end(JSON.stringify({ error: 'Permission denied' }));
    else if (url.pathname === '/api/containers/abc123abc123/restart' && req.method === 'POST') res.end(JSON.stringify({ success: true }));
    else if (url.pathname === '/api/containers/abc123abc123/stop') res.writeHead(403).end(JSON.stringify({ error: 'Permission denied' }));
    else res.writeHead(404).end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const client = createDockhandClient({ url, token: 'dh_validtoken123', env_id: 1, insecure_tls: false });
    assert.deepEqual(await client.environments(), [{ id: 1, name: 'gamehost' }]);
    const [cs2] = await client.containers();
    assert.equal(cs2.name, 'cs2');
    assert.deepEqual(await client.environment('abc123abc123'), { CS2_RCONPW: 'geheim', PATH: '/usr/bin', EMPTY: '' });
    assert.equal(await client.environment('locked'), null, 'no inspect permission: continue without env');
    await client.action('abc123abc123', 'restart');
    await assert.rejects(client.action('abc123abc123', 'stop'), /Berechtigung, Container zu stoppen/);
    await assert.rejects(createDockhandClient({ url, token: 'dh_wrongtoken000', env_id: 1, insecure_tls: false }).environments(), /Token ungültig/);
    await assert.rejects(createDockhandClient({ url, token: 'dh_validtoken123', env_id: null, insecure_tls: false }).containers(), /keine Docker-Umgebung/);
    assert.ok(calls.some(c => c.startsWith('POST /api/containers/abc123abc123/restart?env=1')));
  } finally {
    server.close();
  }
});
