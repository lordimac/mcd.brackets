import type { BracketsManager } from 'brackets-manager';
import type { CrudInterface, Group, Id, Match, Participant, Round, Stage } from 'brackets-model';
import { DEFAULT_POINTS, pointsForPlacement, type PointsConfig } from './points';

export interface Standing {
  placement: number | null;    // null = still in the tournament, the place is not final yet
  placement_to: number | null; // last place of a shared placement (= placement if not shared)
  participant_id: Id;
  participant_name: string;
  wins: number;
  losses: number;
  pending: number;
  points: number; // 0 while the place is open
}

interface RankedParticipant {
  id: Id;
  name: string;
  wins: number;
  losses: number;
  places?: [number, number] | null; // final (shared) place; null = open
}

export async function getStandings(
  storage: CrudInterface, manager: BracketsManager, stageId: Id, pointsConfig: PointsConfig = DEFAULT_POINTS,
): Promise<Standing[] | null> {
  const stage = await storage.select('stage', stageId);
  if (!stage) return null;

  const matches = (await storage.select('match', { stage_id: stageId })) ?? [];
  // Memorial entries ("In Gedenken") are byes and don't appear in the standings. Withdrawn
  // players (left the event during the tournament) only appear if they really played a match.
  const appStage = stage as Stage & { memorial_names?: string[]; withdrawn_names?: string[] };
  const withdrawn = new Set(appStage.withdrawn_names ?? []);
  const allParticipants = (await storage.select('participant', { tournament_id: stage.tournament_id })) ?? [];
  const played = playedParticipantIds(matches);
  const hidden = new Set([
    ...appStage.memorial_names ?? [],
    ...allParticipants.filter(p => withdrawn.has(p.name) && !played.has(p.id)).map(p => p.name),
  ]);
  const participants = allParticipants.filter(p => p.name && !hidden.has(p.name)); // Skip BYE

  let ranked: RankedParticipant[];
  if (stage.type === 'round_robin') {
    ranked = (await rankRoundRobin(manager, stageId)).filter(p => !hidden.has(p.name));
    // Places are final only when every match is played; until then the order is preliminary
    const finished = matches.every(m => m.opponent1 == null || m.opponent2 == null || !!m.opponent1.result || !!m.opponent2.result);
    ranked.forEach((p, index) => { p.places = finished ? [index + 1, index + 1] : null; });
  } else {
    const groups = (await storage.select('group', { stage_id: stageId })) ?? [];
    const rounds = (await storage.select('round', { stage_id: stageId })) ?? [];
    ranked = calculatePlacements(stage, matches, groups, rounds, participants);
  }

  return ranked.map(p => ({
    placement: p.places?.[0] ?? null,
    placement_to: p.places?.[1] ?? null,
    participant_id: p.id,
    participant_name: p.name,
    wins: p.wins,
    losses: p.losses,
    pending: countPending(matches, p.id),
    points: p.places ? sharedPoints(p.places, pointsConfig) : 0,
  }));
}

// A shared place (e.g. 5–6) gets the rounded average of the points of these places
export function sharedPoints([from, to]: [number, number], config: PointsConfig = DEFAULT_POINTS): number {
  let sum = 0;
  for (let place = from; place <= to; place++) sum += pointsForPlacement(place, config);
  return Math.round(sum / (to - from + 1));
}

// Participants with at least one result that was really played (not a forfeit or a BYE)
function playedParticipantIds(matches: Match[]): Set<Id> {
  const ids = new Set<Id>();
  for (const m of matches) {
    if (m.opponent1?.id == null || m.opponent2?.id == null) continue;
    if (!m.opponent1.result && !m.opponent2.result) continue;
    if (m.opponent1.forfeit || m.opponent2.forfeit) continue;
    ids.add(m.opponent1.id);
    ids.add(m.opponent2.id);
  }
  return ids;
}

// Playable matches (both opponents known) without a result yet
function countPending(matches: Match[], participantId: Id): number {
  return matches.filter(m =>
    m.opponent1?.id != null && m.opponent2?.id != null &&
    (m.opponent1.id === participantId || m.opponent2.id === participantId) &&
    !m.opponent1.result && !m.opponent2.result
  ).length;
}

// Round robin: 3 points per win, 1 per draw; ties are broken by brackets-manager (score difference).
// With several groups, the n-th placed of every group ranks before any (n+1)-th placed.
async function rankRoundRobin(manager: BracketsManager, stageId: Id): Promise<RankedParticipant[]> {
  const standings = await manager.get.finalStandings(stageId, {
    rankingFormula: item => 3 * item.wins + item.draws,
  });
  return [...standings]
    .sort((a, b) => a.rank - b.rank || b.points - a.points || b.scoreDifference - a.scoreDifference)
    .map(s => ({ id: s.id, name: s.name, wins: s.wins, losses: s.losses }));
}

// Elimination: the place follows only from the round in which someone is out; everyone out in the
// same round shares the place (wins don't count — a BYE would be a disadvantage otherwise). The
// size of each round is known from the bracket (matches without a BYE), so places are final as soon
// as someone is out, also while the tournament is still running; players still in are open.
export function calculatePlacements(stage: Stage, matches: Match[], groups: Group[], rounds: Round[], participants: Participant[]): RankedParticipant[] {
  const groupOf = (m: Match) => groups.find(g => g.id === m.group_id)?.number ?? 0;
  const roundOf = (m: Match) => rounds.find(r => r.id === m.round_id)?.number ?? 0;
  const inGroup = (number: number) => matches.filter(m => groupOf(m) === number);
  const real = (m: Match) => m.opponent1 != null && m.opponent2 != null; // no BYE
  const decided = (m: Match | undefined) => {
    if (!m || m.opponent1?.id == null || m.opponent2?.id == null) return null;
    if (m.opponent1.result === 'win') return { winner: m.opponent1.id, loser: m.opponent2.id };
    if (m.opponent2.result === 'win') return { winner: m.opponent2.id, loser: m.opponent1.id };
    return null;
  };
  const roundSizes = (list: Match[]) => {
    const sizes = new Map<number, number>();
    for (const m of list) if (real(m)) sizes.set(roundOf(m), (sizes.get(roundOf(m)) ?? 0) + 1);
    return sizes;
  };

  // Places from best to worst as named slots with their size; outcome = participant → slot
  const slots: { key: string; size: number }[] = [{ key: 'first', size: 1 }, { key: 'second', size: 1 }];
  const outcome = new Map<Id, string>();
  const ignored = new Set<Match>(); // a second grand final match that wasn't needed

  if (stage.type === 'double_elimination') {
    const loserBracket = inGroup(2);
    const grandFinal = inGroup(3).sort((a, b) => roundOf(a) - roundOf(b));
    const sizes = roundSizes(loserBracket);
    const lastRound = Math.max(0, ...sizes.keys());
    for (let round = lastRound; round >= 1; round--) slots.push({ key: `lb${round}`, size: sizes.get(round) ?? 0 });
    for (const m of loserBracket) {
      const result = decided(m);
      if (!result) continue;
      if (grandFinal.length === 0 && roundOf(m) === lastRound) outcome.set(result.winner, 'second');
      outcome.set(result.loser, `lb${roundOf(m)}`);
    }
    if (grandFinal.length === 0) {
      // No grand final: the winner bracket winner is first, the loser bracket winner second
      const winnerBracket = inGroup(1);
      const final = winnerBracket.find(m => roundOf(m) === Math.max(...winnerBracket.map(roundOf)));
      const result = decided(final);
      if (result) outcome.set(result.winner, 'first');
    } else {
      // The first match decides if the winner bracket winner (opponent 1) wins it or there is no
      // second one; otherwise the second match decides
      const [first, second] = grandFinal;
      const firstResult = decided(first);
      const decisive = firstResult && (firstResult.winner === first.opponent1?.id || !second) ? first : second;
      if (second && decisive === first) ignored.add(second);
      const result = decided(decisive);
      if (result) {
        outcome.set(result.winner, 'first');
        outcome.set(result.loser, 'second');
      }
    }
  } else {
    const bracket = inGroup(1);
    const consolation = inGroup(2)[0];
    const hasConsolation = !!consolation && real(consolation);
    const sizes = roundSizes(bracket);
    const lastRound = Math.max(0, ...sizes.keys());
    // With a match for 3rd place, the semifinal losers are placed by that match
    if (hasConsolation) slots.push({ key: 'third', size: 1 }, { key: 'fourth', size: 1 });
    for (let round = lastRound - 1 - (hasConsolation ? 1 : 0); round >= 1; round--) slots.push({ key: `r${round}`, size: sizes.get(round) ?? 0 });
    for (const m of bracket) {
      const result = decided(m);
      if (!result) continue;
      if (roundOf(m) === lastRound) {
        outcome.set(result.winner, 'first');
        outcome.set(result.loser, 'second');
      } else if (!(hasConsolation && roundOf(m) === lastRound - 1)) {
        outcome.set(result.loser, `r${roundOf(m)}`);
      }
    }
    const result = hasConsolation ? decided(consolation) : null;
    if (result) {
      outcome.set(result.winner, 'third');
      outcome.set(result.loser, 'fourth');
    }
  }

  const places = new Map<string, [number, number]>();
  let next = 1;
  for (const slot of slots) {
    if (slot.size <= 0) continue;
    places.set(slot.key, [next, next + slot.size - 1]);
    next += slot.size;
  }

  const stats = new Map<Id, RankedParticipant>(participants.map(p => [p.id, { id: p.id, name: p.name, wins: 0, losses: 0 }]));
  for (const m of matches) {
    if (ignored.has(m)) continue;
    const result = decided(m);
    const winner = result && stats.get(result.winner);
    const loser = result && stats.get(result.loser);
    if (!winner || !loser) continue;
    winner.wins++;
    loser.losses++;
  }
  for (const p of stats.values()) {
    const slot = outcome.get(p.id);
    p.places = slot ? places.get(slot) ?? null : null;
  }

  // Players still in first (by their record so far), then by place, shared places by name
  return [...stats.values()].sort((a, b) => {
    if (!a.places !== !b.places) return a.places ? 1 : -1;
    if (a.places && b.places && a.places[0] !== b.places[0]) return a.places[0] - b.places[0];
    if (!a.places && (b.wins !== a.wins || a.losses !== b.losses)) return b.wins - a.wins || a.losses - b.losses;
    return a.name.localeCompare(b.name, 'de');
  });
}
