import crypto from 'crypto';
import { getAppStore, getStorage } from './db';
import { isValidDay, ValidationError } from './lan';
import { stageRounds } from './schedule';
import type { AppStage } from './stages';

// Timetable of an event: own entries (breakfast, dinner, program …) and notes, stored as one
// record per event in the table "timetable". An entry has local times and the days it takes
// place on, so breakfast on three days is one entry. The tournament rounds are not stored here:
// they come from the deadlines of the event's tournaments (schedule.ts), grouped by time.

export const CATEGORIES = ['meal', 'tournament', 'program', 'other'] as const;
export type Category = typeof CATEGORIES[number];

export interface TimetableEntry {
  id: string;
  days: string[];      // "YYYY-MM-DD", sorted, at least one (several = repeated on these days)
  start: string;       // local time "HH:MM"
  end: string | null;  // optional; earlier than start = the next morning
  title: string;
  info: string;        // short extra text, e.g. the place
  category: Category;
}

export interface TimetableNote {
  id: string;
  title: string; // optional
  text: string;
}

export interface Timetable {
  id: number;
  event_id: number;
  entries: TimetableEntry[];
  notes: TimetableNote[];
}

// Tournament rounds with the same time: deadlines (e.g. "Spielrunde 2" until 21:00) or start
// times of the matches for places 1–3 (e.g. "Finale" from 20:00)
export interface TournamentItem {
  kind: 'deadline' | 'start';
  at: string; // ISO timestamp
  title: string;
  rounds: { stage_name: string; label: string }[];
}

const MAX_ENTRIES = 300;
const MAX_NOTES = 30;
const ID_PATTERN = /^[\w-]{1,40}$/;

function text(value: unknown, label: string, max: number, required = false): string {
  const result = typeof value === 'string' ? value.trim() : '';
  if (required && !result) throw new ValidationError(`${label} fehlt`);
  if (result.length > max) throw new ValidationError(`${label} ist zu lang (max. ${max} Zeichen)`);
  return result;
}

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_DAYS = 62;

function clock(value: unknown, label: string): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !TIME_PATTERN.test(value)) throw new ValidationError(`${label}: Uhrzeit als HH:MM angeben`);
  return value;
}

function days(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new ValidationError(`${label}: mindestens einen Tag wählen`);
  if (!value.every(isValidDay)) throw new ValidationError(`${label}: ungültiger Tag`);
  const unique = [...new Set(value as string[])].sort();
  if (unique.length > MAX_DAYS) throw new ValidationError(`${label}: zu viele Tage`);
  return unique;
}

// Keeps the client's ID (so the frontend can edit in place), otherwise creates one
const entryId = (value: unknown) => (typeof value === 'string' && ID_PATTERN.test(value) ? value : crypto.randomUUID());

export function validateTimetable(input: { entries?: unknown; notes?: unknown }): Pick<Timetable, 'entries' | 'notes'> {
  const rawEntries = input.entries ?? [];
  const rawNotes = input.notes ?? [];
  if (!Array.isArray(rawEntries) || !Array.isArray(rawNotes)) throw new ValidationError('entries und notes müssen Listen sein');
  if (rawEntries.length > MAX_ENTRIES) throw new ValidationError(`Höchstens ${MAX_ENTRIES} Einträge`);
  if (rawNotes.length > MAX_NOTES) throw new ValidationError(`Höchstens ${MAX_NOTES} Hinweise`);

  const entries = rawEntries.map((raw, i): TimetableEntry => {
    const title = text(raw?.title, `Eintrag ${i + 1}: Titel`, 120, true);
    const start = clock(raw?.start, `${title}: Beginn`);
    if (!start) throw new ValidationError(`${title}: Beginn fehlt`);
    const end = clock(raw?.end, `${title}: Ende`);
    if (end === start) throw new ValidationError(`${title}: Ende gleich Beginn`);
    const category = CATEGORIES.includes(raw?.category) ? raw.category as Category : 'other';
    return { id: entryId(raw?.id), days: days(raw?.days, title), start, end, title, info: text(raw?.info, `${title}: Info`, 300), category };
  }).sort((a, b) => a.days[0].localeCompare(b.days[0]) || a.start.localeCompare(b.start));

  const notes = rawNotes.map((raw, i): TimetableNote => ({
    id: entryId(raw?.id),
    title: text(raw?.title, `Hinweis ${i + 1}: Überschrift`, 120),
    text: text(raw?.text, `Hinweis ${i + 1}: Text`, 2000, true),
  }));

  return { entries, notes };
}

async function stored(eventId: number): Promise<Timetable | null> {
  return ((await getAppStore().select('timetable', { event_id: eventId })) ?? [])[0] ?? null;
}

export async function getTimetable(eventId: number): Promise<Pick<Timetable, 'entries' | 'notes'>> {
  const record = await stored(eventId);
  return { entries: record?.entries ?? [], notes: record?.notes ?? [] };
}

export async function saveTimetable(eventId: number, input: { entries?: unknown; notes?: unknown }): Promise<Pick<Timetable, 'entries' | 'notes'>> {
  const timetable = validateTimetable(input);
  const record = await stored(eventId);
  if (record) await getAppStore().update('timetable', record.id, { ...record, ...timetable });
  else await getAppStore().insert('timetable', { event_id: eventId, ...timetable });
  return timetable;
}

// Deadlines and start times of the event's tournaments, grouped by kind and time. Deadlines of
// one play slot → "Spielrunde n"; one start → its label ("Finale"), several → "Finalspiele".
export async function tournamentItems(eventName: string): Promise<TournamentItem[]> {
  const groups = new Map<string, { kind: TournamentItem['kind']; at: string; rounds: TournamentItem['rounds']; slots: Set<number> }>();
  const stages = (((await getStorage().select('stage')) ?? []) as AppStage[]).filter(s => s.event_name === eventName);
  for (const stage of stages) {
    for (const round of await stageRounds(stage.id)) {
      if (round.kind === 'none') continue;
      const at = round.kind === 'start' ? round.starts_at : round.ends_at;
      if (!at) continue;
      const key = `${round.kind}:${at}`;
      if (!groups.has(key)) groups.set(key, { kind: round.kind as TournamentItem['kind'], at, rounds: [], slots: new Set() });
      const group = groups.get(key)!;
      group.rounds.push({ stage_name: stage.name, label: round.label });
      group.slots.add(round.slot);
    }
  }
  return [...groups.values()]
    .sort((a, b) => a.at.localeCompare(b.at) || a.kind.localeCompare(b.kind))
    .map(({ kind, at, rounds, slots }) => ({
      kind,
      at,
      title: kind === 'start'
        ? (new Set(rounds.map(r => r.label)).size === 1 ? rounds[0].label : 'Finalspiele')
        : (slots.size === 1 ? `Spielrunde ${[...slots][0]}` : 'Turnierrunden'),
      rounds,
    }));
}
