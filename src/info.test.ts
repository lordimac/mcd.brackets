import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Match } from 'brackets-model';
import { compareVersions, isPlayedMatch, latestVersion } from './info';

test('versions compare numerically, releases after their pre-releases', () => {
  assert.ok(compareVersions('0.17.10-beta', '0.17.9-beta') > 0);
  assert.ok(compareVersions('0.18.0-beta', '0.17.2-beta') > 0);
  assert.ok(compareVersions('1.0.0', '1.0.0-beta') > 0);
  assert.ok(compareVersions('v0.17.2-beta', '0.17.2-beta') === 0);
  assert.ok(compareVersions('0.17.1-beta', '0.17.2-beta') < 0);
  assert.ok(compareVersions('1.0.0-beta.2', '1.0.0-beta.10') < 0);
});

test('latest version from GitHub tags ignores other tags', () => {
  assert.equal(latestVersion(['v0.17.1-beta', 'v0.9.1-beta', 'v0.17.10-beta', 'nightly', 'v0.17.2-beta']), '0.17.10-beta');
  assert.equal(latestVersion(['nightly']), null);
});

test('only real results count as played matches', () => {
  const match = (opponent1: object | null, opponent2: object | null, status = 4) => ({ status, opponent1, opponent2 }) as unknown as Match;
  assert.equal(isPlayedMatch(match({ id: 1, result: 'win' }, { id: 2, result: 'loss' })), true);
  assert.equal(isPlayedMatch(match({ id: 1, result: 'win' }, { id: 2, result: 'loss' }, 5)), true, 'archived');
  assert.equal(isPlayedMatch(match({ id: 1 }, { id: 2 }, 2)), false, 'ready, not played');
  assert.equal(isPlayedMatch(match({ id: 1, result: 'win' }, null)), false, 'bye');
  assert.equal(isPlayedMatch(match({ id: 1, result: 'win' }, { id: 2, forfeit: true })), false, 'memorial forfeit');
});
