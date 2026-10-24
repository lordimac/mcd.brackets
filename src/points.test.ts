import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_POINTS, pointsForPlacement, pointsFromRecord, validatePoints } from './points';
import { ValidationError } from './lan';

test('default points: table for 1st–10th, 1 point from 11th place', () => {
  assert.equal(pointsForPlacement(1), 30);
  assert.equal(pointsForPlacement(2), 22);
  assert.equal(pointsForPlacement(10), 2);
  assert.equal(pointsForPlacement(11), 1);
  assert.equal(pointsForPlacement(40), 1);
});

test('custom points are used for the places and the rest', () => {
  const config = { places: [10, 9, 8, 7, 6, 5, 4, 3, 2, 1], rest: 0 };
  assert.equal(pointsForPlacement(1, config), 10);
  assert.equal(pointsForPlacement(10, config), 1);
  assert.equal(pointsForPlacement(11, config), 0);
});

test('validatePoints accepts whole numbers (also as strings) and rejects everything else', () => {
  assert.deepEqual(
    validatePoints({ places: ['30', 22, 16, 12, 9, 7, 5, 3, 2, 0], rest: '1' }),
    { places: [30, 22, 16, 12, 9, 7, 5, 3, 2, 0], rest: 1 },
  );
  for (const input of [
    { places: [1, 2, 3], rest: 1 },
    { places: [30, 22, 16, 12, 9, 7, 5, 3, 2, -1], rest: 1 },
    { places: [30, 22, 16, 12, 9, 7, 5, 3, 2, 1.5], rest: 1 },
    { places: [30, 22, 16, 12, 9, 7, 5, 3, 2, ''], rest: 1 },
    { places: [30, 22, 16, 12, 9, 7, 5, 3, 2, 2], rest: 5000 },
    { places: [30, 22, 16, 12, 9, 7, 5, 3, 2, 2] },
  ]) {
    assert.throws(() => validatePoints(input), ValidationError, JSON.stringify(input));
  }
});

test('missing or broken stored records fall back to the defaults', () => {
  assert.equal(pointsFromRecord(null), DEFAULT_POINTS);
  assert.equal(pointsFromRecord({ places: 'kaputt', rest: 1 }), DEFAULT_POINTS);
  assert.deepEqual(pointsFromRecord({ places: [5, 4, 3, 2, 1, 0, 0, 0, 0, 0], rest: 0 }).places[0], 5);
});
