import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import { MAX_ATTENDEE_SHARES, normalizeSharePath, validateAttendeeShares, validateEventShares } from './shares';

// db.ts reads DATA_DIR on import, so point it to a temp dir first
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcd-brackets-shares-'));

test('share paths are normalized to "share/folder"', () => {
  assert.equal(normalizeSharePath('\\\\games\\steam\\'), 'games/steam');
  assert.equal(normalizeSharePath(' /Filme / Neu/ '), 'Filme/Neu');
});

test('attendee shares are validated', () => {
  const [share] = validateAttendeeShares([{ id: 'abc', path: 'games', username: 'WORKGROUP\\gast', password: ' geheim ', range_index: 2, label: ' Spiele ' }]);
  assert.deepEqual(share, { id: 'abc', label: 'Spiele', path: 'games', username: 'WORKGROUP\\gast', password: ' geheim ', range_index: 2 });

  // New shares get an ID, missing PC = main PC
  const [fresh] = validateAttendeeShares([{ path: 'daten' }]);
  assert.match(fresh.id, /^[0-9a-f-]{36}$/);
  assert.equal(fresh.range_index, 0);

  assert.deepEqual(validateAttendeeShares(undefined), []);
  assert.throws(() => validateAttendeeShares([{ path: '' }]), /Freigabename fehlt/);
  assert.throws(() => validateAttendeeShares([{ path: 'a:b' }]), /darf keine/);
  assert.throws(() => validateAttendeeShares([{ path: '100%' }]), /darf keine/);
  assert.throws(() => validateAttendeeShares([{ path: 'a', username: 'x', password: 'ab"c' }]), /kein "/);
  assert.throws(() => validateAttendeeShares([{ path: 'a', username: '%USERNAME%' }]), /kein %/);
  assert.throws(() => validateAttendeeShares([{ path: 'a', password: 'nur-passwort' }]), /Benutzername/);
  assert.throws(() => validateAttendeeShares([{ path: 'a', range_index: 3 }]), /ungültiger PC/);
  assert.throws(() => validateAttendeeShares({}), /Liste/);
  assert.throws(() => validateAttendeeShares(Array.from({ length: MAX_ATTENDEE_SHARES + 1 }, () => ({ path: 'a' }))), /Höchstens/);
});

test('event shares need a server: IPv4 or DNS name', () => {
  assert.equal(validateEventShares([{ host: '192.168.120.5', path: 'iso' }])[0].host, '192.168.120.5');
  assert.equal(validateEventShares([{ host: ' NAS.lan.example.org. ', path: 'iso' }])[0].host, 'nas.lan.example.org');
  assert.throws(() => validateEventShares([{ path: 'iso' }]), /Server fehlt/);
  assert.throws(() => validateEventShares([{ host: 'nas_01', path: 'iso' }]), /ungültiger Server/);
});

test('shares are stored with attendee and event and survive other changes', async () => {
  const db: typeof import('./db') = require('./db');
  const store: typeof import('./lan-store') = require('./lan-store');
  await db.ensureAppTables();

  const event = await store.createEvent({ name: 'Shares 2026' });
  const a = await store.addAttendee(event.id, { nickname: 'lordimac' });
  assert.deepEqual(a.shares, []);

  await store.setAttendeeShares(a.id, [{ path: 'games', range_index: 1 }]);
  await store.updateAttendee(a.id, { nickname: 'lordimac2', first_name: '', last_name: '' });
  const [view] = await store.listAttendeeViews(event.id);
  assert.equal(view.shares[0].path, 'games');

  await store.setEventShares(event.id, [{ host: '192.168.120.5', path: 'iso' }]);
  const updated = await store.updateEvent(event.id, { netmask: '255.255.255.0' });
  assert.equal(updated.shares?.[0].path, 'iso');

  // A new event takes over the fixed shares (with new IDs), imported attendees come without shares
  const next = await store.createEvent({ name: 'Shares 2027' });
  assert.equal(next.shares?.[0].path, 'iso');
  assert.notEqual(next.shares?.[0].id, updated.shares?.[0].id);
  await store.importAttendees(next.id, event.id);
  assert.deepEqual((await store.listAttendeeViews(next.id))[0].shares, []);
});

test('attendees may only change the shares of their own PCs', async () => {
  const express: typeof import('express') = require('express');
  const store: typeof import('./lan-store') = require('./lan-store');
  const { shareRouter }: typeof import('./share-routes') = require('./share-routes');
  const { HttpError }: typeof import('./http-error') = require('./http-error');

  // The test client connects from 127.0.0.1: slot 0 of this event
  const event = await store.createEvent({
    name: 'Shares Loopback',
    ranges: [{ start: '127.0.0.1', end: '127.0.0.20' }, { start: '127.0.1.1', end: '127.0.1.20' }, { start: '127.0.2.1', end: '127.0.2.20' }],
  });
  const own = await store.addAttendee(event.id, { nickname: 'Ich' });
  const other = await store.addAttendee(event.id, { nickname: 'Andere' });

  const app = express();
  app.use(express.json());
  app.use('/api', shareRouter);
  app.use((error: Error, _req: import('express').Request, res: import('express').Response, _next: import('express').NextFunction) => {
    res.status(error instanceof HttpError ? error.status : 500).json({ error: error.message });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const put = (url: string) => fetch(`${base}${url}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shares: [{ path: 'games' }] }),
  });

  const previous = process.env.ADMIN_PASSWORD;
  process.env.ADMIN_PASSWORD = 'geheim';
  try {
    assert.equal((await put(`/attendees/${own.id}/shares`)).status, 200);
    assert.equal((await put(`/attendees/${other.id}/shares`)).status, 403);
  } finally {
    if (previous === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = previous;
    server.close();
  }
  assert.equal((await store.listAttendeeViews(event.id)).find(a => a.id === own.id)?.shares[0].path, 'games');
});
