import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { getAppStore, withLock } from './db';
import { isAdmin } from './auth';
import { HttpError } from './http-error';
import { displayName, ValidationError, type Attendee, type LanEvent } from './lan';
import { getEvent } from './lan-store';
import { clientIPv4, identify } from './welcome';
import {
  claimForPrint, createOrder, DEFAULT_MENU, getMenu, getOrder, listOrders, orderView, saveMenu, unmarkPrinted, updateOrder, type BurgerOrder,
} from './burger';

// Burger designer. Reading is public. Ordering, changing and cancelling an own order is public too
// (auth.ts lets these routes through); the order's token (kept by the orderer's browser) or the
// device's IP identification proves "own". Menu, printing and other people's orders: admins only.
export const burgerRouter = Router();

type IdParams = { id: string };

// Non-admins: at most this many orders per attendee that are not printed yet
export const MAX_OPEN_ORDERS = 3;

function idParam(req: Request<IdParams>): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new HttpError(400, 'Ungültige ID');
  return id;
}

function requireAdmin(req: Request): void {
  if (!isAdmin(req)) throw new HttpError(401, 'Admin-Anmeldung erforderlich');
}

// Attendee of this device by its IP address (same identification as the welcome page)
async function ipAttendeeId(req: Request): Promise<number | null> {
  const events: LanEvent[] = (await getAppStore().select('event')) ?? [];
  const attendees: Attendee[] = (await getAppStore().select('attendee')) ?? [];
  return identify(clientIPv4(req.ip), events, attendees).attendee?.id ?? null;
}

function tokenMatches(req: Request, order: BurgerOrder): boolean {
  const token = req.headers['x-burger-token'];
  if (typeof token !== 'string' || !token) return false;
  const a = crypto.createHash('sha256').update(token).digest();
  const b = crypto.createHash('sha256').update(order.token).digest();
  return crypto.timingSafeEqual(a, b);
}

async function findOrder(id: number): Promise<BurgerOrder> {
  const order = await getOrder(id);
  if (!order) throw new HttpError(404, 'Bestellung nicht gefunden');
  return order;
}

// Admins may change everything; the orderer only their own order
async function requireOwner(req: Request, order: BurgerOrder): Promise<void> {
  if (isAdmin(req) || tokenMatches(req, order)) return;
  if (order.attendee_id != null && order.attendee_id === await ipAttendeeId(req)) return;
  throw new HttpError(403, 'Das ist nicht deine Bestellung');
}

// With the default menu, so the editor can go back to it
burgerRouter.get('/burger/menu', async (_req: Request, res: Response) => {
  res.json({ ...await getMenu(), defaults: DEFAULT_MENU });
});

burgerRouter.put('/burger/menu', async (req: Request, res: Response) => {
  res.json({ ...await withLock(() => saveMenu(req.body ?? {})), defaults: DEFAULT_MENU });
});

burgerRouter.get('/events/:id/burger-orders', async (req: Request<IdParams>, res: Response) => {
  const event = await getEvent(idParam(req));
  res.setHeader('Cache-Control', 'no-store');
  res.json({ orders: (await listOrders(event.id)).map(orderView), me: await ipAttendeeId(req) });
});

// Body { attendee_id, choices, extra, note } — admins may give { name } instead of an attendee.
// The answer carries the token once; the browser keeps it to change or cancel the order.
burgerRouter.post('/events/:id/burger-orders', async (req: Request<IdParams>, res: Response) => {
  const event = await getEvent(idParam(req));
  const admin = isAdmin(req);
  const order = await withLock(async () => {
    if (!admin && !(await getMenu()).open) throw new HttpError(403, 'Die Burger-Bestellung ist gerade geschlossen');
    const attendeeId = req.body?.attendee_id == null || req.body.attendee_id === '' ? null : Number(req.body.attendee_id);
    let who: { attendee_id: number | null; name: string };
    if (attendeeId != null) {
      const attendee = await getAppStore().select('attendee', attendeeId);
      if (!attendee || attendee.event_id !== event.id) throw new ValidationError('Teilnehmer nicht gefunden');
      who = { attendee_id: attendee.id, name: displayName(attendee) };
    } else {
      const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
      if (!admin || !name) throw new ValidationError('Bitte auswählen, für wen der Burger ist');
      if (name.length > 60) throw new ValidationError('Name ist zu lang (max. 60 Zeichen)');
      who = { attendee_id: null, name };
    }
    if (!admin && who.attendee_id != null) {
      const open = (await listOrders(event.id)).filter(o => o.attendee_id === who.attendee_id && !o.printed_at).length;
      if (open >= MAX_OPEN_ORDERS) throw new ValidationError(`${who.name} hat schon ${open} Burger in der Warteschlange`);
    }
    return createOrder(event.id, who, req.body ?? {});
  });
  res.status(201).json(order);
});

burgerRouter.put('/burger-orders/:id', async (req: Request<IdParams>, res: Response) => {
  const updated = await withLock(async () => {
    const order = await findOrder(idParam(req));
    await requireOwner(req, order);
    return updateOrder(order, req.body ?? {});
  });
  res.json(orderView(updated));
});

// The orderer can cancel until the order is printed, admins always
burgerRouter.delete('/burger-orders/:id', async (req: Request<IdParams>, res: Response) => {
  await withLock(async () => {
    const order = await findOrder(idParam(req));
    await requireOwner(req, order);
    if (order.printed_at && !isAdmin(req)) throw new ValidationError('Die Bestellung ist schon gedruckt und liegt beim Grill — bitte dort Bescheid sagen');
    await getAppStore().delete('burger_order', { id: order.id });
  });
  res.status(204).send();
});

// Body { ids? }: without ids all orders not printed yet, with ids exactly these (reprint).
// Marks them as printed and returns them for the label PDF.
burgerRouter.post('/events/:id/burger-orders/print', async (req: Request<IdParams>, res: Response) => {
  requireAdmin(req);
  const event = await getEvent(idParam(req));
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : undefined;
  const orders = await withLock(() => claimForPrint(event.id, ids));
  res.json({ orders: orders.map(orderView) });
});

burgerRouter.post('/burger-orders/:id/unprint', async (req: Request<IdParams>, res: Response) => {
  requireAdmin(req);
  const order = await withLock(async () => unmarkPrinted(await findOrder(idParam(req))));
  res.json(orderView(order));
});
