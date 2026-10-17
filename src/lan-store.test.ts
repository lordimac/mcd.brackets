import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// db.ts reads DATA_DIR on import, so point it to a temp dir first
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcd-brackets-lan-'));

const db: typeof import('./db') = require('./db');
const store: typeof import('./lan-store') = require('./lan-store');
const stages: typeof import('./stages') = require('./stages');

test('attendees get slots, play in tournaments and renames propagate', async () => {
  await db.ensureAppTables();

  const event = await store.createEvent({ name: 'mcd.lan 2026', domain: 'lan.example.org' });
  const a = await store.addAttendee(event.id, { first_name: 'Max', last_name: 'Muster', clan: 'M4E', nickname: 'lordimac' });
  const b = await store.addAttendee(event.id, { nickname: 'Frag' });
  assert.deepEqual(a.ips, ['192.168.120.100', '192.168.120.150', '192.168.120.200']);
  assert.equal(b.slot, 1);

  // Freed slots are reused
  await store.deleteAttendee(b.id);
  const c = await store.addAttendee(event.id, { nickname: 'Velvet' });
  assert.equal(c.slot, 1);

  await assert.rejects(store.addAttendee(event.id, { nickname: 'LORDIMAC' }), /schon vergeben/);

  // All attendees of the event are the players, as "Clan-Nickname"
  assert.deepEqual(await store.playerNamesForEvent('mcd.lan 2026'), ['M4E-lordimac', 'Velvet']);
  assert.equal(await store.playerNamesForEvent('unbekannt'), null);

  const stage = await stages.createStage({
    tournamentId: 1, name: 'UT2004', type: 'single_elimination',
    names: (await store.playerNamesForEvent('mcd.lan 2026'))!, settings: {}, eventName: 'mcd.lan 2026',
  });

  // Changing nickname or clan renames the player in the event's tournaments
  await store.updateAttendee(c.id, { nickname: 'Velvet2000', first_name: '', last_name: '' });
  await store.updateAttendee(a.id, { clan: 'CML', nickname: 'lordimac', first_name: 'Max', last_name: 'Muster' });
  const players = (await db.getStorage().select('participant', { tournament_id: stage.tournament_id })) ?? [];
  assert.deepEqual(players.map(p => p.name).sort(), ['CML-lordimac', 'Velvet2000']);

  // Renaming the event renames it on its tournaments
  await store.updateEvent(event.id, { name: 'mcd.lan 26' });
  assert.equal((await stages.findStage(stage.id)).event_name, 'mcd.lan 26');

  // Events with tournaments cannot be deleted
  await assert.rejects(store.deleteEvent(event.id), /Turnier/);
});

test('new events copy settings of the latest event; attendees can be imported', async () => {
  await db.ensureAppTables();
  const source = await store.createEvent({ name: 'LAN 2025', domain: 'lan.example.net', netmask: '255.255.0.0', gateway: '10.0.0.1', logo: 'data:image/png;base64,iVBORw0KGgo=', ranges: [
    { start: '10.0.1.10', end: '10.0.1.19' }, { start: '10.0.2.10', end: '10.0.2.19' }, { start: '10.0.3.10', end: '10.0.3.19' },
  ] });
  await store.addAttendee(source.id, { nickname: 'alpha' });
  await store.addAttendee(source.id, { nickname: 'beta' });

  const next = await store.createEvent({ name: 'LAN 2026' });
  assert.equal(next.domain, 'lan.example.net');
  assert.equal(next.netmask, '255.255.0.0');
  assert.equal(next.gateway, '10.0.0.1');
  assert.equal(next.logo, 'data:image/png;base64,iVBORw0KGgo=');
  assert.deepEqual(next.ranges, source.ranges);

  await store.addAttendee(next.id, { nickname: 'beta' });
  const result = await store.importAttendees(next.id, source.id);
  assert.deepEqual(result, { added: 1, skipped: ['beta'] });
  assert.deepEqual((await store.listAttendeeViews(next.id)).map(a => a.nickname), ['beta', 'alpha']);
});

test('events referenced only by tournaments get a record', async () => {
  await db.ensureAppTables();
  await stages.createStage({ tournamentId: 7, name: 'Alt', type: 'single_elimination', names: ['x', 'y'], settings: {}, eventName: 'Altes Event' });
  await store.syncEventsFromStages();
  const event = await store.findEventByName('Altes Event');
  assert.ok(event);
  assert.equal(event.ranges.length, 3);
});

test('bulk import previews, then adds valid lines and reports the rest', async () => {
  await db.ensureAppTables();
  const event = await store.createEvent({ name: 'Bulk-LAN', domain: 'lan.example.org', ranges: [
    { start: '10.1.0.1', end: '10.1.0.3' }, { start: '10.1.1.1', end: '10.1.1.3' }, { start: '10.1.2.1', end: '10.1.2.3' },
  ] });
  await store.addAttendee(event.id, { nickname: 'vorhanden' });

  const text = [
    'Imhoff, Marc // M4E-lordimac',
    '',
    'Kraus Sven // ohne-komma',
    'Doppelt, Dora // M4E-LORDIMAC',
    ', // Vorhanden',
    'Berg, Julia // CML-velvet',
    'Voll, Viktor // zu-viel',
  ].join('\n');

  const preview = await store.importBulk(event.id, text, true);
  assert.equal(preview.added, 0);
  assert.equal((await store.listAttendees(event.id)).length, 1, 'dry run writes nothing');
  assert.deepEqual(preview.rows.map(r => [r.line, r.ok]), [[1, true], [3, false], [4, false], [5, false], [6, true], [7, false]]);
  assert.match(preview.rows[1].error!, /Komma/);
  assert.match(preview.rows[2].error!, /schon vergeben/);
  assert.match(preview.rows[5].error!, /Kein Platz/);
  assert.deepEqual(preview.rows[0].attendee!.ips, ['10.1.0.2', '10.1.1.2', '10.1.2.2']);

  const result = await store.importBulk(event.id, text, false);
  assert.equal(result.added, 2);
  const views = await store.listAttendeeViews(event.id);
  assert.deepEqual(views.map(a => [a.display_name, a.clan, a.nickname, a.last_name, a.first_name, a.dns_names[0]]), [
    ['vorhanden', '', 'vorhanden', '', '', 'vorhanden.lan.example.org'],
    ['M4E-lordimac', 'M4E', 'lordimac', 'Imhoff', 'Marc', 'lordimac.lan.example.org'],
    ['CML-velvet', 'CML', 'velvet', 'Berg', 'Julia', 'velvet.lan.example.org'],
  ]);
});
