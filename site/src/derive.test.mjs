import assert from 'node:assert/strict';
import test from 'node:test';

import { completeEntryScores, completeRowGeomeans, slopeFit } from './derive.mjs';

test('interactive scores exclude entries with stale/incomplete matrices', () => {
  const result = completeEntryScores(['a', 'b', 'partial'], [
    { key: 'create', values: { a: 10, b: 20, partial: 5 } },
    { key: 'select', values: { a: 4, b: 2, partial: null } },
  ]);
  assert.deepEqual(result.missing, ['partial']);
  assert.equal(result.cellCount, 2);
  assert.deepEqual(result.scores.map(({ id }) => id), ['a', 'b']);
  assert.ok(Math.abs(result.scores[0].value - Math.sqrt(2)) < 1e-12);
  assert.ok(Math.abs(result.scores[1].value - Math.sqrt(2)) < 1e-12);
});

test('entry scores can use one complete selected baseline without dropping cells', () => {
  const result = completeEntryScores(['a', 'b', 'partial'], [
    { key: 'create', values: { a: 10, b: 20, partial: 5 } },
    { key: 'select', values: { a: 4, b: 2, partial: null } },
  ], 'a');
  assert.deepEqual(result.missing, ['partial']);
  assert.equal(result.cellCount, 2);
  assert.ok(Math.abs(result.scores.find(({ id }) => id === 'a').value - 1) < 1e-12);
  assert.ok(Math.abs(result.scores.find(({ id }) => id === 'b').value - 1) < 1e-12);
});

test('heatmap geomeans give every entry the same complete-row denominator', () => {
  const result = completeRowGeomeans(['a', 'b'], [
    { key: 'complete', values: { a: 10, b: 20 } },
    { key: 'missing-b', values: { a: 1, b: null } },
  ]);
  assert.equal(result.rowCount, 1);
  assert.equal(result.values.get('a'), 1);
  assert.equal(result.values.get('b'), 2);
});

test('trend slope is recalculated from current points', () => {
  assert.ok(Math.abs(slopeFit([[10, 100], [100, 1000], [1000, 10000]]) - 1) < 1e-12);
  assert.equal(slopeFit([[10, 1]]), null);
});

test('empty selections do not report phantom complete rows', () => {
  const result = completeRowGeomeans([], [{ key: 'row', values: {} }]);
  assert.equal(result.rowCount, 0);
  assert.equal(result.values.size, 0);
});
