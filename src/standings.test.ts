import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { BracketsManager } from 'brackets-manager';
import { JsonDatabase } from 'brackets-json-db';
import { Status, type CrudInterface, type InputStage } from 'brackets-model';
import { getStandings } from './standings';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcd-brackets-test-'));
  const storage: CrudInterface = new JsonDatabase(path.join(dir, 'db.json'));
  return { storage, manager: new BracketsManager(storage) };
}

// Play every ready match until none is left; the alphabetically smaller name always wins
async function playAll(storage: CrudInterface, manager: BracketsManager, stageId: number) {
  const participants = (await storage.select('participant')) ?? [];
  const nameOf = (id: unknown) => participants.find(p => p.id === id)?.name ?? '';

  for (;;) {
    const matches = (await storage.select('match', { stage_id: stageId })) ?? [];
    const match = matches.find(m => m.status === Status.Ready);
    if (!match) return;
    const firstWins = nameOf(match.opponent1?.id) < nameOf(match.opponent2?.id);
    await manager.update.match({
      id: match.id,
      opponent1: { result: firstWins ? 'win' : 'loss' },
      opponent2: { result: firstWins ? 'loss' : 'win' },
    });
  }
}

async function playedStandings(stage: Omit<InputStage, 'tournamentId' | 'name'>) {
  const { storage, manager } = setup();
  const created = await manager.create.stage({ tournamentId: 1, name: 'Test', ...stage });
  await playAll(storage, manager, Number(created.id));
  const standings = await getStandings(storage, manager, created.id);
  assert.ok(standings);
  return standings;
}

const names = (standings: { participant_name: string }[]) => standings.map(s => s.participant_name);

test('standings use the given points settings (changing them recalculates finished tournaments)', async () => {
  const { storage, manager } = setup();
  const created = await manager.create.stage({ tournamentId: 1, name: 'Test', type: 'single_elimination', seeding: ['A', 'B', 'C', 'D'] });
  await playAll(storage, manager, Number(created.id));

  const byDefault = await getStandings(storage, manager, created.id);
  assert.deepEqual(byDefault!.map(s => s.points), [30, 22, 16, 12]);

  const custom = { places: [100, 50, 25, 10, 9, 8, 7, 6, 5, 4], rest: 0 };
  const recalculated = await getStandings(storage, manager, created.id, custom);
  assert.deepEqual(recalculated!.map(s => s.points), [100, 50, 25, 10]);
});

test('double elimination with simple grand final', async () => {
  const standings = await playedStandings({
    type: 'double_elimination',
    seeding: ['A', 'D', 'B', 'C'],
    settings: { grandFinal: 'simple' },
  });
  assert.deepEqual(names(standings), ['A', 'B', 'C', 'D']);
  assert.deepEqual(standings.map(s => s.points), [30, 22, 16, 12]);
  assert.ok(standings.every(s => s.pending === 0));
});

test('double elimination with double grand final', async () => {
  const standings = await playedStandings({
    type: 'double_elimination',
    seeding: ['A', 'H', 'D', 'E', 'B', 'G', 'C', 'F'],
    settings: { grandFinal: 'double' },
  });
  assert.deepEqual(names(standings).slice(0, 3), ['A', 'B', 'C']);
  assert.equal(standings[0].losses, 0);
});

test('double elimination ignores BYEs', async () => {
  const standings = await playedStandings({
    type: 'double_elimination',
    seeding: ['A', null, 'B', 'C'],
    settings: { grandFinal: 'simple' },
  });
  assert.deepEqual(names(standings), ['A', 'B', 'C']);
});

test('single elimination ranks finalists first', async () => {
  const standings = await playedStandings({
    type: 'single_elimination',
    seeding: ['A', 'D', 'B', 'C'],
  });
  assert.deepEqual(names(standings).slice(0, 2), ['A', 'B']);
  assert.equal(standings.length, 4);
});

test('round robin ranks by 3/1/0 points', async () => {
  const standings = await playedStandings({
    type: 'round_robin',
    seeding: ['C', 'A', 'D', 'B'],
    settings: { groupCount: 1 },
  });
  assert.deepEqual(names(standings), ['A', 'B', 'C', 'D']);
  assert.deepEqual(standings.map(s => s.wins), [3, 2, 1, 0]);
  assert.deepEqual(standings.map(s => s.points), [30, 22, 16, 12]);
});

test('pending counts playable matches without result', async () => {
  const { storage, manager } = setup();
  const stage = await manager.create.stage({ tournamentId: 1, name: 'Test', type: 'round_robin', seeding: ['A', 'B', 'C'], settings: { groupCount: 1 } });
  const standings = await getStandings(storage, manager, stage.id);
  assert.ok(standings);
  assert.ok(standings.every(s => s.pending === 2));
});

test('unknown stage returns null', async () => {
  const { storage, manager } = setup();
  assert.equal(await getStandings(storage, manager, 99), null);
});
