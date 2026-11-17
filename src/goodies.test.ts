import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// db.ts reads DATA_DIR on import, so point it to a temp dir first
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcd-brackets-goodies-'));

const db: typeof import('./db') = require('./db');
const store: typeof import('./lan-store') = require('./lan-store');
const goodies: typeof import('./goodies') = require('./goodies');

const item = (recipient: number, payer: number | null, price: number, quantity = 1) => ({
  id: 'x', article_id: null, name: 'Hoodie', variant: 'XL', quantity, price, recipient_id: recipient, payer_id: payer,
  handed_out: false, note: '', created_at: '',
});

test('balances: the payer is owed the value, own purchases and unpaid goodies cost nothing yet', () => {
  const balances = goodies.computeBalances({
    items: [item(1, 9, 4500), item(2, 9, 2000, 2), item(9, 9, 4500), item(3, null, 1500)],
    payments: [{ id: 'p', from_id: 2, to_id: 9, amount: 1000, note: '', at: '' }],
  });
  const of = (id: number) => balances.find(b => b.person_id === id)!;
  assert.equal(of(1).balance, -4500);
  assert.equal(of(2).balance, -3000);
  assert.equal(of(9).balance, 4500 + 4000 - 1000);
  assert.equal(of(3).balance, 0);
  assert.equal(of(3).open, 1500);
  assert.equal(balances.reduce((sum, b) => sum + b.balance, 0), 0);
});

test('settle: fewest transfers, every debt paid exactly', () => {
  const transfers = goodies.settle([
    { person_id: 1, balance: -3000 }, { person_id: 2, balance: -1000 },
    { person_id: 3, balance: 2500 }, { person_id: 4, balance: 1500 }, { person_id: 5, balance: 0 },
  ]);
  assert.ok(transfers.length <= 3);
  const net = new Map<number, number>();
  for (const t of transfers) {
    assert.ok(t.amount > 0);
    net.set(t.from_id, (net.get(t.from_id) ?? 0) + t.amount);
    net.set(t.to_id, (net.get(t.to_id) ?? 0) - t.amount);
  }
  assert.deepEqual(Object.fromEntries([...net].sort((a, b) => a[0] - b[0])), { 1: 3000, 2: 1000, 3: -2500, 4: -1500 });
  assert.deepEqual(goodies.settle([{ person_id: 1, balance: 0 }]), []);
});

test('people are shown with their real name, nickname only as fallback or to tell twins apart', () => {
  const person = (id: number, first_name: string, last_name: string, nickname: string) =>
    ({ id, event_id: 1, first_name, last_name, clan: '', nickname, hostname: '', slot: id });
  const view = goodies.peopleView([
    person(1, 'Max', 'Muster', 'lordimac'), person(2, '', '', 'Frag'),
    person(3, 'Anna', 'Berg', 'joy'), person(4, 'Anna', 'Berg', 'Hasi'),
  ], { 1: 'maxm' });
  assert.deepEqual(view.map(p => p.name), ['Anna Berg (Hasi)', 'Anna Berg (joy)', 'Frag', 'Max Muster']);
  assert.equal(view.find(p => p.id === 1)!.display_name, 'lordimac');
  assert.equal(view.find(p => p.id === 1)!.paypal, 'maxm');
});

test('changing the article of an entry also changes its name', async () => {
  await db.ensureAppTables();
  const event = await store.createEvent({ name: 'Artikelwechsel' });
  const person = await store.addAttendee(event.id, { nickname: 'Pad' });
  const express: typeof import('express') = require('express');
  const { goodiesRouter }: typeof import('./goodies-routes') = require('./goodies-routes');
  const app = express();
  app.use(express.json());
  app.use('/api', goodiesRouter);
  app.use((error: Error & { status?: number }, _req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }, _next: unknown) => res.status(error.status ?? 400).json({ error: error.message }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/events/${event.id}/goodies`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const send = async (method: string, path: string, body: unknown): Promise<any> =>
    (await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  try {
    const { articles } = await send('PUT', '/articles', { articles: [{ name: 'Pad 5', price: 4499, variants: '5mm' }, { name: 'Pad 3', price: 4125, variants: '3mm' }] });
    const { items } = await send('POST', '/items', { article_id: articles[0].id, variant: '5mm', recipient_id: person.id });
    const changed = await send('PUT', `/items/${items[0].id}`, { article_id: articles[1].id, variant: '3mm', price: 4125 });
    assert.equal(changed.items[0].name, 'Pad 3');
    // Other changes keep the name
    const handed = await send('PUT', `/items/${items[0].id}`, { handed_out: true });
    assert.equal(handed.items[0].name, 'Pad 3');
  } finally {
    server.close();
  }
});

test('direct settlement: everybody pays whoever paid for their goodies, pairs net out', () => {
  // 9 paid A's and B's goodies, 8 paid the mouse pads (one of them for 9); 2 paid 9 back in part
  const data = {
    items: [item(1, 9, 4500), item(2, 9, 3000), item(2, 8, 1500), item(9, 8, 1500), item(8, 9, 4500), item(9, 9, 2000)],
    payments: [{ id: 'p', from_id: 2, to_id: 9, amount: 1000, note: '', at: '' }],
  };
  const transfers = goodies.settleDirect(data);
  const key = (t: { from_id: number; to_id: number; amount: number }) => `${t.from_id}>${t.to_id}:${t.amount}`;
  assert.deepEqual(transfers.map(key).sort(), ['1>9:4500', '2>8:1500', '2>9:2000', '8>9:3000'].sort());
  // Same balances as the simplified settlement
  const net = new Map<number, number>();
  for (const t of transfers) {
    net.set(t.from_id, (net.get(t.from_id) ?? 0) + t.amount);
    net.set(t.to_id, (net.get(t.to_id) ?? 0) - t.amount);
  }
  for (const b of goodies.computeBalances(data)) assert.equal(net.get(b.person_id) ?? 0, -b.balance);
  // Overpaid: the payee owes the difference back
  assert.deepEqual(goodies.settleDirect({ items: [item(1, 9, 1000)], payments: [{ id: 'p', from_id: 1, to_id: 9, amount: 1500, note: '', at: '' }] }).map(key), ['9>1:500']);
  assert.equal(goodies.normalizeSettlement(undefined), 'simplified');
  assert.throws(() => goodies.normalizeSettlement('egal'), /Abrechnungsart/);
});

test('validation: articles, PayPal names, amounts', () => {
  const people = new Map([[7, { id: 7 } as never], [8, { id: 8 } as never]]);
  const [article] = goodies.validateArticles([{ name: 'Hoodie', price: 4500, variants: 'S, M, m, XL', payer_id: 7 }], people);
  assert.deepEqual(article.variants, ['S', 'M', 'XL']);
  assert.equal(article.payer_id, 7);
  assert.throws(() => goodies.validateArticles([{ name: 'A', price: 1 }, { name: 'a', price: 2 }], people), /doppelt/);
  assert.throws(() => goodies.validateArticles([{ name: 'A', price: 1.5 }], people), /Betrag/);
  assert.throws(() => goodies.validateArticles([{ name: 'A', price: 1, payer_id: 99 }], people), /Person nicht gefunden/);

  // Entries take the article's payer unless one is given (null = nobody yet)
  assert.equal(goodies.validateItem({ article_id: article.id, recipient_id: 8 }, [article], people).payer_id, 7);
  assert.equal(goodies.validateItem({ article_id: article.id, recipient_id: 8, payer_id: 8 }, [article], people).payer_id, 8);
  assert.equal(goodies.validateItem({ article_id: article.id, recipient_id: 8, payer_id: null }, [article], people).payer_id, null);
  assert.equal(goodies.normalizePaypal('https://www.paypal.me/MaxMuster/10'), 'MaxMuster');
  assert.equal(goodies.normalizePaypal(''), '');
  assert.throws(() => goodies.normalizePaypal('max muster'), /PayPal/);
});

test('guests: no addresses, no tournaments, unique names; goodies keep people from being deleted', async () => {
  await db.ensureAppTables();
  const event = await store.createEvent({ name: 'Goodies-LAN' });
  const player = await store.addAttendee(event.id, { nickname: 'Frag' });
  const guest = await store.addAttendee(event.id, { first_name: 'Erika', last_name: 'Muster', guest: true });
  assert.equal(guest.guest, true);
  assert.deepEqual(guest.ips, []);
  assert.equal(guest.display_name, 'Erika Muster');
  await assert.rejects(store.addAttendee(event.id, { nickname: 'frag', guest: true }), /gibt es in diesem Event schon/);
  await assert.rejects(store.addAttendee(event.id, { guest: true }), /fehlt/);
  // A guest's nickname does not block DNS names, but the display name must stay unique
  await assert.rejects(store.addAttendee(event.id, { nickname: 'Erika Muster' }), /gibt es in diesem Event schon/);

  assert.deepEqual((await store.playerNamesForEvent('Goodies-LAN'))!.players, ['Frag']);
  assert.deepEqual((await store.listAttendeeViews(event.id)).map(a => a.id), [player.id]);
  assert.deepEqual((await store.listGuestViews(event.id)).map(a => a.id), [guest.id]);
  const summary = (await store.listEventSummaries()).find(e => e.id === event.id)!;
  assert.equal(summary.attendee_count, 1);
  assert.equal(summary.guest_count, 1);

  // Guests stay guests when edited, and have no shares
  const renamed = await store.updateAttendee(guest.id, { first_name: 'Erika', last_name: 'Mustermann', nickname: 'Eri' });
  assert.equal(renamed.display_name, 'Eri');
  assert.equal(renamed.slot, -1);
  await assert.rejects(store.setAttendeeShares(guest.id, []), /Gäste/);

  // Next year: guests are copied as guests
  const next = await store.createEvent({ name: 'Goodies-LAN 2' });
  const result = await store.importAttendees(next.id, event.id);
  assert.equal(result.added, 2);
  assert.equal((await store.listGuests(next.id)).length, 1);

  await goodies.changeGoodies(event.id, d => {
    d.items.push({ ...item(guest.id, player.id, 2500), id: 'i1' });
  });
  await assert.rejects(store.deleteAttendee(guest.id), /Goodies/);
  await goodies.changeGoodies(event.id, d => { d.items = []; });
  await store.deleteAttendee(guest.id);

  await store.deleteEvent(event.id);
  assert.deepEqual(await db.getAppStore().select('goodies', { event_id: event.id }), []);
});
