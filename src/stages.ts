import type { Id, Stage, StageSettings, StageType } from 'brackets-model';
import { getManager, getStorage } from './db';
import { buildSeeding } from './seeding';
import { HttpError } from './http-error';

// Stage as stored by this app: brackets-manager stage plus our event name and the
// memorial entries ("In Gedenken"), which take part by name but always as a bye
export type AppStage = Stage & { event_name?: string; memorial_names?: string[] };

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

  const stage = await getManager().create.stage({
    tournamentId,
    name,
    type,
    seeding: buildSeeding(names, type, memorial),
    settings
  });

  if (!eventName && memorial.length === 0) return stage;

  // Re-read the stored stage: the object returned by create.stage lacks settings
  // brackets-manager adds afterwards (e.g. seedOrdering), which must not be overwritten
  const stored: AppStage = { ...await findStage(stage.id) };
  if (eventName) stored.event_name = eventName;
  if (memorial.length > 0) stored.memorial_names = [...memorial];
  await getStorage().update('stage', stage.id, stored);
  await resolveMemorialMatches(stage.id);
  return stored;
}

// Memorial entries lose every match by forfeit as soon as it is playable, so their
// opponents advance. If two memorial entries meet, the first one advances.
// Call after creating a stage and after every result.
export async function resolveMemorialMatches(stageId: Id): Promise<void> {
  const stage = await findStage(stageId);
  const memorial = new Set(stage.memorial_names ?? []);
  if (memorial.size === 0) return;

  const players = (await getStorage().select('participant', { tournament_id: stage.tournament_id })) ?? [];
  const memorialIds = new Set<Id>(players.filter(p => memorial.has(p.name)).map(p => p.id));
  const isMemorial = (id: Id | null | undefined) => id != null && memorialIds.has(id);

  // Each forfeit can make further matches playable; the bound only guards against loops
  for (let step = 0; step < 1000; step++) {
    const matches = (await getStorage().select('match', { stage_id: stageId })) ?? [];
    const match = matches.find(m => m.status === MATCH_READY && (isMemorial(m.opponent1?.id) || isMemorial(m.opponent2?.id)));
    if (!match) return;
    const firstForfeits = isMemorial(match.opponent1?.id) && !isMemorial(match.opponent2?.id);
    await getManager().update.match(firstForfeits
      ? { id: match.id, opponent1: { forfeit: true } }
      : { id: match.id, opponent2: { forfeit: true } });
  }
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
