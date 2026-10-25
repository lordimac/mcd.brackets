import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Status, type Id } from 'brackets-model';

// db.ts reads DATA_DIR on import, so point it to a temp dir first
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcd-brackets-memorial-'));

const { getManager, getStorage }: typeof import('./db') = require('./db');
const { createStage, findStage, resolveMemorialMatches, seatLayout, seatsScore }: typeof import('./stages') = require('./stages');
const { memorialByes, migrateMemorialStages }: typeof import('./stage-sync') = require('./stage-sync');
const { getStandings }: typeof import('./standings') = require('./standings');

let tournamentId = 1;
const matchesOf = async (stageId: Id) => (await getStorage().select('match', { stage_id: stageId })) ?? [];

// IDs of the matches in round 1 of the winner bracket
async function winnerRoundOne(stageId: Id): Promise<Set<Id>> {
  const group = ((await getStorage().select('group', { stage_id: stageId })) ?? []).find(g => g.number === 1)!;
  const round = ((await getStorage().select('round', { group_id: group.id })) ?? []).find(r => r.number === 1)!;
  return new Set(((await getStorage().select('match', { round_id: round.id })) ?? []).map(m => m.id));
}

async function playAll(stageId: Id) {
  for (;;) {
    await resolveMemorialMatches(stageId);
    const ready = (await matchesOf(stageId)).find(m => m.status === Status.Ready);
    if (!ready) return;
    await getManager().update.match({ id: ready.id, opponent1: { result: 'win' }, opponent2: { result: 'loss' } });
  }
}

for (const type of ['single_elimination', 'double_elimination'] as const) {
  test(`${type}: memorial entries are BYEs with a name — never in a match, never in the loser bracket`, async () => {
    const stage = await createStage({
      tournamentId: tournamentId++, name: type, type, settings: type === 'double_elimination' ? { grandFinal: 'simple' } : {},
      names: ['A', 'B', 'C', 'D', 'E', 'F'], memorial: ['Opa', 'Oma', 'Tante'],
    });
    const players = (await getStorage().select('participant', { tournament_id: stage.tournament_id })) ?? [];
    assert.deepEqual(players.map(p => p.name).sort(), ['A', 'B', 'C', 'D', 'E', 'F'], 'memorial entries are no participants');
    assert.equal(stage.settings.size, 16, '6 players + 3 memorial places');

    // Every memorial entry sits on a BYE of round 1, paired with a player; in double elimination
    // the name also stands on the BYE of loser bracket round 1 where their "loser" would go
    const all = await memorialByes(await findStage(stage.id));
    const wbRound1 = await winnerRoundOne(stage.id);
    const byes = all.filter(b => wbRound1.has(b.match_id));
    assert.deepEqual(byes.map(b => b.name).sort(), ['Oma', 'Opa', 'Tante']);
    const lb = all.filter(b => !wbRound1.has(b.match_id));
    assert.deepEqual(lb.map(b => b.name).sort(), type === 'double_elimination' ? ['Oma', 'Opa', 'Tante'] : []);
    for (const bye of lb) {
      const match = (await matchesOf(stage.id)).find(m => m.id === bye.match_id)!;
      assert.equal(bye.side === 1 ? match.opponent1 : match.opponent2, null, 'a BYE place in the loser bracket');
    }
    for (const bye of byes) {
      const match = (await matchesOf(stage.id)).find(m => m.id === bye.match_id)!;
      const own = bye.side === 1 ? match.opponent1 : match.opponent2;
      const other = bye.side === 1 ? match.opponent2 : match.opponent1;
      assert.equal(own, null, 'the memorial side is a BYE');
      assert.ok(other?.id != null, 'a player is on the other side');
    }

    await playAll(stage.id);
    assert.ok(!(await matchesOf(stage.id)).some(m => m.status === Status.Ready), 'the bracket can be finished');
    const standings = await getStandings(getStorage(), getManager(), stage.id);
    assert.deepEqual(standings!.map(s => s.participant_name).sort(), ['A', 'B', 'C', 'D', 'E', 'F']);
  });
}

test('older double elimination brackets (memorial entries as players) are converted, real results stay', async () => {
  // Old style: memorial entries as participants that lose by forfeit; seeds 4 and 8 meet in the loser bracket
  const id = tournamentId++;
  const created = await getManager().create.stage({
    tournamentId: id, name: 'Alt', type: 'double_elimination', settings: { grandFinal: 'simple' },
    seeding: ['A', 'B', 'C', 'Opa', 'D', 'E', 'F', 'Oma'],
  });
  const stored = await findStage(created.id);
  await getStorage().update('stage', created.id, { ...stored, event_name: 'Alt-LAN', memorial_names: ['Opa', 'Oma'] } as typeof stored);
  const participants = (await getStorage().select('participant', { tournament_id: id })) ?? [];
  const name = (pid: Id | null | undefined) => participants.find(p => p.id === pid)?.name ?? '';
  const memorialName = (pid: Id | null | undefined) => ['Opa', 'Oma'].includes(name(pid));

  // Old behaviour: memorial entries forfeit against players; of two memorial entries the first "wins"
  for (;;) {
    const ready = (await matchesOf(created.id)).find(m => m.status === Status.Ready);
    if (!ready) break;
    const [m1, m2] = [memorialName(ready.opponent1?.id), memorialName(ready.opponent2?.id)];
    if (m2) await getManager().update.match({ id: ready.id, opponent2: { forfeit: true } });
    else if (m1) await getManager().update.match({ id: ready.id, opponent1: { forfeit: true } });
    else await getManager().update.match({ id: ready.id, opponent1: { result: 'win' }, opponent2: { result: 'loss' } });
  }
  const realResults = async (stageId: Id) => (await matchesOf(stageId))
    .filter(m => m.opponent1?.id != null && m.opponent2?.id != null && !m.opponent1.forfeit && !m.opponent2.forfeit && (m.opponent1.result || m.opponent2.result))
    .map(m => `${name((m.opponent1!.result === 'win' ? m.opponent1 : m.opponent2)!.id)}>${name((m.opponent1!.result === 'win' ? m.opponent2 : m.opponent1)!.id)}`)
    .sort();
  const before = await realResults(created.id);

  assert.deepEqual(await migrateMemorialStages(), ['Alt']);
  const stage = ((await getStorage().select('stage')) ?? []).find(s => s.tournament_id === id)!;
  assert.deepEqual(await realResults(stage.id), before, 'all real results are kept');
  assert.ok(!(await matchesOf(stage.id)).some(m => memorialName(m.opponent1?.id) || memorialName(m.opponent2?.id)), 'no memorial entry plays any more');
  assert.deepEqual(((await getStorage().select('participant', { tournament_id: id })) ?? []).map(p => p.name).sort(), ['A', 'B', 'C', 'D', 'E', 'F']);
  // Named BYEs in winner bracket round 1 and where they would drop into the loser bracket
  const byes = await memorialByes(await findStage(stage.id));
  const wb = await winnerRoundOne(stage.id);
  assert.deepEqual(byes.filter(b => wb.has(b.match_id)).map(b => b.name).sort(), ['Oma', 'Opa']);
  assert.deepEqual(byes.filter(b => !wb.has(b.match_id)).map(b => b.name).sort(), ['Oma', 'Opa']);
  assert.deepEqual(await migrateMemorialStages(), [], 'nothing left to convert');
});

test('round robin: memorial entries play and lose; two of them both lose', async () => {
  const stage = await createStage({ tournamentId: tournamentId++, name: 'RR', type: 'round_robin', settings: {}, names: ['A', 'B', 'C'], memorial: ['Opa', 'Oma'] });
  await playAll(stage.id);
  const players = (await getStorage().select('participant', { tournament_id: stage.tournament_id })) ?? [];
  const isMemorial = (pid: Id | null | undefined) => ['Opa', 'Oma'].includes(players.find(p => p.id === pid)?.name ?? '');
  const pair = (await matchesOf(stage.id)).find(m => isMemorial(m.opponent1?.id) && isMemorial(m.opponent2?.id))!;
  assert.ok(pair.opponent1?.forfeit && pair.opponent2?.forfeit && !pair.opponent1.result && !pair.opponent2.result);
  const standings = await getStandings(getStorage(), getManager(), stage.id);
  assert.deepEqual(standings!.map(s => s.participant_name).sort(), ['A', 'B', 'C']);
});

test('double elimination: memorial entries never meet each other in the loser bracket, a real loser arrives there', async () => {
  const names = Array.from({ length: 22 }, (_, i) => `P${i + 1}`);
  for (let attempt = 0; attempt < 5; attempt++) {
    const stage = await createStage({ tournamentId: tournamentId++, name: 'DE22', type: 'double_elimination', settings: { grandFinal: 'simple' }, names, memorial: ['Opa', 'Oma', 'Tante'] });
    const stored = await findStage(stage.id);
    const byes = await memorialByes(stored);
    const wb = await winnerRoundOne(stage.id);
    const lb = byes.filter(b => !wb.has(b.match_id));
    assert.equal(lb.length, 3);
    assert.equal(new Set(lb.map(b => b.match_id)).size, 3, 'each in its own loser bracket match');
    // Best places: player as opponent (2) and a real loser in the loser bracket (1), for all three
    const playerPositions = new Set((await matchesOf(stage.id)).filter(m => wb.has(m.id)).flatMap(m => [m.opponent1?.position, m.opponent2?.position]).filter(Boolean));
    const realSeeding = Array.from({ length: stored.settings.size! }, (_, i) => (playerPositions.has(i + 1) ? 'x' : null));
    assert.equal(seatsScore(realSeeding, stored.memorial_seats ?? {}, seatLayout('double_elimination', stored.settings.size!, stored.settings.seedOrdering)), 9);
  }
});
