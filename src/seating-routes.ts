import { Router, Request, Response } from 'express';
import { withLock } from './db';
import { HttpError } from './http-error';
import { isAdmin } from './auth';
import { addTemplate, assignSeat, autofillRoom, clearSeats, createRoom, deleteRoom, duplicateRoom, listRooms, sortRoomGroups, updateRoom } from './seating-store';

// Seating plan: rooms of an event and seat assignments. Reading is public (people look up
// who sits where), changes need the admin session (auth.ts).
export const seatingRouter = Router();

type IdParams = { id: string };

function idParam(req: Request<IdParams>): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new HttpError(400, 'Ungültige ID');
  return id;
}

// Alternatives are drafts: only admins see them
seatingRouter.get('/events/:id/rooms', async (req: Request<IdParams>, res: Response) => {
  const rooms = await listRooms(idParam(req));
  res.json(isAdmin(req) ? rooms : rooms.filter(r => !r.alternative));
});

seatingRouter.post('/events/:id/rooms', async (req: Request<IdParams>, res: Response) => {
  res.status(201).json(await withLock(() => createRoom(idParam(req), req.body ?? {})));
});

seatingRouter.put('/rooms/:id', async (req: Request<IdParams>, res: Response) => {
  res.json(await withLock(() => updateRoom(idParam(req), req.body ?? {})));
});

// Adds a building block (row, double, u, block, area) at { at: { x, y } } or the first free spot
seatingRouter.post('/rooms/:id/templates', async (req: Request<IdParams>, res: Response) => {
  res.json(await withLock(() => addTemplate(idParam(req), req.body?.template, req.body?.params ?? {}, req.body?.at)));
});

seatingRouter.post('/rooms/:id/sort', async (req: Request<IdParams>, res: Response) => {
  res.json(await withLock(() => sortRoomGroups(idParam(req))));
});

// Body { name?, event_id? } — copies layout, doors and own numbers, not the assignments
seatingRouter.post('/rooms/:id/duplicate', async (req: Request<IdParams>, res: Response) => {
  res.status(201).json(await withLock(() => duplicateRoom(idParam(req), req.body ?? {})));
});

seatingRouter.delete('/rooms/:id', async (req: Request<IdParams>, res: Response) => {
  await withLock(() => deleteRoom(idParam(req)));
  res.status(204).send();
});

// Body { attendee_id: number | null }; answers with all rooms of the event (a move may touch two rooms)
seatingRouter.put('/rooms/:id/seats/:key', async (req: Request<IdParams & { key: string }>, res: Response) => {
  const raw = req.body?.attendee_id;
  const attendeeId = raw === null || raw === undefined ? null : Number(raw);
  if (attendeeId !== null && !Number.isInteger(attendeeId)) throw new HttpError(400, 'Ungültige Teilnehmer-ID');
  res.json(await withLock(() => assignSeat(idParam(req), req.params.key, attendeeId)));
});

seatingRouter.post('/rooms/:id/clear', async (req: Request<IdParams>, res: Response) => {
  res.json(await withLock(() => clearSeats(idParam(req))));
});

seatingRouter.post('/rooms/:id/autofill', async (req: Request<IdParams>, res: Response) => {
  res.json(await withLock(() => autofillRoom(idParam(req))));
});
