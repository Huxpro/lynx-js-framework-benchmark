import assert from 'node:assert/strict';
import test from 'node:test';

import {
  analyzeListFling,
  analyzeListRecycle,
  listKeyIndex,
  nativeListCellKey,
} from './list-observation.mjs';

const frame = (atMs, first, count = 16) => ({
  atMs,
  keys: Array.from({ length: count }, (_, index) => `row-${first + index}`),
});

test('list observations accept only the fixture stable-key namespace', () => {
  assert.equal(listKeyIndex('row-42'), 42);
  assert.equal(listKeyIndex('42'), null);
});

test('Native list observation ignores substring class matches outside list-item cells', () => {
  assert.equal(nativeListCellKey({
    localName: 'view',
    attributes: ['class', 'bench-list-cell-body'],
  }), null);
  assert.equal(nativeListCellKey({
    localName: 'list-item',
    attributes: ['class', 'bench-list-cell bench-list-cell-active', 'item-key', 'row-42'],
  }), 'row-42');
  assert.equal(nativeListCellKey({
    localName: 'list-item',
    attributes: ['class', 'bench-list-cell-body', 'item-key', 'row-42'],
  }), null);
});

test('Native list observation rejects an exact fixture cell without a stable item key', () => {
  assert.throws(
    () => nativeListCellKey({
      localName: 'list-item',
      attributes: ['class', 'bench-list-cell'],
    }),
    /invalid item-key undefined/,
  );
});

test('one-viewport recycle closes on the first presented 16-row advance', () => {
  const result = analyzeListRecycle(frame(0, 0), [frame(16, 8), frame(33, 16), frame(50, 17)]);
  assert.equal(result.operationTimeMs, 33);
  assert.equal(result.recycledCells, 16);
  assert.equal(result.terminal.keys[0], 'row-16');
});

test('one-viewport recycle reports the furthest observed row on a short native drag', () => {
  assert.throws(
    () => analyzeListRecycle(frame(0, 0), [frame(16, 8), frame(32, 15)]),
    /maximum observed advance 15; furthest visible range 15-30/,
  );
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
