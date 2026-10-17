import type { Id, Stage, StageSettings, StageType } from 'brackets-model';
import { getManager, getStorage } from './db';
import { buildSeeding } from './seeding';
import { HttpError } from './http-error';

// Stage as stored by this app: brackets-manager stage plus our event name
export type AppStage = Stage & { event_name?: string };

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
}

export async function createStage({ tournamentId, name, type, names, settings, eventName }: CreateStageInput): Promise<AppStage> {
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
    seeding: buildSeeding(names, type),
    settings
  });

  if (!eventName) return stage;

  // Re-read the stored stage: the object returned by create.stage lacks settings
  // brackets-manager adds afterwards (e.g. seedOrdering), which must not be overwritten
  const stored = await findStage(stage.id);
  const withEvent: AppStage = { ...stored, event_name: eventName };
  await getStorage().update('stage', stage.id, withEvent);
  return withEvent;
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
