import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSeeding, isStageType, nextPowerOfTwo, normalizeNames, shuffle } from './seeding';

test('nextPowerOfTwo', () => {
  assert.equal(nextPowerOfTwo(1), 2);
  assert.equal(nextPowerOfTwo(2), 2);
  assert.equal(nextPowerOfTwo(5), 8);
  assert.equal(nextPowerOfTwo(16), 16);
});

test('shuffle keeps all items and does not mutate the input', () => {
  const input = ['A', 'B', 'C', 'D', 'E'];
  const result = shuffle(input);
  assert.deepEqual([...result].sort(), input);
  assert.deepEqual(input, ['A', 'B', 'C', 'D', 'E']);
});

test('elimination seeding is filled with BYEs up to a power of 2', () => {
  const seeding = buildSeeding(['A', 'B', 'C', 'D', 'E'], 'double_elimination');
  assert.equal(seeding.length, 8);
  assert.equal(seeding.filter(s => s === null).length, 3);
  assert.deepEqual(seeding.filter(s => s !== null).sort(), ['A', 'B', 'C', 'D', 'E']);
});

test('round robin seeding has no BYEs', () => {
  assert.equal(buildSeeding(['A', 'B', 'C'], 'round_robin').length, 3);
});

test('normalizeNames trims, drops empty names and rejects non-string input', () => {
  assert.deepEqual(normalizeNames([' A ', '', 'B', '   ']), ['A', 'B']);
  assert.equal(normalizeNames('A'), null);
  assert.equal(normalizeNames(['A', 1]), null);
});

test('isStageType', () => {
  assert.ok(isStageType('round_robin'));
  assert.ok(!isStageType('swiss'));
});

test('memorial entries follow the players, before the BYEs', () => {
  const seeding = buildSeeding(['A', 'B', 'C'], 'single_elimination', ['M1', 'M2']);
  assert.equal(seeding.length, 8);
  assert.deepEqual([...seeding.slice(0, 3)].sort(), ['A', 'B', 'C']);
  assert.deepEqual([...seeding.slice(3, 5)].sort(), ['M1', 'M2']);
  assert.deepEqual(seeding.slice(5), [null, null, null]);
  assert.equal(buildSeeding(['A', 'B'], 'round_robin', ['M']).length, 3);
});
