import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { deriveRecord } from '@lynx-bench/shared/schema';

import { buildAxisEffectView, loadAxisObservationRuns } from './axis-effects.mjs';

const coordinates = (overrides = {}) => ({
  invalidation: 'runtime',
  recompute: 'block',
  sharing: 'compile-time-code',
  staging: 'ops',
  residency: { firstFrame: 'background', steadyState: 'background' },
  handover: 'operation-stream',
  ...overrides,
});

const entry = (id, overrides = {}) => ({
  id,
  label: id,
  framework: 'framework-a',
  fixture: 'keyed-table-v1',
  tier: 'lab',
  coordinates: coordinates(),
  provenance: {
    source: 'https://example.test/framework-a',
    ref: 'matrix',
    commit: 'abc',
    patched: false,
    patchFile: null,
    buildCommand: 'build matrix',
    buildParameters: { mode: id },
  },
  ...overrides,
});

const ablation = (against, axis, delta, varyingBuildParameters = ['mode'], extra = {}) => ({
  against,
  axis,
  delta,
  provenance: {
    kind: 'same-build-matrix',
    evidence: 'https://example.test/build-matrix',
    varyingBuildParameters,
  },
  ...extra,
});

const record = (entryId, samples, scale = 1000) => deriveRecord({
  suite: 'table',
  harness: 'web',
  environment: 'test',
  entry: entryId,
  workload: 'create',
  scale,
  metric: 'latency',
  boundary: 'input-to-result',
  unit: 'ms',
  samples,
  dnfCount: 0,
});

const run = (records, file = 'pair.json') => ({
  file,
  run: {
    meta: {
      generatedAt: '2026-01-01T00:00:00Z',
      machine: { id: 'machine-a' },
      entryCommits: Object.fromEntries([...new Set(records.map((item) => item.entry))]
        .map((id) => [id, 'abc'])),
    },
    records,
  },
});

test('only a controlled same-codebase single-axis pair becomes attributable', () => {
  const baseline = entry('baseline', {
    provenance: { ...entry('x').provenance, buildParameters: { mode: 'ops' } },
  });
  const candidate = entry('candidate', {
    coordinates: coordinates({ staging: 'code' }),
    provenance: { ...entry('x').provenance, buildParameters: { mode: 'code' } },
    ablation: ablation('baseline', 'staging', 'ops→code'),
  });
  const view = buildAxisEffectView({
    entries: [baseline, candidate],
    runs: [run([record('baseline', [10, 11, 12]), record('candidate', [6, 7, 8])])],
  });
  const pair = view.pairs[0];
  assert.equal(pair.validation.status, 'validated');
  assert.equal(pair.attributable, true);
  assert.equal(pair.effects[0].medianDelta, -4);
  assert.equal(pair.effects[0].rangesDisjoint, true);
  assert.deepEqual(pair.coordinates.context, {
    invalidation: 'runtime',
    recompute: 'block',
    sharing: 'compile-time-code',
    residency: 'background/background',
    handover: 'operation-stream',
  });
  assert.equal(view.axes.find((axis) => axis.axis === 'staging').instrument.status, 'pending');
  assert.equal(JSON.stringify(view).includes('regression'), false);
});

test('cross-codebase, uncontrolled, and mismatched matrices are retained but excluded', () => {
  const baseline = entry('baseline', {
    provenance: { ...entry('x').provenance, buildParameters: { mode: 'ops' } },
  });
  const candidate = entry('candidate', {
    framework: 'framework-b',
    coordinates: coordinates({ staging: 'code' }),
    provenance: {
      ...entry('x').provenance,
      source: 'https://example.test/framework-b',
      buildParameters: { mode: 'code' },
    },
    ablation: ablation('baseline', 'staging', 'ops→code'),
  });
  const crossFramework = buildAxisEffectView({
    entries: [baseline, candidate],
    runs: [run([record('baseline', [10]), record('candidate', [9])])],
  }).pairs[0];
  assert.equal(crossFramework.attributable, false);
  assert.match(crossFramework.validation.reasons.join(' '), /cross-codebase/);

  const sameCodebase = {
    ...candidate,
    framework: baseline.framework,
    provenance: { ...candidate.provenance, source: baseline.provenance.source },
  };
  const mismatched = buildAxisEffectView({
    entries: [baseline, sameCodebase],
    runs: [run([record('baseline', [10], 1000), record('candidate', [9], 10000)])],
  }).pairs[0];
  assert.equal(mismatched.attributable, false);
  assert.match(mismatched.validation.reasons.join(' '), /no-controlled-same-run-matrix/);
});

test('a declared coupled move is a controlled finding, never a single-axis attribution', () => {
  const baseline = entry('baseline', {
    provenance: { ...entry('x').provenance, buildParameters: { mode: 'ops' } },
  });
  const candidate = entry('candidate', {
    coordinates: coordinates({ staging: 'code', sharing: 'compile-time-data' }),
    provenance: { ...entry('x').provenance, buildParameters: { mode: 'code' } },
    ablation: ablation('baseline', 'staging', 'ops→code', ['mode'], { coupled: ['sharing'] }),
  });
  const pair = buildAxisEffectView({
    entries: [baseline, candidate],
    runs: [run([record('baseline', [10]), record('candidate', [8])])],
  }).pairs[0];
  assert.equal(pair.validation.status, 'coupled');
  assert.equal(pair.attributable, false);
  assert.equal(pair.effects.length, 0);
  assert.equal(pair.descriptiveEffects[0].medianDelta, -2);
});

test('ceiling-to-ceiling axis effect and entry-to-own-ceiling residues stay separate', () => {
  const shared = entry('x').provenance;
  const baseline = entry('baseline', {
    provenance: { ...shared, buildParameters: { mode: 'ops' } },
  });
  const candidate = entry('candidate', {
    coordinates: coordinates({ staging: 'code' }),
    provenance: { ...shared, buildParameters: { mode: 'code' } },
    ablation: ablation('baseline', 'staging', 'ops→code'),
  });
  const baselineCeiling = entry('baseline-ceiling', {
    ceilingFor: 'baseline',
    coordinates: baseline.coordinates,
    provenance: { ...shared, buildParameters: { mode: 'ops-ceiling' } },
  });
  const candidateCeiling = entry('candidate-ceiling', {
    ceilingFor: 'candidate',
    coordinates: candidate.coordinates,
    provenance: { ...shared, buildParameters: { mode: 'code-ceiling' } },
  });
  const records = [
    record('baseline', [12, 12, 12]),
    record('candidate', [9, 9, 9]),
    record('baseline-ceiling', [10, 10, 10]),
    record('candidate-ceiling', [6, 6, 6]),
  ];
  const source = run(records);
  source.run.meta.entryCommits = Object.fromEntries(records.map((item) => [item.entry, 'abc']));
  const pair = buildAxisEffectView({
    entries: [baseline, candidate, baselineCeiling, candidateCeiling],
    runs: [source],
  }).pairs[0];
  assert.equal(pair.ceiling.separated, true);
  assert.equal(pair.ceiling.axisEffect.effects[0].medianDelta, -4);
  assert.equal(pair.ceiling.implementationResidue.against.effects[0].medianDelta, 2);
  assert.equal(pair.ceiling.implementationResidue.entry.effects[0].medianDelta, 3);
});

test('ceilings cannot turn a coupled move into an axis effect', () => {
  const shared = entry('x').provenance;
  const baseline = entry('baseline', {
    provenance: { ...shared, buildParameters: { mode: 'ops' } },
  });
  const candidate = entry('candidate', {
    coordinates: coordinates({ staging: 'code', sharing: 'compile-time-data' }),
    provenance: { ...shared, buildParameters: { mode: 'code' } },
    ablation: ablation('baseline', 'staging', 'ops→code', ['mode'], { coupled: ['sharing'] }),
  });
  const baselineCeiling = entry('baseline-ceiling', {
    ceilingFor: 'baseline',
    coordinates: baseline.coordinates,
    provenance: { ...shared, buildParameters: { mode: 'ops-ceiling' } },
  });
  const candidateCeiling = entry('candidate-ceiling', {
    ceilingFor: 'candidate',
    coordinates: candidate.coordinates,
    provenance: { ...shared, buildParameters: { mode: 'code-ceiling' } },
  });
  const records = [
    record('baseline', [12]),
    record('candidate', [9]),
    record('baseline-ceiling', [10]),
    record('candidate-ceiling', [6]),
  ];
  const source = run(records);
  source.run.meta.entryCommits = Object.fromEntries(records.map((item) => [item.entry, 'abc']));
  const pair = buildAxisEffectView({
    entries: [baseline, candidate, baselineCeiling, candidateCeiling],
    runs: [source],
  }).pairs[0];
  assert.equal(pair.validation.status, 'coupled');
  assert.equal(pair.ceiling.axisEffect, null);
  assert.equal(pair.ceiling.implementationResidue.against.effects[0].medianDelta, 2);
  assert.equal(pair.ceiling.implementationResidue.entry.effects[0].medianDelta, 3);
});

test('pipeline tree controls gate an otherwise controlled ablation', () => {
  const shared = entry('x').provenance;
  const baseline = entry('baseline', {
    provenance: { ...shared, buildParameters: { mode: 'ops' } },
  });
  const candidate = entry('candidate', {
    coordinates: coordinates({ staging: 'code' }),
    provenance: { ...shared, buildParameters: { mode: 'code' } },
    ablation: ablation('baseline', 'staging', 'ops→code'),
  });
  const pipelineRecord = (entryId, committedRows) => deriveRecord({
    suite: 'pipeline',
    harness: 'web',
    environment: 'test',
    entry: entryId,
    workload: 'startup',
    scale: 1000,
    metric: 'operationTime',
    boundary: 'operation',
    unit: 'ms',
    samples: [10],
    dnfCount: 0,
    detailSamples: [{
      requestedRows: 1000,
      committedRows,
      callMultiset: { __FlushElementTree: 1 },
      surfaceNames: ['__FlushElementTree'],
    }],
  });
  const pair = buildAxisEffectView({
    entries: [baseline, candidate],
    runs: [run([pipelineRecord('baseline', 1000), pipelineRecord('candidate', 999)])],
  }).pairs[0];
  assert.equal(pair.attributable, false);
  assert.match(pair.validation.reasons.join(' '), /no-controlled-same-run-matrix/);
  assert.match(pair.validation.rejectedRuns[0].reason, /committed-tree-mismatch/);
});

test('compact axis sources retain raw observations and derive residuals only in memory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axis-observation-'));
  try {
    const dir = path.join(root, 'results', 'axis-runs');
    fs.mkdirSync(dir, { recursive: true });
    const source = {
      schemaVersion: 'axis-observation-v1',
      bundleCommit: 'abc',
      sourceArtifact: { blob: 'immutable-source' },
      meta: {
        generatedAt: '2026-01-01T00:00:00Z',
        machine: { id: 'machine-a' },
        webCore: 'test',
        reportable: true,
      },
      fixture: 'keyed-table-v1',
      scale: 1000,
      cells: {
        baseline: {
          operationSamples: [20, 22],
          segmentSamples: Object.fromEntries(
            ['create', 'props', 'events', 'topology', 'read', 'flush']
              .map((segment) => [segment, [1, 1]]),
          ),
          control: {
            requestedRows: 1000,
            committedRows: 1000,
            callMultiset: { __FlushElementTree: 1 },
            surfaceNames: ['__FlushElementTree'],
          },
        },
      },
    };
    const file = path.join(dir, 'source.json');
    fs.writeFileSync(file, `${JSON.stringify(source)}\n`);
    const before = fs.readFileSync(file, 'utf8');
    const [loaded] = loadAxisObservationRuns({ root });
    const residual = loaded.run.records.find((item) => item.metric === 'outsidePapiTime');
    assert.deepEqual(residual.samples, [14, 16]);
    assert.equal(source.cells.baseline.outsidePapiTime, undefined);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
