import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveListRecords } from './list-derivation.mjs';

const source = (workload, metric, samples) => ({
  suite: 'list', harness: 'web', environment: 'test', entry: 'react', workload,
  scale: 10000, contractVersion: 1, comparabilityCohort: 'test', metric,
  boundary: `source-${metric}`, unit: 'count', samples, value: null,
  dnfCount: 0, failures: [], machineId: 'machine', runFile: 'run.json',
});

test('list derivation uses aligned raw totals and preserves blank frames only as source data', () => {
  const records = [
    source('list-recycle', 'operationTimeMs', [20, 30]),
    source('list-recycle', 'recycledCells', [10, 15]),
    source('list-recycle', 'wireToMtsBytes', [100, 300]),
    source('list-recycle', 'wireToBtsBytes', [200, 450]),
    source('list-fling', 'elapsedMs', [1000, 2000]),
    source('list-fling', 'materializedCells', [100, 300]),
    source('list-fling', 'blankFrames', [0, 3]),
    source('list-fling', 'materializationTimesMs', [1, 2, 8, 10]),
  ];
  const derived = deriveListRecords(records);
  assert.deepEqual(
    derived.find(({ metric }) => metric === 'timePerRecycledCellMs').samples,
    [2, 2],
  );
  assert.deepEqual(
    derived.find(({ metric }) => metric === 'wireToMtsBytesPerCell').samples,
    [10, 20],
  );
  assert.deepEqual(
    derived.find(({ metric }) => metric === 'materializedCellsPerSecond').samples,
    [100, 150],
  );
  assert.equal(derived.find(({ metric }) => metric === 'materializationP50Ms').value, 5);
  assert.equal(derived.find(({ metric }) => metric === 'materializationP99Ms').value, 9.94);
  assert.equal(derived.some(({ metric }) => metric === 'blankFrames'), false);
  assert.ok(derived.every((record) => record.rankingEligible === false
    && record.descriptiveEligible === true
    && record.derivedFrom.kind === 'collector-list-derivation'));
});

test('list derivation rejects misaligned source samples instead of inventing a rate', () => {
  assert.throws(() => deriveListRecords([
    source('list-recycle', 'operationTimeMs', [20, 30]),
    source('list-recycle', 'recycledCells', [10]),
  ]), /not aligned/);
});
