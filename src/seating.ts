// Seating plans: a room is a free area (width × depth in seat units) with table groups placed on it.
// Groups can be moved and rotated freely; seats belong to their group (key "<group>.<side><index>"),
// so moving or rotating never changes who sits where. Seat numbers run through the groups in list
// order, within a group in reading order. Pure functions only — persistence is in seating-store.ts.

import { ValidationError, type Attendee } from './lan';

export const MIN_SIZE = 2;
export const MAX_SIZE = 80;
const MAX_GROUPS = 300;
const MAX_ROW_LENGTH = 60;

export type Rotation = 0 | 90 | 180 | 270;
export type RowSides = 'both' | 'one' | 'none';
// Seat numbers within a row: along the table, reversed, around the table (one side there,
// the other back) or around in the other direction
export type Numbering = 'forward' | 'backward' | 'around' | 'around-back';
const ROTATIONS: Rotation[] = [0, 90, 180, 270];
const SIDES: RowSides[] = ['both', 'one', 'none'];
export const NUMBERINGS: Numbering[] = ['forward', 'backward', 'around', 'around-back'];

// A straight row of tables. Unrotated: tables run left to right, "one" puts the seats below
// (in front of) the tables, "both" adds seats above. Rotation is clockwise.
export interface RowGroup {
  id: string;
  type: 'row';
  x: number;
  y: number;
  rotation: Rotation;
  length: number;
  sides: RowSides;
  numbering?: Numbering; // default 'forward'
  start_label?: string;  // own number range, e.g. "101" or "M1"; empty = automatic
}

// A labelled area without seats (stage, orga, entrance, pillar …)
export interface AreaGroup {
  id: string;
  type: 'area';
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
}

export type TableGroup = RowGroup | AreaGroup;

// A door in a wall. offset counts cells from the left (top/bottom wall) or from the top
// (left/right wall); the hinge sits at the start or end of the opening. Doors opening
// outwards swing into the one-cell margin around the room.
export type WallSide = 'top' | 'right' | 'bottom' | 'left';
export interface Door {
  id: string;
  side: WallSide;
  offset: number;
  width: number;
  swing: 'in' | 'out';
  hinge: 'start' | 'end';
}
export const WALL_SIDES: WallSide[] = ['top', 'right', 'bottom', 'left'];

export interface Room {
  id: number;
  event_id: number;
  name: string;
  width: number;
  height: number;
  groups: TableGroup[];
  doors: Door[];
  // A draft/variant of the seating plan: attendees may have a seat here in addition to their
  // seat in the final plan (but only one per alternative room)
  alternative?: boolean;
  seats: Record<string, number>; // seat key → attendee id
}

/* Geometry
   ========================================================================== */

export interface ShapeCell {
  dx: number;
  dy: number;
  kind: 'table' | 'seat';
  key?: string; // seats only
}

export interface Shape {
  w: number;
  h: number;
  cells: ShapeCell[];
}

function rotateCell(cell: ShapeCell, w: number, h: number, rotation: Rotation): ShapeCell {
  const { dx, dy } = cell;
  if (rotation === 90) return { ...cell, dx: h - 1 - dy, dy: dx };
  if (rotation === 180) return { ...cell, dx: w - 1 - dx, dy: h - 1 - dy };
  if (rotation === 270) return { ...cell, dx: dy, dy: w - 1 - dx };
  return cell;
}

// Cells of a group relative to its top-left corner (x, y), after rotation
export function groupShape(group: TableGroup): Shape {
  if (group.type === 'area') return { w: group.width, h: group.height, cells: [] };

  const { id, length, sides, rotation } = group;
  const top = sides === 'both' ? 1 : 0;
  const cells: ShapeCell[] = [];
  for (let i = 0; i < length; i++) {
    if (sides === 'both') cells.push({ dx: i, dy: 0, kind: 'seat', key: `${id}.b${i}` });
    cells.push({ dx: i, dy: top, kind: 'table' });
    if (sides !== 'none') cells.push({ dx: i, dy: top + 1, kind: 'seat', key: `${id}.f${i}` });
  }
  const w = length;
  const h = top + 1 + (sides === 'none' ? 0 : 1);
  const rotated = cells.map(cell => rotateCell(cell, w, h, rotation));
  return rotation === 90 || rotation === 270 ? { w: h, h: w, cells: rotated } : { w, h, cells: rotated };
}

export interface SeatPosition {
  key: string;
  number: number; // position in the seat order (1, 2, 3 …) — used for sorting
  label: string;  // the seat number people see: from the group's start number or automatic
  x: number;
  y: number;
  group: string;
}

export interface GroupLayout {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  cells: ShapeCell[];
}

export interface RoomLayout {
  groups: GroupLayout[];
  seats: SeatPosition[];
  overlaps: [number, number][]; // cells used by more than one group
  duplicates: string[];          // seat numbers used more than once
}

/* Seat labels
   ========================================================================== */

export const MAX_LABEL_LENGTH = 8;
const LABEL_PATTERN = /^[A-Za-z0-9ÄÖÜäöüß._-]{1,8}$/;

export function validateLabel(value: unknown, field = 'Platznummer'): string {
  const label = typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
  if (!LABEL_PATTERN.test(label)) throw new ValidationError(`${field}: 1–${MAX_LABEL_LENGTH} Zeichen (Buchstaben, Ziffern, . _ -)`);
  return label;
}

// "12" → "13", "M9" → "M10", "A-07" → "A-08", "Orga" → "Orga1"
export function nextLabel(label: string, step = 1): string {
  const match = /^(.*?)(\d+)$/.exec(label);
  if (!match) return `${label}${step}`;
  const [, prefix, digits] = match;
  return prefix + String(Number(digits) + step).padStart(digits.length, '0');
}

// Seats of a row in numbering order. Base order: the side nearer the top/left first, each side
// along the table from left to right (or top to bottom) — independent of the rotation.
function orderRowSeats(group: RowGroup, cells: ShapeCell[]): ShapeCell[] {
  const vertical = group.rotation === 90 || group.rotation === 270;
  const along = (c: ShapeCell) => (vertical ? c.dy : c.dx);
  const across = (c: ShapeCell) => (vertical ? c.dx : c.dy);
  const seats = cells.filter(c => c.kind === 'seat');
  const sides = [...new Set(seats.map(across))].sort((a, b) => a - b)
    .map(line => seats.filter(c => across(c) === line).sort((a, b) => along(a) - along(b)));
  const mode = group.numbering ?? 'forward';
  if (mode === 'forward') return sides.flat();
  if (mode === 'backward') return sides.flat().reverse();
  const around = sides.map((side, i) => (i % 2 === 1 ? [...side].reverse() : side)).flat();
  return mode === 'around' ? around : around.reverse();
}

// Cells inside the room a door needs to open (doors opening inwards only)
export function doorSwingCells(door: Door, width: number, height: number): [number, number][] {
  if (door.swing !== 'in') return [];
  const cells: [number, number][] = [];
  for (let i = 0; i < door.width; i++) {
    for (let d = 0; d < door.width; d++) {
      const along = door.offset + i;
      if (door.side === 'top') cells.push([along, d]);
      if (door.side === 'bottom') cells.push([along, height - 1 - d]);
      if (door.side === 'left') cells.push([d, along]);
      if (door.side === 'right') cells.push([width - 1 - d, along]);
    }
  }
  return cells.filter(([x, y]) => x >= 0 && y >= 0 && x < width && y < height);
}

// Absolute seat positions with their numbers, plus overlapping cells (shown red in the editor);
// the swing area of inward doors counts as used
export function describeLayout(room: Pick<Room, 'groups'> & Partial<Pick<Room, 'doors' | 'width' | 'height'>>): RoomLayout {
  const groups: GroupLayout[] = [];
  const seats: SeatPosition[] = [];
  const usage = new Map<string, number>();
  const use = (x: number, y: number) => usage.set(`${x},${y}`, (usage.get(`${x},${y}`) ?? 0) + 1);

  for (const group of room.groups) {
    const shape = groupShape(group);
    groups.push({ id: group.id, x: group.x, y: group.y, w: shape.w, h: shape.h, cells: shape.cells });
    if (group.type === 'area') {
      for (let dy = 0; dy < shape.h; dy++) for (let dx = 0; dx < shape.w; dx++) use(group.x + dx, group.y + dy);
      continue;
    }
    const groupSeats = orderRowSeats(group, shape.cells);
    for (const cell of shape.cells) use(group.x + cell.dx, group.y + cell.dy);
    groupSeats.forEach((cell, i) => {
      seats.push({
        key: cell.key!, number: seats.length + 1, x: group.x + cell.dx, y: group.y + cell.dy, group: group.id,
        label: group.start_label ? nextLabel(group.start_label, i) : '',
      });
    });
  }

  // Seats without a start number of their group: 1, 2, 3 … skipping numbers already taken
  const taken = new Set(seats.map(s => s.label).filter(Boolean));
  let next = 1;
  for (const seat of seats) {
    if (seat.label) continue;
    while (taken.has(String(next))) next++;
    seat.label = String(next++);
  }
  const counts = new Map<string, number>();
  for (const seat of seats) counts.set(seat.label.toLowerCase(), (counts.get(seat.label.toLowerCase()) ?? 0) + 1);
  const duplicates = [...new Set(seats.filter(s => (counts.get(s.label.toLowerCase()) ?? 0) > 1).map(s => s.label))];

  for (const door of room.doors ?? []) {
    for (const [x, y] of doorSwingCells(door, room.width ?? MAX_SIZE, room.height ?? MAX_SIZE)) use(x, y);
  }

  const overlaps = [...usage].filter(([, n]) => n > 1).map(([pos]) => pos.split(',').map(Number) as [number, number]);
  return { groups, seats, overlaps, duplicates };
}

export function seatKeys(room: Pick<Room, 'groups'>): string[] {
  return describeLayout(room).seats.map(s => s.key);
}

// Only seats that still exist keep their occupant
export function keepExistingSeats(room: Pick<Room, 'groups'>, seats: Record<string, number>): Record<string, number> {
  const valid = new Set(seatKeys(room));
  return Object.fromEntries(Object.entries(seats).filter(([key]) => valid.has(key)));
}

/* Validation
   ========================================================================== */

function intInRange(value: unknown, min: number, max: number, label: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new ValidationError(`${label}: ${min} bis ${max}`);
  return n;
}

export function validateRoomName(name: unknown): string {
  const value = typeof name === 'string' ? name.trim() : '';
  if (!value) throw new ValidationError('Der Raum braucht einen Namen');
  if (value.length > 60) throw new ValidationError('Der Raumname ist zu lang (max. 60 Zeichen)');
  return value;
}

export function validateSize(width: unknown, height: unknown): { width: number; height: number } {
  return {
    width: intInRange(width, MIN_SIZE, MAX_SIZE, 'Raumbreite'),
    height: intInRange(height, MIN_SIZE, MAX_SIZE, 'Raumtiefe'),
  };
}

function validateGroup(input: unknown): TableGroup {
  const g = (input ?? {}) as Record<string, unknown>;
  const id = typeof g.id === 'string' && /^g\d{1,6}$/.test(g.id) ? g.id : null;
  if (!id) throw new ValidationError('Ungültige Tischgruppe');
  const x = intInRange(g.x, 0, MAX_SIZE, 'Position');
  const y = intInRange(g.y, 0, MAX_SIZE, 'Position');

  if (g.type === 'area') {
    const label = typeof g.label === 'string' ? g.label.trim().slice(0, 40) : '';
    return { id, type: 'area', x, y, width: intInRange(g.width, 1, MAX_SIZE, 'Flächenbreite'), height: intInRange(g.height, 1, MAX_SIZE, 'Flächentiefe'), label };
  }
  if (g.type !== 'row') throw new ValidationError('Ungültige Tischgruppe');
  const rotation = Number(g.rotation) as Rotation;
  if (!ROTATIONS.includes(rotation)) throw new ValidationError('Drehung: 0, 90, 180 oder 270 Grad');
  const sides = g.sides as RowSides;
  if (!SIDES.includes(sides)) throw new ValidationError('Ungültige Platzanordnung');
  const numbering = (g.numbering ?? 'forward') as Numbering;
  if (!NUMBERINGS.includes(numbering)) throw new ValidationError('Ungültige Nummerierung');
  const row: RowGroup = { id, type: 'row', x, y, rotation, length: intInRange(g.length, 1, MAX_ROW_LENGTH, 'Tische in der Reihe'), sides };
  if (numbering !== 'forward') row.numbering = numbering;
  if (g.start_label !== undefined && g.start_label !== null && String(g.start_label).trim() !== '') {
    row.start_label = validateLabel(g.start_label, 'Startnummer');
  }
  return row;
}

const wallLength = (side: WallSide, width: number, height: number) => (side === 'top' || side === 'bottom' ? width : height);

// Doors must fit into their wall and not overlap each other
export function validateDoors(input: unknown, width: number, height: number): Door[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new ValidationError('Ungültige Türen');
  if (input.length > 50) throw new ValidationError('Höchstens 50 Türen pro Raum');
  const doors = input.map((raw): Door => {
    const d = (raw ?? {}) as Record<string, unknown>;
    const id = typeof d.id === 'string' && /^d\d{1,6}$/.test(d.id) ? d.id : null;
    if (!id) throw new ValidationError('Ungültige Tür');
    const side = d.side as WallSide;
    if (!WALL_SIDES.includes(side)) throw new ValidationError('Tür: ungültige Wand');
    const doorWidth = intInRange(d.width, 1, 6, 'Türbreite');
    const offset = intInRange(d.offset, 0, Math.max(0, wallLength(side, width, height) - doorWidth), 'Tür liegt außerhalb der Wand — Position');
    const swing = d.swing === 'out' ? 'out' : 'in';
    const hinge = d.hinge === 'end' ? 'end' : 'start';
    return { id, side, offset, width: doorWidth, swing, hinge };
  });
  const ids = new Set<string>();
  for (const door of doors) {
    if (ids.has(door.id)) throw new ValidationError('Doppelte Tür');
    ids.add(door.id);
    const clash = doors.find(o => o !== door && o.side === door.side && o.offset < door.offset + door.width && door.offset < o.offset + o.width);
    if (clash) throw new ValidationError('Zwei Türen überlappen sich');
  }
  return doors;
}

// New door: on the wall nearest to the clicked cell (or the top wall), at the first free stretch
export function placeDoor(room: Pick<Room, 'width' | 'height' | 'doors'>, input: { width?: unknown; swing?: unknown; hinge?: unknown; side?: unknown }, at?: { x: number; y: number }): Door[] {
  const doorWidth = intInRange(input.width ?? 2, 1, 6, 'Türbreite');
  let side: WallSide = WALL_SIDES.includes(input.side as WallSide) ? (input.side as WallSide) : 'top';
  let wanted = 0;
  if (at && !WALL_SIDES.includes(input.side as WallSide)) {
    const distances: [WallSide, number][] = [['top', at.y], ['bottom', room.height - 1 - at.y], ['left', at.x], ['right', room.width - 1 - at.x]];
    side = distances.sort((a, b) => a[1] - b[1])[0][0];
  }
  if (at) wanted = side === 'top' || side === 'bottom' ? at.x : at.y;
  const length = wallLength(side, room.width, room.height);
  if (doorWidth > length) throw new ValidationError('Die Tür ist breiter als die Wand');
  const used = room.doors.filter(d => d.side === side);
  const free = (offset: number) => used.every(o => offset + doorWidth <= o.offset || o.offset + o.width <= offset);
  const offsets = Array.from({ length: length - doorWidth + 1 }, (_, i) => i)
    .sort((a, b) => Math.abs(a - wanted) - Math.abs(b - wanted));
  const offset = offsets.find(free);
  if (offset === undefined) throw new ValidationError('An dieser Wand ist kein Platz mehr für die Tür');
  const max = room.doors.reduce((m, d) => Math.max(m, Number(d.id.slice(1))), 0);
  return [...room.doors, {
    id: `d${max + 1}`, side, offset, width: doorWidth,
    swing: input.swing === 'out' ? 'out' : 'in', hinge: input.hinge === 'end' ? 'end' : 'start',
  }];
}

// Groups must have unique ids and lie completely inside the room
export function validateGroups(input: unknown, width: number, height: number): TableGroup[] {
  if (!Array.isArray(input)) throw new ValidationError('Tischgruppen fehlen');
  if (input.length > MAX_GROUPS) throw new ValidationError(`Höchstens ${MAX_GROUPS} Tischgruppen pro Raum`);
  const groups = input.map(validateGroup);
  const ids = new Set<string>();
  for (const group of groups) {
    if (ids.has(group.id)) throw new ValidationError('Doppelte Tischgruppe');
    ids.add(group.id);
    const shape = groupShape(group);
    if (group.x + shape.w > width || group.y + shape.h > height) {
      throw new ValidationError('Eine Tischgruppe liegt außerhalb des Raums — Raum vergrößern oder Gruppe verschieben');
    }
  }
  return groups;
}

/* Templates: building blocks that add one or more groups
   ========================================================================== */

export type TemplateName = 'row' | 'double' | 'u' | 'block' | 'area';

export interface TemplateInput {
  length?: unknown;   // tables per row (row, double, block) or at the base (u)
  arm?: unknown;      // u: seats along each arm
  rows?: unknown;     // block: number of double rows
  sides?: unknown;    // row: both / one / none
  label?: unknown;    // area
  width?: unknown;    // area
  height?: unknown;   // area
}

type GroupDraft = Omit<RowGroup, 'id'> | Omit<AreaGroup, 'id'>;

// Groups of a template relative to (0, 0)
export function templateGroups(name: TemplateName, input: TemplateInput): GroupDraft[] {
  const row = (x: number, y: number, rotation: Rotation, length: number, sides: RowSides): GroupDraft =>
    ({ type: 'row', x, y, rotation, length, sides });

  if (name === 'row') {
    const sides = SIDES.includes(input.sides as RowSides) ? (input.sides as RowSides) : 'both';
    return [row(0, 0, 0, intInRange(input.length ?? 6, 1, MAX_ROW_LENGTH, 'Tische'), sides)];
  }
  if (name === 'double') {
    // Two rows back to back: seats above the upper tables, seats below the lower ones
    const n = intInRange(input.length ?? 6, 1, MAX_ROW_LENGTH, 'Tische');
    return [row(0, 0, 180, n, 'one'), row(0, 2, 0, n, 'one')];
  }
  if (name === 'block') {
    const n = intInRange(input.length ?? 6, 1, MAX_ROW_LENGTH, 'Tische');
    const rows = intInRange(input.rows ?? 3, 1, 20, 'Doppelreihen');
    return Array.from({ length: rows }, (_, i) => [row(0, i * 5, 180, n, 'one'), row(0, i * 5 + 2, 0, n, 'one')]).flat();
  }
  if (name === 'u') {
    // Opening at the top, seats inside: left arm, base, right arm
    const base = intInRange(input.length ?? 6, 2, MAX_ROW_LENGTH, 'Plätze unten');
    const arm = intInRange(input.arm ?? 4, 1, MAX_ROW_LENGTH, 'Plätze je Seite');
    return [row(0, 0, 270, arm, 'one'), row(1, arm, 180, base, 'one'), row(base, 0, 90, arm, 'one')];
  }
  if (name === 'area') {
    const label = typeof input.label === 'string' ? input.label.trim().slice(0, 40) : '';
    return [{ type: 'area', x: 0, y: 0, width: intInRange(input.width ?? 4, 1, MAX_SIZE, 'Breite'), height: intInRange(input.height ?? 2, 1, MAX_SIZE, 'Tiefe'), label }];
  }
  throw new ValidationError('Unbekannter Baustein');
}

export function nextGroupId(groups: TableGroup[], offset = 0): string {
  const max = groups.reduce((m, g) => Math.max(m, Number(g.id.slice(1))), 0);
  return `g${max + 1 + offset}`;
}

// Cells a group really uses (tables, seats, the whole area) — the inside of a U stays free
function usedCells(group: TableGroup): [number, number][] {
  const shape = groupShape(group);
  if (group.type === 'area') {
    const cells: [number, number][] = [];
    for (let dy = 0; dy < shape.h; dy++) for (let dx = 0; dx < shape.w; dx++) cells.push([group.x + dx, group.y + dy]);
    return cells;
  }
  return shape.cells.map(c => [group.x + c.dx, group.y + c.dy]);
}

// Adds a template. With a preferred position (a click on the canvas) it goes there, or as close as
// possible; otherwise to the first free spot, preferably with one free cell around it.
export function placeTemplate(
  room: Pick<Room, 'width' | 'height' | 'groups'> & Partial<Pick<Room, 'doors'>>, name: TemplateName, input: TemplateInput,
  at?: { x: number; y: number },
): TableGroup[] {
  const drafts = templateGroups(name, input).map((draft, i) => ({ ...draft, id: nextGroupId(room.groups, i) }) as TableGroup);
  const w = Math.max(...drafts.map(g => g.x + groupShape(g).w));
  const h = Math.max(...drafts.map(g => g.y + groupShape(g).h));
  const draftCells = drafts.flatMap(usedCells);

  const taken = new Set<string>();
  const spaced = new Set<string>();
  const doorCells = (room.doors ?? []).flatMap(d => doorSwingCells(d, room.width, room.height));
  for (const [x, y] of [...room.groups.flatMap(usedCells), ...doorCells]) {
    taken.add(`${x},${y}`);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) spaced.add(`${x + dx},${y + dy}`);
  }
  const fits = (ox: number, oy: number, blocked: Set<string>) =>
    ox >= 0 && oy >= 0 && ox + w <= room.width && oy + h <= room.height &&
    draftCells.every(([x, y]) => !blocked.has(`${x + ox},${y + oy}`));
  const place = (ox: number, oy: number) => [...room.groups, ...drafts.map(g => ({ ...g, x: g.x + ox, y: g.y + oy }))];

  const positions: [number, number][] = [];
  for (let oy = 0; oy + h <= room.height; oy++) for (let ox = 0; ox + w <= room.width; ox++) positions.push([ox, oy]);

  if (at) {
    // Clicked cell = top-left corner; otherwise the closest free position
    const tx = Math.round(at.x), ty = Math.round(at.y);
    const byDistance = [...positions].sort((a, b) =>
      (Math.abs(a[0] - tx) + Math.abs(a[1] - ty)) - (Math.abs(b[0] - tx) + Math.abs(b[1] - ty)));
    const best = byDistance.find(([ox, oy]) => fits(ox, oy, taken));
    if (best) return place(...best);
  } else {
    const best = positions.find(([ox, oy]) => fits(ox, oy, spaced)) ?? positions.find(([ox, oy]) => fits(ox, oy, taken));
    if (best) return place(...best);
  }
  throw new ValidationError(`Kein freier Bereich für ${w} × ${h} Felder — Raum vergrößern oder Gruppen verschieben`);
}

/* Assignment helpers
   ========================================================================== */

// Clans sit together: clan, then nickname (German collation); attendees without clan last
const collator = new Intl.Collator('de', { sensitivity: 'base', numeric: true });
export function autofillOrder(attendees: Attendee[]): Attendee[] {
  return [...attendees].sort((a, b) => {
    if (!a.clan !== !b.clan) return a.clan ? -1 : 1;
    return collator.compare(a.clan ?? '', b.clan ?? '') || collator.compare(a.nickname, b.nickname);
  });
}

// Fill the free seats of a room in seat-number order with the attendees that have no seat yet
export function autofill(room: Pick<Room, 'groups' | 'seats'>, unseated: Attendee[]): Record<string, number> {
  const seats = { ...room.seats };
  const free = seatKeys(room).filter(key => seats[key] === undefined);
  autofillOrder(unseated).slice(0, free.length).forEach((attendee, i) => { seats[free[i]] = attendee.id; });
  return seats;
}

// Groups ordered by position (top to bottom, then left to right) — renumbers the seats accordingly
export function sortGroupsByPosition(groups: TableGroup[]): TableGroup[] {
  return [...groups].sort((a, b) => a.y - b.y || a.x - b.x);
}

/* Rooms from the first version (a grid of cells "S"/"T"/"." and seat keys "row-col")
   ========================================================================== */

export interface LegacyRoom {
  id: number;
  event_id: number;
  name: string;
  cells: string[];
  seats: Record<string, number>;
}

export function isLegacyRoom(room: unknown): room is LegacyRoom {
  return typeof room === 'object' && room !== null && Array.isArray((room as LegacyRoom).cells) && !Array.isArray((room as Room).groups);
}

// Every horizontal run of tables becomes a row with seats above, below, both or none;
// occupants move to the seat at the same position. Seats not next to a table run are dropped.
export function migrateLegacyRoom(legacy: LegacyRoom): Room {
  const cells = legacy.cells;
  const at = (r: number, c: number) => cells[r]?.[c] ?? '.';
  const groups: TableGroup[] = [];
  cells.forEach((line, r) => {
    for (const match of line.matchAll(/T+/g)) {
      const x = match.index!;
      const length = match[0].length;
      const full = (row: number) => Array.from({ length }, (_, i) => at(row, x + i)).every(cell => cell === SEAT_CELL);
      const above = full(r - 1), below = full(r + 1);
      const id = `g${groups.length + 1}`;
      if (above && below) groups.push({ id, type: 'row', x, y: r - 1, rotation: 0, length, sides: 'both' });
      else if (below) groups.push({ id, type: 'row', x, y: r, rotation: 0, length, sides: 'one' });
      else if (above) groups.push({ id, type: 'row', x, y: r - 1, rotation: 180, length, sides: 'one' });
      else groups.push({ id, type: 'row', x, y: r, rotation: 0, length, sides: 'none' });
    }
  });

  const keyAt = new Map(describeLayout({ groups }).seats.map(s => [`${s.y}-${s.x}`, s.key]));
  const seats: Record<string, number> = {};
  for (const [oldKey, attendeeId] of Object.entries(legacy.seats ?? {})) {
    const key = keyAt.get(oldKey);
    if (key) seats[key] = attendeeId;
  }
  return {
    id: legacy.id,
    event_id: legacy.event_id,
    name: legacy.name,
    width: Math.min(MAX_SIZE, Math.max(MIN_SIZE, cells[0]?.length ?? MIN_SIZE)),
    height: Math.min(MAX_SIZE, Math.max(MIN_SIZE, cells.length)),
    groups,
    doors: [],
    seats,
  };
}

const SEAT_CELL = 'S';
