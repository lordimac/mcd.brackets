import { Router, Request, Response } from 'express';
import { getAppStore, withLock } from './db';
import { HttpError } from './http-error';
import { ValidationError } from './lan';
import { getEvent } from './lan-store';
import {
  applyImport, clearContainerCache, containerFor, createDockhandClient, dockhandView, EMPTY_DOCKHAND, importCandidate, isDockhandConfigured,
  itemView, planItem, validateDockhandSettings, type ContainerAction, type DockhandContainer, type DockhandSettingsData, type ImportItem,
} from './dockhand';
import { clearStatusCache, findServer, GAMES, GameServerNotFound, listServers, saveServers, type GameId } from './gameservers';

// Dockhand: settings and import are admin only (also GET, see auth.ts); the container state
// comes with the public game server status (gameserver-routes.ts uses containerStates)
export const dockhandRouter = Router();

type IdParams = { id: string };
type ServerParams = { id: string; serverId: string };

function idParam(req: Request<IdParams>): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new HttpError(400, 'Ungültige ID');
  return id;
}

async function storedSettings() {
  return ((await getAppStore().select('dockhand')) ?? [])[0] ?? null;
}

export async function dockhandSettings(): Promise<DockhandSettingsData> {
  const stored = await storedSettings();
  if (!stored) return EMPTY_DOCKHAND;
  const { id: _id, ...settings } = stored;
  return settings;
}

dockhandRouter.get('/dockhand', async (_req: Request, res: Response) => {
  res.json(dockhandView(await dockhandSettings()));
});

dockhandRouter.put('/dockhand', async (req: Request, res: Response) => {
  const settings = await withLock(async () => {
    const stored = await storedSettings();
    const next = validateDockhandSettings(req.body ?? {}, stored ?? EMPTY_DOCKHAND);
    if (stored) await getAppStore().update('dockhand', stored.id, { ...next, id: stored.id });
    else await getAppStore().insert('dockhand', next);
    return next;
  });
  clearContainerCache();
  res.json(dockhandView(settings));
});

// Test with the form values (empty token = stored one): lists the Docker environments to choose from
dockhandRouter.post('/dockhand/test', async (req: Request, res: Response) => {
  const settings = validateDockhandSettings(req.body ?? {}, await dockhandSettings());
  const client = createDockhandClient(settings, null);
  const environments = await client.environments();
  let containers: number | null = null;
  if (settings.env_id !== null && environments.some(e => e.id === settings.env_id)) {
    containers = (await createDockhandClient(settings).containers()).length;
  }
  res.json({ ok: true, environments, containers });
});

async function configuredClient() {
  const settings = await dockhandSettings();
  if (!isDockhandConfigured(settings)) throw new ValidationError('Dockhand ist nicht eingerichtet (Adresse, API-Token und Docker-Umgebung)');
  return createDockhandClient(settings);
}

// Candidates for all containers: env variables only for recognized ones (or the given games)
async function buildPlan(eventId: number, overrides: Map<string, GameId> = new Map(), only?: Set<string>): Promise<{ items: ImportItem[]; containers: DockhandContainer[] }> {
  const client = await configuredClient();
  const [containers, servers] = await Promise.all([client.containers(), listServers(eventId)]);
  const items = await Promise.all(containers
    .filter(c => !only || only.has(c.id))
    .map(async container => {
      const override = overrides.get(container.id);
      const recognized = override ?? importCandidate(container, null).game;
      const env = recognized ? await client.environment(container.id).catch(() => null) : null;
      return planItem(importCandidate(container, env, override), servers);
    }));
  const order = { update: 0, create: 1, 'no-host': 2, unchanged: 3, unknown: 4 } as const;
  items.sort((a, b) => order[a.action] - order[b.action] || a.candidate.container_name.localeCompare(b.candidate.container_name, 'de'));
  return { items, containers };
}

dockhandRouter.post('/events/:id/dockhand/preview', async (req: Request<IdParams>, res: Response) => {
  const event = await getEvent(idParam(req));
  const { items } = await buildPlan(event.id);
  res.json({ items: items.map(itemView) });
});

// Body { items: [{ container_id, game }] }: only these containers, with the chosen game
dockhandRouter.post('/events/:id/dockhand/apply', async (req: Request<IdParams>, res: Response) => {
  const event = await getEvent(idParam(req));
  const chosen = Array.isArray(req.body?.items) ? req.body.items as { container_id?: unknown; game?: unknown }[] : [];
  const overrides = new Map<string, GameId>();
  for (const item of chosen) {
    if (typeof item?.container_id !== 'string') continue;
    if (typeof item.game !== 'string' || !Object.hasOwn(GAMES, item.game)) throw new ValidationError('Für jeden gewählten Container ein Spiel angeben');
    overrides.set(item.container_id, item.game as GameId);
  }
  if (!overrides.size) throw new ValidationError('Keine Container gewählt');
  const { items } = await buildPlan(event.id, overrides, new Set(overrides.keys()));
  const servers = await withLock(async () => saveServers(event.id, applyImport(items, await listServers(event.id))));
  clearContainerCache();
  res.json({
    created: items.filter(i => i.action === 'create').length,
    updated: items.filter(i => i.action === 'update').length,
    skipped: items.filter(i => i.action === 'no-host').map(i => i.candidate.container_name),
    servers: servers.length,
  });
});

// Body { action: start|stop|restart }
dockhandRouter.post('/events/:id/gameservers/:serverId/container', async (req: Request<ServerParams>, res: Response) => {
  const action = req.body?.action as ContainerAction;
  if (!['start', 'stop', 'restart'].includes(action)) throw new ValidationError('Unbekannte Container-Aktion');
  let server;
  try {
    server = await findServer(idParam(req), req.params.serverId);
  } catch (error) {
    if (error instanceof GameServerNotFound) throw new HttpError(404, 'Server nicht gefunden');
    throw error;
  }
  if (!server.container) throw new ValidationError('Der Server ist mit keinem Container verknüpft (über „Aus Dockhand“ übernehmen)');
  const client = await configuredClient();
  const container = containerFor(server, await client.containers());
  if (!container) throw new HttpError(404, `Container ${server.container.name} gibt es in Dockhand nicht mehr`);
  await client.action(container.id, action);
  clearContainerCache();
  clearStatusCache();
  res.json({ ok: true, action, container: container.name });
});
