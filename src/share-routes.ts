import { Router, Request, Response } from 'express';
import { withLock } from './db';
import { isAdmin } from './auth';
import { HttpError } from './http-error';
import { setAttendeeShares, setEventShares } from './lan-store';
import { ipAttendeeId } from './welcome-routes';

// SMB shares (shares.ts). Reading comes with GET /events and /events/:id/attendees.
// Attendees set their own shares (recognized by IP, auth.ts lets the route through), admins all;
// the fixed shares of an event are for admins only.
export const shareRouter = Router();

type IdParams = { id: string };

function idParam(req: Request<IdParams>): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new HttpError(400, 'Ungültige ID');
  return id;
}

// Body { shares: [...] } — always the complete list
shareRouter.put('/attendees/:id/shares', async (req: Request<IdParams>, res: Response) => {
  const id = idParam(req);
  if (!isAdmin(req) && await ipAttendeeId(req) !== id) {
    throw new HttpError(403, 'Du kannst nur die Shares deiner eigenen PCs festlegen');
  }
  res.json({ shares: await withLock(() => setAttendeeShares(id, req.body?.shares)) });
});

shareRouter.put('/events/:id/shares', async (req: Request<IdParams>, res: Response) => {
  res.json({ shares: await withLock(() => setEventShares(idParam(req), req.body?.shares)) });
});
