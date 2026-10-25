import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Status, type Id, type Match } from 'brackets-model';

// db.ts reads DATA_DIR on import, so point it to a temp dir first
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcd-brackets-schedule-'));

const { ensureAppTables, getStorage }: typeof import('./db') = require('./db');
const store: typeof import('./lan-store') = require('./lan-store');
const { createStage, findStage }: typeof import('./stages') = require('./stages');
const { decideOverdueMatches, eventSchedule, saveEventSchedule, saveSchedule, stageRounds }: typeof import('./schedule') = require('./schedule');
const { updateMatchResult }: typeof import('./results') = require('./results');
const { syncEventStages }: typeof import('./stage-sync') = require('./stage-sync');
const { HttpError }: typeof import('./http-error') = require('./http-error');

let tournamentId = 1;
const NOW = Date.now();
const past = new Date(NOW - 60_000).toISOString();
const future = new Date(NOW + 3_600_000).toISOString();

async function stage(type: 'single_elimination' | 'double_elimination' | 'round_robin', count: number, extra: { eventName?: string } = {}) {
  return createStage({
    tournamentId: tournamentId++, name: type, type, settings: type === 'double_elimination' ? { grandFinal: 'simple' } : {},
    names: Array.from({ length: count }, (_, i) => `P${i + 1}`), ...extra,
  });
}

type DrawnMatch = Match & { drawn?: boolean };
const matchesOf = async (stageId: Id) => ((await getStorage().select('match', { stage_id: stageId })) ?? []) as DrawnMatch[];
const inRound = async (stageId: Id, label: string) => {
  const round = (await stageRounds(stageId)).find(r => r.label === label)!;
  return (await matchesOf(stageId)).filter(m => m.round_id === round.round_id);
};

test('round labels in bracket order; the matches for places 1–3 get a start time', async () => {
  const de = await stage('double_elimination', 4);
  assert.deepEqual((await stageRounds(de.id)).map(r => `${r.label}/${r.kind}`), [
    'Winner Bracket · Runde 1/deadline', 'Winner Bracket · Runde 2/deadline',
    'Loser Bracket · Runde 1/none', 'Loser Bracket · Finale (Platz 3)/start',
    'Grand Final/start',
  ]);
  const se = await stage('single_elimination', 8);
  assert.deepEqual((await stageRounds(se.id)).map(r => `${r.label}/${r.kind}`), ['Runde 1/deadline', 'Halbfinale/start', 'Finale/start']);
  const rr = await stage('round_robin', 4);
  assert.ok((await stageRounds(rr.id)).every(r => r.kind === 'none'), 'round robin has no times');
});

test('start times are never decided by lot; an old deadline of such a round counts as its start', async () => {
  const se = await stage('single_elimination', 4);
  await saveSchedule(se.id, [{ group: 1, round: 1, starts_at: past }, { group: 1, round: 2, starts_at: past }]);
  assert.deepEqual((await stageRounds(se.id)).map(r => [r.ends_at, r.starts_at]), [[null, past], [null, past]]);
  assert.equal(await decideOverdueMatches(se.id, NOW), 0);
  assert.ok((await inRound(se.id, 'Halbfinale')).every(m => m.status === Status.Ready), 'semifinals stay open');

  // Stored as deadline by an older version: shown as start, still never by lot
  const stored = await findStage(se.id);
  await getStorage().update('stage', se.id, { ...stored, schedule: [{ group: 1, round: 1, label: 'Halbfinale', ends_at: past }] } as typeof stored);
  assert.deepEqual((await stageRounds(se.id)).map(r => [r.ends_at, r.starts_at]), [[null, past], [null, null]]);
  assert.equal(await decideOverdueMatches(se.id, NOW), 0);
});

test('after the deadline open matches of the round are decided by lot, later rounds wait for their own', async () => {
  const se = await stage('single_elimination', 16);
  await saveSchedule(se.id, [
    { group: 1, round: 1, ends_at: past },
    { group: 1, round: 2, ends_at: future },
  ]);

  // One match was played by hand before the deadline
  const [first] = await inRound(se.id, 'Runde 1');
  await updateMatchResult(first.id, { opponent1: { result: 'win' }, opponent2: { result: 'loss' } });

  const decided = await decideOverdueMatches(se.id, NOW, () => 1);
  assert.equal(decided, 7);
  const round1 = await inRound(se.id, 'Runde 1');
  assert.ok(round1.every(m => m.status >= Status.Completed));
  assert.equal(round1.filter(m => m.drawn).length, 7, 'the played match is not marked');
  assert.ok(round1.filter(m => m.drawn).every(m => m.opponent2?.result === 'win'), 'the lot decided');
  assert.ok((await inRound(se.id, 'Runde 2')).every(m => m.status === Status.Ready), 'round 2 has time');

  // Nothing more to do now; once the deadline of round 2 is over, it follows; the semifinal has
  // a start time and is never decided by lot
  assert.equal(await decideOverdueMatches(se.id, NOW), 0);
  assert.equal(await decideOverdueMatches(se.id, NOW + 7_200_000), 4);
  assert.ok((await inRound(se.id, 'Halbfinale')).every(m => m.status === Status.Ready));
});

test('confirming the same winner by hand removes the lot mark', async () => {
  const se = await stage('single_elimination', 8);
  await saveSchedule(se.id, [{ group: 1, round: 1, ends_at: past }]);
  await decideOverdueMatches(se.id, NOW, () => 0);
  const [drawn] = await inRound(se.id, 'Runde 1');
  assert.equal(drawn.drawn, true);
  const confirmed = await updateMatchResult(drawn.id, { opponent1: { result: 'win' }, opponent2: { result: 'loss' } }) as DrawnMatch;
  assert.equal(confirmed.drawn, false);
  assert.equal(confirmed.opponent1?.result, 'win');
});

test('a correction removes the lot mark', async () => {
  const se = await stage('single_elimination', 8);
  await saveSchedule(se.id, [{ group: 1, round: 1, ends_at: past }]);
  await decideOverdueMatches(se.id, NOW, () => 0);
  const [drawn] = await inRound(se.id, 'Runde 1');
  assert.equal(drawn.drawn, true);
  await updateMatchResult(drawn.id, { opponent1: { result: 'loss' }, opponent2: { result: 'win' }, resetFollowing: true });
  assert.equal(((await getStorage().select('match', drawn.id)) as DrawnMatch).drawn, false);
});

test('invalid input is rejected, empty values remove the deadline', async () => {
  const se = await stage('single_elimination', 8);
  await assert.rejects(saveSchedule(se.id, [{ group: 1, round: 1, ends_at: 'morgen' }]), (e: unknown) => e instanceof HttpError && e.status === 400);
  await assert.rejects(saveSchedule(se.id, [{ group: 9, round: 1, ends_at: future }]), (e: unknown) => e instanceof HttpError && e.status === 400);
  await saveSchedule(se.id, [{ group: 1, round: 1, ends_at: future }]);
  await saveSchedule(se.id, [{ group: 1, round: 1, ends_at: '' }]);
  assert.deepEqual((await findStage(se.id)).schedule, []);
});

test('deadlines survive a rebuild; after the deadline of round 1 nobody joins any more', async () => {
  await ensureAppTables();
  const event = await store.createEvent({ name: 'Fristen-LAN', memorial: [] });
  for (let i = 1; i <= 6; i++) await store.addAttendee(event.id, { nickname: `P${i}` });
  const se = await stage('single_elimination', 6, { eventName: event.name });
  const first = (await inRound(se.id, 'Runde 1')).find(m => m.status === Status.Ready)!;
  await updateMatchResult(first.id, { opponent1: { result: 'win' }, opponent2: { result: 'loss' } }); // started
  await saveSchedule(se.id, [{ group: 1, round: 2, starts_at: future }]);

  await store.addAttendee(event.id, { nickname: 'P7' });
  const [report] = await syncEventStages(event.name);
  assert.deepEqual(report.added, ['P7']);
  assert.deepEqual((await findStage(report.stage_id)).schedule?.map(d => d.label), ['Halbfinale']);

  await saveSchedule(report.stage_id, [{ group: 1, round: 1, ends_at: past }]);
  await store.addAttendee(event.id, { nickname: 'P8' });
  const [late] = await syncEventStages(event.name);
  assert.deepEqual(late.late, ['P8']);
});

test('play slots: loser bracket one slot behind, grand final after it, 3rd place with the final', async () => {
  const de = await stage('double_elimination', 8);
  assert.deepEqual((await stageRounds(de.id)).map(r => `${r.label}=${r.slot}`), [
    'Winner Bracket · Runde 1=1', 'Winner Bracket · Runde 2=2', 'Winner Bracket · Runde 3=3',
    'Loser Bracket · Runde 1=2', 'Loser Bracket · Runde 2=3', 'Loser Bracket · Runde 3=4', 'Loser Bracket · Finale (Platz 3)=5',
    'Grand Final=6',
  ]);
  const se = await createStage({ tournamentId: tournamentId++, name: 'se', type: 'single_elimination', settings: { consolationFinal: true }, names: ['A', 'B', 'C', 'D'] });
  assert.deepEqual((await stageRounds(se.id)).map(r => `${r.label}=${r.slot}/${r.kind}`), ['Halbfinale=1/start', 'Finale=2/start', 'Spiel um Platz 3=2/start']);
});

test('one schedule for all tournaments of an event: deadlines by play slot, start times per tournament', async () => {
  const eventName = 'Spielrunden-LAN';
  const se = await stage('single_elimination', 8, { eventName });
  const de = await stage('double_elimination', 4, { eventName });
  const at = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();

  const { slots, finals, decided } = await saveEventSchedule(eventName,
    [{ slot: 1, ends_at: at(1) }, { slot: 2, ends_at: at(2) }, { slot: 3, ends_at: at(3) }],
    [{ stage_id: se.id, group: 1, round: 3, starts_at: at(5) }, { stage_id: de.id, group: 3, round: 1, starts_at: at(6) }]);
  assert.equal(decided, 0);
  assert.deepEqual(slots.map(s => s.slot), [1, 2], 'only normal rounds have play slots');
  assert.deepEqual(slots[1].rounds.map(r => `${r.stage_name}: ${r.label}`), [
    'double_elimination: Winner Bracket · Runde 2',
  ], 'the loser bracket has no times');
  assert.deepEqual(finals.map(f => `${f.stage_name}: ${f.label}=${f.starts_at}`), [
    'single_elimination: Halbfinale=null',
    `single_elimination: Finale=${at(5)}`,
    'double_elimination: Loser Bracket · Finale (Platz 3)=null',
    `double_elimination: Grand Final=${at(6)}`,
  ]);
  assert.deepEqual((await stageRounds(se.id)).map(r => r.ends_at ?? r.starts_at), [at(1), null, at(5)]);
  assert.deepEqual((await stageRounds(de.id)).map(r => r.ends_at ?? r.starts_at), [at(1), at(2), null, null, at(6)]);

  // A single tournament changed afterwards: that slot shows "mixed"
  await saveSchedule(se.id, [{ group: 1, round: 1, ends_at: at(5) }, { group: 1, round: 3, starts_at: at(5) }]);
  const after = await eventSchedule(eventName);
  assert.equal(after[0].mixed, true);
  assert.equal(after[0].ends_at, null);
  assert.equal(after[1].ends_at, at(2));

  // Saving without slot 1 and without finals keeps what is there
  await saveEventSchedule(eventName, [{ slot: 2, ends_at: at(4) }]);
  assert.deepEqual((await stageRounds(se.id)).map(r => r.ends_at ?? r.starts_at), [at(5), null, at(5)]);
  assert.deepEqual((await stageRounds(de.id)).map(r => r.ends_at), [at(1), at(4), null, null, null]);
});

test('loser bracket and round robin rounds never get a time, also not from old data', async () => {
  const de = await stage('double_elimination', 8);
  const rr = await stage('round_robin', 4);
  await saveSchedule(de.id, [{ group: 2, round: 1, ends_at: past }]);
  assert.equal((await stageRounds(de.id)).find(r => r.label === 'Loser Bracket · Runde 1')!.ends_at, null);
  // Stored by an older version: ignored, never by lot
  const stored = await findStage(rr.id);
  await getStorage().update('stage', rr.id, { ...stored, schedule: [{ group: 1, round: 1, label: 'Runde 1', ends_at: past }] } as typeof stored);
  assert.ok((await stageRounds(rr.id)).every(r => r.ends_at === null));
  assert.equal(await decideOverdueMatches(rr.id, NOW), 0);
});
