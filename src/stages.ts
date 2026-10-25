import type { Id, Stage, StageSettings, StageType } from 'brackets-model';
import { getManager, getStorage } from './db';
import { ordering } from 'brackets-manager/dist/ordering';
import { buildSeeding, nextPowerOfTwo, shuffle } from './seeding';
import { HttpError } from './http-error';
import type { RoundDeadline } from './schedule';

// Stage as stored by this app: brackets-manager stage plus our event name, the memorial
// entries ("In Gedenken"), which take part by name but always as a bye, and the players who
// left the event after the tournament had started (withdrawn: they lose their open matches by
// forfeit) or joined too late for a started bracket (late: not in this tournament, see stage-sync.ts)
// schedule: deadlines per round (schedule.ts).
// memorial_seats: in elimination brackets the memorial entries are BYEs with a name — seed
// position (as string) → name; they are no participants, so they never play or advance.
export type AppStage = Stage & {
  event_name?: string; memorial_names?: string[]; withdrawn_names?: string[]; late_names?: string[]; schedule?: RoundDeadline[];
  memorial_seats?: Record<string, string>;
};

// Round 1 layout of an elimination bracket, from its seed orderings: who meets whom (seed position
// → opponent's position), which match a position plays in, and — double elimination — whose
// losers meet in round 1 of the loser bracket (match number → other match number)
export interface SeatLayout {
  partners: Map<number, number>;
  matchOf: Map<number, number>;
  positionsOf: Map<number, number[]>;
  loserPartner?: Map<number, number>;
}

export function seatLayout(type: StageType, size: number, seedOrdering: string[] = []): SeatLayout {
  const pick = (method: string | undefined, fallback: keyof typeof ordering) => ordering[(method ?? fallback) as keyof typeof ordering] ?? ordering[fallback];
  const slots: number[] = pick(seedOrdering[0], 'inner_outer')([...Array(size).keys()].map(i => i + 1), 0);
  const layout: SeatLayout = { partners: new Map(), matchOf: new Map(), positionsOf: new Map() };
  for (let i = 0; i + 1 < slots.length; i += 2) {
    const match = i / 2 + 1;
    layout.partners.set(slots[i], slots[i + 1]);
    layout.partners.set(slots[i + 1], slots[i]);
    layout.matchOf.set(slots[i], match);
    layout.matchOf.set(slots[i + 1], match);
    layout.positionsOf.set(match, [slots[i], slots[i + 1]]);
  }
  if (type === 'double_elimination') {
    const losers: number[] = pick(seedOrdering[1], 'natural')([...Array(size / 2).keys()].map(i => i + 1), 0);
    layout.loserPartner = new Map();
    for (let i = 0; i + 1 < losers.length; i += 2) {
      layout.loserPartner.set(losers[i], losers[i + 1]);
      layout.loserPartner.set(losers[i + 1], losers[i]);
    }
  }
  return layout;
}

// How good a BYE place is for a memorial entry: +2 if a player is its round 1 opponent (the
// player gets the bye), +1 if in the loser bracket the loser of a real match arrives there
function seatScore(seeding: readonly unknown[], position: number, layout?: SeatLayout): number {
  if (!layout) return 0;
  const isPlayer = (p: number | undefined) => p !== undefined && seeding[p - 1] != null;
  let score = isPlayer(layout.partners.get(position)) ? 2 : 0;
  const other = layout.loserPartner?.get(layout.matchOf.get(position) ?? 0);
  if (other !== undefined && (layout.positionsOf.get(other) ?? []).every(isPlayer)) score += 1;
  return score;
}

export function seatsScore(seeding: readonly unknown[], seats: Record<string, string>, layout?: SeatLayout): number {
  return Object.keys(seats).reduce((sum, position) => sum + seatScore(seeding, Number(position), layout), 0);
}

// Bracket size for elimination: every memorial entry needs a BYE place whose round 1 opponent
// is a player (as far as there are enough players for that)
export function eliminationSize(players: number, memorial: number): number {
  let size = nextPowerOfTwo(Math.max(players, 2));
  while (size - players < memorial || (Math.min(players, size - players) < memorial && size - players < players)) size *= 2;
  return size;
}

// Players drawn at random, BYEs (null) after them up to the bracket size
export function drawElimination(players: readonly string[], memorialCount: number, random: () => number = Math.random): (string | null)[] {
  const seeding: (string | null)[] = shuffle(players, random);
  const size = eliminationSize(players.length, memorialCount);
  while (seeding.length < size) seeding.push(null);
  return seeding;
}

// Seeds the memorial names on BYE places (null in the seeding): the best places first (see
// seatScore — a player gets the bye, in the loser bracket a real loser arrives), so a memorial
// entry stands where a player would otherwise get a bye. Existing seats stay where their name is
// still on the list and the place is still a BYE. Names without a free BYE are left out.
export function assignMemorialSeats(seeding: readonly unknown[], memorial: readonly string[], existing: Record<string, string> = {}, layout?: SeatLayout): Record<string, string> {
  const seats: Record<string, string> = {};
  const wanted = new Set(memorial);
  for (const [position, name] of Object.entries(existing)) {
    if (wanted.has(name) && seeding[Number(position) - 1] == null && !Object.values(seats).includes(name)) seats[position] = name;
  }
  const seated = new Set(Object.values(seats));
  const free = seeding.flatMap((value, i) => (value == null && !seats[i + 1] ? [i + 1] : []))
    .sort((a, b) => seatScore(seeding, b, layout) - seatScore(seeding, a, layout) || b - a);
  for (const name of memorial.filter(n => !seated.has(n))) {
    const position = free.shift();
    if (position === undefined) break;
    seats[position] = name;
  }
  return seats;
}

// Status.Ready from brackets-model (only a type dependency at runtime)
const MATCH_READY = 2;

// Settings that survive regenerating a stage (size and seed ordering are derived again)
const PRESERVED_SETTINGS = ['grandFinal', 'groupCount', 'roundRobinMode', 'consolationFinal', 'skipFirstRound'] as const;

export function pickSettings(source: Partial<StageSettings> | undefined): StageSettings {
  const settings: Record<string, unknown> = {};
  for (const key of PRESERVED_SETTINGS) {
    if (source?.[key] !== undefined) settings[key] = source[key];
  }
  return settings as StageSettings;
}

export interface CreateStageInput {
  tournamentId: Id;
  name: string;
  type: StageType;
  names: string[];
  settings: StageSettings;
  eventName?: string;
  memorial?: string[];
}

export async function createStage({ tournamentId, name, type, names, settings, eventName, memorial = [] }: CreateStageInput): Promise<AppStage> {
  if (names.length < 2) {
    throw new HttpError(400, 'Mindestens 2 Teilnehmer erforderlich');
  }
  if (type === 'round_robin' && !settings.groupCount) {
    settings = { ...settings, groupCount: 1 };
  }

  // Elimination: memorial entries take BYE places (with their name), round robin: they play
  // and lose every match by forfeit
  const elimination = type !== 'round_robin';
  const seeding = elimination ? drawElimination(names, memorial.length) : buildSeeding(names, type, memorial);
  const stage = await getManager().create.stage({ tournamentId, name, type, seeding, settings });

  if (!eventName && memorial.length === 0) return stage;

  // Re-read the stored stage: the object returned by create.stage lacks settings
  // brackets-manager adds afterwards (e.g. seedOrdering), which must not be overwritten
  const stored: AppStage = { ...await findStage(stage.id) };
  if (eventName) stored.event_name = eventName;
  if (memorial.length > 0) stored.memorial_names = [...memorial];
  if (elimination && memorial.length > 0) {
    stored.memorial_seats = assignMemorialSeats(seeding, memorial, {}, seatLayout(type, seeding.length, stored.settings.seedOrdering));
  }
  await getStorage().update('stage', stage.id, stored);
  await resolveMemorialMatches(stage.id);
  return stored;
}

// Memorial entries in round robin and withdrawn players lose every match by forfeit as soon as
// it is playable, so their opponents advance. If two of them meet, both lose (double forfeit).
// (In elimination brackets memorial entries are BYEs, see memorial_seats.)
// Call after creating a stage and after every result.
export async function resolveMemorialMatches(stageId: Id): Promise<void> {
  const stage = await findStage(stageId);
  const memorialIds = await autoForfeitIds(stage);
  if (memorialIds.size === 0) return;
  const isMemorial = (id: Id | null | undefined) => id != null && memorialIds.has(id);

  // Each forfeit can make further matches playable; the bound only guards against loops
  for (let step = 0; step < 1000; step++) {
    const matches = (await getStorage().select('match', { stage_id: stageId })) ?? [];
    const match = matches.find(m => m.status === MATCH_READY && (isMemorial(m.opponent1?.id) || isMemorial(m.opponent2?.id)));
    if (!match) return;
    await getManager().update.match({
      id: match.id,
      ...(isMemorial(match.opponent1?.id) ? { opponent1: { forfeit: true } } : {}),
      ...(isMemorial(match.opponent2?.id) ? { opponent2: { forfeit: true } } : {}),
    });
  }
}

// Participants who lose automatically: memorial entries and withdrawn players
export async function autoForfeitIds(stage: AppStage): Promise<Set<Id>> {
  return participantIdsByName(stage, [...stage.memorial_names ?? [], ...stage.withdrawn_names ?? []]);
}

// Participant IDs of the memorial entries of a stage
export async function memorialParticipantIds(stage: AppStage): Promise<Set<Id>> {
  return participantIdsByName(stage, stage.memorial_names ?? []);
}

async function participantIdsByName(stage: AppStage, names: string[]): Promise<Set<Id>> {
  const wanted = new Set(names);
  if (wanted.size === 0) return new Set();
  const players = (await getStorage().select('participant', { tournament_id: stage.tournament_id })) ?? [];
  return new Set(players.filter(p => wanted.has(p.name)).map(p => p.id));
}

// Delete a stage including all participants of its tournament
// (brackets-manager handles matches/rounds/groups)
export async function deleteStage(stage: Stage): Promise<void> {
  await getStorage().delete('participant', { tournament_id: stage.tournament_id });
  await getManager().delete.stage(stage.id);
}

export async function findStage(id: Id): Promise<AppStage> {
  const stage = await getStorage().select('stage', id);
  if (!stage) throw new HttpError(404, 'Stage not found');
  return stage;
}
