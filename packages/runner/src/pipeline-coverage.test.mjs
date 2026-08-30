import assert from 'node:assert/strict';
import test from 'node:test';

import { BOUNDARIES } from '@lynx-bench/shared/schema';

import {
  PIPELINE_FEATURED_MATRIX_CELL_COUNT,
  PIPELINE_MATRIX_CELL_COUNT_PER_ENTRY,
  PIPELINE_METRICS,
  assertPipelineCoverage,
  buildPipelineMatrixContract,
  classifyPipelineCoverage,
} from './pipeline-coverage.mjs';

const ENTRIES = [
  'octane', 'octane-hux', 'react', 'vue-vapor',
  'vue-vapor-ifr', 'vue-vdom', 'vue-vdom-ifr-et',
].map((id) => ({ id, tier: 'featured', harnesses: ['web'] }));

function recordsFor(cell, { dnf = false } = {}) {
  return PIPELINE_METRICS.map((metric) => ({
    ...cell,
    metric,
    boundary: metric === 'operationTime'
      ? BOUNDARIES.pipelineOperation
      : metric === 'outsidePapiTime'
        ? BOUNDARIES.pipelineResidual
        : metric.endsWith('Calls') ? BOUNDARIES.papiCalls : BOUNDARIES.papiSelfTime,
    unit: metric.endsWith('Calls') ? 'count' : 'ms',
    samples: dnf ? [] : [1],
    n: dnf ? 0 : 1,
    median: dnf ? null : 1,
    dnfCount: dnf ? 1 : 0,
    attemptedCount: 1,
    acceptedCount: dnf ? 0 : 1,
    failures: dnf ? [{ category: 'pipeline-predicate-timeout' }] : [],
    pipelineControl: dnf
      ? { status: 'incomplete', reason: 'pipeline-dnf-without-observation' }
      : { status: 'controlled' },
  }));
}

test('Pipeline contract is exactly seven Web entries by twelve operation cells', () => {
  const contract = buildPipelineMatrixContract([...ENTRIES].reverse());
  assert.equal(contract.expectedCellCount, PIPELINE_FEATURED_MATRIX_CELL_COUNT);
  assert.equal(contract.cells.length, 84);
  assert.equal(contract.entryIds.length, 7);
  for (const entry of ENTRIES) {
    assert.equal(
      contract.cells.filter((cell) => cell.entry === entry.id).length,
      PIPELINE_MATRIX_CELL_COUNT_PER_ENTRY,
    );
  }
});

test('Pipeline coverage rejects silent gaps and accepts explicit DNF attempts', () => {
  const contract = buildPipelineMatrixContract(ENTRIES);
  const records = contract.cells.flatMap((cell, index) =>
    recordsFor(cell, { dnf: index === 0 }));
  const complete = classifyPipelineCoverage({ entries: ENTRIES, sourceRecords: records });
  assert.deepEqual(complete.summary, { dnf: 1, measured: 83 });
  assert.doesNotThrow(() => assertPipelineCoverage(complete));

  const incomplete = classifyPipelineCoverage({
    entries: ENTRIES,
    sourceRecords: records.filter((record) => record.entry !== 'react'),
  });
  assert.equal(incomplete.summary.unscheduled, 12);
  assert.throws(() => assertPipelineCoverage(incomplete), /incomplete or invalid/);
});

test('Pipeline coverage requires every time/call/residual metric for each operation', () => {
  const contract = buildPipelineMatrixContract(ENTRIES);
  const records = contract.cells.flatMap((cell) => recordsFor(cell));
  records.splice(records.findIndex((record) =>
    record.entry === 'octane' && record.metric === 'papiFlushCalls'), 1);
  const coverage = classifyPipelineCoverage({ entries: ENTRIES, sourceRecords: records });
  assert.equal(coverage.summary['invalid-incomparable'], 1);
  assert.throws(() => assertPipelineCoverage(coverage), /incomplete or invalid/);
});
