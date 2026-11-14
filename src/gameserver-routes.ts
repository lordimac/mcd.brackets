import { Router, Request, Response } from 'express';
import { withLock } from './db';
import { isAdmin } from './auth';
import { HttpError } from './http-error';
import { getEvent, listAttendees } from './lan-store';
import { GameServerError } from './gameserver-protocols';
import { cachedContainers, containerFor, DockhandError, isDockhandConfigured, type DockhandContainer } from './dockhand';
import { dockhandSettings } from './dockhand-routes';
import {
  actionCommand, availableActions, cachedStatus, findServer, GameServerNotFound, listServers, playerMatcher, runCommand, saveServers,
  serverView, statusView, validateCommand, type GameServer,
} from './gameservers';

// Game servers of an event: list and status are public, saving and administration need the
// admin session (auth.ts lets only GET through)
export const gameServerRouter = Router();

type IdParams = { id: string };
type ServerParams = { id: string; serverId: string };

function idParam(req: Request<IdParams>): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new HttpError(400, 'Ungültige ID');
  return id;
}

async function serverOf(req: Request<ServerParams>): Promise<GameServer> {
  try {
    return await findServer(idParam(req), req.params.serverId);
  } catch (error) {
    if (error instanceof GameServerNotFound) throw new HttpError(404, 'Server nicht gefunden');
    throw error;
  }
}

const listView = (servers: GameServer[], admin: boolean) =>
  servers.map(server => ({ ...serverView(server, admin), actions: availableActions(server.game) }));

gameServerRouter.get('/events/:id/gameservers', async (req: Request<IdParams>, res: Response) => {
  const event = await getEvent(idParam(req));
  res.json(listView(await listServers(event.id), isAdmin(req)));
});

// Body { servers: [...] }: always the complete list
gameServerRouter.put('/events/:id/gameservers', async (req: Request<IdParams>, res: Response) => {
  const eventId = idParam(req);
  await getEvent(eventId);
  const servers = await withLock(() => saveServers(eventId, req.body?.servers));
  res.json(listView(servers, true));
});

// Status of all servers of the event, queried in parallel (cached for a few seconds)
gameServerRouter.get('/events/:id/gameservers/status', async (req: Request<IdParams>, res: Response) => {
  const event = await getEvent(idParam(req));
  const [servers, attendees] = await Promise.all([listServers(event.id), listAttendees(event.id)]);
  const match = playerMatcher(event, attendees);
  const admin = isAdmin(req);
  // Container state from Dockhand for linked servers (one cached list call)
  const settings = await dockhandSettings();
  let containers: DockhandContainer[] | null = null;
  let dockhandError: string | null = null;
  const [statuses] = await Promise.all([
    Promise.all(servers.map(server => cachedStatus(server))),
    (async () => {
      if (!isDockhandConfigured(settings) || !servers.some(s => s.container)) return;
      try {
        containers = await cachedContainers(settings);
      } catch (error) {
        dockhandError = error instanceof DockhandError ? error.message : 'Dockhand nicht erreichbar';
      }
    })(),
  ]);
  res.setHeader('Cache-Control', 'no-store');
  res.json(statuses.map((status, i) => {
    const server = servers[i];
    const container = containers && server.container ? containerFor(server, containers) : null;
    return {
      ...statusView(status, match, admin),
      container: !server.container || (!containers && !dockhandError) ? null
        : container ? { name: container.name, state: container.state, status: container.status }
        : { name: server.container.name, state: containers ? 'missing' : 'unknown', status: '' },
      ...(admin && dockhandError && server.container ? { dockhand_error: dockhandError } : {}),
    };
  }));
});

async function execute(res: Response, server: GameServer, command: string) {
  try {
    res.json({ command, output: (await runCommand(server, command)).trimEnd() });
  } catch (error) {
    if (error instanceof GameServerError) throw new HttpError(502, error.message);
    throw error;
  }
}

// Body { command }: free console command (RCON or WebAdmin console)
gameServerRouter.post('/events/:id/gameservers/:serverId/rcon', async (req: Request<ServerParams>, res: Response) => {
  const server = await serverOf(req);
  await execute(res, server, validateCommand(req.body?.command));
});

// Body { action: say|map|restart|next|kick, value }: the command is built on the server
gameServerRouter.post('/events/:id/gameservers/:serverId/action', async (req: Request<ServerParams>, res: Response) => {
  const server = await serverOf(req);
  await execute(res, server, actionCommand(server.game, req.body?.action, req.body?.value));
});
