import { Router, Request, Response } from 'express';
import { withLock } from './db';
import { HttpError } from './http-error';
import { getEvent } from './lan-store';
import { getTimetable, saveTimetable, tournamentItems } from './timetable';

// Timetable of an event: reading is public, changes need the admin session (auth.ts)
export const timetableRouter = Router();

type IdParams = { id: string };

function idParam(req: Request<IdParams>): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new HttpError(400, 'Ungültige ID');
  return id;
}

async function view(eventId: number) {
  const event = await getEvent(eventId);
  return { ...await getTimetable(event.id), tournament_rounds: await tournamentItems(event.name) };
}

timetableRouter.get('/events/:id/timetable', async (req: Request<IdParams>, res: Response) => {
  res.json(await view(idParam(req)));
});

// Body { entries, notes }: the whole timetable (the frontend always sends everything)
timetableRouter.put('/events/:id/timetable', async (req: Request<IdParams>, res: Response) => {
  const eventId = idParam(req);
  await getEvent(eventId);
  await withLock(() => saveTimetable(eventId, req.body ?? {}));
  res.json(await view(eventId));
});
