import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// db.ts reads DATA_DIR on import, so point it to a temp dir first
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcd-brackets-db-'));

const db: typeof import('./db') = require('./db');

const onDisk = () => JSON.parse(fs.readFileSync(db.dbPath, 'utf-8'));
const eventNames = async () => ((await db.getAppStore().select('event')) ?? []).map(e => e.name);
const insertEvent = (name: string) => db.getAppStore().insert('event', { name } as never);

test('outside a lock every change is written at once', async () => {
  await db.ensureAppTables();
  const before = db.getRevision();
  await insertEvent('Sofort');
  assert.ok(db.getRevision() > before, 'the revision counts changes');
  assert.ok(onDisk().event.some((e: { name: string }) => e.name === 'Sofort'));
  assert.equal(fs.existsSync(`${db.dbPath}.tmp`), false, 'no temporary file left');
});

test('inside a lock the changes are written once at the end', async () => {
  await db.withLock(async () => {
    await insertEvent('Gesammelt 1');
    await insertEvent('Gesammelt 2');
    assert.deepEqual(onDisk().event.filter((e: { name: string }) => e.name.startsWith('Gesammelt')), [], 'not on disk yet');
    assert.deepEqual((await eventNames()).filter(n => n.startsWith('Gesammelt')), ['Gesammelt 1', 'Gesammelt 2'], 'but in memory');
  });
  assert.deepEqual(onDisk().event.filter((e: { name: string }) => e.name.startsWith('Gesammelt')).map((e: { name: string }) => e.name), ['Gesammelt 1', 'Gesammelt 2']);
  assert.equal(fs.existsSync(`${db.dbPath}.tmp`), false);
});

test('a failing inner rollback keeps the changes made before it in the same lock', async () => {
  await db.withLock(async () => {
    await insertEvent('Außen');
    await assert.rejects(db.withRollback(async () => {
      await insertEvent('Innen');
      throw new Error('kaputt');
    }), /kaputt/);
  });
  const names = await eventNames();
  assert.ok(names.includes('Außen'));
  assert.ok(!names.includes('Innen'));
  const stored = onDisk().event.map((e: { name: string }) => e.name);
  assert.ok(stored.includes('Außen') && !stored.includes('Innen'), 'the file has the same state');
});

test('a failing rollback outside a lock writes the restored state', async () => {
  await assert.rejects(db.withRollback(async () => {
    await insertEvent('Verworfen');
    throw new Error('kaputt');
  }), /kaputt/);
  assert.ok(!(await eventNames()).includes('Verworfen'));
  assert.ok(!onDisk().event.some((e: { name: string }) => e.name === 'Verworfen'));
});

test('replacing the database inside a lock keeps the new data', async () => {
  await db.withLock(() => db.replaceDatabase({ event: [{ id: 1, name: 'Wiederhergestellt' }] }));
  assert.deepEqual(await eventNames(), ['Wiederhergestellt']);
  assert.deepEqual(onDisk().event.map((e: { name: string }) => e.name), ['Wiederhergestellt']);
  assert.ok(Array.isArray(onDisk().burger_order), 'missing app tables are created and saved');
});
