import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Attendee } from './lan';
import {
  autofill, describeLayout, groupShape, keepExistingSeats, placeTemplate, sortGroupsByPosition, templateGroups,
  validateGroups, type RowGroup, type TableGroup,
} from './seating';

// db.ts reads DATA_DIR on import, so point it to a temp dir first
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcd-brackets-seating-'));

const row = (id: string, x: number, y: number, rotation: RowGroup['rotation'], length: number, sides: RowGroup['sides']): RowGroup =>
  ({ id, type: 'row', x, y, rotation, length, sides });

// Draws a layout as text: S = seat, T = table, X = overlap
function draw(groups: TableGroup[], width: number, height: number): string[] {
  const grid = Array.from({ length: height }, () => Array(width).fill('.'));
  for (const g of groups) {
    for (const cell of groupShape(g).cells) {
      const [x, y] = [g.x + cell.dx, g.y + cell.dy];
      grid[y][x] = grid[y][x] === '.' ? (cell.kind === 'seat' ? 'S' : 'T') : 'X';
    }
  }
  return grid.map(r => r.join(''));
}

test('rows rotate clockwise; "one" puts the seats in front (below when unrotated)', () => {
  assert.deepEqual(draw([row('g1', 0, 0, 0, 3, 'both')], 3, 3), ['SSS', 'TTT', 'SSS']);
  assert.deepEqual(draw([row('g1', 0, 0, 0, 3, 'one')], 3, 2), ['TTT', 'SSS']);
  assert.deepEqual(draw([row('g1', 0, 0, 90, 3, 'one')], 2, 3), ['ST', 'ST', 'ST']);
  assert.deepEqual(draw([row('g1', 0, 0, 180, 3, 'one')], 3, 2), ['SSS', 'TTT']);
  assert.deepEqual(draw([row('g1', 0, 0, 270, 3, 'one')], 2, 3), ['TS', 'TS', 'TS']);
  assert.deepEqual(draw([row('g1', 0, 0, 0, 2, 'none')], 2, 1), ['TT']);
});

test('templates: U shape with seats inside, double rows back to back, without overlaps', () => {
  const u = templateGroups('u', { length: 4, arm: 2 }).map((g, i) => ({ ...g, id: `g${i + 1}` }) as TableGroup);
  assert.deepEqual(draw(u, 6, 4), [
    'TS..ST',
    'TS..ST',
    '.SSSS.',
    '.TTTT.',
  ]);
  const double = templateGroups('double', { length: 3 }).map((g, i) => ({ ...g, id: `g${i + 1}` }) as TableGroup);
  assert.deepEqual(draw(double, 3, 4), ['SSS', 'TTT', 'TTT', 'SSS']);
  assert.equal(describeLayout({ groups: u }).overlaps.length, 0);
  assert.equal(describeLayout({ groups: u }).seats.length, 8);
});

test('seat numbers follow the group order, within a group in reading order; keys survive moves', () => {
  const groups = [row('g2', 0, 4, 0, 2, 'one'), row('g1', 0, 0, 0, 2, 'both')];
  const layout = describeLayout({ groups });
  assert.deepEqual(layout.seats.map(s => [s.number, s.key]), [[1, 'g2.f0'], [2, 'g2.f1'], [3, 'g1.b0'], [4, 'g1.b1'], [5, 'g1.f0'], [6, 'g1.f1']]);
  assert.deepEqual(describeLayout({ groups: sortGroupsByPosition(groups) }).seats[0].key, 'g1.b0');

  // Moving and rotating keeps the keys, shortening a row drops the seats beyond its end
  const moved = [{ ...groups[0], x: 5, rotation: 90 as const }, { ...groups[1], length: 1 }];
  assert.deepEqual(keepExistingSeats({ groups: moved }, { 'g2.f1': 1, 'g1.b1': 2, 'g1.f0': 3 }), { 'g2.f1': 1, 'g1.f0': 3 });

  // Overlaps are reported
  assert.deepEqual(describeLayout({ groups: [row('g1', 0, 0, 0, 2, 'one'), row('g2', 1, 0, 0, 2, 'one')] }).overlaps.length, 2);
});

test('validation: groups inside the room, unique ids, known values', () => {
  assert.throws(() => validateGroups([row('g1', 5, 0, 0, 6, 'both')], 10, 10), /außerhalb/);
  assert.throws(() => validateGroups([row('g1', 0, 0, 0, 2, 'one'), row('g1', 0, 5, 0, 2, 'one')], 10, 10), /Doppelte/);
  assert.throws(() => validateGroups([{ ...row('g1', 0, 0, 0, 2, 'one'), rotation: 45 }], 10, 10), /Drehung/);
  assert.equal(validateGroups([{ id: 'g1', type: 'area', x: 1, y: 1, width: 3, height: 2, label: ' Bühne ' }], 10, 10)[0].type, 'area');
});

test('templates are placed at the first free spot, with one cell of space', () => {
  const first = placeTemplate({ width: 10, height: 10, groups: [] }, 'row', { length: 4, sides: 'both' });
  assert.deepEqual(first.map(g => [g.id, g.x, g.y]), [['g1', 0, 0]]);
  const second = placeTemplate({ width: 10, height: 10, groups: first }, 'row', { length: 4, sides: 'both' });
  assert.deepEqual(second.map(g => [g.id, g.x, g.y]), [['g1', 0, 0], ['g2', 5, 0]]);
  assert.throws(() => placeTemplate({ width: 4, height: 4, groups: first }, 'block', { length: 4, rows: 2 }), /Kein freier Bereich/);
});

test('the free inside of a U shape can take another block, also at a clicked position', () => {
  // U with seats outside (opening at the bottom), 8 × 8 with a free 4 × 4 inside — like a rotated U
  const u = [
    row('g1', 1, 0, 0, 6, 'one'), row('g2', 0, 1, 90, 6, 'one'), row('g3', 6, 1, 270, 6, 'one'),
  ].map(g => ({ ...g, rotation: g.id === 'g1' ? 180 : g.rotation, y: g.id === 'g1' ? 0 : 2, length: g.id === 'g1' ? 6 : 4 })) as RowGroup[];
  const room = { width: 8, height: 8, groups: u as TableGroup[] };
  assert.deepEqual(draw(room.groups, 8, 8).slice(0, 6), [
    '.SSSSSS.',
    '.TTTTTT.',
    'ST....TS',
    'ST....TS',
    'ST....TS',
    'ST....TS',
  ]);
  // 4 × 4 double row fits exactly inside (no spacing possible there)
  const inside = placeTemplate(room, 'double', { length: 4 }, { x: 2, y: 2 });
  assert.deepEqual(inside.slice(3).map(g => [g.x, g.y]), [[2, 2], [2, 4]]);
  assert.equal(describeLayout({ groups: inside }).overlaps.length, 0);
  // Without a position: the free inside is found as well (spacing preferred, not required)
  const anywhere = placeTemplate(room, 'double', { length: 4 });
  assert.equal(describeLayout({ groups: anywhere }).overlaps.length, 0);
  // A clicked position that doesn't fit goes to the nearest free one
  const near = placeTemplate(room, 'row', { length: 2, sides: 'none' }, { x: 0, y: 0 });
  // (0, 0) is blocked by the seat at (1, 0): the block goes to the closest free spot instead
  const added = near.at(-1)!;
  assert.notDeepEqual([added.x, added.y], [0, 0]);
  assert.equal(describeLayout({ groups: near }).overlaps.length, 0);
});

test('autofill seats clans together on the free seats', () => {
  const a = (id: number, nickname: string, clan = '') => ({ id, nickname, clan }) as Attendee;
  const groups = [row('g1', 0, 0, 0, 4, 'one')];
  const seats = autofill({ groups, seats: { 'g1.f1': 99 } }, [a(1, 'zed'), a(2, 'bob', 'FRG'), a(3, 'al', 'MCD'), a(4, 'ann', 'FRG')]);
  assert.deepEqual(seats, { 'g1.f0': 4, 'g1.f1': 99, 'g1.f2': 2, 'g1.f3': 3 });
});

test('rooms: create, templates, assign (one seat per attendee), cascade on attendee and event delete', async () => {
  const db: typeof import('./db') = require('./db');
  const lan: typeof import('./lan-store') = require('./lan-store');
  const seating: typeof import('./seating-store') = require('./seating-store');
  await db.ensureAppTables();

  const event = await lan.createEvent({ name: 'Sitz-LAN' });
  const max = await lan.addAttendee(event.id, { clan: 'MCD', nickname: 'Maxi' });
  const nova = await lan.addAttendee(event.id, { nickname: 'Nova' });

  const hall = await seating.createRoom(event.id, { name: 'Halle' });
  assert.deepEqual([hall.width, hall.height, hall.layout.seats.length], [24, 14, 0]);
  const withU = await seating.addTemplate(hall.id, 'u', { length: 3, arm: 2 });
  assert.equal(withU.layout.seats.length, 7);
  const side = await seating.createRoom(event.id, { name: 'Nebenraum', width: 6, height: 4 });
  await seating.addTemplate(side.id, 'row', { length: 2, sides: 'one' });
  await assert.rejects(seating.createRoom(event.id, { name: 'halle' }), /schon einen Raum/);

  const firstSeat = withU.layout.seats[0].key;
  await seating.assignSeat(hall.id, firstSeat, max.id);
  const rooms = await seating.assignSeat(side.id, 'g1.f0', max.id); // moves Maxi to the other room
  assert.deepEqual(rooms.map(r => r.seats), [{}, { 'g1.f0': max.id }]);
  await assert.rejects(seating.assignSeat(hall.id, 'g9.f0', nova.id), /gibt es nicht/);

  const filled = await seating.autofillRoom(hall.id);
  assert.deepEqual([filled.seated, filled.remaining], [1, 0]);
  assert.deepEqual(filled.rooms[0].seats, { [firstSeat]: nova.id });

  // Removing a group frees its seats; leaving the room bounds is rejected
  await assert.rejects(seating.updateRoom(hall.id, { width: 3 }), /außerhalb/);
  assert.deepEqual((await seating.updateRoom(hall.id, { groups: [] })).seats, {});

  // A new event copies the room layouts without assignments
  const next = await lan.createEvent({ name: 'Sitz-LAN 2' });
  assert.deepEqual((await seating.listRooms(next.id)).map(r => [r.name, r.groups.length, Object.keys(r.seats).length]), [['Halle', 0, 0], ['Nebenraum', 1, 0]]);

  // Duplicating copies the layout but not the assignments; names stay unique
  await seating.assignSeat(side.id, 'g1.f0', max.id);
  const sideGroups = (await seating.listRooms(event.id)).find(r => r.id === side.id)!.groups;
  await seating.updateRoom(side.id, { groups: sideGroups.map(g => ({ ...g, start_label: 'M1' })), doors: [{ id: 'd1', side: 'top', offset: 0, width: 1, swing: 'out', hinge: 'start' }] });
  const copy = await seating.duplicateRoom(side.id, {});
  assert.equal(copy.name, 'Nebenraum (Kopie)');
  assert.deepEqual([copy.groups.length, copy.doors.length, copy.layout.seats.map(s => s.label), copy.seats], [1, 1, ['M1', 'M2'], {}]);
  assert.equal((await seating.duplicateRoom(side.id, {})).name, 'Nebenraum (Kopie 2)');
  const other = await lan.createEvent({ name: 'Sitz-LAN Ziel' });
  assert.equal((await seating.duplicateRoom(side.id, { event_id: other.id })).name, 'Nebenraum (Kopie)', 'the target event already got a copy of Nebenraum');
  await assert.rejects(seating.duplicateRoom(side.id, { name: 'Halle' }), /schon einen Raum/);

  await lan.deleteAttendee(max.id);
  assert.ok((await seating.listRooms(event.id)).every(r => Object.keys(r.seats).length === 0), 'deleting an attendee frees the seat');
  await lan.deleteEvent(event.id);
  assert.deepEqual((await db.getAppStore().select('room', { event_id: event.id })) ?? [], []);
});

test('rooms of the first version become table groups, occupants keep their position', async () => {
  const { migrateLegacyRoom, isLegacyRoom }: typeof import('./seating') = require('./seating');
  const legacy = {
    id: 0, event_id: 0, name: 'Rittersaal',
    cells: ['SSS.SS', 'TTT.TT', 'SSS...', '......', 'TT....', 'SS....'],
    seats: { '0-1': 7, '2-2': 8, '5-0': 9, '0-4': 10 },
  };
  assert.equal(isLegacyRoom(legacy), true);
  const room = migrateLegacyRoom(legacy);
  assert.equal(isLegacyRoom(room), false);
  assert.deepEqual([room.width, room.height], [6, 6]);
  assert.deepEqual(room.groups.map(g => g.type === 'row' && [g.x, g.y, g.rotation, g.length, g.sides]), [
    [0, 0, 0, 3, 'both'],   // seats above and below
    [4, 0, 180, 2, 'one'],  // seats above only
    [0, 4, 0, 2, 'one'],    // seats below only
  ]);
  assert.deepEqual(draw(room.groups, 6, 6), ['SSS.SS', 'TTT.TT', 'SSS...', '......', 'TT....', 'SS....']);
  const layout = describeLayout(room);
  const occupant = (x: number, y: number) => room.seats[layout.seats.find(s => s.x === x && s.y === y)!.key];
  assert.deepEqual([occupant(1, 0), occupant(2, 2), occupant(0, 5), occupant(4, 0)], [7, 8, 9, 10]);
});

test('numbering per row: forward, backward, around, around backwards — also for vertical rows', () => {
  const numbersOf = (g: RowGroup) => {
    const layout = describeLayout({ groups: [g] });
    // Grid of seat numbers to read the order at a glance
    const shape = groupShape(g);
    const grid = Array.from({ length: shape.h }, () => Array(shape.w).fill('·'));
    for (const s of layout.seats) grid[s.y - g.y][s.x - g.x] = String(s.number);
    return grid.map(r => r.join(' '));
  };
  const horizontal = row('g1', 0, 0, 0, 3, 'both');
  assert.deepEqual(numbersOf(horizontal), ['1 2 3', '· · ·', '4 5 6']);
  assert.deepEqual(numbersOf({ ...horizontal, numbering: 'backward' }), ['6 5 4', '· · ·', '3 2 1']);
  assert.deepEqual(numbersOf({ ...horizontal, numbering: 'around' }), ['1 2 3', '· · ·', '6 5 4']);
  assert.deepEqual(numbersOf({ ...horizontal, numbering: 'around-back' }), ['6 5 4', '· · ·', '1 2 3']);
  // Vertical: one side after the other (left first), top to bottom — no zigzag, whatever the rotation
  assert.deepEqual(numbersOf(row('g1', 0, 0, 90, 3, 'both')), ['1 · 4', '2 · 5', '3 · 6']);
  assert.deepEqual(numbersOf(row('g1', 0, 0, 270, 3, 'both')), ['1 · 4', '2 · 5', '3 · 6']);
  assert.deepEqual(numbersOf(row('g1', 0, 0, 180, 3, 'one')), ['1 2 3', '· · ·']);
  assert.throws(() => validateGroups([{ ...horizontal, numbering: 'zickzack' }], 10, 10), /Nummerierung/);
});

test('doors: on a wall, no overlap, inward swing keeps its area free', async () => {
  const { validateDoors, placeDoor, doorSwingCells }: typeof import('./seating') = require('./seating');
  const door = { id: 'd1', side: 'left' as const, offset: 2, width: 2, swing: 'in' as const, hinge: 'start' as const };
  assert.deepEqual(validateDoors([door], 8, 6), [door]);
  assert.throws(() => validateDoors([{ ...door, offset: 5 }], 8, 6), /außerhalb der Wand/);
  assert.throws(() => validateDoors([door, { ...door, id: 'd2', offset: 3 }], 8, 6), /überlappen/);
  assert.deepEqual(doorSwingCells(door, 8, 6), [[0, 2], [1, 2], [0, 3], [1, 3]]);
  assert.deepEqual(doorSwingCells({ ...door, swing: 'out' }, 8, 6), [], 'outward doors swing outside the room');

  // A table in the swing area is an overlap; new blocks avoid the swing area
  const blocking = describeLayout({ width: 8, height: 6, doors: [door], groups: [row('g1', 0, 3, 0, 2, 'none')] });
  assert.equal(blocking.overlaps.length, 2);
  const placed = placeTemplate({ width: 8, height: 6, doors: [door], groups: [] }, 'row', { length: 2, sides: 'none' }, { x: 0, y: 2 });
  assert.equal(describeLayout({ width: 8, height: 6, doors: [door], groups: placed }).overlaps.length, 0);

  // A new door goes to the wall nearest the click, at the free stretch closest to it
  const right = placeDoor({ width: 8, height: 6, doors: [door] }, { width: 1, swing: 'out' }, { x: 7, y: 4 });
  assert.deepEqual(right.at(-1), { id: 'd2', side: 'right', offset: 4, width: 1, swing: 'out', hinge: 'start' });
  const nextToOther = placeDoor({ width: 8, height: 6, doors: [door] }, { width: 2, side: 'left' }, { x: 0, y: 2 });
  assert.equal(nextToOther.at(-1)!.offset, 0);
});

test('seat numbers: own start per group, the rest automatic without collisions', () => {
  const { nextLabel }: typeof import('./seating') = require('./seating');
  assert.deepEqual(['12', 'M9', 'A-07', 'Orga'].map(l => nextLabel(l)), ['13', 'M10', 'A-08', 'Orga1']);

  const outer = row('g1', 0, 0, 0, 3, 'one');                                   // automatic
  const middle = { ...row('g2', 0, 3, 0, 3, 'one'), start_label: '101' };      // own range
  const extra = row('g3', 0, 6, 0, 3, 'one');                                   // automatic
  assert.deepEqual(describeLayout({ groups: [outer, middle, extra] }).seats.map(s => s.label),
    ['1', '2', '3', '101', '102', '103', '4', '5', '6']);
  // Automatic numbers skip those of a start range; overlapping start ranges are duplicates
  assert.deepEqual(describeLayout({ groups: [outer, { ...middle, start_label: '2' }] }).seats.map(s => s.label),
    ['1', '5', '6', '2', '3', '4']);
  assert.deepEqual(describeLayout({ groups: [{ ...outer, start_label: '7' }, { ...middle, start_label: '8' }] }).duplicates, ['8', '9']);
  assert.throws(() => validateGroups([{ ...outer, start_label: '#1' }], 10, 10), /Startnummer/);
});

test('alternative rooms: seats in addition to the final plan; making one final moves people; clearing', async () => {
  const db: typeof import('./db') = require('./db');
  const lan: typeof import('./lan-store') = require('./lan-store');
  const seating: typeof import('./seating-store') = require('./seating-store');
  await db.ensureAppTables();

  const event = await lan.createEvent({ name: 'Alternativ-LAN' });
  for (const r of await seating.listRooms(event.id)) await seating.deleteRoom(r.id); // copies of earlier events
  const a = await lan.addAttendee(event.id, { nickname: 'Alpha' });
  const b = await lan.addAttendee(event.id, { nickname: 'Bravo' });

  const final = await seating.createRoom(event.id, { name: 'Halle', width: 6, height: 4 });
  await seating.addTemplate(final.id, 'row', { length: 3, sides: 'one' });
  await seating.assignSeat(final.id, 'g1.f0', a.id);

  const draft = await seating.duplicateRoom(final.id, { name: 'Halle Variante', alternative: true });
  assert.equal(draft.alternative, true);
  // Alpha may sit in the alternative too — the final seat stays
  let rooms = await seating.assignSeat(draft.id, 'g1.f2', a.id);
  assert.deepEqual(rooms.map(r => r.seats), [{ 'g1.f0': a.id }, { 'g1.f2': a.id }]);
  // … but only once within the alternative
  rooms = await seating.assignSeat(draft.id, 'g1.f1', a.id);
  assert.deepEqual(rooms[1].seats, { 'g1.f1': a.id });
  // Autofill in the alternative only looks at the alternative
  const filled = await seating.autofillRoom(draft.id);
  assert.deepEqual([filled.seated, filled.remaining], [1, 0]);
  assert.deepEqual(Object.values(filled.rooms[1].seats).sort(), [a.id, b.id].sort());

  // Making the alternative final: its people leave the other final rooms
  const promoted = await seating.updateRoom(draft.id, { alternative: false });
  assert.equal(promoted.alternative, false);
  rooms = await seating.listRooms(event.id);
  assert.deepEqual(rooms[0].seats, {}, 'Alpha moved out of the old final room');
  assert.equal(Object.keys(rooms[1].seats).length, 2);

  // Free all seats of a room
  rooms = await seating.clearSeats(draft.id);
  assert.deepEqual(rooms[1].seats, {});
});
