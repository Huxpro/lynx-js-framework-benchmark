import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  canonicalMetricKey,
  deriveRecord,
  makeRecord,
} from '@lynx-bench/shared/schema';

import {
  alignedMetricAttempts,
  dnfAttempt,
} from './attempt-series.mjs';
import {
  resolveCampaign,
  resolvedCampaignMatrix,
  validateCampaignMetadata,
} from './campaign.mjs';
import { validateFormalRun, writeRunFile } from './run-files.mjs';

const matrix = {
  cases: [{ name: 'create', scales: [1000], freshPage: false }],
  suites: ['table'],
  scales: [1000],
  startupScales: [],
  reps: 3,
  startupReps: 1,
  stormReps: 1,
};

test('attempt derivation preserves success/DNF/success alignment and ignores stored derivatives', () => {
  const observations = [
    { values: { latency: 1, cpu: 10, wire: 100 } },
    dnfAttempt(1, 'timeout'),
    { values: { latency: 3, cpu: 30, wire: 300 } },
  ];
  const latency = alignedMetricAttempts(observations, 'latency');
  const cpu = alignedMetricAttempts(observations, 'cpu');
  const wire = alignedMetricAttempts(observations, 'wire');
  assert.deepEqual(latency.map(({ index, value, dnf }) => [index, value, dnf]), [
    [0, 1, false],
    [1, null, true],
    [2, 3, false],
  ]);
  assert.deepEqual(
    cpu.map(({ index, dnf }) => [index, dnf]),
    wire.map(({ index, dnf }) => [index, dnf]),
  );
  const derived = deriveRecord({
    suite: 'table',
    harness: 'web',
    environment: 'lynx-for-web',
    entry: 'vue-vapor-a',
    workload: 'create',
    scale: 1000,
    metric: 'latency',
    boundary: 'test',
    unit: 'ms',
    attempts: latency,
    samples: [999],
    dnfCount: 99,
    median: 999,
  });
  assert.deepEqual(derived.samples, [1, 3]);
  assert.equal(derived.dnfCount, 1);
  assert.equal(derived.median, 2);
});

test('attempt validation rejects duplicate, missing, nonfinite, and finite DNF positions', () => {
  const base = {
    suite: 'table',
    harness: 'web',
    environment: 'lynx-for-web',
    entry: 'vue-vapor-a',
    workload: 'create',
    scale: 1000,
    metric: 'latency',
    boundary: 'test',
    unit: 'ms',
  };
  for (const attempts of [
    [
      { index: 0, value: 1, dnf: false, errorKind: null },
      { index: 0, value: 2, dnf: false, errorKind: null },
    ],
    [{ index: 1, value: 1, dnf: false, errorKind: null }],
    [{ index: 0, value: Number.POSITIVE_INFINITY, dnf: false, errorKind: null }],
    [{ index: 0, value: 1, dnf: true, errorKind: 'timeout' }],
    [{ index: 0, value: null, dnf: false, errorKind: null }],
  ]) {
    assert.throws(() => deriveRecord({ ...base, attempts }), /attempt/);
  }
});

test('campaign metadata is all-or-none, leg-indexed, and receipt-variant bound', () => {
  const entry = { id: 'vue-vapor-a' };
  const verified = new Map([[
    entry.id,
    { receipt: { variant: 'ifr' } },
  ]]);
  const args = {
    'campaign-id': 'campaign',
    'comparison-id': 'comparison',
    phase: 'table',
    leg: 'B2',
    'sequence-index': '2',
  };
  const campaign = resolveCampaign({
    args,
    labRoot: '/lab',
    entries: [entry],
    verifiedLabEntries: verified,
    harness: 'web',
    matrix,
    runLabel: 'comparison-ifr-table-b2',
  });
  assert.equal(campaign.variant, 'ifr');
  assert.equal(campaign.sequenceIndex, 2);
  assert.throws(
    () => resolveCampaign({
      args: { ...args, 'sequence-index': '1' },
      labRoot: '/lab',
      entries: [entry],
      verifiedLabEntries: verified,
      harness: 'web',
      matrix,
      runLabel: 'label',
    }),
    /B2 requires sequence index 2/,
  );
  assert.throws(
    () => resolveCampaign({
      args: { 'campaign-id': 'partial' },
      labRoot: '/lab',
      entries: [entry],
      verifiedLabEntries: verified,
      harness: 'web',
      matrix,
      runLabel: 'label',
    }),
    /all-or-none/,
  );
});

test('formal write gate requires exact attempts and canonical campaign metadata', () => {
  const campaign = {
    schemaVersion: 1,
    id: 'campaign',
    comparisonId: 'comparison',
    variant: 'vapor',
    phase: 'table',
    leg: 'A1',
    sequenceIndex: 0,
  };
  const resolvedMatrix = resolvedCampaignMatrix(matrix, 'web', 'table');
  const attempts = [
    { index: 0, value: 1, dnf: false, errorKind: null },
    { index: 1, value: null, dnf: true, errorKind: 'timeout' },
    { index: 2, value: 3, dnf: false, errorKind: null },
  ];
  const record = makeRecord({
    suite: 'table',
    entry: 'vue-vapor-a',
    workload: 'create',
    scale: 1000,
    metric: 'latency',
    boundary: 'test',
    unit: 'ms',
    attempts,
  });
  const run = {
    schemaVersion: 2,
    meta: {
      runLabel: 'comparison-vapor-table-a1',
      startedAt: '2026-08-16T00:00:00.000Z',
      finishedAt: '2026-08-16T00:00:01.000Z',
      generatedAt: '2026-08-16T00:00:01.000Z',
      campaign,
      resolvedMatrix,
      machine: { id: 'machine' },
    },
    records: [record],
  };
  assert.equal(validateFormalRun(run), run);
  assert.throws(
    () => validateFormalRun({
      ...run,
      meta: { ...run.meta, generatedAt: '2026-08-16T00:00:02.000Z' },
    }),
    /generatedAt must equal finishedAt/,
  );
  assert.throws(
    () => validateFormalRun({
      ...run,
      records: [{ ...record, attempts: attempts.slice(0, 2) }],
    }),
    /attempts length must be 3/,
  );
  assert.throws(
    () => validateCampaignMetadata({
      campaign,
      generatedAt: run.meta.generatedAt,
    }),
    /partial/,
  );

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'formal-run-write-'));
  try {
    const file = writeRunFile({
      root,
      run,
      machineId: 'machine',
      label: run.meta.runLabel,
    });
    assert.equal(fs.existsSync(file), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('canonical metric keys do not collapse variant or suite', () => {
  const record = {
    suite: 'table',
    harness: 'web',
    environment: 'lynx-for-web',
    workload: 'create',
    scale: 1000,
    metric: 'latency',
    boundary: 'test',
    unit: 'ms',
  };
  assert.notEqual(
    canonicalMetricKey(record, 'vapor'),
    canonicalMetricKey(record, 'ifr'),
  );
  assert.notEqual(
    canonicalMetricKey(record, 'vapor'),
    canonicalMetricKey({ ...record, suite: 'startup' }, 'vapor'),
  );
});
