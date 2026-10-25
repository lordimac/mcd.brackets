import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Status, type Id, type Match } from 'brackets-model';

// db.ts reads DATA_DIR on import, so point it to a temp dir first
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcd-brackets-sync-'));

const { ensureAppTables, getManager, getStorage }: typeof import('./db') = require('./db');
const store: typeof import('./lan-store') = require('./lan-store');
const { createStage, findStage, resolveMemorialMatches }: typeof import('./stages') = require('./stages');
const { setConsolationFinal, setGrandFinalDouble, syncEventStages }: typeof import('./stage-sync') = require('./stage-sync');
const { getStandings }: typeof import('./standings') = require('./standings');

let eventCounter = 0;

async function eventWithPlayers(count: number) {
  await ensureAppTables();
  const event = await store.createEvent({ name: `LAN ${++eventCounter}`, memorial: [] });
  for (let i = 1; i <= count; i++) await store.addAttendee(event.id, { nickname: `P${i}` });
  return event;
}

async function tournament(eventName: string, type: 'single_elimination' | 'double_elimination' | 'round_robin') {
  const names = await store.playerNamesForEvent(eventName);
  return createStage({
    tournamentId: 1000 + eventCounter * 10 + ['single_elimination', 'double_elimination', 'round_robin'].indexOf(type),
    name: type, type, names: names!.players, memorial: names!.memorial, eventName,
    settings: type === 'double_elimination' ? { grandFinal: 'simple' } : {},
  });
}

const matchesOf = async (stageId: Id) => (await getStorage().select('match', { stage_id: stageId })) ?? [];

async function nameOf(stageId: Id) {
  const stage = await findStage(stageId);
  const players = (await getStorage().select('participant', { tournament_id: stage.tournament_id })) ?? [];
  return (id: Id | null | undefined) => players.find(p => p.id === id)?.name ?? '?';
}

// Played results as "winner>loser" (independent of IDs, which change with a rebuild)
async function results(stageId: Id): Promise<string[]> {
  const name = await nameOf(stageId);
  return (await matchesOf(stageId))
    .filter(m => m.opponent1?.id != null && m.opponent2?.id != null && (m.opponent1.result || m.opponent2.result))
    .map(m => {
      const firstWins = m.opponent1!.result === 'win';
      const winner = name((firstWins ? m.opponent1 : m.opponent2)!.id);
      const loser = name((firstWins ? m.opponent2 : m.opponent1)!.id);
      return `${winner}>${loser}${m.opponent1!.forfeit || m.opponent2!.forfeit ? ' (kampflos)' : ''}`;
    })
    .sort();
}

// Plays ready matches (smaller name wins) while filter allows
async function play(stageId: Id, filter: (m: Match) => boolean = () => true) {
  const name = await nameOf(stageId);
  for (;;) {
    const ready = (await matchesOf(stageId)).find(m => m.status === Status.Ready && filter(m));
    if (!ready) return;
    const firstWins = name(ready.opponent1!.id).localeCompare(name(ready.opponent2!.id), 'de', { numeric: true }) < 0;
    await getManager().update.match({ id: ready.id, opponent1: { result: firstWins ? 'win' : 'loss' }, opponent2: { result: firstWins ? 'loss' : 'win' } });
    await resolveMemorialMatches(stageId);
  }
}

async function firstRoundIds(stageId: Id): Promise<Set<Id>> {
  const rounds = (await getStorage().select('round', { stage_id: stageId })) ?? [];
  const groups = (await getStorage().select('group', { stage_id: stageId })) ?? [];
  const first = rounds.find(r => r.number === 1 && groups.find(g => g.id === r.group_id)?.number === 1)!;
  return new Set(((await getStorage().select('match', { round_id: first.id })) ?? []).map(m => m.id));
}

const attendeeId = async (eventId: number, nickname: string) => (await store.listAttendees(eventId)).find(a => a.nickname === nickname)!.id;

test('not started: new players take free places, the draw stays; a bigger bracket is drawn again', async () => {
  const event = await eventWithPlayers(5);
  const stage = await tournament(event.name, 'single_elimination');
  const positions = async (id: Id) => {
    const name = await nameOf(id);
    const out: Record<string, number> = {};
    for (const m of await matchesOf(id)) for (const side of [m.opponent1, m.opponent2]) if (side?.id != null && side.position) out[name(side.id)] = side.position;
    return out;
  };
  const before = await positions(stage.id);

  await store.addAttendee(event.id, { nickname: 'P6' });
  const [report] = await syncEventStages(event.name);
  assert.deepEqual(report.added, ['P6']);
  assert.equal(report.redrawn, false);
  const after = await positions(report.stage_id);
  for (const [player, position] of Object.entries(before)) assert.equal(after[player], position, `${player} keeps the place`);

  for (const n of [7, 8, 9]) await store.addAttendee(event.id, { nickname: `P${n}` });
  const [grown] = await syncEventStages(event.name);
  assert.equal(grown.redrawn, true);
  assert.equal((await findStage(grown.stage_id)).settings.size, 16);

  await store.deleteAttendee(await attendeeId(event.id, 'P9'));
  const [shrunk] = await syncEventStages(event.name);
  assert.deepEqual(shrunk.removed, ['P9']);
  assert.equal((await findStage(shrunk.stage_id)).settings.size, 8);
});

for (const type of ['single_elimination', 'double_elimination'] as const) {
  test(`started (${type}): a newcomer takes a free place, every result is kept`, async () => {
    const event = await eventWithPlayers(6); // 8 places: 2 BYEs
    let stage = await tournament(event.name, type);
    const round1 = await firstRoundIds(stage.id);
    await play(stage.id, m => round1.has(m.id));
    const before = await results(stage.id);
    assert.ok(before.length > 0);

    await store.addAttendee(event.id, { nickname: 'P7' });
    const [report] = await syncEventStages(event.name);
    assert.deepEqual(report.added, ['P7']);
    assert.equal(report.error, undefined);
    assert.deepEqual(await results(report.stage_id), before, 'no result lost or changed');

    // The newcomer has a ready match in round 1, and the bracket can be finished
    const name = await nameOf(report.stage_id);
    assert.ok((await matchesOf(report.stage_id)).some(m => m.status === Status.Ready && [name(m.opponent1?.id), name(m.opponent2?.id)].includes('P7')));
    await play(report.stage_id);
    assert.ok(!(await matchesOf(report.stage_id)).some(m => m.status === Status.Ready));
    stage = await findStage(report.stage_id);
  });
}

test('started without free place: the newcomer is reported once and stays out', async () => {
  const event = await eventWithPlayers(4); // 4 places, no BYE
  const stage = await tournament(event.name, 'single_elimination');
  const round1 = await firstRoundIds(stage.id);
  await play(stage.id, m => round1.has(m.id));
  const before = await results(stage.id);

  await store.addAttendee(event.id, { nickname: 'P5' });
  const [report] = await syncEventStages(event.name);
  assert.deepEqual(report.late, ['P5']);
  assert.deepEqual(report.added, []);
  assert.deepEqual(await results(report.stage_id), before);

  await store.addAttendee(event.id, { nickname: 'P6' });
  const [next] = await syncEventStages(event.name);
  assert.deepEqual(next.late, ['P6'], 'P5 is not reported again');
  assert.deepEqual((await findStage(next.stage_id)).late_names, ['P5', 'P6']);
});

test('started: a leaving player disappears from the bracket, the place becomes a BYE', async () => {
  const event = await eventWithPlayers(8);
  const stage = await tournament(event.name, 'single_elimination');
  const round1 = await firstRoundIds(stage.id);
  const firstMatch = (await matchesOf(stage.id)).find(m => round1.has(m.id))!;
  await play(stage.id, m => m.id === firstMatch.id); // only one result: the tournament has started
  const before = await results(stage.id);

  // Someone from another round-1 match leaves before playing
  const name = await nameOf(stage.id);
  const open = (await matchesOf(stage.id)).find(m => round1.has(m.id) && m.status === Status.Ready)!;
  const leaver = name(open.opponent1!.id);
  const opponent = name(open.opponent2!.id);
  await store.deleteAttendee(await attendeeId(event.id, leaver));
  const [report] = await syncEventStages(event.name);
  assert.deepEqual(report.removed, [leaver]);
  assert.equal(report.dropped, 0);

  const after = await nameOf(report.stage_id);
  const matches = await matchesOf(report.stage_id);
  assert.ok(!matches.some(m => [after(m.opponent1?.id), after(m.opponent2?.id)].includes(leaver)), 'gone from every match');
  const byeMatch = matches.find(m => [after(m.opponent1?.id), after(m.opponent2?.id)].includes(opponent) && (m.opponent1 === null || m.opponent2 === null))!;
  assert.ok(byeMatch, 'the opponent gets a BYE and advances');
  assert.deepEqual(await results(report.stage_id), before, 'the played result stays');
  assert.ok(!((await getStorage().select('participant', { tournament_id: stage.tournament_id })) ?? []).some(p => p.name === leaver));
});

test('started: a new player takes the place of one who left; results built on the leaver are dropped', async () => {
  const event = await eventWithPlayers(8);
  const stage = await tournament(event.name, 'single_elimination');
  const round1 = await firstRoundIds(stage.id);
  await play(stage.id, m => round1.has(m.id)); // all of round 1
  const name = await nameOf(stage.id);
  const firstMatch = (await matchesOf(stage.id)).find(m => round1.has(m.id))!;
  const winnerSide = firstMatch.opponent1!.result === 'win' ? firstMatch.opponent1! : firstMatch.opponent2!;
  const loserSide = winnerSide === firstMatch.opponent1 ? firstMatch.opponent2! : firstMatch.opponent1!;
  const leaver = name(winnerSide.id);
  const formerOpponent = name(loserSide.id);
  // The leaver also played round 2
  await play(stage.id, m => [m.opponent1?.id, m.opponent2?.id].includes(winnerSide.id));

  await store.deleteAttendee(await attendeeId(event.id, leaver));
  await store.addAttendee(event.id, { nickname: 'NEU' });
  const [report] = await syncEventStages(event.name);
  assert.deepEqual(report.removed, [leaver]);
  assert.deepEqual(report.added, ['NEU']);
  assert.equal(report.dropped, 2, 'round 1 and round 2 of the leaver');

  const after = await nameOf(report.stage_id);
  const newMatch = (await matchesOf(report.stage_id)).find(m => [after(m.opponent1?.id), after(m.opponent2?.id)].includes('NEU'))!;
  assert.deepEqual([after(newMatch.opponent1?.id), after(newMatch.opponent2?.id)].sort(), ['NEU', formerOpponent].sort(), 'NEU takes the place');
  assert.equal(newMatch.status, Status.Ready, 'to be played');
  assert.equal((await results(report.stage_id)).length, 3, 'the other round 1 results stay');
});

test('started round robin: a newcomer gets matches against everyone, results are kept', async () => {
  const event = await eventWithPlayers(4);
  const stage = await tournament(event.name, 'round_robin');
  await play(stage.id);
  const before = await results(stage.id);

  await store.addAttendee(event.id, { nickname: 'P5' });
  const [report] = await syncEventStages(event.name);
  assert.deepEqual(report.added, ['P5']);
  assert.deepEqual(await results(report.stage_id), before);
  const name = await nameOf(report.stage_id);
  const newcomerMatches = (await matchesOf(report.stage_id)).filter(m => [name(m.opponent1?.id), name(m.opponent2?.id)].includes('P5'));
  assert.equal(newcomerMatches.length, 4);
});

test('nothing changes when the attendees did not change', async () => {
  const event = await eventWithPlayers(5);
  await tournament(event.name, 'double_elimination');
  assert.deepEqual(await syncEventStages(event.name), []);
});

test('the match for 3rd place can be switched on and off later, results stay', async () => {
  const event = await eventWithPlayers(8);
  const stage = await tournament(event.name, 'single_elimination');
  const round1 = await firstRoundIds(stage.id);
  await play(stage.id, m => round1.has(m.id));
  const before = await results(stage.id);
  const groups = async (id: Id) => ((await getStorage().select('group', { stage_id: id })) ?? []).length;
  assert.equal(await groups(stage.id), 1);

  const on = await setConsolationFinal(stage.id, true);
  assert.equal(on.dropped, 0);
  assert.equal(await groups(on.stage_id), 2, 'group 2 = match for 3rd place');
  assert.deepEqual(await results(on.stage_id), before);
  assert.equal((await findStage(on.stage_id)).settings.consolationFinal, true);

  await play(on.stage_id); // semifinals, final and the match for 3rd place
  const played = await results(on.stage_id);
  const off = await setConsolationFinal(on.stage_id, false);
  assert.equal(off.dropped, 1, 'only the 3rd place match');
  assert.equal(await groups(off.stage_id), 1);
  assert.equal((await results(off.stage_id)).length, played.length - 1);

  const de = await tournament(event.name, 'double_elimination');
  await assert.rejects(setConsolationFinal(de.id, true), /Single Elimination/);
});

test('the second grand final match can be switched on and off later, results stay', async () => {
  const event = await eventWithPlayers(8);
  const stage = await tournament(event.name, 'double_elimination');
  const groupOf = async (id: Id) => {
    const groups = (await getStorage().select('group', { stage_id: id })) ?? [];
    return (m: Match) => groups.find(g => g.id === m.group_id)!.number;
  };
  const grandFinal = async (id: Id) => {
    const group = await groupOf(id);
    return (await matchesOf(id)).filter(m => group(m) === 3);
  };
  const notGrandFinal = await groupOf(stage.id);
  await play(stage.id, m => notGrandFinal(m) !== 3);
  // The loser bracket winner (opponent 2) wins the first grand final match
  const [first] = await grandFinal(stage.id);
  await getManager().update.match({ id: first.id, opponent1: { result: 'loss' }, opponent2: { result: 'win' } });
  const before = await results(stage.id);
  assert.equal((await grandFinal(stage.id)).length, 1);

  const on = await setGrandFinalDouble(stage.id, true);
  assert.equal(on.dropped, 0);
  assert.equal((await findStage(on.stage_id)).settings.grandFinal, 'double');
  assert.deepEqual(await results(on.stage_id), before);
  const [, second] = await grandFinal(on.stage_id);
  assert.equal(second.status, Status.Ready, 'the second match is needed now');

  await play(on.stage_id);
  assert.equal((await results(on.stage_id)).length, before.length + 1);
  const off = await setGrandFinalDouble(on.stage_id, false);
  assert.equal(off.dropped, 1, 'only the second grand final match');
  assert.equal((await findStage(off.stage_id)).settings.grandFinal, 'simple');
  assert.equal((await grandFinal(off.stage_id)).length, 1);
  assert.deepEqual(await results(off.stage_id), before);

  assert.deepEqual(await setGrandFinalDouble(off.stage_id, false), { stage_id: off.stage_id, dropped: 0 });
  // The winner bracket winner won the first match: switching on keeps every result
  const other = await tournament(event.name, 'double_elimination');
  await play(other.id);
  const decided = await results(other.id);
  const again = await setGrandFinalDouble(other.id, true);
  assert.equal((await grandFinal(again.stage_id)).length, 2);
  assert.deepEqual(await results(again.stage_id), decided);

  const se = await tournament(event.name, 'single_elimination');
  await assert.rejects(setGrandFinalDouble(se.id, true), /Double Elimination/);
});
