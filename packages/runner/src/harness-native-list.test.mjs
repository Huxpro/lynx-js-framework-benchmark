import assert from 'node:assert/strict';
import test from 'node:test';

import { LIST_CASES } from '../../shared/src/list-workloads.mjs';
import { buildNativeListMatrixContract, runNativeListMatrix } from './harness-native-list.mjs';

const entry = { id: 'fixture', framework: 'reactlynx' };
const bundleSnapshots = new Map(
  [
    [1000, Buffer.from('list-1000')],
    [10000, Buffer.from('list-10000')],
  ].map(([scale, bundleBytes]) => [
    `fixture:${scale}`,
    {
      entryId: 'fixture',
      scale,
      bundlePath: `/fixture/list-${scale}.lynx.bundle`,
      bundleBytes,
      sha256: 'f'.repeat(64),
    },
  ]),
);

function adapter(overrides = {}) {
  return {
    environment: 'lynx-native-test',
    async loadBundle() {},
    async collectListStartup() {
      return {
        firstVisibleContentMs: 12,
        initial: {
          atMs: 0,
          keys: Array.from({ length: 16 }, (_, index) => `row-${index}`),
        },
      };
    },
    async driveListCase(kase) {
      if (kase.name === 'list-recycle')
        return {
          metrics: { operationTimeMs: 33, recycledCells: 16 },
          metricFailures: {
            wireToMtsBytes: {
              category: 'unsupported-native-wire-meter',
              capabilityScope: 'metric',
              capabilityProven: true,
            },
            wireToBtsBytes: {
              category: 'unsupported-native-wire-meter',
              capabilityScope: 'metric',
              capabilityProven: true,
            },
          },
        };
      return {
        metrics: {
          elapsedMs: 1500,
          materializedCells: 30,
          blankFrames: 0,
        },
        metricFailures: {
          materializationTimesMs: {
            category: 'unsupported-native-materialization-entry-clock',
            capabilityScope: 'metric',
            capabilityProven: true,
          },
        },
      };
    },
    ...overrides,
  };
}

test('Native list matrix emits one source record per contract cell', async () => {
  const records = await runNativeListMatrix({
    adapter: adapter(),
    entries: [entry],
    bundleSnapshots,
    reps: 2,
  });
  const contract = buildNativeListMatrixContract([entry]);
  assert.equal(records.length, contract.expectedCellCount);
  assert.deepEqual(
    records.filter((record) => record.metric === 'firstVisibleContentMs').map((record) => record.n),
    [2, 2],
  );
  assert.equal(records.find((record) => record.metric === 'operationTimeMs').n, 2);
  const materialization = records.find((record) => record.metric === 'materializationTimesMs');
  assert.equal(materialization.n, 0);
  assert.equal(materialization.dnfCount, 2);
  const wire = records.find((record) => record.metric === 'wireToMtsBytes');
  assert.equal(wire.n, 0);
  assert.equal(wire.dnfCount, 2);
  assert.ok(wire.failures.every((failure) => failure.capabilityProven === true));
});

test('Native list repetitions commit atomically after validating every metric', async () => {
  const recycle = LIST_CASES.filter((kase) => kase.name === 'list-recycle');
  const records = await runNativeListMatrix({
    adapter: adapter({
      async driveListCase() {
        return { metrics: { operationTimeMs: 33 } };
      },
    }),
    entries: [entry],
    cases: recycle,
    bundleSnapshots,
    reps: 1,
  });
  assert.equal(records.length, 4);
  assert.ok(records.every((record) => record.n === 0 && record.dnfCount === 1));
  assert.ok(
    records.every((record) => record.failures[0].category === 'native-list-capture-failure'),
  );
});

test('Native list matrix rejects a partial metric checkpoint', async () => {
  const recycle = LIST_CASES.find((kase) => kase.name === 'list-recycle');
  await assert.rejects(
    () =>
      runNativeListMatrix({
        adapter: adapter(),
        entries: [entry],
        cases: [recycle],
        bundleSnapshots,
        reps: 1,
        existingCellKeys: new Set(['fixture|list|list-recycle|10000|operationTimeMs']),
      }),
    /partially checkpointed/,
  );
});
