import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// db.ts reads DATA_DIR on import, so point it to a temp dir first
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcd-brackets-burger-'));

const { ensureAppTables }: typeof import('./db') = require('./db');
const burger: typeof import('./burger') = require('./burger');
const store: typeof import('./lan-store') = require('./lan-store');
const { ValidationError }: typeof import('./lan') = require('./lan');

const { DEFAULT_MENU, validateMenu, validateChoices, summarizeOrder } = burger;

const order = {
  size: 'single', patty: 'meat', cheese: 'blue', toppings: ['onion', 'bacon'], sauce: ['burger-sauce'], bun: 'brioche',
};

test('the summary follows the menu order, with "extra viel" and texts for empty categories', () => {
  const picked = validateChoices(DEFAULT_MENU, { choices: order, extra: ['burger-sauce', 'bacon', 'unknown'] });
  assert.deepEqual(picked.choices.size, ['single'], 'single choices become lists');
  assert.deepEqual(picked.extra, ['burger-sauce'], 'extra only for chosen options of categories with extra');
  assert.equal(summarizeOrder(DEFAULT_MENU, picked), 'Einfach, Fleisch, Blauschimmel, Zwiebeln, Bacon, extra viel Burgersauce, Brioche');

  const plain = validateChoices(DEFAULT_MENU, { choices: { ...order, toppings: [], sauce: [] } });
  assert.equal(summarizeOrder(DEFAULT_MENU, plain), 'Einfach, Fleisch, Blauschimmel, ohne Belag, ohne Sauce, Brioche');
});

test('single categories need exactly one available option', () => {
  assert.throws(() => validateChoices(DEFAULT_MENU, { choices: { ...order, cheese: undefined } }), /Käse/);
  assert.throws(() => validateChoices(DEFAULT_MENU, { choices: { ...order, cheese: ['blue', 'cheddar'] } }), /Käse/);
  assert.throws(() => validateChoices(DEFAULT_MENU, { choices: { ...order, toppings: ['gold'] } }), /unbekannte/);

  const menu = structuredClone(DEFAULT_MENU);
  menu.categories.find(c => c.id === 'bun')!.options.find(o => o.id === 'protein')!.available = false;
  assert.throws(() => validateChoices(menu, { choices: { ...order, bun: 'protein' } }), /nicht \(mehr\) verfügbar/);
});

test('the menu validation keeps IDs, creates unique ones for new entries and checks the fields', () => {
  assert.deepEqual(validateMenu(DEFAULT_MENU), DEFAULT_MENU, 'the default menu is valid as it is');

  const menu = validateMenu({
    open: false,
    categories: [
      { id: 'toppings', name: 'Belag', visual: 'topping', multiple: true, extra: true, empty_label: ' ohne ', options: [
        { id: 'bacon', name: 'Bacon', color: '#B8452F', shape: 'strip' },
        { name: 'Röstzwiebeln', shape: 'glitter' },
        { name: 'Röstzwiebeln' },
      ] },
      { name: 'Extras', visual: 'sparkles', multiple: false, extra: true, empty_label: 'x', options: [{ name: 'Spiegelei', available: false }] },
    ],
  });
  assert.equal(menu.open, false);
  const [toppings, extras] = menu.categories;
  assert.deepEqual(toppings.options.map(o => o.id), ['bacon', 'roestzwiebeln', 'roestzwiebeln-2']);
  assert.equal(toppings.options[0].color, '#b8452f');
  assert.equal(toppings.options[1].shape, '', 'unknown shapes are dropped');
  assert.equal(toppings.empty_label, 'ohne');
  assert.equal(extras.id, 'extras');
  assert.equal(extras.visual, 'none');
  assert.equal(extras.extra, false, '"extra viel" only for multiple choice');
  assert.equal(extras.empty_label, '');
  assert.equal(extras.options[0].available, false);

  for (const categories of [
    [],
    [{ name: '', options: [{ name: 'x' }] }],
    [{ name: 'Leer', options: [] }],
    [{ name: 'Größe', visual: 'size', options: [{ name: 'Mega', count: 9 }] }],
  ]) {
    assert.throws(() => validateMenu({ categories }), ValidationError, JSON.stringify(categories));
  }
});

test('orders get numbers per event, can be changed until printed and are printed only once', async () => {
  await ensureAppTables();
  const event = await store.createEvent({ name: 'Burger-LAN' });
  const other = await store.createEvent({ name: 'Andere LAN' });

  const first = await burger.createOrder(event.id, { attendee_id: null, name: 'Orga' }, { choices: order, note: '  gut   durch ' });
  const second = await burger.createOrder(event.id, { attendee_id: null, name: 'Gast' }, { choices: order });
  const elsewhere = await burger.createOrder(other.id, { attendee_id: null, name: 'Gast' }, { choices: order });
  assert.deepEqual([first.number, second.number, elsewhere.number], [1, 2, 1]);
  assert.equal(first.note, 'gut durch');
  assert.ok(first.token.length >= 20);
  assert.equal('token' in burger.orderView(first), false, 'the token never leaves the server in lists');

  const changed = await burger.updateOrder(first, { choices: { ...order, size: 'double' } });
  assert.match(changed.summary, /^Doppelt,/);
  assert.equal(changed.note, '', 'an update replaces the note too');

  const printed = await burger.claimForPrint(event.id);
  assert.deepEqual(printed.map(o => o.number), [1, 2]);
  assert.ok(printed.every(o => o.printed_at));
  assert.deepEqual(await burger.claimForPrint(event.id), [], 'printed orders are not printed again');

  const reprint = await burger.claimForPrint(event.id, [second.id]);
  assert.deepEqual(reprint.map(o => o.id), [second.id], 'explicit reprint');
  assert.equal(reprint[0].printed_at, printed[1].printed_at, 'a reprint keeps the first print time');

  const printedFirst = (await burger.getOrder(first.id))!;
  await assert.rejects(() => burger.updateOrder(printedFirst, { choices: order }), /schon beim Grill/);

  await burger.unmarkPrinted((await burger.getOrder(second.id))!);
  assert.deepEqual((await burger.claimForPrint(event.id)).map(o => o.id), [second.id], 'back in the queue');

  await store.deleteEvent(event.id);
  assert.deepEqual(await burger.listOrders(event.id), [], 'deleting the event removes its orders');
  assert.equal((await burger.listOrders(other.id)).length, 1);
});

test('the stored menu is used, a broken record falls back to the default', async () => {
  await ensureAppTables();
  const saved = await burger.saveMenu({ ...DEFAULT_MENU, open: false });
  assert.equal(saved.open, false);
  assert.equal((await burger.getMenu()).open, false);
  await burger.saveMenu(DEFAULT_MENU);
  assert.equal((await burger.getMenu()).open, true);
});

test('stored menus get the current default colours, own colours stay', () => {
  const menu = structuredClone(DEFAULT_MENU);
  const patties = menu.categories.find(c => c.id === 'patty')!.options;
  patties.find(o => o.id === 'veggie')!.color = '#7c8a3c'; // former default
  patties.find(o => o.id === 'meat')!.color = '#123456';
  const result = burger.withCurrentColors(menu).categories.find(c => c.id === 'patty')!.options;
  assert.equal(result.find(o => o.id === 'veggie')!.color, '#022c12');
  assert.equal(result.find(o => o.id === 'meat')!.color, '#123456');
});

test('the tablet display moves orders from waiting to started to done and locks them', async () => {
  await ensureAppTables();
  const event = await store.createEvent({ name: 'Küchen-LAN' });
  const created = await burger.createOrder(event.id, { attendee_id: null, name: 'Gast' }, { choices: order });
  assert.equal(burger.isLocked(created), false);

  const started = await burger.setKitchenState(created, 'started', new Date('2026-10-31T18:00:00Z'));
  assert.equal(started.started_at, '2026-10-31T18:00:00.000Z');
  assert.equal(started.done_at, null);
  assert.equal(burger.isLocked(started), true, 'being prepared = no more changes by the orderer');
  await assert.rejects(() => burger.updateOrder(started, { choices: order }), /schon beim Grill/);

  const done = await burger.setKitchenState(started, 'done', new Date('2026-10-31T18:05:00Z'));
  assert.equal(done.started_at, started.started_at, 'the start time stays');
  assert.equal(done.done_at, '2026-10-31T18:05:00.000Z');

  const directlyDone = await burger.setKitchenState(created, 'done', new Date('2026-10-31T18:07:00Z'));
  assert.equal(directlyDone.started_at, directlyDone.done_at, 'done implies started');

  const back = await burger.setKitchenState(done, 'waiting');
  assert.deepEqual([back.started_at, back.done_at], [null, null]);
  assert.equal(burger.isLocked(back), false);
  await assert.rejects(() => burger.setKitchenState(back, 'eaten'), ValidationError);
});

test('menus saved before the output switches print labels and have no tablet display', () => {
  const { print_labels: _p, kitchen_display: _k, ...old } = DEFAULT_MENU;
  const menu = validateMenu(old);
  assert.equal(menu.print_labels, true);
  assert.equal(menu.kitchen_display, false);
  assert.equal(validateMenu({ ...old, print_labels: false, kitchen_display: true }).print_labels, false);
});
