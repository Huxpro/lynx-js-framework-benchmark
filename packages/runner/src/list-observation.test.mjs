import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeListFling, analyzeListRecycle, listKeyIndex } from './list-observation.mjs';

const frame = (atMs, first, count = 16) => ({
  atMs,
  keys: Array.from({ length: count }, (_, index) => `row-${first + index}`),
});

test('list observations accept only the fixture stable-key namespace', () => {
  assert.equal(listKeyIndex('row-42'), 42);
  assert.equal(listKeyIndex('42'), null);
});

test('one-viewport recycle closes on the first presented 16-row advance', () => {
  const result = analyzeListRecycle(frame(0, 0), [frame(16, 8), frame(33, 16), frame(50, 17)]);
  assert.equal(result.operationTimeMs, 33);
  assert.equal(result.recycledCells, 16);
  assert.equal(result.terminal.keys[0], 'row-16');
});

test('fling counts source blank frames and first visible appearances', () => {
  const result = analyzeListFling(frame(0, 0), [
    { atMs: 16, keys: [] },
    frame(32, 16),
    frame(48, 17),
    frame(64, 17),
  ]);
  assert.equal(result.elapsedMs, 64);
  assert.equal(result.blankFrames, 1);
  assert.equal(result.materializedCells, 17);
  assert.equal(result.materializationTimesMs.length, 17);
  assert.ok(result.materializationTimesMs.every((value) => value >= 0));
});
