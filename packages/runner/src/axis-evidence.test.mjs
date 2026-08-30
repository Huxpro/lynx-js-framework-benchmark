import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  AXIS_EVIDENCE_LEDGER_VERSION,
  buildAxisEvidenceLedger,
  loadAxisEvidenceSources,
} from './axis-evidence.mjs';

const source = (comparisons) => ({
  file: 'axis-evidence/test.json',
  source: { schemaVersion: 'axis-evidence-source-v1', cohortId: 'test', comparisons },
});

const comparison = (overrides = {}) => ({
  id: 'candidate',
  group: 'architecture',
  shape: 'pair',
  title: 'candidate',
  source: { label: 'source', url: 'https://example.test/source' },
  subjects: ['before', 'after'],
  relationship: 'same-codebase',
  intendedAxis: 'staging',
  changedAxes: ['staging'],
  controls: {
    sameCodebase: true,
    sameFixture: true,
    singlePhysicalRun: true,
    singleBuildVariable: true,
  },
  observations: [{
    label: 'latency',
    metric: 'latency',
    unit: 'ms',
    lowerIsBetter: true,
    before: { label: 'before', value: 10 },
    after: { label: 'after', value: 8 },
  }],
  ...overrides,
});

test('the evidence ledger admits only a controlled single-axis pair', () => {
  const ledger = buildAxisEvidenceLedger({ sources: [source([
    comparison(),
    comparison({ id: 'coupled', changedAxes: ['staging', 'handover'] }),
    comparison({
      id: 'residue',
      group: 'residue',
      intendedAxis: null,
      changedAxes: [],
      controls: {
        sameCodebase: true,
        sameFixture: true,
        singlePhysicalRun: true,
        singleBuildVariable: false,
      },
    }),
  ])] });
  assert.equal(ledger.version, AXIS_EVIDENCE_LEDGER_VERSION);
  assert.deepEqual(ledger.comparisons.map((item) => item.verdict), [
    'attributable',
    'coupled',
    'implementation-residue',
  ]);
  assert.equal(ledger.summary.attributableCount, 1);
  assert.equal(ledger.comparisons[0].observations[0].delta, -2);
  assert.equal(ledger.comparisons[0].observations[0].relativeDelta, -0.2);
});

test('cross-framework points and uncontrolled pairs remain descriptive or excluded', () => {
  const ledger = buildAxisEvidenceLedger({ sources: [source([
    comparison({ id: 'cross', relationship: 'cross-framework' }),
    comparison({
      id: 'uncontrolled',
      controls: {
        sameCodebase: true,
        sameFixture: true,
        singlePhysicalRun: null,
        singleBuildVariable: true,
      },
    }),
  ])] });
  assert.equal(ledger.comparisons[0].verdict, 'descriptive');
  assert.equal(ledger.comparisons[1].verdict, 'uncontrolled');
  assert.equal(ledger.summary.attributableCount, 0);
});

test('checked-in first cohort parses and keeps implementation residue separate', () => {
  const root = path.resolve(new URL('../../..', import.meta.url).pathname);
  const sources = loadAxisEvidenceSources({ root });
  const ledger = buildAxisEvidenceLedger({
    sources,
    pairs: [
      {
        id: 'octane-c163-interpreted→octane-c163-program',
        attributable: false,
        effects: [],
        descriptiveEffects: Array(8).fill({}),
      },
      {
        id: 'vue-vapor→vue-vapor-ifr',
        attributable: false,
        effects: [],
        descriptiveEffects: Array(284).fill({}),
      },
    ],
  });
  assert.equal(ledger.summary.comparisonCount, 6);
  assert.equal(ledger.summary.attributableCount, 0);
  assert.equal(ledger.summary.coupledCount, 3);
  assert.equal(ledger.summary.descriptiveCount, 1);
  assert.equal(ledger.summary.implementationResidueCount, 2);
  assert.equal(ledger.comparisons.find((item) => item.id === 'octane-template-program').auditEffectCount, 8);
});

test('malformed residue cannot be loaded as an axis effect', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axis-evidence-'));
  try {
    const dir = path.join(root, 'results', 'axis-evidence');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'bad.json'), JSON.stringify({
      schemaVersion: 'axis-evidence-source-v1',
      cohortId: 'bad',
      comparisons: [comparison({ group: 'residue', changedAxes: ['staging'] })],
    }));
    assert.throws(() => loadAxisEvidenceSources({ root }), /residue must keep all six coordinates fixed/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
