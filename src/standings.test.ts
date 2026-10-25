import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { BracketsManager } from 'brackets-manager';
import { JsonDatabase } from 'brackets-json-db';
import { Status, type CrudInterface, type InputStage } from 'brackets-model';
import { getStandings, sharedPoints } from './standings';

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
  assert.deepEqual(byDefault!.map(s => s.points), [30, 22, 14, 14], 'semifinal losers share 3–4');

  const custom = { places: [100, 50, 25, 10, 9, 8, 7, 6, 5, 4], rest: 0 };
  const recalculated = await getStandings(storage, manager, created.id, custom);
  assert.deepEqual(recalculated!.map(s => s.points), [100, 50, 18, 18]);
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

const places = (standings: { placement: number | null; placement_to: number | null }[]) =>
  standings.map(s => s.placement === null ? 'offen' : s.placement === s.placement_to ? `${s.placement}` : `${s.placement}–${s.placement_to}`);

test('shared places get the rounded average of their points', () => {
  assert.equal(sharedPoints([5, 6]), 8);
  assert.equal(sharedPoints([7, 8]), 4);
  assert.equal(sharedPoints([9, 12]), 2); // (2 + 2 + 1 + 1) / 4 = 1.5
  assert.equal(sharedPoints([3, 3]), 16);
});

test('double elimination: out in the same round = same place, a BYE is no disadvantage', async () => {
  // 12 players in a bracket of 16; BYEs count as no win, so wins differ within a round
  const standings = await playedStandings({
    type: 'double_elimination',
    seeding: ['A', null, 'H', 'I', 'D', 'E', 'J', 'K', 'B', null, 'F', 'G', 'C', 'L', null, null],
    settings: { grandFinal: 'simple' },
  });
  assert.deepEqual(places(standings), ['1', '2', '3', '4', '5–6', '5–6', '7–8', '7–8', '9–10', '9–10', '11–12', '11–12']);
  assert.deepEqual(standings.map(s => s.points), [30, 22, 16, 12, 8, 8, 4, 4, 2, 2, 1, 1]);
  const shared = standings.filter(s => s.placement === 5);
  assert.notEqual(shared[0].wins, shared[1].wins, 'same place despite a different number of wins');
});

test('single elimination: semifinal losers share 3rd place, a match for 3rd place separates them', async () => {
  const shared = await playedStandings({ type: 'single_elimination', seeding: ['A', 'H', 'D', 'E', 'B', 'G', 'C', 'F'] });
  assert.deepEqual(places(shared), ['1', '2', '3–4', '3–4', '5–8', '5–8', '5–8', '5–8']);
  assert.deepEqual(shared.map(s => s.points), [30, 22, 14, 14, 6, 6, 6, 6]);

  const separated = await playedStandings({
    type: 'single_elimination', seeding: ['A', 'H', 'D', 'E', 'B', 'G', 'C', 'F'], settings: { consolationFinal: true },
  });
  assert.deepEqual(places(separated), ['1', '2', '3', '4', '5–8', '5–8', '5–8', '5–8']);
  assert.deepEqual(names(separated).slice(0, 4), ['A', 'C', 'B', 'D']);
});

test('places are open (no points) until they are final', async () => {
  const { storage, manager } = setup();
  const stage = await manager.create.stage({ tournamentId: 1, name: 'Test', type: 'single_elimination', seeding: ['A', 'B', 'C', 'D'] });
  const before = await getStandings(storage, manager, stage.id);
  assert.ok(before!.every(s => s.placement === null && s.points === 0), 'nothing played yet');

  // One semifinal played: its loser is out (shares 3–4), everyone else is still open
  const [semi] = ((await storage.select('match', { stage_id: stage.id })) ?? []).filter(m => m.status === Status.Ready);
  await manager.update.match({ id: semi.id, opponent1: { result: 'win' }, opponent2: { result: 'loss' } });
  const running = await getStandings(storage, manager, stage.id);
  assert.deepEqual(places(running!), ['offen', 'offen', 'offen', '3–4']);
  assert.deepEqual(running!.map(s => s.points), [0, 0, 0, 14]);

  const rr = await manager.create.stage({ tournamentId: 2, name: 'RR', type: 'round_robin', seeding: ['A', 'B', 'C'], settings: { groupCount: 1 } });
  const [first] = ((await storage.select('match', { stage_id: rr.id })) ?? []).filter(m => m.status === Status.Ready);
  await manager.update.match({ id: first.id, opponent1: { result: 'win' }, opponent2: { result: 'loss' } });
  const rrStandings = await getStandings(storage, manager, rr.id);
  assert.ok(rrStandings!.every(s => s.placement === null && s.points === 0), 'round robin is final only at the end');
});

test('double grand final: the second match decides only after the loser bracket winner won the first', async () => {
  for (const loserBracketWinsFirst of [true, false]) {
    const { storage, manager } = setup();
    const stage = await manager.create.stage({ tournamentId: 1, name: 'Test', type: 'double_elimination', seeding: ['A', 'D', 'B', 'C'], settings: { grandFinal: 'double' } });
    const groups = (await storage.select('group', { stage_id: stage.id })) ?? [];
    const finalGroup = groups.find(g => g.number === 3)!.id;
    const ready = async () => ((await storage.select('match', { stage_id: stage.id })) ?? []).find(m => m.status === Status.Ready);
    for (let match = await ready(); match; match = await ready()) {
      // Before the grand final the opponent 1 wins; in the grand final see the loop variable;
      // the second grand final match (played anyway if brackets-manager offers it) goes to opponent 2
      const inFinal = match.group_id === finalGroup;
      const firstWins = !inFinal ? true : match.number === 1 && (await storage.select('round', match.round_id))!.number === 1 ? !loserBracketWinsFirst : false;
      await manager.update.match({ id: match.id, opponent1: { result: firstWins ? 'win' : 'loss' }, opponent2: { result: firstWins ? 'loss' : 'win' } });
    }
    const standings = await getStandings(storage, manager, stage.id);
    assert.deepEqual(places(standings!).slice(0, 2), ['1', '2']);
    const [first, second] = ((await storage.select('match', { group_id: finalGroup })) ?? []).sort((a, b) => Number(a.round_id) - Number(b.round_id));
    const name = async (id: unknown) => (await storage.select('participant', id as number))!.name;
    // LB winner wins match 1 → match 2 decides (opponent 2 wins it); otherwise match 1 decides
    const champion = loserBracketWinsFirst ? await name(second.opponent2!.id) : await name(first.opponent1!.id);
    assert.equal(standings![0].participant_name, champion);
  }
});
