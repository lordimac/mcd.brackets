import crypto from 'crypto';
import type { Group, Id, Match, Round } from 'brackets-model';
import { getManager, getStorage, withLock, withRollback } from './db';
import { HttpError } from './http-error';
import { findStage, resolveMemorialMatches, type AppStage } from './stages';

// Playing times per round ("Spielzeiten"). Only rounds of a single elimination bracket and of the
// winner bracket of a double elimination have a deadline ("spielen bis"); the loser bracket and
// round robin have none. When a round's deadline has passed, every match of that round that is
// still open but playable is decided by lot; the match gets drawn: true (shown as "per Los").
// A correction of the result removes the mark (results.ts).
// The matches for places 1–3 (single elimination: semifinal, 3rd place match, final; double
// elimination: grand final and the loser bracket final, whose loser is 3rd) get a start time
// instead: no deadline, never by lot.
// Times are stored on the stage by group and round number, so they survive rebuilding the stage
// (stage-sync.ts) and a new draw.

export interface RoundDeadline {
  group: number;       // group number (elimination: 1 winner bracket, 2 loser bracket / 3rd place, 3 grand final)
  round: number;       // round number within the group
  label: string;       // e.g. "Winner Bracket · Runde 2"
  ends_at?: string;    // ISO timestamp: deadline (normal rounds)
  starts_at?: string;  // ISO timestamp: start (matches for places 1–3)
}

// deadline: "spielen bis" (lot afterwards), start: "ab" (places 1–3), none: no time at all
export type RoundKind = 'deadline' | 'start' | 'none';

const STATUS_READY = 2;
const CHECK_INTERVAL_MS = 30_000;

// Readable name of a round, like the match labels in results.ts
export function roundLabel(stage: AppStage, groupNumber: number, roundNumber: number, roundCount: number, groupCount: number): string {
  if (stage.type === 'round_robin') return groupCount > 1 ? `Gruppe ${groupNumber} · Runde ${roundNumber}` : `Runde ${roundNumber}`;
  if (stage.type === 'single_elimination') {
    if (groupNumber === 2) return 'Spiel um Platz 3';
    if (roundNumber === roundCount) return 'Finale';
    if (roundNumber === roundCount - 1) return 'Halbfinale';
    return `Runde ${roundNumber}`;
  }
  if (groupNumber === 3) return roundNumber === 1 ? 'Grand Final' : 'Grand Final · Rückspiel';
  if (groupNumber === 2 && roundNumber === roundCount) return 'Loser Bracket · Finale (Platz 3)';
  return `${groupNumber === 1 ? 'Winner Bracket' : 'Loser Bracket'} · Runde ${roundNumber}`;
}

// Matches for places 1–3 get a start time: single elimination semifinal, final and 3rd place
// match; double elimination grand final (both rounds) and the last loser bracket round
// Other loser bracket rounds and round robin rounds have no time.
export function roundKind(type: AppStage['type'], group: number, round: number, roundCounts: Map<number, number>): RoundKind {
  if (type === 'round_robin') return 'none';
  if (type === 'single_elimination') return group === 2 || round >= (roundCounts.get(1) ?? 1) - 1 ? 'start' : 'deadline';
  if (group === 3) return 'start';
  if (group === 2) return round === roundCounts.get(2) ? 'start' : 'none';
  return 'deadline';
}

export interface RoundInfo {
  round_id: Id;
  group: number;
  round: number;
  label: string;
  slot: number; // play slot ("Spielrunde") for the shared schedule of an event
  kind: RoundKind;
  ends_at: string | null;   // deadline (kind 'deadline')
  starts_at: string | null; // start (kind 'start')
}

// Play slot of a round, so all tournaments of an event can share one schedule ("Spielrunde n"):
// round n of a single bracket, winner bracket or round robin → n; loser bracket round k → k + 1
// (its players come from the winner round before); grand final round r → after the loser
// bracket; the match for 3rd place is played with the final.
export function playSlot(type: AppStage['type'], group: number, round: number, roundCounts: Map<number, number>): number {
  if (type === 'round_robin' || group === 1) return round;
  if (type === 'single_elimination') return roundCounts.get(1) ?? round; // 3rd place
  if (group === 2) return round + 1;
  return (roundCounts.get(2) ?? 0) + 1 + round;
}

// All rounds of a stage in bracket order, with their deadline
export async function stageRounds(stageId: Id): Promise<RoundInfo[]> {
  const stage = await findStage(stageId);
  const groups: Group[] = (await getStorage().select('group', { stage_id: stageId })) ?? [];
  const rounds: Round[] = (await getStorage().select('round', { stage_id: stageId })) ?? [];
  const deadlines = stage.schedule ?? [];
  const roundCounts = new Map(groups.map(g => [g.number, rounds.filter(r => r.group_id === g.id).length]));
  return [...groups].sort((a, b) => a.number - b.number).flatMap(group => {
    const own = rounds.filter(r => r.group_id === group.id).sort((a, b) => a.number - b.number);
    return own.map(round => {
      const kind = roundKind(stage.type, group.number, round.number, roundCounts);
      const stored = deadlines.find(d => d.group === group.number && d.round === round.number);
      return {
        round_id: round.id,
        group: group.number,
        round: round.number,
        label: roundLabel(stage, group.number, round.number, own.length, groups.length),
        slot: playSlot(stage.type, group.number, round.number, roundCounts),
        kind,
        // A time stored as deadline before a round became a "start" round counts as its start
        // (never by lot)
        ends_at: kind === 'deadline' ? stored?.ends_at ?? null : null,
        starts_at: kind === 'start' ? stored?.starts_at ?? stored?.ends_at ?? null : null,
      };
    });
  });
}

function parseTime(value: unknown, label: string): string | null {
  if (value == null || value === '') return null;
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(time)) throw new HttpError(400, `${label}: ungültige Uhrzeit`);
  return new Date(time).toISOString();
}

// Input: [{ group, round, ends_at | starts_at: ISO string | null }] — ends_at for normal rounds,
// starts_at for the matches for places 1–3; unknown rounds are rejected
export async function saveSchedule(stageId: Id, input: unknown): Promise<RoundInfo[]> {
  if (!Array.isArray(input)) throw new HttpError(400, 'rounds muss eine Liste sein');
  const rounds = await stageRounds(stageId);
  const schedule: RoundDeadline[] = [];
  for (const entry of input) {
    const round = rounds.find(r => r.group === entry?.group && r.round === entry?.round);
    if (!round) throw new HttpError(400, 'Unbekannte Runde');
    const base = { group: round.group, round: round.round, label: round.label };
    if (round.kind === 'none') continue; // no time for this round (loser bracket, round robin)
    if (round.kind === 'start') {
      const startsAt = parseTime(entry.starts_at, round.label);
      if (startsAt) schedule.push({ ...base, starts_at: startsAt });
    } else {
      const endsAt = parseTime(entry.ends_at, round.label);
      if (endsAt) schedule.push({ ...base, ends_at: endsAt });
    }
  }
  const stage: AppStage = { ...await findStage(stageId), schedule };
  await getStorage().update('stage', stageId, stage);
  return stageRounds(stageId);
}

/* Shared schedule for all tournaments of an event: deadlines by play slot, start times of the
   matches for places 1–3 per tournament */

export interface EventSlot {
  slot: number;
  ends_at: string | null; // the deadline all rounds of this slot share (null: none or different ones)
  mixed: boolean;         // the rounds of this slot have different deadlines right now
  rounds: { stage_id: Id; stage_name: string; label: string }[];
}

export interface EventFinal {
  stage_id: Id;
  stage_name: string;
  group: number;
  round: number;
  label: string;
  starts_at: string | null;
}

async function eventStages(eventName: string): Promise<AppStage[]> {
  return (((await getStorage().select('stage')) ?? []) as AppStage[]).filter(s => s.event_name === eventName);
}

export async function eventFinals(eventName: string): Promise<EventFinal[]> {
  const finals: EventFinal[] = [];
  for (const stage of await eventStages(eventName)) {
    for (const round of await stageRounds(stage.id)) {
      if (round.kind !== 'start') continue;
      finals.push({ stage_id: stage.id, stage_name: stage.name, group: round.group, round: round.round, label: round.label, starts_at: round.starts_at });
    }
  }
  return finals;
}

export async function eventSchedule(eventName: string): Promise<EventSlot[]> {
  const slots = new Map<number, EventSlot & { times: Set<string | null> }>();
  for (const stage of await eventStages(eventName)) {
    for (const round of await stageRounds(stage.id)) {
      if (round.kind !== 'deadline') continue;
      if (!slots.has(round.slot)) slots.set(round.slot, { slot: round.slot, ends_at: null, mixed: false, rounds: [], times: new Set() });
      const entry = slots.get(round.slot)!;
      entry.rounds.push({ stage_id: stage.id, stage_name: stage.name, label: round.label });
      entry.times.add(round.ends_at);
    }
  }
  return [...slots.values()].sort((a, b) => a.slot - b.slot).map(({ times, ...slot }) => ({
    ...slot,
    ends_at: times.size === 1 ? [...times][0] : null,
    mixed: times.size > 1,
  }));
}

// slots: [{ slot, ends_at: ISO string | null }] — every normal round of every tournament of the
// event gets the deadline of its slot (empty = no deadline); slots not in the input keep theirs.
// finals: [{ stage_id, group, round, starts_at }] — start times of the matches for places 1–3;
// finals not in the input keep theirs. Open matches of rounds already over are decided.
export async function saveEventSchedule(eventName: string, slotsInput: unknown, finalsInput: unknown = []): Promise<{ slots: EventSlot[]; finals: EventFinal[]; decided: number }> {
  if (!Array.isArray(slotsInput)) throw new HttpError(400, 'slots muss eine Liste sein');
  if (!Array.isArray(finalsInput)) throw new HttpError(400, 'finals muss eine Liste sein');
  const times = new Map<number, string | null>();
  for (const entry of slotsInput) {
    if (!Number.isInteger(entry?.slot)) throw new HttpError(400, 'Ungültige Spielrunde');
    times.set(entry.slot, parseTime(entry.ends_at, `Spielrunde ${entry.slot}`));
  }
  const starts = new Map<string, string | null>();
  for (const entry of finalsInput) {
    starts.set(`${entry?.stage_id}:${entry?.group}:${entry?.round}`, parseTime(entry?.starts_at, 'Finalspiel'));
  }

  let decided = 0;
  for (const stage of await eventStages(eventName)) {
    const rounds = await stageRounds(stage.id);
    await saveSchedule(stage.id, rounds.filter(r => r.kind !== 'none').map(r => {
      const key = `${stage.id}:${r.group}:${r.round}`;
      return r.kind === 'start'
        ? { group: r.group, round: r.round, starts_at: starts.has(key) ? starts.get(key) : r.starts_at }
        : { group: r.group, round: r.round, ends_at: times.has(r.slot) ? times.get(r.slot) : r.ends_at };
    }));
    decided += await decideOverdueMatches(stage.id);
  }
  return { slots: await eventSchedule(eventName), finals: await eventFinals(eventName), decided };
}

// Decides every playable open match whose round deadline has passed by lot.
// Repeats, because a decision can make a match of a later (also overdue) round playable.
export async function decideOverdueMatches(stageId: Id, now: number = Date.now(), random: () => number = () => crypto.randomInt(2)): Promise<number> {
  const stage = await findStage(stageId);
  if (!stage.schedule?.length) return 0;
  let decided = 0;
  for (let step = 0; step < 1000; step++) {
    const due = new Set((await stageRounds(stageId)).filter(r => r.ends_at && Date.parse(r.ends_at) <= now).map(r => r.round_id));
    if (due.size === 0) return decided;
    const matches: Match[] = (await getStorage().select('match', { stage_id: stageId })) ?? [];
    const match = matches.find(m => m.status === STATUS_READY && due.has(m.round_id) && m.opponent1?.id != null && m.opponent2?.id != null);
    if (!match) return decided;

    const firstWins = random() === 0;
    await getManager().update.match({
      id: match.id,
      opponent1: { result: firstWins ? 'win' : 'loss' },
      opponent2: { result: firstWins ? 'loss' : 'win' },
    });
    const stored = await getStorage().select('match', match.id);
    if (stored) await getStorage().update('match', match.id, { ...stored, drawn: true } as Match);
    await resolveMemorialMatches(stageId);
    decided++;
  }
  return decided;
}

async function decideAllOverdue(): Promise<void> {
  const stages = ((await getStorage().select('stage')) ?? []) as AppStage[];
  for (const stage of stages.filter(s => s.schedule?.length)) {
    try {
      const decided = await withLock(() => withRollback(() => decideOverdueMatches(stage.id)));
      if (decided > 0) console.log(`🎲 ${stage.name}: ${decided} Match(es) nach Rundenschluss per Los entschieden`);
    } catch (error) {
      console.error(`Spielzeiten von ${stage.name} konnten nicht geprüft werden:`, error);
    }
  }
}

// Checks the deadlines at startup and every 30 seconds
export function startScheduleChecks(): void {
  decideAllOverdue();
  setInterval(decideAllOverdue, CHECK_INTERVAL_MS).unref();
}
