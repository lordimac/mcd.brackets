import type { BracketsManager } from 'brackets-manager';
import type { CrudInterface, Group, Id, Match, Participant, Round, Stage } from 'brackets-model';

// Championship points by placement (index 0 = 1st place); everyone below gets 1 point
export const POINTS_SYSTEM = [30, 22, 16, 12, 9, 7, 5, 3, 2, 2, 2, 2, 1, 1, 1, 1];

export function pointsForPlacement(placement: number): number {
  return POINTS_SYSTEM[placement - 1] ?? 1;
}

export interface Standing {
  placement: number;
  participant_id: Id;
  participant_name: string;
  wins: number;
  losses: number;
  pending: number;
  points: number;
}

interface RankedParticipant {
  id: Id;
  name: string;
  wins: number;
  losses: number;
}

interface EliminationStats extends RankedParticipant {
  finalMatch: Match | null; // The last match they played
  finalMatchRound: number;
  finalMatchGroup: number;
  wonFinalMatch: boolean;
}

export async function getStandings(storage: CrudInterface, manager: BracketsManager, stageId: Id): Promise<Standing[] | null> {
  const stage = await storage.select('stage', stageId);
  if (!stage) return null;

  const matches = (await storage.select('match', { stage_id: stageId })) ?? [];
  // Memorial entries ("In Gedenken") are byes and don't appear in the standings
  const memorial = new Set((stage as Stage & { memorial_names?: string[] }).memorial_names ?? []);
  const participants = ((await storage.select('participant', { tournament_id: stage.tournament_id })) ?? [])
    .filter(p => p.name && !memorial.has(p.name)); // Skip BYE

  let ranked: RankedParticipant[];
  if (stage.type === 'round_robin') {
    ranked = (await rankRoundRobin(manager, stageId)).filter(p => !memorial.has(p.name));
  } else {
    const groups = (await storage.select('group', { stage_id: stageId })) ?? [];
    const rounds = (await storage.select('round', { stage_id: stageId })) ?? [];
    ranked = calculatePlacements(stage, matches, groups, rounds, participants);
  }

  return ranked.map((p, index) => ({
    placement: index + 1,
    participant_id: p.id,
    participant_name: p.name,
    wins: p.wins,
    losses: p.losses,
    pending: countPending(matches, p.id),
    points: pointsForPlacement(index + 1),
  }));
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

export function calculatePlacements(stage: Stage, matches: Match[], groups: Group[], rounds: Round[], participants: Participant[]): RankedParticipant[] {
  if (stage.type === 'double_elimination') {
    // For double elimination, we need to track final match results
    // Winner = champion, runner-up = grand final loser, 3rd = LB final loser, etc.
    const participantData = new Map<Id, EliminationStats>();

    participants.forEach(p => {
      participantData.set(p.id, {
        id: p.id,
        name: p.name,
        wins: 0,
        losses: 0,
        finalMatch: null,
        finalMatchRound: 0,
        finalMatchGroup: 0,
        wonFinalMatch: false
      });
    });

    // Process all matches to track participant progress
    matches.forEach(match => {
      if (match.opponent1?.id == null || match.opponent2?.id == null) return;
      if (!match.opponent1.result && !match.opponent2.result) return; // Skip unplayed matches

      const p1 = participantData.get(match.opponent1.id);
      const p2 = participantData.get(match.opponent2.id);

      if (!p1 || !p2) return;

      const round = rounds.find(r => r.id === match.round_id);
      const group = groups.find(g => g.id === match.group_id);

      if (!round || !group) return;

      const winner = match.opponent1.result === 'win' ? p1 : p2;
      const loser = match.opponent1.result === 'win' ? p2 : p1;

      winner.wins++;
      loser.losses++;

      // Update final match for both players
      const isLaterMatch = (group.number > winner.finalMatchGroup) ||
                          (group.number === winner.finalMatchGroup && round.number > winner.finalMatchRound);

      if (isLaterMatch || !winner.finalMatch) {
        winner.finalMatch = match;
        winner.finalMatchRound = round.number;
        winner.finalMatchGroup = group.number;
        winner.wonFinalMatch = true;
      }

      const isLaterMatchLoser = (group.number > loser.finalMatchGroup) ||
                               (group.number === loser.finalMatchGroup && round.number > loser.finalMatchRound);

      if (isLaterMatchLoser || !loser.finalMatch) {
        loser.finalMatch = match;
        loser.finalMatchRound = round.number;
        loser.finalMatchGroup = group.number;
        loser.wonFinalMatch = false;
      }
    });

    // Sort by final placement:
    // 1. Players who won their final match and reached later rounds are ranked higher
    // 2. Among those eliminated in the same round, more wins = better
    return Array.from(participantData.values())
      .sort((a, b) => {
        // First, sort by the group they reached (higher group number = finals)
        if (b.finalMatchGroup !== a.finalMatchGroup) {
          return b.finalMatchGroup - a.finalMatchGroup;
        }

        // If same group, check if they won or lost their final match
        if (a.wonFinalMatch !== b.wonFinalMatch) {
          return a.wonFinalMatch ? -1 : 1;
        }

        // If same group and same outcome, sort by round reached
        if (b.finalMatchRound !== a.finalMatchRound) {
          return b.finalMatchRound - a.finalMatchRound;
        }

        // Then by total wins
        if (b.wins !== a.wins) {
          return b.wins - a.wins;
        }

        // Finally by losses (fewer = better)
        return a.losses - b.losses;
      });
  }

  // For single elimination, simpler logic
  const participantStats = new Map<Id, RankedParticipant>();

  participants.forEach(p => {
    participantStats.set(p.id, { id: p.id, name: p.name, wins: 0, losses: 0 });
  });

  matches.forEach(match => {
    const p1 = match.opponent1?.id != null ? participantStats.get(match.opponent1.id) : undefined;
    const p2 = match.opponent2?.id != null ? participantStats.get(match.opponent2.id) : undefined;

    if (match.opponent1?.result === 'win' && p1 && p2) {
      p1.wins++;
      p2.losses++;
    } else if (match.opponent2?.result === 'win' && p1 && p2) {
      p2.wins++;
      p1.losses++;
    }
  });

  return Array.from(participantStats.values())
    .sort((a, b) => {
      if (b.wins !== a.wins) return b.wins - a.wins;
      return a.losses - b.losses;
    });
}
