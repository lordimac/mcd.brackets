import type { Group, Id, Match, ParticipantResult, Round } from 'brackets-model';
import { getManager, getStorage } from './db';
import { HttpError } from './http-error';
import { findStage, memorialParticipantIds, resolveMemorialMatches, type AppStage } from './stages';

// Correcting results. brackets-manager archives a match as soon as a following match has a
// result, and then refuses to change it ("The match is locked."). To correct such a match, the
// results of all following matches (transitively: winner and loser paths) are reset first, last
// ones first, and have to be entered again. Matches that don't depend on it keep their results.

// Status values from brackets-model (only a type dependency at runtime)
const STATUS_RUNNING = 3;

// A match with a result (or a running score) between two known opponents. BYE matches are
// completed automatically and follow their previous matches by themselves.
const isPlayed = (m: Match) => m.status >= STATUS_RUNNING && m.opponent1?.id != null && m.opponent2?.id != null;

export interface FollowingResult {
  id: Id;
  label: string;
  opponent1: ParticipantResult | null;
  opponent2: ParticipantResult | null;
}

// All played matches whose opponents depend on the given match, in bracket order
export async function followingResults(matchId: Id): Promise<Match[]> {
  const match = await getStorage().select('match', matchId);
  if (!match) throw new HttpError(404, 'Match nicht gefunden');
  const stage = await findStage(match.stage_id);
  if (stage.type === 'round_robin') return []; // every round robin match stands on its own

  const found = new Map<Id, Match>();
  const queue: Id[] = [matchId];
  while (queue.length) {
    for (const next of await getManager().find.nextMatches(queue.shift()!)) {
      // Matches without result end the chain; BYE matches pass it on
      if (next.status < STATUS_RUNNING || found.has(next.id)) continue;
      found.set(next.id, next);
      queue.push(next.id);
    }
  }
  return [...found.values()].filter(isPlayed).sort((a, b) => Number(a.id) - Number(b.id));
}

// Resets the given matches; a match can only be reset once its own following matches are open again
async function resetResults(matches: Match[]): Promise<void> {
  const pending = new Set(matches.map(m => m.id));
  for (let pass = 0; pending.size > 0; pass++) {
    if (pass > matches.length) throw new Error('Folgeergebnisse ließen sich nicht zurücksetzen');
    for (const id of [...pending]) {
      const next = await getManager().find.nextMatches(id);
      if (next.some(isPlayed)) continue;
      await getManager().reset.matchResults(id);
      await clearDrawn(id);
      pending.delete(id);
    }
  }
}

// Input is partial: a score is only compared when it is given
// Results decided by lot after a deadline carry drawn: true (schedule.ts)
async function clearDrawn(matchId: Id): Promise<void> {
  const stored = await getStorage().select('match', matchId) as (Match & { drawn?: boolean }) | null;
  if (stored?.drawn) await getStorage().update('match', matchId, { ...stored, drawn: false } as Match);
}

const sameResult = (a: ParticipantResult | null | undefined, b: Partial<ParticipantResult> | null | undefined) =>
  (a?.result ?? null) === (b?.result ?? null) && !!a?.forfeit === !!b?.forfeit
  && (b?.score === undefined || b.score === a?.score);

export interface ResultInput {
  opponent1?: Partial<ParticipantResult>;
  opponent2?: Partial<ParticipantResult>;
  resetFollowing?: boolean;
}

// Sets a match result. If following matches already have results, they are only reset with
// resetFollowing (the frontend shows them first); otherwise the change is refused with 409.
// Run inside withLock + withRollback: a failure halfway must not leave the bracket half reset.
export async function updateMatchResult(matchId: Id, input: ResultInput): Promise<Match | null> {
  const match = await getStorage().select('match', matchId);
  if (!match) throw new HttpError(404, 'Match nicht gefunden');
  const stage = await findStage(match.stage_id);

  const memorial = await memorialParticipantIds(stage);
  if ([match.opponent1?.id, match.opponent2?.id].some(id => id != null && memorial.has(id))) {
    throw new HttpError(400, 'Matches mit einem Gedenk-Eintrag werden automatisch entschieden');
  }

  // The same result again (e.g. the same winner clicked twice): nothing to change, but a result
  // decided by lot is now confirmed by hand
  if (sameResult(match.opponent1, input.opponent1) && sameResult(match.opponent2, input.opponent2)) {
    await clearDrawn(matchId);
    return getStorage().select('match', matchId);
  }

  const following = await followingResults(matchId);
  if (following.length > 0) {
    if (input.resetFollowing !== true) {
      throw new HttpError(409, `Für dieses Match gibt es ${following.length} Folgeergebnis(se), die erst zurückgesetzt werden müssen`);
    }
    await resetResults(following);
  }

  await getManager().update.match({ id: matchId, opponent1: input.opponent1, opponent2: input.opponent2 });
  await clearDrawn(matchId); // entered by hand: no longer "per Los"
  await resolveMemorialMatches(match.stage_id); // next matches may be against a memorial entry
  return getStorage().select('match', matchId);
}

// Readable position of a match, e.g. "Winner Bracket · Runde 2 · Match 1"
export async function matchLabel(stage: AppStage, match: Match): Promise<string> {
  const group = await getStorage().select('group', match.group_id) as Group | null;
  const round = await getStorage().select('round', match.round_id) as Round | null;
  const rounds = ((await getStorage().select('round', { group_id: match.group_id })) ?? []).length;
  const groupNumber = group?.number ?? 1;
  const roundNumber = round?.number ?? 1;

  if (stage.type === 'single_elimination') {
    if (groupNumber === 2) return 'Spiel um Platz 3';
    if (roundNumber === rounds) return 'Finale';
    if (roundNumber === rounds - 1) return `Halbfinale · Match ${match.number}`;
    return `Runde ${roundNumber} · Match ${match.number}`;
  }
  if (groupNumber === 3) return roundNumber === 1 ? 'Grand Final' : 'Grand Final · Rückspiel';
  const bracket = groupNumber === 1 ? 'Winner Bracket' : 'Loser Bracket';
  return `${bracket} · Runde ${roundNumber} · Match ${match.number}`;
}

export async function describeFollowing(matchId: Id): Promise<{ label: string; following: FollowingResult[] }> {
  const match = await getStorage().select('match', matchId);
  if (!match) throw new HttpError(404, 'Match nicht gefunden');
  const stage = await findStage(match.stage_id);
  const following = await followingResults(matchId);
  return {
    label: stage.type === 'round_robin' ? `Match ${match.number}` : await matchLabel(stage, match),
    following: await Promise.all(following.map(async m => ({
      id: m.id,
      label: await matchLabel(stage, m),
      opponent1: m.opponent1,
      opponent2: m.opponent2,
    }))),
  };
}
