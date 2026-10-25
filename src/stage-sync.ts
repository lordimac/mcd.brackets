import type { Id, Match, Participant, ParticipantResult, StageSettings } from 'brackets-model';
import { ordering } from 'brackets-manager/dist/ordering';
import { getManager, getStorage, withRollback } from './db';
import { playerNamesForEvent } from './lan-store';
import { HttpError } from './http-error';
import { followingResults } from './results';
import { buildSeeding, nextPowerOfTwo, shuffle } from './seeding';
import { assignMemorialSeats, autoForfeitIds, drawElimination, eliminationSize, findStage, resolveMemorialMatches, seatLayout, seatsScore, type AppStage } from './stages';

// Keeps the tournaments of an event in line with its attendees (players + memorial names).
// Called after every change of the attendees or the memorial list.
//
// - Not started (no real result yet): leaving players are taken out, new ones take free places
//   (BYEs) in the existing draw; if the bracket size has to change, it is drawn again.
// - Started: leaving players leave the bracket too. Their place becomes a BYE, or a new player
//   takes it; the results they took part in and what followed from them are dropped. Other new
//   players take a free place (BYE) in round 1 whose following matches haven't been played yet.
//   The stage is rebuilt with the same seeding and all remaining results are entered again.
//   Round robin: leaving players' matches disappear, new players get matches against everyone.
//   Without a free place a new player can't join this tournament any more (late_names).

const STATUS_RUNNING = 3;
const STATUS_COMPLETED = 4;
const STATUS_READY = 2;

export interface StageSyncReport {
  stage_id: Id;      // after a rebuild the stage (and its matches) have new IDs
  old_stage_id: Id;
  name: string;
  added: string[];     // play from now on
  removed: string[];   // taken out of the bracket (place: BYE or a new player)
  dropped: number;     // results dropped because a removed player took part (or they followed from it)
  late: string[];      // newly unable to join: started bracket without a free place
  redrawn: boolean;    // not started and the bracket size changed: new draw
  error?: string;      // unexpected problem: this tournament was left unchanged
}

// A result between two real opponents that was played (not a forfeit)
const isRealResult = (m: Match) => m.status >= STATUS_RUNNING
  && m.opponent1?.id != null && m.opponent2?.id != null && !m.opponent1.forfeit && !m.opponent2.forfeit;

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export async function syncEventStages(eventName: string): Promise<StageSyncReport[]> {
  const names = await playerNamesForEvent(eventName);
  if (!names) return [];
  const stages = ((await getStorage().select('stage')) ?? []) as AppStage[];
  const reports: StageSyncReport[] = [];
  for (const stage of stages.filter(s => s.event_name === eventName)) {
    try {
      const report = await withRollback(() => syncStage(stage.id, names.players, names.memorial));
      if (report) reports.push(report);
    } catch (error) {
      console.error(`Abgleich von Turnier ${stage.name} fehlgeschlagen:`, error);
      reports.push({ ...emptyReport(stage), error: error instanceof Error ? error.message : String(error) });
    }
  }
  return reports;
}

function emptyReport(stage: AppStage): StageSyncReport {
  return { stage_id: stage.id, old_stage_id: stage.id, name: stage.name, added: [], removed: [], dropped: 0, late: [], redrawn: false };
}

async function syncStage(stageId: Id, players: string[], memorial: string[]): Promise<StageSyncReport | null> {
  const stage = await findStage(stageId);
  const participants: Participant[] = (await getStorage().select('participant', { tournament_id: stage.tournament_id })) ?? [];
  const known = new Set(participants.map(p => p.name));
  // Elimination: memorial entries are named BYEs (memorial_seats), no participants
  const memorialPlays = stage.type === 'round_robin';
  const desired = memorialPlays ? [...players, ...memorial] : [...players];
  const desiredSet = new Set(desired);
  const memorialSet = new Set(memorial);
  const lateBefore = new Set(stage.late_names ?? []);

  // Leaving: participants no longer among the attendees (also players marked "withdrawn" by
  // older versions); in elimination brackets memorial entries are no participants
  const joining = desired.filter(name => !known.has(name));
  const leavingPlayers = participants.filter(p => p.name && !desiredSet.has(p.name) && (memorialPlays || !memorialSet.has(p.name)));
  const memorialChanged = !sameList(stage.memorial_names ?? [], memorial);
  const lateChanged = [...lateBefore].some(name => !desiredSet.has(name));
  const legacyWithdrawn = (stage.withdrawn_names ?? []).length > 0;
  if (!joining.length && !leavingPlayers.length && !memorialChanged && !lateChanged && !legacyWithdrawn) return null;

  const report = emptyReport(stage);
  const matches: Match[] = (await getStorage().select('match', { stage_id: stage.id })) ?? [];

  if (!matches.some(isRealResult)) {
    return syncNotStarted(stage, participants, players, memorial, report);
  }

  // Started: leaving players' places become BYEs (or go to new players), new players take free
  // places (elimination) or get matches against everyone (round robin)
  const leavingIds = new Set(leavingPlayers.map(p => p.id));
  let seedingIds: (Id | null)[];
  const vacated: number[] = [];
  if (memorialPlays) {
    seedingIds = (await roundRobinSeeding(stage, participants)).filter(id => !leavingIds.has(id!));
  } else {
    seedingIds = (await eliminationSeeding(stage)).seedingIds.map((id, i) => {
      if (id == null || !leavingIds.has(id)) return id;
      vacated.push(i);
      return null;
    });
  }
  const places = joining.length ? await planNewcomers(stage, joining, vacated) : [];
  const placedNames = new Set(places.map(p => p.name));
  const notPlaced = joining.filter(name => !placedNames.has(name));
  report.late = notPlaced.filter(name => !lateBefore.has(name));
  const late = [...new Set([...lateBefore, ...notPlaced])].filter(name => desiredSet.has(name) && !placedNames.has(name));

  const fields: StageFields = { memorial_names: [...memorial], withdrawn_names: [], late_names: late };
  const seatsFor = (seeding: unknown[]) => (memorialPlays ? undefined
    : assignMemorialSeats(seeding, memorial, stage.memorial_seats, seatLayout(stage.type, seeding.length, stage.settings.seedOrdering)));

  if (leavingPlayers.length || places.length || legacyWithdrawn) {
    for (const { name, index } of places) {
      const id = await getStorage().insert('participant', { tournament_id: stage.tournament_id, name }) as Id;
      if (index === null) seedingIds.push(id);
      else seedingIds[index] = id;
    }
    const rebuilt = await rebuildStage(stage, seedingIds, { ...fields, memorial_seats: seatsFor(seedingIds) }, true);
    for (const p of leavingPlayers) await getStorage().delete('participant', { id: p.id });
    report.stage_id = rebuilt.stageId;
    report.dropped = rebuilt.dropped;
    report.removed = leavingPlayers.map(p => p.name);
    report.added = [...placedNames];
    return report;
  }

  if (!memorialPlays) fields.memorial_seats = seatsFor(seedingIds);
  await saveStageFields(stage.id, fields);
  await resolveMemorialMatches(stage.id);
  return report;
}

// Where the newcomers go (index into the seeding, null = appended for round robin). Elimination:
// first the places of players who just left, then BYE slots of round 1 whose following matches
// have no result yet — plain BYEs before memorial places. Nobody joins once the deadline of
// round 1 has passed (round robin: any deadline): the new match would be decided by lot at once.
// Nothing is written here.
async function planNewcomers(stage: AppStage, newcomers: string[], vacated: number[]): Promise<{ name: string; index: number | null }[]> {
  const overdue = (stage.schedule ?? []).filter(d => d.ends_at && Date.parse(d.ends_at) <= Date.now());
  const tooLate = stage.type === 'round_robin' ? overdue.length > 0 : overdue.some(d => d.group === 1 && d.round === 1);
  if (tooLate) return [];
  if (stage.type === 'round_robin') return newcomers.map(name => ({ name, index: null }));

  const { freeSlots } = await eliminationSeeding(stage);
  const seats = stage.memorial_seats ?? {};
  const free: number[] = [];
  const seated: number[] = [];
  for (const { position, matchId } of freeSlots) {
    if ((await followingResults(matchId)).length > 0) continue;
    (seats[position] ? seated : free).push(position - 1);
  }
  return [...shuffle(vacated), ...shuffle(free), ...shuffle(seated)]
    .slice(0, newcomers.length)
    .map((index, i) => ({ name: newcomers[i], index }));
}

// Seeding of an elimination stage, read from round 1 of the winner bracket: opponents carry their
// seed position. BYE positions are the missing ones; the seed ordering of round 1 tells which
// match each position belongs to.
async function eliminationSeeding(stage: AppStage): Promise<{ seedingIds: (Id | null)[]; freeSlots: { position: number; matchId: Id; side: 1 | 2 }[] }> {
  const size = stage.settings.size;
  const method = stage.settings.seedOrdering?.[0];
  if (!size || !method || !(method in ordering)) throw new Error('Setzliste des Turniers unbekannt');

  const firstRound = await roundOneMatches(stage);
  const seedingIds: (Id | null)[] = Array(size).fill(null);
  for (const match of firstRound) {
    for (const side of [match.opponent1, match.opponent2]) {
      if (side?.id != null && side.position) seedingIds[side.position - 1] = side.id;
    }
  }

  const slots: number[] = ordering[method as keyof typeof ordering]([...Array(size).keys()].map(i => i + 1), 0);
  const freeSlots: { position: number; matchId: Id; side: 1 | 2 }[] = [];
  firstRound.forEach((match, i) => {
    ([[slots[2 * i], 1], [slots[2 * i + 1], 2]] as const).forEach(([position, side]) => {
      if (seedingIds[position - 1] == null && match.number === i + 1) freeSlots.push({ position, matchId: match.id, side });
    });
  });
  return { seedingIds, freeSlots };
}

async function roundOneMatches(stage: AppStage): Promise<Match[]> {
  const groups = (await getStorage().select('group', { stage_id: stage.id })) ?? [];
  const winnerBracket = groups.find(g => g.number === 1);
  if (!winnerBracket) throw new Error('Gruppe 1 fehlt');
  const rounds = (await getStorage().select('round', { group_id: winnerBracket.id })) ?? [];
  const first = rounds.find(r => r.number === 1);
  if (!first) throw new Error('Runde 1 fehlt');
  return ((await getStorage().select('match', { round_id: first.id })) ?? []).sort((a, b) => a.number - b.number);
}

// Round robin: keep the order of the current participants (by group, then position)
async function roundRobinSeeding(stage: AppStage, participants: Participant[]): Promise<(Id | null)[]> {
  const matches: Match[] = (await getStorage().select('match', { stage_id: stage.id })) ?? [];
  const inStage = new Set(matches.flatMap(m => [m.opponent1?.id, m.opponent2?.id]).filter((id): id is Id => id != null));
  return participants.filter(p => inStage.has(p.id)).map(p => p.id);
}

// Not started: nothing to keep but the draw. Leaving players are removed; new ones take BYE
// places. If the bracket size changes (or for round robin), the stage is drawn again.
async function syncNotStarted(stage: AppStage, participants: Participant[], players: string[], memorial: string[], report: StageSyncReport): Promise<StageSyncReport> {
  const memorialPlays = stage.type === 'round_robin'; // elimination: memorial entries are named BYEs
  const desired = new Set(memorialPlays ? [...players, ...memorial] : players);
  const leaving = participants.filter(p => !desired.has(p.name));
  report.removed = leaving.map(p => p.name).filter(name => !(stage.withdrawn_names ?? []).includes(name));
  for (const p of leaving) await getStorage().delete('participant', { id: p.id });
  const remaining = participants.filter(p => desired.has(p.name));
  const known = new Set(remaining.map(p => p.name));
  const joining = (memorialPlays ? [...players, ...memorial] : players).filter(name => !known.has(name));
  report.added = joining;
  const fields: StageFields = { memorial_names: [...memorial], withdrawn_names: [], late_names: [] };

  const count = remaining.length + joining.length;
  if (count < 2) throw new Error('Mindestens 2 Teilnehmer erforderlich');

  // Memorial entries need BYE places of their own, so they count for the bracket size
  const keepDraw = !memorialPlays && eliminationSize(count, memorial.length) === stage.settings.size;
  if (keepDraw) {
    const { seedingIds } = await eliminationSeeding(stage);
    const remainingIds = new Set(remaining.map(p => p.id));
    const kept = seedingIds.map(id => (id != null && remainingIds.has(id) ? id : null));
    // New players on plain BYEs first, memorial places only when nothing else is free
    const seats = stage.memorial_seats ?? {};
    const nulls = kept.flatMap((id, i) => (id == null ? [i] : []));
    const free = [...shuffle(nulls.filter(i => !seats[i + 1])), ...shuffle(nulls.filter(i => seats[i + 1]))];
    for (const [i, name] of joining.entries()) {
      kept[free[i]] = await getStorage().insert('participant', { tournament_id: stage.tournament_id, name }) as Id;
    }
    const layout = seatLayout(stage.type, kept.length, stage.settings.seedOrdering);
    report.stage_id = (await rebuildStage(stage, kept, { ...fields, memorial_seats: assignMemorialSeats(kept, memorial, seats, layout) })).stageId;
    return report;
  }

  // New draw (players shuffled, memorial entries after them, BYEs at the end)
  for (const p of remaining) await getStorage().delete('participant', { id: p.id });
  const seeding = memorialPlays ? buildSeeding(players, stage.type, memorial) : drawElimination(players, memorial.length);
  report.redrawn = !memorialPlays;
  report.stage_id = await recreateWithNames(stage, seeding, fields);
  if (!memorialPlays) {
    const created = await findStage(report.stage_id);
    const memorial_seats = assignMemorialSeats(seeding, memorial, {}, seatLayout(created.type, seeding.length, created.settings.seedOrdering));
    const withSeats: AppStage = { ...created, memorial_seats };
    await getStorage().update('stage', created.id, withSeats);
  }
  return report;
}

type StageFields = Pick<AppStage, 'memorial_names' | 'withdrawn_names' | 'late_names' | 'memorial_seats'>;

async function saveStageFields(stageId: Id, fields: StageFields): Promise<void> {
  const stored = await findStage(stageId);
  await getStorage().update('stage', stageId, { ...stored, ...fields });
}

// Old results with their position in the bracket, to be entered again after a rebuild
interface PlayedResult {
  group: number;
  round: number;
  number: number;
  results: Map<Id, Partial<ParticipantResult>>;
  drawn: boolean; // decided by lot after a deadline (schedule.ts)
}

async function playedResults(stageId: Id): Promise<PlayedResult[]> {
  const groups = (await getStorage().select('group', { stage_id: stageId })) ?? [];
  const rounds = (await getStorage().select('round', { stage_id: stageId })) ?? [];
  const matches: Match[] = (await getStorage().select('match', { stage_id: stageId })) ?? [];
  return matches
    .filter(m => m.status >= STATUS_COMPLETED && m.opponent1?.id != null && m.opponent2?.id != null)
    .map(m => ({
      group: groups.find(g => g.id === m.group_id)?.number ?? 0,
      round: rounds.find(r => r.id === m.round_id)?.number ?? 0,
      number: m.number,
      results: new Map([m.opponent1!, m.opponent2!].map(side => [side.id!, { result: side.result, forfeit: side.forfeit, score: side.score }])),
      drawn: !!(m as Match & { drawn?: boolean }).drawn,
    }));
}

// Deletes and creates the stage again with the given seeding (participant IDs, null = BYE),
// keeping name, type, settings and our own fields, then enters all previous results again.
// Throws if a result can't be placed (the caller rolls back).
// With allowDrop, results that no longer fit (a removed player took part) are dropped and counted.
async function rebuildStage(stage: AppStage, seedingIds: (Id | null)[], fields: StageFields, allowDrop = false): Promise<{ stageId: Id; dropped: number }> {
  const previous = await playedResults(stage.id);
  await getManager().delete.stage(stage.id);
  const settings: StageSettings = stage.type === 'round_robin' ? { ...stage.settings, size: seedingIds.length } : stage.settings;
  const created = await getManager().create.stage({ tournamentId: stage.tournament_id, name: stage.name, type: stage.type, seedingIds, settings });
  await storeFields(created.id, stage, fields);
  const dropped = await replayResults(created.id, stage.type === 'round_robin', previous, await autoForfeitIds(await findStage(created.id)), allowDrop);
  await resolveMemorialMatches(created.id);
  return { stageId: created.id, dropped };
}

// New draw by names (nothing played yet): creates the participants anew
async function recreateWithNames(stage: AppStage, seeding: (string | null)[], fields: StageFields): Promise<Id> {
  await getManager().delete.stage(stage.id);
  const settings: StageSettings = { ...stage.settings };
  delete settings.size;
  delete settings.seedOrdering;
  const created = await getManager().create.stage({ tournamentId: stage.tournament_id, name: stage.name, type: stage.type, seeding, settings });
  await storeFields(created.id, stage, fields);
  await resolveMemorialMatches(created.id);
  return created.id;
}

// Re-read the stored stage (the object from create.stage lacks e.g. seedOrdering) and add our fields
async function storeFields(stageId: Id, previous: AppStage, fields: StageFields): Promise<void> {
  const stored: AppStage = { ...await findStage(stageId) };
  if (previous.event_name) stored.event_name = previous.event_name;
  if (previous.schedule) stored.schedule = previous.schedule; // same rounds: deadlines stay
  Object.assign(stored, fields);
  await getStorage().update('stage', stageId, stored);
}

// Enters the previous results again: a result goes to the ready match at the same place
// (elimination: group, round, number; round robin: same group) with the same two opponents.
// Results that happen automatically (a forfeit of a memorial entry or withdrawn player, two of
// them against each other) are not copied but decided again by resolveMemorialMatches, so a
// wrong old decision is fixed. Each result can make further matches ready, so this runs until
// nothing changes.
async function replayResults(stageId: Id, roundRobin: boolean, previous: PlayedResult[], autoIds: Set<Id> = new Set(), allowDrop = false): Promise<number> {
  const automatic = (p: PlayedResult) => {
    const sides = [...p.results.entries()];
    return sides.every(([id]) => autoIds.has(id)) || sides.some(([id, r]) => r.forfeit && autoIds.has(id));
  };
  const pending = previous.filter(p => !automatic(p));
  const completed = async () => ((await getStorage().select('match', { stage_id: stageId })) ?? []).filter(m => m.status >= STATUS_COMPLETED).length;
  for (let progress = true; progress && pending.length > 0;) {
    progress = false;
    const before = await completed();
    await resolveMemorialMatches(stageId);
    if ((await completed()) > before) progress = true;
    const groups = (await getStorage().select('group', { stage_id: stageId })) ?? [];
    const rounds = (await getStorage().select('round', { stage_id: stageId })) ?? [];
    const ready = ((await getStorage().select('match', { stage_id: stageId })) ?? []).filter(m => m.status === STATUS_READY);

    for (const match of ready) {
      const group = groups.find(g => g.id === match.group_id)?.number;
      const round = rounds.find(r => r.id === match.round_id)?.number;
      const ids = [match.opponent1?.id, match.opponent2?.id];
      const index = pending.findIndex(p => p.group === group
        && (roundRobin || (p.round === round && p.number === match.number))
        && ids.every(id => id != null && p.results.has(id)));
      if (index < 0) continue;
      const [result] = pending.splice(index, 1);
      await getManager().update.match({
        id: match.id,
        opponent1: result.results.get(match.opponent1!.id!),
        opponent2: result.results.get(match.opponent2!.id!),
      });
      if (result.drawn) {
        const stored = await getStorage().select('match', match.id);
        if (stored) await getStorage().update('match', match.id, { ...stored, drawn: true } as Match);
      }
      progress = true;
      break; // statuses changed: read the matches again
    }
  }
  if (pending.length > 0 && !allowDrop) throw new Error(`${pending.length} Ergebnis(se) ließen sich nicht übertragen`);
  return pending.length;
}

// Memorial entries of elimination brackets as named BYEs, for the viewer: [{ match_id, side, name }].
// Round 1 of the winner bracket, and in double elimination also round 1 of the loser bracket,
// where the "loser" of their winner bracket match would go (they lose there automatically, too).
export async function memorialByes(stage: AppStage): Promise<{ match_id: Id; side: 1 | 2; name: string }[]> {
  const seats = stage.memorial_seats;
  if (stage.type === 'round_robin' || !seats || Object.keys(seats).length === 0) return [];
  const { freeSlots } = await eliminationSeeding(stage);
  const winnerBracket = freeSlots.filter(slot => seats[slot.position]).map(slot => ({ match_id: slot.matchId, side: slot.side, name: seats[slot.position] }));
  if (stage.type !== 'double_elimination') return winnerBracket;

  // Loser bracket round 1: the losers of winner bracket round 1 (in match order), ordered by the
  // second seed ordering and paired like brackets-manager does when creating the stage
  const firstRound = await roundOneMatches(stage);
  const lbRound1 = await loserRoundOneMatches(stage);
  const method = stage.settings.seedOrdering?.[1] ?? 'natural';
  const order = ordering[method as keyof typeof ordering] ?? ordering.natural;
  const losers: number[] = order(firstRound.map(m => m.number), 0);
  const loserBracket = winnerBracket.flatMap(entry => {
    const wbNumber = firstRound.find(m => m.id === entry.match_id)?.number;
    const index = losers.indexOf(wbNumber!);
    const match = lbRound1.find(m => m.number === Math.floor(index / 2) + 1);
    const side = (index % 2 === 0 ? 1 : 2) as 1 | 2;
    if (index < 0 || !match || (side === 1 ? match.opponent1 : match.opponent2) !== null) return [];
    return [{ match_id: match.id, side, name: entry.name }];
  });
  return [...winnerBracket, ...loserBracket];
}

async function loserRoundOneMatches(stage: AppStage): Promise<Match[]> {
  const groups = (await getStorage().select('group', { stage_id: stage.id })) ?? [];
  const loserBracket = groups.find(g => g.number === 2);
  if (!loserBracket) return [];
  const rounds = (await getStorage().select('round', { group_id: loserBracket.id })) ?? [];
  const first = rounds.find(r => r.number === 1);
  if (!first) return [];
  return ((await getStorage().select('match', { round_id: first.id })) ?? []).sort((a, b) => a.number - b.number);
}

async function improveMemorialSeats(stage: AppStage): Promise<boolean> {
  const current = stage.memorial_seats ?? {};
  const names = stage.memorial_names ?? [];
  if (names.length === 0) return false;
  const { seedingIds } = await eliminationSeeding(stage);
  const layout = seatLayout(stage.type, seedingIds.length, stage.settings.seedOrdering);
  const best = assignMemorialSeats(seedingIds, names, {}, layout);
  if (seatsScore(seedingIds, best, layout) <= seatsScore(seedingIds, current, layout)) return false;
  const updated: AppStage = { ...stage, memorial_seats: best };
  await getStorage().update('stage', stage.id, updated);
  return true;
}

// Runs at startup and brings older tournaments up to date, keeping every real result:
// - elimination brackets in which memorial entries still take part as players (older versions:
//   they lost by forfeit, could meet in the loser bracket and even "win" against a BYE) are
//   rebuilt with the same seeding, the memorial entries as named BYEs;
// - round robin stages in which one memorial entry beat another are rebuilt (both lose).
export async function migrateMemorialStages(): Promise<string[]> {
  const changed: string[] = [];
  for (const stage of ((await getStorage().select('stage')) ?? []) as AppStage[]) {
    const memorial = new Set(stage.memorial_names ?? []);
    const participants: Participant[] = (await getStorage().select('participant', { tournament_id: stage.tournament_id })) ?? [];
    const matches: Match[] = (await getStorage().select('match', { stage_id: stage.id })) ?? [];
    const inMatches = new Set(matches.flatMap(m => [m.opponent1?.id, m.opponent2?.id]).filter((id): id is Id => id != null));
    const fields: StageFields = { memorial_names: stage.memorial_names ?? [], withdrawn_names: stage.withdrawn_names ?? [], late_names: stage.late_names ?? [] };
    try {
      if (stage.type !== 'round_robin') {
        const memorialPlayers = participants.filter(p => memorial.has(p.name));
        if (!memorialPlayers.some(p => inMatches.has(p.id))) {
          // Already named BYEs: move the names to better BYE places if there are any. Only labels
          // move — a BYE stays a BYE, so this never changes the bracket.
          if (!(await improveMemorialSeats(stage))) continue;
          changed.push(stage.name);
          continue;
        }
        await withRollback(async () => {
          const memorialIds = new Map(memorialPlayers.map(p => [p.id, p.name]));
          const { seedingIds } = await eliminationSeeding(stage);
          const seats: Record<string, string> = {};
          const seeding = seedingIds.map((id, i) => {
            if (id == null || !memorialIds.has(id)) return id;
            seats[i + 1] = memorialIds.get(id)!;
            return null;
          });
          await rebuildStage(stage, seeding, { ...fields, memorial_seats: seats });
          for (const p of memorialPlayers) await getStorage().delete('participant', { id: p.id });
        });
      } else {
        const auto = await autoForfeitIds(stage);
        const wrong = matches.some(m => m.opponent1?.id != null && m.opponent2?.id != null
          && auto.has(m.opponent1.id) && auto.has(m.opponent2.id)
          && (m.opponent1.result === 'win' || m.opponent2.result === 'win'));
        if (!wrong) continue;
        await withRollback(async () => {
          await rebuildStage(stage, await roundRobinSeeding(stage, participants), fields);
        });
      }
      changed.push(stage.name);
    } catch (error) {
      console.error(`Turnier ${stage.name} ließ sich nicht umstellen:`, error);
    }
  }
  return changed;
}

// Settings that can change after the start. brackets-manager can't change them on an existing
// stage, so the stage is rebuilt with the same seeding and all results are entered again;
// results of matches that no longer exist are dropped and counted.
async function rebuildWithSettings(stage: AppStage, settings: StageSettings): Promise<{ stage_id: Id; dropped: number }> {
  const { seedingIds } = await eliminationSeeding(stage);
  const changed: AppStage = { ...stage, settings: { ...stage.settings, ...settings } };
  const { stageId: newId, dropped } = await rebuildStage(changed, seedingIds, {
    memorial_names: stage.memorial_names ?? [],
    withdrawn_names: stage.withdrawn_names ?? [],
    late_names: stage.late_names ?? [],
    memorial_seats: stage.memorial_seats,
  }, true);
  return { stage_id: newId, dropped };
}

// Switches the match for 3rd place of a single elimination tournament on or off;
// switching it off drops only the result of the 3rd place match.
export async function setConsolationFinal(stageId: Id, enabled: boolean): Promise<{ stage_id: Id; dropped: number }> {
  const stage = await findStage(stageId);
  if (stage.type !== 'single_elimination') throw new HttpError(400, 'Ein Spiel um Platz 3 gibt es nur bei Single Elimination');
  if (!!stage.settings.consolationFinal === enabled) return { stage_id: stage.id, dropped: 0 };
  return rebuildWithSettings(stage, { consolationFinal: enabled });
}

// Switches the second grand final match of a double elimination tournament (played when the
// loser bracket winner wins the first one) on or off; switching it off drops only its result.
export async function setGrandFinalDouble(stageId: Id, enabled: boolean): Promise<{ stage_id: Id; dropped: number }> {
  const stage = await findStage(stageId);
  if (stage.type !== 'double_elimination') throw new HttpError(400, 'Ein Grand Final mit Rückspiel gibt es nur bei Double Elimination');
  if ((stage.settings.grandFinal === 'double') === enabled) return { stage_id: stage.id, dropped: 0 };
  return rebuildWithSettings(stage, { grandFinal: enabled ? 'double' : 'simple' });
}
