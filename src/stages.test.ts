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

for (const type of ['single_elimination', 'double_elimination', 'round_robin'] as const) {
  test(`memorial entries take part as byes (${type})`, async () => {
    const { createStage }: typeof import('./stages') = require('./stages');
    const { resolveMemorialMatches }: typeof import('./stages') = require('./stages');
    const { getManager, getStorage }: typeof import('./db') = require('./db');
    const { getStandings }: typeof import('./standings') = require('./standings');

    const stage = await createStage({
      tournamentId: 100 + ['single_elimination', 'double_elimination', 'round_robin'].indexOf(type),
      name: 'Gedenkturnier',
      type,
      names: ['A', 'B', 'C', 'D', 'E'],
      settings: type === 'double_elimination' ? { grandFinal: 'simple' } : {},
      memorial: ['Opa Willi', 'Tante Erna'],
    });
    assert.deepEqual(stage.memorial_names, ['Opa Willi', 'Tante Erna']);

    const players = (await getStorage().select('participant', { tournament_id: stage.tournament_id })) ?? [];
    const memorialIds = new Set(players.filter(p => ['Opa Willi', 'Tante Erna'].includes(p.name)).map(p => p.id));
    if (type === 'round_robin') {
      assert.equal(memorialIds.size, 2, 'round robin: memorial entries are named participants');
    } else {
      // Elimination: named BYEs on BYE places, no participants
      assert.equal(memorialIds.size, 0);
      assert.deepEqual(Object.values(stage.memorial_seats ?? {}).sort(), ['Opa Willi', 'Tante Erna']);
    }

    // Play everything; memorial matches must resolve themselves after every result
    for (;;) {
      const matches = (await getStorage().select('match', { stage_id: stage.id })) ?? [];
      const ready = matches.find(m => m.status === Status.Ready);
      if (!ready) break;
      assert.ok(!memorialIds.has(ready.opponent1!.id!) && !memorialIds.has(ready.opponent2!.id!), 'memorial matches are never left open');
      await getManager().update.match({ id: ready.id, opponent1: { result: 'win' }, opponent2: { result: 'loss' } });
      await resolveMemorialMatches(stage.id);
    }

    // Memorial entries never win and are not ranked
    const matches = (await getStorage().select('match', { stage_id: stage.id })) ?? [];
    for (const m of matches) {
      for (const side of [m.opponent1, m.opponent2]) {
        if (side?.id != null && memorialIds.has(side.id) && side.result) {
          const other = side === m.opponent1 ? m.opponent2 : m.opponent1;
          if (other?.id != null && !memorialIds.has(other.id)) assert.notEqual(side.result, 'win');
        }
      }
    }
    const standings = await getStandings(getStorage(), getManager(), stage.id);
    assert.ok(standings);
    assert.equal(standings.length, 5);
    assert.ok(standings.every(s => !['Opa Willi', 'Tante Erna'].includes(s.participant_name)));
  });
}
