// Goodies settlement (hoodies, shirts, mouse pads …) in the style of Settle Up: who gets what,
// who paid for it, and at the end who sends whom how much. All amounts in euro cents (integers).
// One record per event in table `goodies`. People are attendees and guests of the event (by ID).

import crypto from 'crypto';
import { getAppStore } from './db';
import { displayName, isGuest, ValidationError, type Attendee } from './lan';

export interface GoodiesArticle {
  id: string;
  name: string;        // "Hoodie"
  price: number;       // cents per piece
  variants: string[];  // sizes or versions, e.g. ["S", "M", "L", "XL"]; empty = none
  payer_id: number | null; // who paid the shop for this article (default for new entries); null = not set
}

export interface GoodiesItem {
  id: string;
  article_id: string | null; // catalog article it came from (null = free entry)
  name: string;              // article name at the time of entry
  variant: string;           // "XL", "5 mm" … ('' = none)
  quantity: number;
  price: number;             // cents per piece (copied from the article, may differ)
  recipient_id: number;      // who gets it (and owes it)
  payer_id: number | null;   // who paid the shop for it; null = nobody yet (no debt yet)
  handed_out: boolean;       // already handed over at the event
  note: string;
  created_at: string;
}

// Money that already went from one person to another (settles debts)
export interface GoodiesPayment {
  id: string;
  from_id: number;
  to_id: number;
  amount: number;  // cents
  note: string;
  at: string;
}

export interface GoodiesRecord {
  id: number;
  event_id: number;
  articles: GoodiesArticle[];
  items: GoodiesItem[];
  payments: GoodiesPayment[];
  paypal: Record<string, string>; // person ID → PayPal.me name
}

export type GoodiesData = Omit<GoodiesRecord, 'id' | 'event_id'>;

export const MAX_PRICE = 1_000_000;  // 10 000 € per piece is plenty
export const MAX_QUANTITY = 100;
const MAX_ARTICLES = 50;
const MAX_ITEMS = 2000;
const MAX_PAYMENTS = 1000;

const EMPTY: GoodiesData = { articles: [], items: [], payments: [], paypal: {} };

/* Validation
   ========================================================================== */

function text(value: unknown, label: string, max: number, required = false): string {
  const result = typeof value === 'string' ? value.trim() : '';
  if (required && !result) throw new ValidationError(`${label} fehlt`);
  if (result.length > max) throw new ValidationError(`${label} ist zu lang (max. ${max} Zeichen)`);
  return result;
}

export function cents(value: unknown, label: string, allowZero = true): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < (allowZero ? 0 : 1) || value > MAX_PRICE) {
    throw new ValidationError(`${label}: ungültiger Betrag`);
  }
  return value;
}

function newId(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z0-9-]{1,40}$/.test(value) ? value : crypto.randomUUID();
}

// Variants as list or comma-separated text ("S, M, L, XL"); trimmed, without duplicates
export function normalizeVariants(input: unknown): string[] {
  const values = typeof input === 'string' ? input.split(',') : Array.isArray(input) ? input : [];
  const variants: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') throw new ValidationError('Varianten müssen Text sein');
    const variant = value.trim();
    if (!variant) continue;
    if (variant.length > 30) throw new ValidationError(`Variante zu lang: ${variant}`);
    if (!variants.some(v => v.toLowerCase() === variant.toLowerCase())) variants.push(variant);
  }
  if (variants.length > 30) throw new ValidationError('Höchstens 30 Varianten je Artikel');
  return variants;
}

export function validateArticles(input: unknown, people: Map<number, Attendee>): GoodiesArticle[] {
  if (!Array.isArray(input)) throw new ValidationError('articles muss eine Liste sein');
  if (input.length > MAX_ARTICLES) throw new ValidationError(`Höchstens ${MAX_ARTICLES} Artikel`);
  const articles = input.map((raw, i): GoodiesArticle => ({
    id: newId(raw?.id),
    name: text(raw?.name, `Artikel ${i + 1}: Name`, 60, true),
    price: cents(raw?.price, `Artikel ${i + 1}: Preis`),
    variants: normalizeVariants(raw?.variants),
    payer_id: raw?.payer_id == null || raw.payer_id === '' ? null : personId(raw.payer_id, people, `Artikel ${i + 1}: Bezahlt von`),
  }));
  const names = new Set<string>();
  for (const article of articles) {
    const key = article.name.toLowerCase();
    if (names.has(key)) throw new ValidationError(`Den Artikel „${article.name}“ gibt es doppelt`);
    names.add(key);
  }
  return articles;
}

export interface ItemInput {
  article_id?: unknown;
  name?: unknown;
  variant?: unknown;
  quantity?: unknown;
  price?: unknown;
  recipient_id?: unknown;
  payer_id?: unknown;
  handed_out?: unknown;
  note?: unknown;
}

function personId(value: unknown, people: Map<number, Attendee>, label: string): number {
  const id = typeof value === 'string' && value !== '' ? Number(value) : value;
  if (typeof id !== 'number' || !people.has(id)) throw new ValidationError(`${label}: Person nicht gefunden`);
  return id;
}

// With an article, name, price and payer default to the article's (all may still be changed;
// payer_id: null given explicitly = nobody has paid yet)
export function validateItem(input: ItemInput, articles: GoodiesArticle[], people: Map<number, Attendee>, existing?: GoodiesItem): Omit<GoodiesItem, 'id' | 'created_at'> {
  const articleId = typeof input.article_id === 'string' && input.article_id ? input.article_id : null;
  const article = articleId ? articles.find(a => a.id === articleId) : undefined;
  if (articleId && !article && articleId !== existing?.article_id) throw new ValidationError('Artikel nicht gefunden');

  const name = text(input.name ?? article?.name, 'Artikel', 60, true);
  const variant = text(input.variant, 'Variante', 30);
  const quantity = input.quantity === undefined ? 1 : input.quantity;
  if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
    throw new ValidationError(`Menge: 1 bis ${MAX_QUANTITY}`);
  }
  const price = cents(input.price ?? article?.price, 'Preis');
  const recipientId = personId(input.recipient_id, people, 'Für wen');
  const payerInput = input.payer_id === undefined ? article?.payer_id ?? null : input.payer_id;
  const payerId = payerInput == null || payerInput === '' ? null : personId(payerInput, people, 'Bezahlt von');
  return {
    article_id: articleId,
    name,
    variant,
    quantity,
    price,
    recipient_id: recipientId,
    payer_id: payerId,
    handed_out: input.handed_out === true,
    note: text(input.note, 'Notiz', 200),
  };
}

export function validatePayment(input: { from_id?: unknown; to_id?: unknown; amount?: unknown; note?: unknown }, people: Map<number, Attendee>): Omit<GoodiesPayment, 'id' | 'at'> {
  const from = personId(input.from_id, people, 'Von');
  const to = personId(input.to_id, people, 'An');
  if (from === to) throw new ValidationError('Von und An sind dieselbe Person');
  return { from_id: from, to_id: to, amount: cents(input.amount, 'Betrag', false), note: text(input.note, 'Notiz', 200) };
}

// PayPal.me name: also accepts the whole link ("https://paypal.me/name"); '' = remove
export function normalizePaypal(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  const name = raw.replace(/^(https?:\/\/)?(www\.)?paypal\.me\//i, '').replace(/\/.*$/, '');
  if (name && !/^[A-Za-z0-9]{1,20}$/.test(name)) {
    throw new ValidationError('PayPal.me-Name: nur Buchstaben und Ziffern, höchstens 20 Zeichen');
  }
  return name;
}

/* Settlement
   ========================================================================== */

export interface Balance {
  person_id: number;
  received: number;   // value of the goodies this person gets (paid by anyone)
  paid: number;       // what this person paid to the shop
  sent: number;       // payments sent to others
  got: number;        // payments received from others
  balance: number;    // > 0: gets money back, < 0: owes money
  open: number;       // value of own goodies nobody has paid for yet
}

export interface Transfer {
  from_id: number;
  to_id: number;
  amount: number;
}

// Debts only arise from goodies with a payer: the payer is owed their value by the recipient
export function computeBalances(data: Pick<GoodiesData, 'items' | 'payments'>): Balance[] {
  const balances = new Map<number, Balance>();
  const of = (id: number) => {
    if (!balances.has(id)) balances.set(id, { person_id: id, received: 0, paid: 0, sent: 0, got: 0, balance: 0, open: 0 });
    return balances.get(id)!;
  };
  for (const item of data.items) {
    const total = item.price * item.quantity;
    const recipient = of(item.recipient_id);
    recipient.received += total;
    if (item.payer_id == null) {
      recipient.open += total;
      continue;
    }
    of(item.payer_id).paid += total;
  }
  for (const payment of data.payments) {
    of(payment.from_id).sent += payment.amount;
    of(payment.to_id).got += payment.amount;
  }
  for (const b of balances.values()) {
    b.balance = b.paid - (b.received - b.open) + b.sent - b.got;
  }
  return [...balances.values()];
}

// Fewest transfers (greedy: the biggest debtor pays the biggest creditor). Ties by person ID,
// so the suggestion does not jump around between reloads.
export function settle(balances: Pick<Balance, 'person_id' | 'balance'>[]): Transfer[] {
  const creditors = balances.filter(b => b.balance > 0).map(b => ({ id: b.person_id, amount: b.balance }));
  const debtors = balances.filter(b => b.balance < 0).map(b => ({ id: b.person_id, amount: -b.balance }));
  const order = (a: { id: number; amount: number }, b: { id: number; amount: number }) => b.amount - a.amount || a.id - b.id;
  const transfers: Transfer[] = [];
  while (creditors.length && debtors.length) {
    creditors.sort(order);
    debtors.sort(order);
    const creditor = creditors[0], debtor = debtors[0];
    const amount = Math.min(creditor.amount, debtor.amount);
    transfers.push({ from_id: debtor.id, to_id: creditor.id, amount });
    creditor.amount -= amount;
    debtor.amount -= amount;
    if (creditor.amount === 0) creditors.shift();
    if (debtor.amount === 0) debtors.shift();
  }
  return transfers;
}

/* Storage
   ========================================================================== */

async function stored(eventId: number): Promise<GoodiesRecord | null> {
  return ((await getAppStore().select('goodies', { event_id: eventId })) ?? [])[0] ?? null;
}

export async function getGoodies(eventId: number): Promise<GoodiesData> {
  const record = await stored(eventId);
  return record
    ? { articles: (record.articles ?? []).map(a => ({ ...a, payer_id: a.payer_id ?? null })), items: record.items ?? [], payments: record.payments ?? [], paypal: record.paypal ?? {} }
    : structuredClone(EMPTY);
}

async function save(eventId: number, data: GoodiesData): Promise<GoodiesData> {
  const record = await stored(eventId);
  if (record) await getAppStore().update('goodies', record.id, { ...record, ...data });
  else await getAppStore().insert('goodies', { event_id: eventId, ...data });
  return data;
}

// Edits load the current state, change it and save it (always inside withLock)
export async function changeGoodies(eventId: number, change: (data: GoodiesData) => void | Promise<void>): Promise<GoodiesData> {
  const data = await getGoodies(eventId);
  await change(data);
  if (data.items.length > MAX_ITEMS) throw new ValidationError(`Höchstens ${MAX_ITEMS} Einträge`);
  if (data.payments.length > MAX_PAYMENTS) throw new ValidationError(`Höchstens ${MAX_PAYMENTS} Zahlungen`);
  return save(eventId, data);
}

// IDs of people that have goodies entries, payments or paid for an article: they cannot be deleted
export async function goodiesPeople(eventId: number): Promise<Set<number>> {
  const data = await getGoodies(eventId);
  return new Set([
    ...data.articles.flatMap(a => (a.payer_id == null ? [] : [a.payer_id])),
    ...data.items.flatMap(i => (i.payer_id == null ? [i.recipient_id] : [i.recipient_id, i.payer_id])),
    ...data.payments.flatMap(p => [p.from_id, p.to_id]),
  ]);
}

export interface PersonView {
  id: number;
  name: string;         // real name "Vorname Nachname" (money is about people, not nicknames)
  display_name: string; // "Clan-Nickname" as everywhere else (search, recognition)
  real_name: string;    // "Vorname Nachname" without the nickname added for twins ('' = none); for the table import
  guest: boolean;
  paypal: string;
}

// Real name; without first and last name the display name. Two people with the same real name
// get their nickname added, so nobody pays the wrong one.
export function peopleView(people: Attendee[], paypal: Record<string, string>): PersonView[] {
  const views = people.map(p => {
    const display = displayName({ ...p, clan: p.clan ?? '' });
    const real = `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim();
    return { id: p.id, name: real || display, display_name: display, real_name: real, guest: isGuest(p), paypal: paypal[String(p.id)] ?? '' };
  });
  const count = new Map<string, number>();
  for (const v of views) count.set(v.name.toLowerCase(), (count.get(v.name.toLowerCase()) ?? 0) + 1);
  return views
    .map(v => (count.get(v.name.toLowerCase())! > 1 && v.name !== v.display_name ? { ...v, name: `${v.name} (${v.display_name})` } : v))
    .sort((a, b) => a.name.localeCompare(b.name, 'de', { sensitivity: 'base' }));
}

// Everything the page needs: data, people and the computed settlement
export function goodiesView(data: GoodiesData, people: Attendee[]) {
  const balances = computeBalances(data);
  return {
    ...data,
    people: peopleView(people, data.paypal),
    balances,
    transfers: settle(balances),
  };
}
