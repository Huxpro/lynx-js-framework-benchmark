import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LAB_WEB_CONTRACT_VERSION,
  assertCompleteLabWebRun,
  buildLabWebContract,
  labWebMatrixOptions,
  resolveLabWebEntry,
} from './lab-web.mjs';

const lab = {
  id: 'octane-new1',
  tier: 'lab',
  provenance: { commit: 'abc123' },
  webLab: { enabled: true, contract: LAB_WEB_CONTRACT_VERSION },
};

test('Lab Web is explicit and derives the complete extended matrix', () => {
  assert.throws(() => resolveLabWebEntry([lab], null, true), /exactly one explicit --entry/);
  const selected = resolveLabWebEntry([lab], [lab.id], true);
  assert.equal(selected.contract.cells.length, 35);
  assert.deepEqual(labWebMatrixOptions(selected.contract), {
    scales: [1000, 3000, 5000, 10000, 20000, 30000],
    reps: 7,
    stormReps: 3,
    startupReps: 5,
  });
});

test('Lab Web acceptance requires every contracted cell and exact provenance', () => {
  const contract = buildLabWebContract(lab);
  const records = contract.cells.map((cell) => ({
    ...cell, harness: 'web', samples: Array(cell.expectedReps).fill(1), dnfCount: 0,
  }));
  const run = {
    meta: {
      completed: true,
      completedAt: '2026-01-01T00:00:00Z',
      comparisonScope: 'lab-entry-web',
      labWeb: {
        entryId: lab.id, entryCommit: contract.entryCommit, contractVersion: contract.version,
        contractSha256: contract.sha256, expectedCellCount: contract.expectedCellCount,
      },
      entryCommits: { [lab.id]: contract.entryCommit },
    },
    records,
  };
  assert.equal(assertCompleteLabWebRun(run, lab)?.contract.expectedCellCount, 35);
  assert.equal(assertCompleteLabWebRun({ ...run, records: records.slice(1) }, lab), null);
  assert.equal(assertCompleteLabWebRun({
    ...run, records: [{ ...records[0], samples: records[0].samples.slice(1) }, ...records.slice(1)],
  }, lab), null);
  assert.equal(assertCompleteLabWebRun({
    ...run,
    records: [{
      ...records[0], samples: records[0].samples.slice(1), dnfCount: 1, failures: [],
    }, ...records.slice(1)],
  }, lab), null);
  assert.equal(assertCompleteLabWebRun({
    ...run, meta: { ...run.meta, completed: false, completedAt: null },
  }, lab), null);
  assert.equal(assertCompleteLabWebRun({
    ...run, records: [...records, { ...records[0], entry: 'other' }],
  }, lab), null);
  assert.equal(assertCompleteLabWebRun(run, {
    ...lab,
    provenance: { ...lab.provenance, patched: true, patchFile: 'entry.patch' },
  }), null);
});
