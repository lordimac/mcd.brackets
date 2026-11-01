import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Status } from 'brackets-model';

// db.ts reads DATA_DIR on import, so point it to a temp dir first
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcd-brackets-close-'));

const { assertMatchStageOpen, assertStageOpen, createStage, findStage, setStageClosed }: typeof import('./stages') = require('./stages');
const { getManager, getStorage }: typeof import('./db') = require('./db');
const { findOverdueMatch }: typeof import('./schedule') = require('./schedule');
const { HttpError }: typeof import('./http-error') = require('./http-error');

let nextTournament = 1;

const matchesOf = async (stageId: number | string) => (await getStorage().select('match', { stage_id: stageId })) ?? [];

// Every ready match: opponent 1 wins
async function playAll(stageId: number | string) {
  for (;;) {
    const ready = (await matchesOf(stageId)).find(m => m.status === Status.Ready);
    if (!ready) return;
    await getManager().update.match({ id: ready.id, opponent1: { result: 'win' }, opponent2: { result: 'loss' } });
  }
}

const newStage = (type: 'single_elimination' | 'double_elimination' = 'single_elimination') => createStage({
  tournamentId: nextTournament++, name: 'Test', type, names: ['A', 'B', 'C', 'D', 'E'], settings: {},
});

const isConflict = (error: unknown) => error instanceof HttpError && error.status === 409;

test('a tournament can only be closed when it is finished', async () => {
  const stage = await newStage();
  await assert.rejects(setStageClosed(stage.id, true), isConflict);
  assert.equal((await findStage(stage.id)).closed_at, undefined);

  await playAll(stage.id);
  const closed = await setStageClosed(stage.id, true);
  assert.ok(closed.closed_at);
  assert.ok((await findStage(stage.id)).closed_at, 'stored');
});

test('a double elimination with an unneeded second grand final match counts as finished', async () => {
  const stage = await createStage({
    tournamentId: nextTournament++, name: 'Test', type: 'double_elimination', names: ['A', 'B', 'C', 'D'], settings: { grandFinal: 'double' },
  });
  await playAll(stage.id); // the winner bracket winner takes the first grand final match
  assert.ok((await setStageClosed(stage.id, true)).closed_at);
});

test('a closed tournament refuses changes until it is opened again', async () => {
  const stage = await newStage();
  await playAll(stage.id);
  await setStageClosed(stage.id, true);
  const closed = await findStage(stage.id);
  const match = (await matchesOf(stage.id)).find(m => m.opponent1?.id != null && m.opponent2?.id != null)!;

  assert.throws(() => assertStageOpen(closed), isConflict);
  await assert.rejects(assertMatchStageOpen(match.id), isConflict);

  const opened = await setStageClosed(stage.id, false);
  assert.equal(opened.closed_at, undefined);
  assertStageOpen(await findStage(stage.id));
  await assertMatchStageOpen(match.id);
});

test('closing keeps the brackets-manager fields of the stage (seed ordering)', async () => {
  const stage = await newStage('double_elimination');
  await playAll(stage.id);
  const before = await findStage(stage.id);
  await setStageClosed(stage.id, true);
  await setStageClosed(stage.id, false);
  assert.deepEqual((await findStage(stage.id)).settings, before.settings);
});

test('overdue rounds of a closed tournament are not decided by lot', async () => {
  const stage = await newStage();
  await playAll(stage.id);
  await setStageClosed(stage.id, true);
  const stored = await findStage(stage.id);
  const withSchedule: typeof stored = { ...stored, schedule: [{ group: 1, round: 1, label: 'Runde 1', ends_at: '2020-01-01T00:00:00.000Z' }] };
  await getStorage().update('stage', stage.id, withSchedule);
  assert.equal(await findOverdueMatch(stage.id, Date.now()), null);
});
