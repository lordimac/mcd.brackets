import { Router, Request, Response } from 'express';
import { getAppStore, withLock } from './db';
import { isAdmin } from './auth';
import { HttpError } from './http-error';
import { exportBindZone, exportCsv, exportHosts } from './lan';
import { syncEventStages } from './stage-sync';
import {
  addAttendee, createEvent, deleteAttendee, deleteEvent, getEvent, importAttendees, importBulk,
  listAttendees, listAttendeeViews, listEventSummaries, updateAttendee, updateEvent,
} from './lan-store';

export const lanRouter = Router();

type IdParams = { id: string };

function idParam(req: Request<IdParams>): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new HttpError(400, 'Ungültige ID');
  return id;
}

// File name part from an event name, e.g. "mcd.lan 2026" → "mcd-lan-2026"
function fileSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'event';
}

// After every change of attendees or memorial names, the event's tournaments follow
// (stage-sync.ts); the answer lists what happened to them as bracket_changes
async function withBracketSync<T extends object>(eventId: number, change: () => Promise<T>): Promise<T & { bracket_changes: Awaited<ReturnType<typeof syncEventStages>> }> {
  const result = await change();
  const event = await getEvent(eventId);
  return { ...result, bracket_changes: await syncEventStages(event.name) };
}

async function eventIdOfAttendee(id: number): Promise<number> {
  const attendee = await getAppStore().select('attendee', id);
  if (!attendee) throw new HttpError(404, 'Teilnehmer nicht gefunden');
  return attendee.event_id;
}

/* Events */

// Reading is public, but the WLAN password only goes to admins: null = hidden (the IP slips
// of visitors then get a line to fill in), '' = open network
lanRouter.get('/events', async (req: Request, res: Response) => {
  const events = await listEventSummaries();
  res.json(isAdmin(req) ? events : events.map(e => ({ ...e, wifi_password: e.wifi_password ? null : '' })));
});

lanRouter.post('/events', async (req: Request, res: Response) => {
  res.status(201).json(await withLock(() => createEvent(req.body ?? {})));
});

lanRouter.put('/events/:id', async (req: Request<IdParams>, res: Response) => {
  res.json(await withLock(() => withBracketSync(idParam(req), () => updateEvent(idParam(req), req.body ?? {}))));
});

lanRouter.delete('/events/:id', async (req: Request<IdParams>, res: Response) => {
  await withLock(() => deleteEvent(idParam(req)));
  res.status(204).send();
});

/* Attendees */

lanRouter.get('/events/:id/attendees', async (req: Request<IdParams>, res: Response) => {
  res.json(await listAttendeeViews(idParam(req)));
});

lanRouter.post('/events/:id/attendees', async (req: Request<IdParams>, res: Response) => {
  res.status(201).json(await withLock(() => withBracketSync(idParam(req), () => addAttendee(idParam(req), req.body ?? {}))));
});

// Copy attendees from another event (e.g. last year's)
lanRouter.post('/events/:id/attendees/import', async (req: Request<IdParams>, res: Response) => {
  const fromEventId = Number(req.body?.fromEventId);
  if (!Number.isInteger(fromEventId)) throw new HttpError(400, 'fromEventId fehlt');
  res.json(await withLock(() => withBracketSync(idParam(req), () => importAttendees(idParam(req), fromEventId))));
});

// Bulk import "Nachname, Vorname // Clan-Nickname" per line; dryRun only previews
lanRouter.post('/events/:id/attendees/bulk', async (req: Request<IdParams>, res: Response) => {
  const text = req.body?.text;
  if (typeof text !== 'string') throw new HttpError(400, 'text fehlt');
  const dryRun = req.body?.dryRun === true;
  res.json(await withLock(() => dryRun
    ? importBulk(idParam(req), text, true)
    : withBracketSync(idParam(req), () => importBulk(idParam(req), text, false))));
});

lanRouter.put('/attendees/:id', async (req: Request<IdParams>, res: Response) => {
  res.json(await withLock(async () => withBracketSync(await eventIdOfAttendee(idParam(req)), () => updateAttendee(idParam(req), req.body ?? {}))));
});

lanRouter.delete('/attendees/:id', async (req: Request<IdParams>, res: Response) => {
  res.json(await withLock(async () => withBracketSync(await eventIdOfAttendee(idParam(req)), async () => {
    await deleteAttendee(idParam(req));
    return {};
  })));
});

/* Exports: CSV, hosts file, BIND zone */

const EXPORTS = {
  csv: { build: exportCsv, type: 'text/csv; charset=utf-8', file: (slug: string) => `teilnehmer-${slug}.csv` },
  hosts: { build: exportHosts, type: 'text/plain; charset=utf-8', file: (slug: string) => `hosts-${slug}.txt` },
  zone: { build: exportBindZone, type: 'text/plain; charset=utf-8', file: (slug: string) => `${slug}.zone` },
} as const;

lanRouter.get('/events/:id/export/:format', async (req: Request<IdParams & { format: string }>, res: Response) => {
  const format = EXPORTS[req.params.format as keyof typeof EXPORTS];
  if (!format) throw new HttpError(404, 'Unbekanntes Exportformat');

  const event = await getEvent(idParam(req));
  const body = format.build(event, await listAttendees(event.id));
  res.setHeader('Content-Type', format.type);
  res.setHeader('Content-Disposition', `attachment; filename="${format.file(fileSlug(event.name))}"`);
  res.send(body);
});
