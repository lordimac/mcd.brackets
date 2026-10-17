import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Status } from 'brackets-model';

// db.ts reads DATA_DIR on import, so point it to a temp dir first
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mcd-brackets-stages-'));

test('stage with event keeps the settings brackets-manager stored and stays playable', async () => {
  const { createStage, findStage }: typeof import('./stages') = require('./stages');
  const { getManager, getStorage }: typeof import('./db') = require('./db');

  const stage = await createStage({
    tournamentId: 1,
    name: 'UT2004',
    type: 'double_elimination',
    names: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'],
    settings: { grandFinal: 'simple' },
    eventName: 'LAN',
  });

  const stored = await findStage(stage.id);
  assert.equal(stored.event_name, 'LAN');
  assert.ok(stored.settings.seedOrdering?.length, 'seedOrdering must not be dropped');

  // Play the whole bracket: loser bracket updates need the seed ordering
  for (;;) {
    const matches = (await getStorage().select('match', { stage_id: stage.id })) ?? [];
    const match = matches.find(m => m.status === Status.Ready);
    if (!match) break;
    await getManager().update.match({ id: match.id, opponent1: { result: 'win' }, opponent2: { result: 'loss' } });
  }

  const matches = (await getStorage().select('match', { stage_id: stage.id })) ?? [];
  assert.ok(matches.some(m => m.status >= Status.Completed));
  assert.ok(!matches.some(m => m.status === Status.Ready));
});
