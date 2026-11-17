import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { withLock } from './db';
import { HttpError } from './http-error';
import { getEvent, listPeople } from './lan-store';
import { ValidationError } from './lan';
import {
  changeGoodies, getGoodies, goodiesView, normalizePaypal, normalizeSettlement, validateArticles, validateItem, validatePayment, type GoodiesData,
} from './goodies';

// Goodies settlement (goodies.ts). Reading is public (everyone sees what they owe and can pay
// via PayPal right away); all changes need the admin session (auth.ts).
export const goodiesRouter = Router();

type IdParams = { id: string };

function idParam(req: Request<IdParams>): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new HttpError(400, 'Ungültige ID');
  return id;
}

async function peopleMap(eventId: number) {
  const people = await listPeople(eventId);
  return { people, byId: new Map(people.map(p => [p.id, p])) };
}

async function respond(res: Response, eventId: number, data?: GoodiesData): Promise<void> {
  const [goodies, { people }] = await Promise.all([data ?? getGoodies(eventId), peopleMap(eventId)]);
  res.setHeader('Cache-Control', 'no-store');
  res.json(goodiesView(goodies, people));
}

goodiesRouter.get('/events/:id/goodies', async (req: Request<IdParams>, res: Response) => {
  const event = await getEvent(idParam(req));
  await respond(res, event.id);
});

// Body { articles }: the whole catalog
goodiesRouter.put('/events/:id/goodies/articles', async (req: Request<IdParams>, res: Response) => {
  const event = await getEvent(idParam(req));
  const data = await withLock(async () => {
    const { byId } = await peopleMap(event.id);
    return changeGoodies(event.id, d => { d.articles = validateArticles(req.body?.articles, byId); });
  });
  await respond(res, event.id, data);
});

// Body { items: [...] } adds several entries at once (one per recipient), or a single item
goodiesRouter.post('/events/:id/goodies/items', async (req: Request<IdParams>, res: Response) => {
  const event = await getEvent(idParam(req));
  const data = await withLock(async () => {
    const { byId } = await peopleMap(event.id);
    return changeGoodies(event.id, d => {
      const inputs = Array.isArray(req.body?.items) ? req.body.items : [req.body ?? {}];
      if (!inputs.length) throw new ValidationError('Keine Einträge');
      const now = new Date().toISOString();
      for (const input of inputs) {
        d.items.push({ id: crypto.randomUUID(), created_at: now, ...validateItem(input ?? {}, d.articles, byId) });
      }
    });
  });
  res.status(201);
  await respond(res, event.id, data);
});

goodiesRouter.put('/events/:id/goodies/items/:itemId', async (req: Request<IdParams & { itemId: string }>, res: Response) => {
  const event = await getEvent(idParam(req));
  const data = await withLock(async () => {
    const { byId } = await peopleMap(event.id);
    return changeGoodies(event.id, d => {
      const index = d.items.findIndex(i => i.id === req.params.itemId);
      if (index === -1) throw new HttpError(404, 'Eintrag nicht gefunden');
      const existing = d.items[index];
      // Partial updates (e.g. only handed_out) keep the other fields. A new article brings its
      // own name unless one is given (otherwise the entry kept the old article's name)
      const input = { ...existing, ...(req.body ?? {}) };
      if (req.body?.article_id && req.body.article_id !== existing.article_id && req.body.name === undefined) delete input.name;
      d.items[index] = { ...existing, ...validateItem(input, d.articles, byId, existing) };
    });
  });
  await respond(res, event.id, data);
});

goodiesRouter.delete('/events/:id/goodies/items/:itemId', async (req: Request<IdParams & { itemId: string }>, res: Response) => {
  const event = await getEvent(idParam(req));
  const data = await withLock(() => changeGoodies(event.id, d => {
    const before = d.items.length;
    d.items = d.items.filter(i => i.id !== req.params.itemId);
    if (d.items.length === before) throw new HttpError(404, 'Eintrag nicht gefunden');
  }));
  await respond(res, event.id, data);
});

// Body { from_id, to_id, amount, note }: money that went from one person to another
goodiesRouter.post('/events/:id/goodies/payments', async (req: Request<IdParams>, res: Response) => {
  const event = await getEvent(idParam(req));
  const data = await withLock(async () => {
    const { byId } = await peopleMap(event.id);
    return changeGoodies(event.id, d => {
      d.payments.push({ id: crypto.randomUUID(), at: new Date().toISOString(), ...validatePayment(req.body ?? {}, byId) });
    });
  });
  res.status(201);
  await respond(res, event.id, data);
});

goodiesRouter.delete('/events/:id/goodies/payments/:paymentId', async (req: Request<IdParams & { paymentId: string }>, res: Response) => {
  const event = await getEvent(idParam(req));
  const data = await withLock(() => changeGoodies(event.id, d => {
    const before = d.payments.length;
    d.payments = d.payments.filter(p => p.id !== req.params.paymentId);
    if (d.payments.length === before) throw new HttpError(404, 'Zahlung nicht gefunden');
  }));
  await respond(res, event.id, data);
});

// Body { settlement: 'simplified' | 'direct' }: how the transfers are suggested
goodiesRouter.put('/events/:id/goodies/settings', async (req: Request<IdParams>, res: Response) => {
  const event = await getEvent(idParam(req));
  const settlement = normalizeSettlement(req.body?.settlement ?? null);
  const data = await withLock(() => changeGoodies(event.id, d => { d.settlement = settlement; }));
  await respond(res, event.id, data);
});

// Body { person_id, paypal }: PayPal.me name of a person ('' = remove)
goodiesRouter.put('/events/:id/goodies/paypal', async (req: Request<IdParams>, res: Response) => {
  const event = await getEvent(idParam(req));
  const data = await withLock(async () => {
    const { byId } = await peopleMap(event.id);
    const personId = Number(req.body?.person_id);
    if (!byId.has(personId)) throw new ValidationError('Person nicht gefunden');
    const name = normalizePaypal(req.body?.paypal);
    return changeGoodies(event.id, d => {
      if (name) d.paypal[String(personId)] = name;
      else delete d.paypal[String(personId)];
    });
  });
  await respond(res, event.id, data);
});
