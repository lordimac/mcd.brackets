import { BracketsManager } from 'brackets-manager';
import { JsonDatabase } from 'brackets-json-db';
import type { CrudInterface } from 'brackets-model';
import path from 'path';
import fs from 'fs';
import type { Attendee, LanEvent } from './lan';
import type { OpnsenseSettings } from './opnsense';
import type { PointsConfig } from './points';
import type { Room } from './seating';
import type { Timetable } from './timetable';
import type { BurgerMenu, BurgerOrder } from './burger';

export const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(__dirname, '../data'));
export const dbPath = path.join(dataDir, 'db.json');

fs.mkdirSync(dataDir, { recursive: true });

// Typed via CrudInterface, whose per-table overloads are stricter than JsonDatabase's own typings
let storage: CrudInterface = new JsonDatabase(dbPath);
let manager = new BracketsManager(storage);

export const getStorage = () => storage;
export const getManager = () => manager;

// Our own tables in the same db.json (so backup/restore covers them).
// JsonDatabase works with any table name; only the brackets-model typings don't know them.
interface AppTables {
  event: LanEvent;
  attendee: Attendee;
  opnsense: OpnsenseSettings; // at most one record: connection to the firewall
  room: Room;                 // seating plan rooms of an event
  points: PointsConfig & { id: number }; // at most one record: championship points (default if missing)
  timetable: Timetable;       // at most one record per event: own entries and notes
  burger_menu: BurgerMenu & { id: number }; // at most one record: burger designer menu (default if missing)
  burger_order: BurgerOrder;  // burger orders of an event
}
type AppTable = keyof AppTables;
export const APP_TABLES: AppTable[] = ['event', 'attendee', 'opnsense', 'room', 'points', 'timetable', 'burger_menu', 'burger_order'];

export interface AppStore {
  select<T extends AppTable>(table: T): Promise<AppTables[T][] | null>;
  select<T extends AppTable>(table: T, id: number): Promise<AppTables[T] | null>;
  select<T extends AppTable>(table: T, filter: Partial<AppTables[T]>): Promise<AppTables[T][] | null>;
  insert<T extends AppTable>(table: T, value: Omit<AppTables[T], 'id'>): Promise<number>;
  update<T extends AppTable>(table: T, id: number, value: AppTables[T]): Promise<boolean>;
  delete<T extends AppTable>(table: T, filter?: Partial<AppTables[T]>): Promise<boolean>;
}

export const getAppStore = () => storage as unknown as AppStore;

// Create missing app tables (selecting a missing table yields null, deleting all creates it empty)
export async function ensureAppTables(): Promise<void> {
  const store = getAppStore();
  for (const table of APP_TABLES) {
    if ((await store.select(table)) === null) await store.delete(table);
  }
}

// Replace the database file atomically and re-create storage + manager,
// because node-json-db keeps the previous state in memory.
export async function replaceDatabase(data: unknown): Promise<void> {
  const tmpPath = `${dbPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmpPath, dbPath);
  storage = new JsonDatabase(dbPath);
  manager = new BracketsManager(storage);
  await ensureAppTables();
}

// Serialize write operations so read-modify-write sequences don't interleave
let queue: Promise<unknown> = Promise.resolve();
export function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

// Restore the previous database state if fn fails halfway
export async function withRollback<T>(fn: () => Promise<T>): Promise<T> {
  const snapshot = fs.readFileSync(dbPath, 'utf-8');
  try {
    return await fn();
  } catch (error) {
    await replaceDatabase(JSON.parse(snapshot));
    throw error;
  }
}
