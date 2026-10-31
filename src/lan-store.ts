import type { Participant, Stage } from 'brackets-model';
import { getAppStore, getStorage } from './db';
import {
  assertNotMemorial, assertUniqueAttendee, AttendeeInput, DEFAULT_RANGES, describeAttendee, displayName, eventCapacity,
  EventSettingsInput, nextFreeSlot, parseBulkLine, validateAttendee, validateEventSettings, ValidationError,
  type Attendee, type AttendeeView, type LanEvent,
} from './lan';
import { HttpError } from './http-error';

type StageWithEvent = Stage & { event_name?: string };

export interface EventSummary extends LanEvent {
  attendee_count: number;
  capacity: number;
  tournament_count: number;
}

async function allEvents(): Promise<LanEvent[]> {
  return (await getAppStore().select('event')) ?? [];
}

async function allStages(): Promise<StageWithEvent[]> {
  return (await getStorage().select('stage')) ?? [];
}

export async function getEvent(id: number): Promise<LanEvent> {
  const event = await getAppStore().select('event', id);
  if (!event) throw new HttpError(404, 'Event nicht gefunden');
  return event;
}

export async function findEventByName(name: string): Promise<LanEvent | null> {
  return (await allEvents()).find(e => e.name === name) ?? null;
}

export async function listAttendees(eventId: number): Promise<Attendee[]> {
  return (await getAppStore().select('attendee', { event_id: eventId })) ?? [];
}

async function assertUniqueEventName(name: string, exceptId?: number): Promise<void> {
  if ((await allEvents()).some(e => e.name === name && e.id !== exceptId)) {
    throw new ValidationError(`Ein Event „${name}“ gibt es schon`);
  }
}

/* Events
   ========================================================================== */

export async function listEventSummaries(): Promise<EventSummary[]> {
  const [events, attendees, stages] = await Promise.all([
    allEvents(),
    getAppStore().select('attendee').then(a => a ?? []),
    allStages(),
  ]);
  return events.map(event => ({
    ...event,
    attendee_count: attendees.filter(a => a.event_id === event.id).length,
    capacity: eventCapacity(event),
    tournament_count: stages.filter(s => s.event_name === event.name).length,
  }));
}

// Events that so far only existed as event_name on stages get a record with default settings
export async function syncEventsFromStages(): Promise<void> {
  const known = new Set((await allEvents()).map(e => e.name));
  const names = new Set((await allStages()).map(s => s.event_name).filter((n): n is string => !!n));
  for (const name of names) {
    if (!known.has(name)) {
      await getAppStore().insert('event', { name, domain: '', dns_server: '', netmask: '', gateway: '', logo: '', starts_on: '', ends_on: '', wifi_enabled: false, wifi_ssid: '', wifi_password: '', memorial: [], ip_identification: true, ranges: DEFAULT_RANGES });
    }
  }
}

// Settings not given are copied from the most recent event, so a new year starts with last year's setup
export async function createEvent(input: EventSettingsInput): Promise<LanEvent> {
  const latest = (await allEvents()).at(-1);
  const settings = validateEventSettings({
    name: input.name,
    domain: input.domain ?? latest?.domain ?? '',
    dns_server: input.dns_server ?? latest?.dns_server ?? '',
    netmask: input.netmask ?? latest?.netmask ?? '',
    gateway: input.gateway ?? latest?.gateway ?? '',
    logo: input.logo ?? latest?.logo ?? '',
    starts_on: input.starts_on ?? '', // every event has its own dates
    ends_on: input.ends_on ?? '',
    wifi_enabled: input.wifi_enabled ?? latest?.wifi_enabled ?? false,
    wifi_ssid: input.wifi_ssid ?? latest?.wifi_ssid ?? '',
    wifi_password: input.wifi_password ?? latest?.wifi_password ?? '',
    memorial: input.memorial ?? latest?.memorial ?? [],
    ip_identification: input.ip_identification ?? latest?.ip_identification ?? true,
    ranges: input.ranges ?? latest?.ranges ?? DEFAULT_RANGES,
  });
  await assertUniqueEventName(settings.name);
  const id = await getAppStore().insert('event', settings);
  // The rooms of the last event are usually the same: copy their layouts, without seat assignments
  if (latest) {
    for (const room of (await getAppStore().select('room', { event_id: latest.id })) ?? []) {
      await getAppStore().insert('room', { event_id: id, name: room.name, width: room.width, height: room.height, groups: room.groups.map(g => ({ ...g })), doors: (room.doors ?? []).map(d => ({ ...d })), seats: {} });
    }
  }
  return getEvent(id);
}

// Renaming also renames the event on its tournaments
export async function updateEvent(id: number, input: EventSettingsInput): Promise<LanEvent> {
  const event = await getEvent(id);
  const slots = (await listAttendees(id)).map(a => a.slot);
  const settings = validateEventSettings({ ...event, ...input }, slots);
  await assertUniqueEventName(settings.name, id);
  for (const attendee of await listAttendees(id)) {
    assertNotMemorial(displayName({ clan: attendee.clan ?? '', nickname: attendee.nickname }), settings.memorial);
  }

  if (settings.name !== event.name) {
    for (const stage of await allStages()) {
      if (stage.event_name === event.name) {
        await getStorage().update('stage', stage.id, { ...stage, event_name: settings.name } as Stage);
      }
    }
  }

  const updated: LanEvent = { ...settings, id };
  await getAppStore().update('event', id, updated);
  return updated;
}

export async function deleteEvent(id: number): Promise<void> {
  const event = await getEvent(id);
  const tournaments = (await allStages()).filter(s => s.event_name === event.name).length;
  if (tournaments > 0) {
    throw new HttpError(409, `Das Event hat noch ${tournaments} Turnier${tournaments === 1 ? '' : 'e'} — diese zuerst löschen`);
  }
  await getAppStore().delete('attendee', { event_id: id });
  await getAppStore().delete('room', { event_id: id });
  await getAppStore().delete('timetable', { event_id: id });
  await getAppStore().delete('burger_order', { event_id: id });
  await getAppStore().delete('event', { id });
}

/* Attendees
   ========================================================================== */

export async function listAttendeeViews(eventId: number): Promise<AttendeeView[]> {
  const event = await getEvent(eventId);
  return (await listAttendees(eventId))
    .sort((a, b) => a.slot - b.slot)
    .map(a => describeAttendee(event, a));
}

export async function addAttendee(eventId: number, input: AttendeeInput): Promise<AttendeeView> {
  const event = await getEvent(eventId);
  const attendee = validateAttendee(input);
  const others = await listAttendees(eventId);
  assertUniqueAttendee(attendee, others);
  assertNotMemorial(displayName(attendee), event.memorial);

  const slot = nextFreeSlot(others.map(a => a.slot), eventCapacity(event));
  if (slot === null) throw new ValidationError(`Alle ${eventCapacity(event)} Plätze sind vergeben — IP-Bereiche vergrößern`);

  const admin = input.admin === true;
  const id = await getAppStore().insert('attendee', { ...attendee, admin, event_id: eventId, slot });
  return describeAttendee(event, { ...attendee, admin, id, event_id: eventId, slot });
}

// A changed clan or nickname is also changed on the player entries of the event's tournaments
export async function updateAttendee(id: number, input: AttendeeInput): Promise<AttendeeView> {
  const existing = await getAppStore().select('attendee', id);
  if (!existing) throw new HttpError(404, 'Teilnehmer nicht gefunden');
  const event = await getEvent(existing.event_id);

  const changes = validateAttendee(input);
  const others = (await listAttendees(event.id)).filter(a => a.id !== id);
  assertUniqueAttendee(changes, others);
  assertNotMemorial(displayName(changes), event.memorial);

  const oldName = displayName({ clan: existing.clan ?? '', nickname: existing.nickname });
  if (displayName(changes) !== oldName) {
    await renamePlayer(event.name, oldName, displayName(changes));
  }

  const admin = input.admin === undefined ? existing.admin === true : input.admin === true;
  const updated: Attendee = { ...existing, ...changes, admin };
  await getAppStore().update('attendee', id, updated);
  return describeAttendee(event, updated);
}

export async function deleteAttendee(id: number): Promise<void> {
  const existing = await getAppStore().select('attendee', id);
  if (!existing) throw new HttpError(404, 'Teilnehmer nicht gefunden');
  await getAppStore().delete('attendee', { id });
  // Free their seat in the seating plan
  for (const room of (await getAppStore().select('room', { event_id: existing.event_id })) ?? []) {
    const seats = Object.fromEntries(Object.entries(room.seats).filter(([, attendeeId]) => attendeeId !== id));
    if (Object.keys(seats).length !== Object.keys(room.seats).length) await getAppStore().update('room', room.id, { ...room, seats });
  }
}

// Copies attendees (names, nickname) of another event; nicknames already present are skipped.
// The admin flag is not copied: admin rights are given per event on purpose.
export async function importAttendees(eventId: number, fromEventId: number): Promise<{ added: number; skipped: string[] }> {
  if (eventId === fromEventId) throw new ValidationError('Quelle und Ziel sind dasselbe Event');
  await getEvent(fromEventId);
  const source = (await listAttendees(fromEventId)).sort((a, b) => a.slot - b.slot);

  let added = 0;
  const skipped: string[] = [];
  for (const attendee of source) {
    try {
      await addAttendee(eventId, { ...attendee, admin: false });
      added++;
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      skipped.push(displayName({ clan: attendee.clan ?? '', nickname: attendee.nickname }));
    }
  }
  return { added, skipped };
}

export interface BulkRow {
  line: number;
  text: string;
  ok: boolean;
  error?: string;
  attendee?: AttendeeView;
}

// Order for assigning addresses in the bulk import: last name, first name, nickname
// (German collation, case-insensitive); lines without a last name come last
const nameCollator = new Intl.Collator('de', { sensitivity: 'base', numeric: true });

export function compareByLastName(a: Pick<Attendee, 'last_name' | 'first_name' | 'nickname'>, b: Pick<Attendee, 'last_name' | 'first_name' | 'nickname'>): number {
  if (!a.last_name !== !b.last_name) return a.last_name ? -1 : 1;
  return nameCollator.compare(a.last_name, b.last_name)
    || nameCollator.compare(a.first_name, b.first_name)
    || nameCollator.compare(a.nickname, b.nickname);
}

// Bulk import, one attendee per line ("Nachname, Vorname // Clan-Nickname"; empty lines are ignored).
// Every line is checked against the existing attendees and the lines before it (so for duplicates
// the first line wins). The valid lines are then sorted by last name and get their addresses in
// that order. Rows come back in that order, followed by the invalid lines.
// With dryRun nothing is written (preview).
export async function importBulk(eventId: number, text: string, dryRun: boolean): Promise<{ rows: BulkRow[]; added: number }> {
  const event = await getEvent(eventId);
  const capacity = eventCapacity(event);
  const known = await listAttendees(eventId);
  const accepted: { line: number; text: string; attendee: ReturnType<typeof validateAttendee> }[] = [];
  const rejected: BulkRow[] = [];

  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const attendee = validateAttendee(parseBulkLine(line));
      assertUniqueAttendee(attendee, [...known, ...accepted.map(a => ({ ...a.attendee, id: -1, event_id: eventId, slot: -1 }))]);
      assertNotMemorial(displayName(attendee), event.memorial);
      accepted.push({ line: index + 1, text: line, attendee });
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      rejected.push({ line: index + 1, text: line, ok: false, error: error.message });
    }
  }

  // Stable sort: equal names keep their input order
  accepted.sort((a, b) => compareByLastName(a.attendee, b.attendee));

  const rows: BulkRow[] = [];
  let added = 0;
  for (const { line, text: lineText, attendee } of accepted) {
    const slot = nextFreeSlot(known.map(a => a.slot), capacity);
    if (slot === null) {
      rows.push({ line, text: lineText, ok: false, error: `Kein Platz frei (${capacity} Plätze)` });
      continue;
    }
    const id = dryRun ? -1 : await getAppStore().insert('attendee', { ...attendee, event_id: eventId, slot });
    const stored: Attendee = { ...attendee, id, event_id: eventId, slot };
    known.push(stored);
    if (!dryRun) added++;
    rows.push({ line, text: lineText, ok: true, attendee: describeAttendee(event, stored) });
  }
  return { rows: [...rows, ...rejected], added };
}

async function renamePlayer(eventName: string, oldName: string, newName: string): Promise<void> {
  const tournamentIds = new Set((await allStages()).filter(s => s.event_name === eventName).map(s => s.tournament_id));
  const players: Participant[] = (await getStorage().select('participant')) ?? [];
  for (const player of players) {
    if (tournamentIds.has(player.tournament_id) && player.name === oldName) {
      await getStorage().update('participant', player.id, { ...player, name: newName });
    }
  }
}

// Players of a tournament: all attendees of its event as "Clan-Nickname" (in registration order),
// plus the event's memorial names, which take part as byes
export async function playerNamesForEvent(eventName: string | undefined): Promise<{ players: string[]; memorial: string[] } | null> {
  if (!eventName) return null;
  const event = await findEventByName(eventName);
  if (!event) return null;
  const players = (await listAttendees(event.id)).sort((a, b) => a.slot - b.slot).map(a => displayName({ clan: a.clan ?? '', nickname: a.nickname }));
  return { players, memorial: event.memorial ?? [] };
}
