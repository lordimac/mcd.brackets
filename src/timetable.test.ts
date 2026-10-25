import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// db.ts reads DATA_DIR on import, so point it to a temp dir first
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcd-brackets-timetable-'));

const { ensureAppTables, getAppStore }: typeof import('./db') = require('./db');
const store: typeof import('./lan-store') = require('./lan-store');
const { createStage }: typeof import('./stages') = require('./stages');
const { saveEventSchedule }: typeof import('./schedule') = require('./schedule');
const { getTimetable, saveTimetable, tournamentItems, validateTimetable }: typeof import('./timetable') = require('./timetable');
const { ValidationError }: typeof import('./lan') = require('./lan');

const at = (hour: number) => `2026-10-24T${String(hour).padStart(2, '0')}:00:00.000Z`;

test('entries have days and local times, are sorted and keep their IDs; notes need a text', () => {
  const result = validateTimetable({
    entries: [
      { id: 'dinner', days: ['2026-11-20'], start: '18:00', end: '19:30', title: ' Abendessen ', info: 'Kantine', category: 'meal' },
      { days: ['2026-11-22', '2026-11-21', '2026-11-21'], start: '08:00', title: 'Frühstück', category: 'unbekannt' },
      { days: ['2026-11-21'], start: '22:00', end: '02:00', title: 'Nachtturnier', category: 'program' },
    ],
    notes: [{ title: 'WLAN', text: 'Nur für Gäste' }, { text: 'Bitte Müll trennen' }],
  });
  assert.deepEqual(result.entries.map(e => e.title), ['Abendessen', 'Frühstück', 'Nachtturnier']);
  assert.equal(result.entries[0].id, 'dinner');
  assert.deepEqual(result.entries[1].days, ['2026-11-21', '2026-11-22'], 'sorted, without duplicates');
  assert.ok(result.entries[1].id.length > 10, 'new entries get an ID');
  assert.equal(result.entries[1].category, 'other');
  assert.equal(result.entries[1].end, null);
  assert.equal(result.entries[2].end, '02:00', 'an end before the start is the next morning');
  assert.deepEqual(result.notes.map(n => n.title), ['WLAN', '']);

  const ok = { days: ['2026-11-20'], start: '09:00', title: 'x' };
  for (const input of [
    { entries: [{ ...ok, title: '' }] },
    { entries: [{ ...ok, start: '' }] },
    { entries: [{ ...ok, start: '25:00' }] },
    { entries: [{ ...ok, end: '09:00' }] },
    { entries: [{ ...ok, days: [] }] },
    { entries: [{ ...ok, days: ['2026-11-31'] }] },
    { notes: [{ title: 'Nur Titel', text: ' ' }] },
    { entries: 'nein' },
  ]) {
    assert.throws(() => validateTimetable(input), ValidationError, JSON.stringify(input));
  }
});

test('stored per event, tournament rounds come from the deadlines, removed with the event', async () => {
  await ensureAppTables();
  const event = await store.createEvent({ name: 'Zeitplan-LAN', memorial: [] });
  await saveTimetable(event.id, { entries: [{ days: ['2026-10-24', '2026-10-25'], start: '09:00', title: 'Frühstück', category: 'meal' }], notes: [{ text: 'Ruhe ab 2 Uhr' }] });
  assert.deepEqual((await getTimetable(event.id)).entries.map(e => e.title), ['Frühstück']);
  await saveTimetable(event.id, { entries: [], notes: [] });
  assert.deepEqual(await getTimetable(event.id), { entries: [], notes: [] });

  const jenga = await createStage({ tournamentId: 1, name: 'Jenga', type: 'single_elimination', names: ['A', 'B', 'C', 'D'], settings: {}, eventName: event.name });
  const uno = await createStage({ tournamentId: 2, name: 'UNO', type: 'double_elimination', names: ['A', 'B', 'C', 'D'], settings: { grandFinal: 'simple' }, eventName: event.name });
  await saveEventSchedule(event.name, [{ slot: 1, ends_at: at(20) }, { slot: 2, ends_at: at(21) }], [
    { stage_id: jenga.id, group: 1, round: 2, starts_at: at(22) },
    { stage_id: uno.id, group: 3, round: 1, starts_at: at(22) },
    { stage_id: uno.id, group: 2, round: 2, starts_at: at(21) },
  ]);

  const items = await tournamentItems(event.name);
  assert.deepEqual(items.map(i => `${i.kind} ${i.title}@${i.at}`), [
    `deadline Spielrunde 1@${at(20)}`,
    `deadline Spielrunde 2@${at(21)}`,
    `start Loser Bracket · Finale (Platz 3)@${at(21)}`,
    `start Finalspiele@${at(22)}`,
  ]);
  assert.deepEqual(items[1].rounds.map(r => `${r.stage_name}: ${r.label}`), ['UNO: Winner Bracket · Runde 2']);
  assert.deepEqual(items[3].rounds.map(r => `${r.stage_name}: ${r.label}`), ['Jenga: Finale', 'UNO: Grand Final']);

  // Deleting an event removes its timetable
  const other = await store.createEvent({ name: 'Wegwerf-LAN', memorial: [] });
  await saveTimetable(other.id, { notes: [{ text: 'weg damit' }] });
  await store.deleteEvent(other.id);
  assert.deepEqual((await getAppStore().select('timetable', { event_id: other.id })) ?? [], []);
});
