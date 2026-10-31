import crypto from 'crypto';
import { getAppStore } from './db';
import { ValidationError } from './lan';

// Burger designer: a global menu (categories with options, editable by admins) and the orders
// of an event. Every order stores its printed summary ("Einfach, Fleisch, Bacon, extra viel
// Burgersauce"), so later menu changes don't alter it. Orders are printed on DYMO labels by the
// browser (public/burger-labels.js); printed_at keeps them from being printed twice. On the tablet
// display (kitchen) an order goes waiting → started → done (started_at, done_at). Printed or started
// orders can't be changed by the orderer any more.

// How the frontend draws a category (public/burger.js); 'none' = only listed, not drawn
export const VISUALS = ['size', 'patty', 'cheese', 'topping', 'sauce', 'bun', 'none'] as const;
export type Visual = typeof VISUALS[number];

// Look of a topping or cheese layer
export const SHAPES = ['leaf', 'slices', 'coins', 'rings', 'crumbs', 'strip', 'slice', 'crumble'] as const;
export type Shape = typeof SHAPES[number];

export interface BurgerOption {
  id: string;
  name: string;      // shown in the designer
  short: string;     // on the label; empty = name
  color: string;     // "#rrggbb"
  shape: Shape | ''; // toppings and cheese
  count: number;     // size: number of patties (otherwise 0)
  available: boolean;
}

export interface BurgerCategory {
  id: string;
  name: string;
  visual: Visual;
  multiple: boolean;   // several options (toppings, sauces) instead of exactly one
  extra: boolean;      // multiple only: each chosen option can be "extra viel"
  empty_label: string; // multiple only: label/print text when nothing is chosen, e.g. "ohne Sauce"
  options: BurgerOption[];
}

export interface BurgerMenu {
  open: boolean; // attendees may order (admins always)
  print_labels: boolean;    // orders are printed on DYMO labels
  kitchen_display: boolean; // orders are shown on the tablet display (kitchen)
  categories: BurgerCategory[];
}

export interface BurgerOrder {
  id: number;
  event_id: number;
  number: number;              // per event, from 1
  attendee_id: number | null;  // null = ordered by an admin for someone without attendee record
  name: string;                // display name at the time of ordering
  choices: Record<string, string[]>; // category id → option ids
  extra: string[];             // option ids chosen as "extra viel"
  note: string;
  summary: string;
  created_at: string;
  printed_at: string | null;
  started_at: string | null;   // tablet display: being prepared (missing in old orders = null)
  done_at: string | null;      // tablet display: ready
  token: string;               // lets the orderer's browser change or cancel it until printed
}

export type OrderView = Omit<BurgerOrder, 'token'>;

const opt = (id: string, name: string, short: string, color: string, extra: Partial<BurgerOption> = {}): BurgerOption =>
  ({ id, name, short, color, shape: '', count: 0, available: true, ...extra });

export const DEFAULT_MENU: BurgerMenu = {
  open: true,
  print_labels: true,
  kitchen_display: false,
  categories: [
    { id: 'size', name: 'Größe', visual: 'size', multiple: false, extra: false, empty_label: '', options: [
      opt('single', 'Single (ein Patty)', 'Einfach', '#5b3420', { count: 1 }),
      opt('double', 'Double (zwei Patties)', 'Doppelt', '#5b3420', { count: 2 }),
    ] },
    { id: 'patty', name: 'Patty', visual: 'patty', multiple: false, extra: false, empty_label: '', options: [
      opt('meat', 'Fleisch', 'Fleisch', '#5b3420'),
      opt('veggie', 'Vegetarisch', 'Veggie', '#022c12'),
    ] },
    { id: 'cheese', name: 'Käse', visual: 'cheese', multiple: false, extra: false, empty_label: '', options: [
      opt('no-cheese', 'Ohne Käse', 'ohne Käse', '', { shape: '' }),
      opt('cheddar', 'Cheddar', 'Cheddar', '#ffae1a', { shape: 'slice' }),
      opt('blue', 'Blauschimmel', 'Blauschimmel', '#e9e4cf', { shape: 'crumble' }),
    ] },
    { id: 'toppings', name: 'Belag', visual: 'topping', multiple: true, extra: false, empty_label: 'ohne Belag', options: [
      opt('lettuce', 'Eisbergsalat', 'Salat', '#8fd14f', { shape: 'leaf' }),
      opt('tomato', 'Tomaten', 'Tomate', '#e8412c', { shape: 'slices' }),
      opt('pickles', 'Gewürzgurken', 'Gurken', '#6f9a2e', { shape: 'coins' }),
      opt('onion', 'Zwiebeln roh', 'Zwiebeln', '#e9d7f0', { shape: 'rings' }),
      opt('fried-onion', 'Röstzwiebeln', 'Röstzwiebeln', '#c27a2c', { shape: 'crumbs' }),
      opt('bacon', 'Bacon', 'Bacon', '#b8452f', { shape: 'strip' }),
      opt('jalapeno', 'Jalapeños', 'Jalapeños', '#3f9b38', { shape: 'coins' }),
    ] },
    { id: 'sauce', name: 'Sauce', visual: 'sauce', multiple: true, extra: true, empty_label: 'ohne Sauce', options: [
      opt('burger-sauce', 'Burgersauce', 'Burgersauce', '#f2a65a'),
      opt('ketchup', 'Ketchup', 'Ketchup', '#c8221b'),
      opt('mustard', 'Senf', 'Senf', '#e8c21a'),
      opt('mayo', 'Mayonnaise', 'Mayo', '#f6efd2'),
      opt('bbq', 'BBQ rauchig', 'BBQ', '#6b2a14'),
    ] },
    { id: 'bun', name: 'Brötchen', visual: 'bun', multiple: false, extra: false, empty_label: '', options: [
      opt('brioche', 'Brioche Bun', 'Brioche', '#e19a45'),
      opt('low-carb', 'Ohne Stärke', 'ohne Stärke', '#c9a66b'),
      opt('protein', 'Eiweiß-Bun', 'Eiweiß-Bun', '#b9814a'),
    ] },
  ],
};

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const MAX_CATEGORIES = 20;
const MAX_OPTIONS = 40;
export const MAX_NOTE = 200;

function text(value: unknown, label: string, max: number, required = false): string {
  const result = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (required && !result) throw new ValidationError(`${label} fehlt`);
  if (result.length > max) throw new ValidationError(`${label} ist zu lang (max. ${max} Zeichen)`);
  return result;
}

// Readable ID from the name for new entries ("Röstzwiebeln" → "roestzwiebeln"), unique in `taken`
function makeId(value: unknown, name: string, taken: Set<string>): string {
  if (typeof value === 'string' && ID_PATTERN.test(value) && !taken.has(value)) return value;
  const base = name.toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'x';
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
  return id;
}

// The whole menu as sent by the editor. Option IDs are unique across the menu, because an
// order lists its "extra viel" options by ID alone.
export function validateMenu(input: { open?: unknown; print_labels?: unknown; kitchen_display?: unknown; categories?: unknown }): BurgerMenu {
  if (!Array.isArray(input.categories) || input.categories.length === 0) throw new ValidationError('Mindestens eine Kategorie anlegen');
  if (input.categories.length > MAX_CATEGORIES) throw new ValidationError(`Höchstens ${MAX_CATEGORIES} Kategorien`);
  const categoryIds = new Set<string>();
  const optionIds = new Set<string>();
  const categories = input.categories.map((raw, i): BurgerCategory => {
    const name = text(raw?.name, `Kategorie ${i + 1}: Name`, 40, true);
    const id = makeId(raw?.id, name, categoryIds);
    categoryIds.add(id);
    const visual = VISUALS.includes(raw?.visual) ? raw.visual as Visual : 'none';
    const multiple = raw?.multiple === true;
    if (!Array.isArray(raw?.options) || raw.options.length === 0) throw new ValidationError(`${name}: mindestens eine Zutat anlegen`);
    if (raw.options.length > MAX_OPTIONS) throw new ValidationError(`${name}: höchstens ${MAX_OPTIONS} Zutaten`);
    const options = raw.options.map((o: Record<string, unknown> | null, j: number): BurgerOption => {
      const optionName = text(o?.name, `${name}, Zutat ${j + 1}: Name`, 40, true);
      const optionId = makeId(o?.id, optionName, optionIds);
      optionIds.add(optionId);
      const color = typeof o?.color === 'string' && COLOR_PATTERN.test(o.color) ? o.color.toLowerCase() : '';
      const count = visual === 'size' ? Number(o?.count) : 0;
      if (visual === 'size' && !(Number.isInteger(count) && count >= 0 && count <= 4)) throw new ValidationError(`${optionName}: Anzahl Patties 0–4`);
      return {
        id: optionId,
        name: optionName,
        short: text(o?.short, `${optionName}: Kurzform`, 30),
        color,
        shape: SHAPES.includes(o?.shape as Shape) ? o!.shape as Shape : '',
        count,
        available: o?.available !== false,
      };
    });
    return {
      id, name, visual, multiple,
      extra: multiple && raw?.extra === true,
      empty_label: multiple ? text(raw?.empty_label, `${name}: Text für „nichts gewählt“`, 30) : '',
      options,
    };
  });
  // Missing in menus saved before the switches existed: printing only
  return { open: input.open !== false, print_labels: input.print_labels !== false, kitchen_display: input.kitchen_display === true, categories };
}

// Choices of an order against the menu: single categories need exactly one available option,
// multiple ones any number. Options that are no longer available are rejected.
export function validateChoices(menu: BurgerMenu, input: { choices?: unknown; extra?: unknown }): Pick<BurgerOrder, 'choices' | 'extra'> {
  const raw = input.choices && typeof input.choices === 'object' ? input.choices as Record<string, unknown> : {};
  const choices: Record<string, string[]> = {};
  const chosen = new Set<string>();
  for (const category of menu.categories) {
    const value = raw[category.id];
    const ids = [...new Set(Array.isArray(value) ? value : value == null || value === '' ? [] : [value])];
    for (const id of ids) {
      const option = category.options.find(o => o.id === id);
      if (!option) throw new ValidationError(`${category.name}: unbekannte Auswahl`);
      if (!option.available) throw new ValidationError(`${option.name} ist leider nicht (mehr) verfügbar`);
    }
    if (!category.multiple && ids.length !== 1) throw new ValidationError(`Bitte bei „${category.name}“ etwas auswählen`);
    choices[category.id] = ids as string[];
    ids.forEach(id => chosen.add(id as string));
  }
  const extraOptions = new Set(menu.categories.filter(c => c.extra).flatMap(c => c.options.map(o => o.id)));
  const extra = Array.isArray(input.extra)
    ? [...new Set(input.extra.filter((id): id is string => typeof id === 'string' && chosen.has(id) && extraOptions.has(id)))]
    : [];
  return { choices, extra };
}

// Short text for the label in menu order: "Einfach, Fleisch, Blauschimmel, Zwiebeln, Bacon,
// extra viel Burgersauce"
export function summarizeOrder(menu: BurgerMenu, order: Pick<BurgerOrder, 'choices' | 'extra'>): string {
  const parts: string[] = [];
  for (const category of menu.categories) {
    const ids = order.choices[category.id] ?? [];
    const options = category.options.filter(o => ids.includes(o.id));
    if (!options.length && category.empty_label) parts.push(category.empty_label);
    for (const option of options) parts.push(`${order.extra.includes(option.id) ? 'extra viel ' : ''}${option.short || option.name}`);
  }
  return parts.join(', ');
}

/* Storage: the menu as one record in "burger_menu" (missing = default), orders in "burger_order"
   ========================================================================== */

// Former default colours → current ones, so stored menus get the new look too
// (colours chosen in the editor are kept)
const OLD_DEFAULT_COLORS: Record<string, string> = { '#7c8a3c': '#022c12', '#4a5a2c': '#022c12', '#42401f': '#022c12' }; // veggie patty

export function withCurrentColors(menu: BurgerMenu): BurgerMenu {
  return {
    ...menu,
    categories: menu.categories.map(c => ({ ...c, options: c.options.map(o => ({ ...o, color: OLD_DEFAULT_COLORS[o.color] ?? o.color })) })),
  };
}

export async function getMenu(): Promise<BurgerMenu> {
  const record = ((await getAppStore().select('burger_menu')) ?? [])[0];
  if (!record) return DEFAULT_MENU;
  try {
    return withCurrentColors(validateMenu(record));
  } catch {
    return DEFAULT_MENU; // broken record: better the default than no ordering at all
  }
}

export async function saveMenu(input: Parameters<typeof validateMenu>[0]): Promise<BurgerMenu> {
  const menu = validateMenu(input);
  const record = ((await getAppStore().select('burger_menu')) ?? [])[0];
  if (record) await getAppStore().update('burger_menu', record.id, { ...menu, id: record.id });
  else await getAppStore().insert('burger_menu', menu);
  return menu;
}

export const orderView = ({ token: _token, ...order }: BurgerOrder): OrderView => order;

export async function listOrders(eventId: number): Promise<BurgerOrder[]> {
  return ((await getAppStore().select('burger_order', { event_id: eventId })) ?? []).sort((a, b) => a.number - b.number);
}

export async function getOrder(id: number): Promise<BurgerOrder | null> {
  return getAppStore().select('burger_order', id);
}

export async function createOrder(eventId: number, who: { attendee_id: number | null; name: string }, input: { choices?: unknown; extra?: unknown; note?: unknown }, now = new Date()): Promise<BurgerOrder> {
  const menu = await getMenu();
  const picked = validateChoices(menu, input);
  const number = (await listOrders(eventId)).reduce((max, o) => Math.max(max, o.number), 0) + 1;
  const order: Omit<BurgerOrder, 'id'> = {
    event_id: eventId,
    number,
    ...who,
    ...picked,
    note: text(input.note, 'Anmerkung', MAX_NOTE),
    summary: summarizeOrder(menu, picked),
    created_at: now.toISOString(),
    printed_at: null,
    started_at: null,
    done_at: null,
    token: crypto.randomBytes(18).toString('base64url'),
  };
  const id = await getAppStore().insert('burger_order', order);
  return { ...order, id };
}

// Printed or being prepared: the orderer can't change or cancel it any more
export const isLocked = (order: BurgerOrder): boolean => !!(order.printed_at || order.started_at);
export const LOCKED_MESSAGE = 'Die Bestellung liegt schon beim Grill — bitte dort Bescheid sagen';

export async function updateOrder(order: BurgerOrder, input: { choices?: unknown; extra?: unknown; note?: unknown }): Promise<BurgerOrder> {
  if (isLocked(order)) throw new ValidationError(LOCKED_MESSAGE);
  const menu = await getMenu();
  const picked = validateChoices(menu, input);
  const updated: BurgerOrder = { ...order, ...picked, note: text(input.note, 'Anmerkung', MAX_NOTE), summary: summarizeOrder(menu, picked) };
  await getAppStore().update('burger_order', order.id, updated);
  return updated;
}

// Orders to print: the given ones (reprint), otherwise all not printed yet. All of them count as
// printed from now on — the browser can't tell whether the printer really printed.
export async function claimForPrint(eventId: number, ids?: number[], now = new Date()): Promise<BurgerOrder[]> {
  const orders = (await listOrders(eventId)).filter(o => (ids ? ids.includes(o.id) : !o.printed_at));
  const printedAt = now.toISOString();
  for (const order of orders) {
    if (order.printed_at) continue;
    order.printed_at = printedAt;
    await getAppStore().update('burger_order', order.id, order);
  }
  return orders;
}

// Back into the queue (e.g. the label roll ran out)
export async function unmarkPrinted(order: BurgerOrder): Promise<BurgerOrder> {
  const updated = { ...order, printed_at: null };
  await getAppStore().update('burger_order', order.id, updated);
  return updated;
}

export const KITCHEN_STATES = ['waiting', 'started', 'done'] as const;
export type KitchenState = typeof KITCHEN_STATES[number];

// Tablet display: waiting (back to the start), started (being prepared), done (ready). Done
// implies started; a time already set is kept, so going back and forth doesn't reset it.
export async function setKitchenState(order: BurgerOrder, state: unknown, now = new Date()): Promise<BurgerOrder> {
  if (!KITCHEN_STATES.includes(state as KitchenState)) throw new ValidationError('Unbekannter Status');
  const at = now.toISOString();
  const updated: BurgerOrder = {
    ...order,
    started_at: state === 'waiting' ? null : order.started_at ?? at,
    done_at: state === 'done' ? order.done_at ?? at : null,
  };
  await getAppStore().update('burger_order', order.id, updated);
  return updated;
}
