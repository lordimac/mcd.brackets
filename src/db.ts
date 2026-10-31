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

// The node-json-db instance inside JsonDatabase (private field "internal"); only what we use
interface InternalJsonDb {
  save(force?: boolean): void;
  getData(dataPath: string): unknown;
  resetData(data: unknown): void;
  reload(): void;
}

// node-json-db writes the whole file on every insert/update/delete, and not atomically.
// We take over saving: inside withLock all changes are written once at the end, always via
// a temporary file + rename, so a crash never leaves a half-written db.json.
let deferSaves = false;
let dirty = false;
let revision = 0; // counts changes (also inside a lock), for caches of derived data

function writeAtomic(data: unknown): void {
  const tmpPath = `${dbPath}.tmp`;
  const fd = fs.openSync(tmpPath, 'w');
  try {
    fs.writeFileSync(fd, JSON.stringify(data, null, 2), 'utf-8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, dbPath);
}

function openDatabase(): { storage: CrudInterface; internal: InternalJsonDb } {
  const database = new JsonDatabase(dbPath);
  const internal = (database as unknown as { internal: InternalJsonDb }).internal;
  internal.save = () => {
    revision++;
    if (deferSaves) dirty = true;
    else writeAtomic(internal.getData('/'));
  };
  // Typed via CrudInterface, whose per-table overloads are stricter than JsonDatabase's own typings
  return { storage: database as unknown as CrudInterface, internal };
}

let { storage, internal } = openDatabase();
let manager = new BracketsManager(storage);

export const getStorage = () => storage;
export const getManager = () => manager;
export const getRevision = () => revision;

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

// brackets-json-db swallows errors of insert and returns -1 instead of an ID; we throw
export const getAppStore = (): AppStore => {
  const store = storage as unknown as AppStore;
  return {
    select: store.select.bind(store),
    update: store.update.bind(store),
    delete: store.delete.bind(store),
    async insert(table, value) {
      const id = await store.insert(table, value);
      if (typeof id !== 'number' || id < 0) throw new Error(`Datensatz konnte nicht gespeichert werden (${table})`);
      return id;
    },
  };
};

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
  writeAtomic(data);
  dirty = false;
  revision++;
  ({ storage, internal } = openDatabase());
  manager = new BracketsManager(storage);
  await ensureAppTables();
}

// Inside a lock: write the collected changes once. If that fails, memory goes back to the
// file's state, so what the app shows matches what is stored.
function flush(): void {
  if (!dirty) return;
  dirty = false;
  try {
    writeAtomic(internal.getData('/'));
  } catch (error) {
    internal.reload();
    revision++;
    throw error;
  }
}

async function deferred<T>(fn: () => Promise<T>): Promise<T> {
  deferSaves = true;
  try {
    return await fn();
  } finally {
    deferSaves = false;
    flush();
  }
}

// Serialize write operations so read-modify-write sequences don't interleave;
// all changes of fn are saved together when it ends
let queue: Promise<unknown> = Promise.resolve();
export function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(() => deferred(fn), () => deferred(fn));
  queue = run.catch(() => undefined);
  return run;
}

// Restore the previous database state if fn fails halfway. The snapshot comes from memory:
// inside a lock the file still has the state from before the lock (nested rollbacks).
export async function withRollback<T>(fn: () => Promise<T>): Promise<T> {
  const snapshot = structuredClone(internal.getData('/'));
  const db = internal;
  try {
    return await fn();
  } catch (error) {
    if (db === internal) {
      db.resetData(snapshot);
      db.save(); // written now, or at the end of the lock
    } else {
      await replaceDatabase(snapshot); // fn replaced the database (restore)
    }
    throw error;
  }
}
