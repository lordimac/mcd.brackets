import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Status, type Match } from 'brackets-model';

// db.ts reads DATA_DIR on import, so point it to a temp dir first
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcd-brackets-results-'));

const { createStage, resolveMemorialMatches }: typeof import('./stages') = require('./stages');
const { getManager, getStorage }: typeof import('./db') = require('./db');
const { describeFollowing, followingResults, updateMatchResult }: typeof import('./results') = require('./results');
const { HttpError }: typeof import('./http-error') = require('./http-error');

let nextTournament = 1;

async function playedStage(type: 'single_elimination' | 'double_elimination' | 'round_robin', names: string[], memorial: string[] = []) {
  const stage = await createStage({
    tournamentId: nextTournament++, name: 'Test', type, names, memorial,
    settings: type === 'double_elimination' ? { grandFinal: 'double' } : type === 'single_elimination' ? { consolationFinal: true } : {},
  });
  await playAll(stage.id);
  return stage;
}

// Every ready match: opponent 1 wins
async function playAll(stageId: number | string) {
  for (;;) {
    const ready = (await matchesOf(stageId)).find(m => m.status === Status.Ready);
    if (!ready) return;
    await getManager().update.match({ id: ready.id, opponent1: { result: 'win' }, opponent2: { result: 'loss' } });
    await resolveMemorialMatches(stageId);
  }
}

const matchesOf = async (stageId: number | string) => (await getStorage().select('match', { stage_id: stageId })) ?? [];
const winnerSide = (m: Match) => m.opponent1?.result === 'win' ? 1 : m.opponent2?.result === 'win' ? 2 : null;
const flipped = (m: Match) => winnerSide(m) === 1
  ? { opponent1: { result: 'loss' as const }, opponent2: { result: 'win' as const } }
  : { opponent1: { result: 'win' as const }, opponent2: { result: 'loss' as const } };

// First match of round 1 in which both opponents really played
async function firstRealMatch(stageId: number | string): Promise<Match> {
  const match = (await matchesOf(stageId)).find(m => m.opponent1?.id != null && m.opponent2?.id != null && !m.opponent1.forfeit && !m.opponent2.forfeit);
  assert.ok(match);
  return match;
}

for (const type of ['single_elimination', 'double_elimination'] as const) {
  test(`correcting an early result resets only the dependent results (${type})`, async () => {
    const stage = await playedStage(type, ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
    const target = await firstRealMatch(stage.id);
    const before = await matchesOf(stage.id);

    const following = await followingResults(target.id);
    assert.ok(following.length > 0, 'the final etc. depend on round 1');
    const followingIds = new Set(following.map(m => m.id));

    // Without confirmation the correction is refused and nothing changes
    await assert.rejects(updateMatchResult(target.id, flipped(target)), (e: unknown) => e instanceof HttpError && e.status === 409);
    assert.deepEqual(await matchesOf(stage.id), before);

    const updated = await updateMatchResult(target.id, { ...flipped(target), resetFollowing: true });
    assert.equal(winnerSide(updated!), winnerSide(target) === 1 ? 2 : 1);

    const after = await matchesOf(stage.id);
    for (const m of after) {
      const old = before.find(b => b.id === m.id)!;
      if (followingIds.has(m.id)) assert.ok(m.status < Status.Running, `following match ${m.id} is open again`);
      else if (m.id !== target.id) assert.equal(winnerSide(m), winnerSide(old), `independent match ${m.id} keeps its result`);
    }

    // The new winner moved on and the bracket can be finished again
    await playAll(stage.id);
    assert.ok(!(await matchesOf(stage.id)).some(m => m.status === Status.Ready));
  });
}

test('choosing the same winner again changes nothing', async () => {
  const stage = await playedStage('single_elimination', ['A', 'B', 'C', 'D']);
  const target = await firstRealMatch(stage.id);
  const before = await matchesOf(stage.id);
  await updateMatchResult(target.id, { opponent1: { result: target.opponent1!.result }, opponent2: { result: target.opponent2!.result }, resetFollowing: true });
  assert.deepEqual((await matchesOf(stage.id)).map(winnerSide), before.map(winnerSide));
});

test('the preview describes the following matches', async () => {
  const stage = await playedStage('double_elimination', ['A', 'B', 'C', 'D']);
  const target = await firstRealMatch(stage.id);
  const preview = await describeFollowing(target.id);
  assert.match(preview.label, /^Winner Bracket · Runde 1 · Match 1$/);
  assert.ok(preview.following.some(f => f.label.startsWith('Loser Bracket')));
  assert.ok(preview.following.some(f => f.label === 'Grand Final'));
});

test('memorial matches cannot be changed and are decided again after a correction', async () => {
  const stage = await playedStage('single_elimination', ['A', 'B', 'C', 'D', 'E', 'F', 'G'], ['Opa Willi']);
  const players = (await getStorage().select('participant', { tournament_id: stage.tournament_id })) ?? [];
  const memorialId = players.find(p => p.name === 'Opa Willi')!.id;
  const memorialMatch = (await matchesOf(stage.id)).find(m => m.opponent1?.id === memorialId || m.opponent2?.id === memorialId)!;
  await assert.rejects(updateMatchResult(memorialMatch.id, flipped(memorialMatch)), (e: unknown) => e instanceof HttpError && e.status === 400);

  const target = (await matchesOf(stage.id)).find(m =>
    m.opponent1?.id != null && m.opponent2?.id != null && m.opponent1.id !== memorialId && m.opponent2.id !== memorialId)!;
  await updateMatchResult(target.id, { ...flipped(target), resetFollowing: true });
  const open = (await matchesOf(stage.id)).filter(m => m.status === Status.Ready);
  assert.ok(open.every(m => m.opponent1?.id !== memorialId && m.opponent2?.id !== memorialId), 'memorial matches resolve themselves again');
});

test('round robin results can be changed directly', async () => {
  const stage = await playedStage('round_robin', ['A', 'B', 'C', 'D']);
  const target = (await matchesOf(stage.id))[0];
  assert.deepEqual(await followingResults(target.id), []);
  const updated = await updateMatchResult(target.id, flipped(target));
  assert.equal(winnerSide(updated!), winnerSide(target) === 1 ? 2 : 1);
});
