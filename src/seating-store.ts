import { getAppStore } from './db';
import { HttpError } from './http-error';
import { ValidationError } from './lan';
import { getEvent, listAttendees } from './lan-store';
import {
  autofill, describeLayout, isLegacyRoom, keepExistingSeats, migrateLegacyRoom, placeDoor, placeTemplate, validateDoors, seatKeys, sortGroupsByPosition, validateGroups,
  validateRoomName, validateSize, type Room, type RoomLayout, type TemplateInput, type TemplateName,
} from './seating';

// What the API returns: the stored room plus its computed layout (seat numbers and positions)
export type RoomView = Room & { layout: RoomLayout };

const DEFAULT_SIZE = { width: 24, height: 14 };

function view(room: Room): RoomView {
  return { ...room, layout: describeLayout(room) };
}

// Rooms saved before doors existed have none
const withDoors = (room: Room): Room => (Array.isArray(room.doors) ? room : { ...room, doors: [] });

async function storedRooms(eventId: number): Promise<Room[]> {
  return ((await getAppStore().select('room', { event_id: eventId })) ?? []).map(withDoors).sort((a, b) => a.id - b.id);
}

// Converts rooms of the first seating version (cell grid) — at startup and after a restore
export async function migrateRooms(): Promise<number> {
  let migrated = 0;
  for (const room of ((await getAppStore().select('room')) ?? []) as unknown[]) {
    if (!isLegacyRoom(room)) continue;
    const converted = migrateLegacyRoom(room);
    await getAppStore().update('room', converted.id, converted);
    migrated++;
  }
  return migrated;
}

export async function listRooms(eventId: number): Promise<RoomView[]> {
  await getEvent(eventId);
  // Seats of deleted attendees are dropped on the fly (deleteAttendee also cleans up)
  const attendeeIds = new Set((await listAttendees(eventId)).map(a => a.id));
  return (await storedRooms(eventId)).map(room => view({
    ...room,
    seats: Object.fromEntries(Object.entries(room.seats).filter(([, id]) => attendeeIds.has(id))),
  }));
}

async function getRoom(id: number): Promise<Room> {
  const room = await getAppStore().select('room', id);
  if (!room) throw new HttpError(404, 'Raum nicht gefunden');
  return withDoors(room);
}

async function assertUniqueRoomName(eventId: number, name: string, exceptId?: number): Promise<void> {
  if ((await storedRooms(eventId)).some(r => r.id !== exceptId && r.name.toLowerCase() === name.toLowerCase())) {
    throw new ValidationError(`Es gibt schon einen Raum „${name}“`);
  }
}

async function saveRoom(room: Room): Promise<RoomView> {
  // Rooms may still carry "labels" from the removed click numbering — dropped on save
  const { labels: _dropped, ...rest } = room as Room & { labels?: unknown };
  const cleaned = { ...rest, seats: keepExistingSeats(room, room.seats) };
  await getAppStore().update('room', room.id, cleaned);
  return view(cleaned);
}

// Rooms whose seats count against each other: an alternative only against itself,
// a final room against all final rooms of the event
const isAlternative = (room: Pick<Room, 'alternative'>) => room.alternative === true;
function competingRooms(room: Room, rooms: Room[]): Room[] {
  return isAlternative(room) ? rooms.filter(r => r.id === room.id) : rooms.filter(r => !isAlternative(r));
}

export async function createRoom(eventId: number, input: { name?: unknown; width?: unknown; height?: unknown; alternative?: unknown }): Promise<RoomView> {
  await getEvent(eventId);
  const name = validateRoomName(input.name);
  await assertUniqueRoomName(eventId, name);
  const size = validateSize(input.width ?? DEFAULT_SIZE.width, input.height ?? DEFAULT_SIZE.height);
  const id = await getAppStore().insert('room', { event_id: eventId, name, ...size, groups: [], doors: [], alternative: input.alternative === true, seats: {} });
  return view(await getRoom(id));
}

// Name, size and/or groups (the editor sends the complete group list); seats of removed groups are freed
// Making an alternative final moves its attendees out of the other final rooms (this one wins)
export async function updateRoom(id: number, input: { name?: unknown; width?: unknown; height?: unknown; groups?: unknown; doors?: unknown; alternative?: unknown }): Promise<RoomView> {
  const room = await getRoom(id);
  const name = input.name === undefined ? room.name : validateRoomName(input.name);
  await assertUniqueRoomName(room.event_id, name, id);
  const size = validateSize(input.width ?? room.width, input.height ?? room.height);
  const groups = validateGroups(input.groups ?? room.groups, size.width, size.height);
  const doors = validateDoors(input.doors ?? room.doors, size.width, size.height);
  const alternative = input.alternative === undefined ? isAlternative(room) : input.alternative === true;
  if (isAlternative(room) && !alternative) {
    const ids = new Set(Object.values(room.seats));
    for (const other of await storedRooms(room.event_id)) {
      if (other.id === room.id || isAlternative(other)) continue;
      const seats = Object.fromEntries(Object.entries(other.seats).filter(([, a]) => !ids.has(a)));
      if (Object.keys(seats).length !== Object.keys(other.seats).length) await getAppStore().update('room', other.id, { ...other, seats });
    }
  }
  return saveRoom({ ...room, name, ...size, groups, doors, alternative });
}

export async function addTemplate(id: number, template: unknown, input: TemplateInput, at?: unknown): Promise<RoomView> {
  const room = await getRoom(id);
  const pos = at as { x?: unknown; y?: unknown } | undefined;
  const preferred = pos && Number.isFinite(Number(pos.x)) && Number.isFinite(Number(pos.y)) ? { x: Number(pos.x), y: Number(pos.y) } : undefined;
  if (template === 'door') return saveRoom({ ...room, doors: placeDoor(room, (input ?? {}) as Record<string, unknown>, preferred) });
  const groups = placeTemplate(room, template as TemplateName, input ?? {}, preferred);
  return saveRoom({ ...room, groups });
}

// Renumbers the seats: groups top to bottom, then left to right
export async function sortRoomGroups(id: number): Promise<RoomView> {
  const room = await getRoom(id);
  return saveRoom({ ...room, groups: sortGroupsByPosition(room.groups) });
}

// Copy of a room (layout, doors, start numbers — no assignments) in the same or another event.
// Without a name: "<name> (Kopie)", "<name> (Kopie 2)" … whichever is free.
export async function duplicateRoom(id: number, input: { name?: unknown; event_id?: unknown; alternative?: unknown }): Promise<RoomView> {
  const room = await getRoom(id);
  const eventId = input.event_id === undefined || input.event_id === null ? room.event_id : Number(input.event_id);
  if (!Number.isInteger(eventId)) throw new ValidationError('Ungültiges Ziel-Event');
  await getEvent(eventId);
  let name: string;
  if (input.name !== undefined && String(input.name).trim() !== '') {
    name = validateRoomName(input.name);
  } else {
    const taken = new Set((await storedRooms(eventId)).map(r => r.name.toLowerCase()));
    name = eventId !== room.event_id && !taken.has(room.name.toLowerCase()) ? room.name : `${room.name} (Kopie)`;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${room.name} (Kopie ${n})`;
    name = validateRoomName(name.slice(0, 60));
  }
  await assertUniqueRoomName(eventId, name);
  const newId = await getAppStore().insert('room', {
    event_id: eventId, name, width: room.width, height: room.height,
    groups: room.groups.map(g => ({ ...g })), doors: room.doors.map(d => ({ ...d })),
    alternative: input.alternative === true, seats: {},
  });
  return view(await getRoom(newId));
}

export async function deleteRoom(id: number): Promise<void> {
  await getRoom(id);
  await getAppStore().delete('room', { id });
}

// attendeeId null frees the seat; an attendee has at most one seat per event (any room)
export async function assignSeat(roomId: number, key: string, attendeeId: number | null): Promise<RoomView[]> {
  const room = await getRoom(roomId);
  if (!seatKeys(room).includes(key)) throw new ValidationError('Diesen Platz gibt es nicht');

  if (attendeeId !== null) {
    const attendee = (await listAttendees(room.event_id)).find(a => a.id === attendeeId);
    if (!attendee) throw new ValidationError('Teilnehmer gehört nicht zu diesem Event');
    for (const other of competingRooms(room, await storedRooms(room.event_id))) {
      const seats = Object.fromEntries(Object.entries(other.seats).filter(([, id]) => id !== attendeeId));
      if (Object.keys(seats).length !== Object.keys(other.seats).length) {
        await getAppStore().update('room', other.id, { ...other, seats });
        if (other.id === room.id) room.seats = seats;
      }
    }
  }

  const seats = { ...room.seats };
  if (attendeeId === null) delete seats[key];
  else seats[key] = attendeeId;
  await saveRoom({ ...room, seats });
  return listRooms(room.event_id);
}

// Frees every seat of a room
export async function clearSeats(roomId: number): Promise<RoomView[]> {
  const room = await getRoom(roomId);
  await saveRoom({ ...room, seats: {} });
  return listRooms(room.event_id);
}

// Seats everyone without a seat (in the final rooms — or, in an alternative, in this room) on the free seats
export async function autofillRoom(roomId: number): Promise<{ rooms: RoomView[]; seated: number; remaining: number }> {
  const room = await getRoom(roomId);
  const rooms = await listRooms(room.event_id);
  const seatedIds = new Set(competingRooms(room, rooms).flatMap(r => Object.values(r.seats)));
  const unseated = (await listAttendees(room.event_id)).filter(a => !seatedIds.has(a.id));
  const current = rooms.find(r => r.id === roomId)!;
  const seats = autofill(current, unseated);
  const seated = Object.keys(seats).length - Object.keys(current.seats).length;
  await saveRoom({ ...room, seats });
  return { rooms: await listRooms(room.event_id), seated, remaining: unseated.length - seated };
}
