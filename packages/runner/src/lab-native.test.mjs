import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LAB_NATIVE_CELL_COUNT,
  LAB_NATIVE_CONTRACT_VERSION,
  assertCompleteLabNativeRun,
  buildLabNativeContract,
  labNativeMatrixOptions,
  resolveNativeEntrySelection,
} from './lab-native.mjs';
import { classifyNativeCoverage } from './native-coverage.mjs';

const featured = { id: 'octane', tier: 'featured', framework: 'octane' };
const lab = {
  id: 'octane-new1',
  tier: 'lab',
  framework: 'octane',
  provenance: { commit: 'abc123' },
  nativeLab: { enabled: true, contract: LAB_NATIVE_CONTRACT_VERSION },
};

test('Native defaults to featured and rejects implicit Lab execution', () => {
  assert.deepEqual(
    resolveNativeEntrySelection([featured, lab]).entries.map((entry) => entry.id),
    ['octane'],
  );
  assert.throws(
    () => resolveNativeEntrySelection([featured, lab], { requestedEntryIds: [lab.id] }),
    /require --lab-native/,
  );
});

test('Lab Native requires one explicit opted-in entry and resolves the full contract', () => {
  assert.throws(
    () => resolveNativeEntrySelection([featured, lab], { labNative: true }),
    /exactly one explicit --entry/,
  );
  assert.throws(
    () => resolveNativeEntrySelection([featured, lab], {
      requestedEntryIds: [featured.id],
      labNative: true,
    }),
    /tier=lab/,
  );
  const selected = resolveNativeEntrySelection([featured, lab], {
    requestedEntryIds: [lab.id],
    labNative: true,
  });
  assert.equal(selected.comparisonScope, 'lab-entry');
  assert.equal(selected.contract.cells.length, LAB_NATIVE_CELL_COUNT);
  assert.deepEqual(selected.contract.entryCommit, 'abc123');
  assert.equal(selected.contract.cells.some((cell) => cell.scale === 30000), true);
  assert.deepEqual(labNativeMatrixOptions(selected.contract), {
    scales: [1000, 3000, 5000, 10000, 20000, 30000],
    startupScales: [0, 1000, 10000, 30000],
    reps: 5,
    startupReps: 3,
  });
});

test('collector accepts only a commit-matching complete single-entry Native Lab run', () => {
  const contract = buildLabNativeContract(lab);
  const records = contract.cells.map((cell) => ({
    ...cell,
    harness: 'native',
    environment: 'native-test',
    samples: Array(cell.expectedReps).fill(1),
    n: cell.expectedReps,
    median: 1,
    mean: 1,
    std: 0,
    min: 1,
    max: 1,
    p95: 1,
    ci95: 0,
    dnfCount: 0,
    failures: [],
  }));
  const run = {
    meta: {
      checkpoint: true,
      checkpointComplete: true,
      comparisonScope: 'lab-entry',
      labNative: {
        entryId: lab.id,
        entryCommit: lab.provenance.commit,
        contractVersion: contract.version,
        contractSha256: contract.sha256,
        expectedCellCount: contract.expectedCellCount,
      },
      entryCommits: { [lab.id]: lab.provenance.commit },
      matrixContract: contract,
    },
    nativeCoverage: classifyNativeCoverage({ entries: [lab], contract, sourceRecords: records }),
    records,
  };
  assert.equal(assertCompleteLabNativeRun(run, lab)?.records.length, LAB_NATIVE_CELL_COUNT);
  assert.equal(assertCompleteLabNativeRun({ ...run, records: records.slice(1) }, lab), null);
  assert.equal(assertCompleteLabNativeRun({
    ...run, records: [{ ...records[0], samples: records[0].samples.slice(1) }, ...records.slice(1)],
  }, lab), null);
  assert.equal(assertCompleteLabNativeRun({
    ...run,
    records: [{
      ...records[0], samples: records[0].samples.slice(1), dnfCount: 1, failures: [],
    }, ...records.slice(1)],
  }, lab), null);
  assert.equal(assertCompleteLabNativeRun({
    ...run, meta: { ...run.meta, checkpointComplete: false },
  }, lab), null);
  assert.equal(assertCompleteLabNativeRun({
    ...run, records: [...records, { ...records[0], harness: 'web' }],
  }, lab), null);
  assert.equal(assertCompleteLabNativeRun({
    ...run,
    meta: { ...run.meta, labNative: { ...run.meta.labNative, expectedCellCount: 34 } },
  }, lab), null);
  assert.equal(assertCompleteLabNativeRun({
    ...run,
    meta: { ...run.meta, entryCommits: { [lab.id]: 'stale' } },
  }, lab), null);
  assert.equal(assertCompleteLabNativeRun(run, {
    ...lab,
    provenance: { ...lab.provenance, patched: true, patchFile: 'entry.patch' },
  }), null);
});
