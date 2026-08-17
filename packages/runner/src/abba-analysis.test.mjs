import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { analyzeAbbaManifest } from './abba-analysis.mjs';
import {
  BOOTSTRAP_REPLICATES,
  confirmedEffect,
  pairedAbbaStatistics,
  practicalThreshold,
  quantileR7,
} from './abba-stats.mjs';
import {
  expectedVueVaporCoverage,
  expectedVueVaporKeys,
} from './vue-vapor-coverage.mjs';
import { canonicalAnalysisBytes } from '../../../scripts/lab/analyze-vue-vapor-abba.mjs';

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const LEGS = ['A1', 'B1', 'B2', 'A2'];
const NATIVE_ENVIRONMENT = 'lynx-native-test';

function attempts(value, reps = 3) {
  return Array.from({ length: reps }, (_, index) => ({
    index,
    value,
    dnf: false,
    errorKind: null,
  }));
}

function recordFromKey(key, entry, value = 1) {
  const [
    _variant,
    suite,
    harness,
    environment,
    workload,
    scale,
    metric,
    boundary,
    unit,
  ] = JSON.parse(key);
  const scalar = suite === 'bundle' || workload === 'memory';
  return {
    suite,
    harness,
    environment,
    entry,
    workload,
    scale,
    metric,
    boundary,
    unit,
    value: scalar ? value : null,
    samples: scalar ? null : [value, value, value],
    attempts: scalar ? null : attempts(value),
    detailSamples: null,
    detail: null,
    dnfCount: 0,
  };
}

function phaseKeys(variant, harness, phase) {
  return expectedVueVaporKeys(variant, { nativeEnvironment: NATIVE_ENVIRONMENT })
    .filter((key) => {
      const tuple = JSON.parse(key);
      if (tuple[2] !== harness) return false;
      if (phase === 'table') {
        return (tuple[1] === 'table' && tuple[4] !== 'memory')
          || (harness === 'web' && tuple[1] === 'bundle');
      }
      if (phase === 'startup') {
        return tuple[1] === 'startup'
          || (harness === 'web' && tuple[1] === 'bundle');
      }
      return tuple[1] === 'table' && tuple[4] === 'memory';
    });
}

function resolvedMatrix(keys, harness, phase) {
  const cells = new Map();
  for (const key of keys) {
    const tuple = JSON.parse(key);
    if (tuple[1] === 'bundle' || tuple[4] === 'memory') continue;
    cells.set(`${tuple[4]}\0${tuple[5]}`, {
      workload: tuple[4],
      scale: tuple[5],
      reps: 3,
    });
  }
  return {
    schemaVersion: 1,
    harness,
    table: phase === 'table' ? [...cells.values()] : phase === 'heap'
      ? [{ workload: 'memory', scale: 10000, reps: 1 }]
      : [],
    startup: phase === 'startup' ? [...cells.values()] : [],
  };
}

function writeSequence(root, {
  id,
  variant,
  harness,
  phase,
  offset,
}) {
  const keys = phaseKeys(variant, harness, phase);
  const legs = {};
  for (const [legIndex, leg] of LEGS.entries()) {
    const arm = leg.startsWith('A') ? 'a' : 'b';
    const entry = `${variant}-${arm}`;
    const artifact = {
      fingerprint: `${variant}-${arm}-fingerprint`,
      receiptSha256: `${variant}-${arm}-receipt`,
    };
    const value = arm === 'a' ? 1 : 1.01;
    const started = new Date(Date.UTC(2026, 7, 16, 0, offset + legIndex, 0));
    const finished = new Date(started.getTime() + 1000);
    const runLabel = `${id}-${leg.toLowerCase()}`;
    const records = keys.map((key) =>
      recordFromKey(key, entry, JSON.parse(key)[1] === 'bundle' ? 1 : value));
    const run = {
      schemaVersion: 2,
      meta: {
        runLabel,
        startedAt: started.toISOString(),
        finishedAt: finished.toISOString(),
        generatedAt: finished.toISOString(),
        campaign: {
          schemaVersion: 1,
          id,
          comparisonId: 'comparison',
          variant,
          phase,
          leg,
          sequenceIndex: legIndex,
        },
        resolvedMatrix: resolvedMatrix(keys, harness, phase),
        machine: {
          id: `${harness}-machine`,
          platform: harness === 'web' ? 'linux' : 'android',
          loadAverage: [legIndex, 0, 0],
        },
        calibration: harness === 'web'
          ? { probeVersion: 1, score: 100 + legIndex, iterations: 1000 }
          : null,
        browser: harness === 'web'
          ? { executableRealpath: '/browser', version: '1', sha256: 'browser-sha' }
          : null,
        benchmarkWorktree: { head: 'benchmark', patchSha256: 'patch' },
        entryArtifacts: { [entry]: artifact },
        entryCommits: { [entry]: `${variant}-${arm}-commit` },
      },
      records,
    };
    const bytes = Buffer.from(JSON.stringify(run));
    const file = path.join(root, `${id}-${leg.toLowerCase()}.json`);
    fs.writeFileSync(file, bytes);
    legs[leg] = {
      path: path.basename(file),
      sha256: sha256(bytes),
      runLabel,
      campaignId: id,
    };
  }
  return { id, variant, harness, phase, legs };
}

function fullFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'abba-analysis-'));
  const sequences = [];
  let offset = 0;
  for (const variant of ['vapor', 'ifr']) {
    for (const [harness, phase] of [
      ['web', 'table'],
      ['web', 'startup'],
      ['native', 'table'],
      ['native', 'startup'],
    ]) {
      sequences.push(writeSequence(root, {
        id: `${variant}-${harness}-${phase}`,
        variant,
        harness,
        phase,
        offset,
      }));
      offset += 4;
    }
    for (let heap = 0; heap < 3; heap++) {
      sequences.push(writeSequence(root, {
        id: `${variant}-web-heap-${heap}`,
        variant,
        harness: 'web',
        phase: 'heap',
        offset,
      }));
      offset += 4;
    }
  }
  return {
    root,
    manifest: {
      schemaVersion: 1,
      status: 'complete',
      comparisonId: 'comparison',
      sequences,
    },
  };
}

function mutateLeg(fixture, sequenceIndex, leg, mutate) {
  const descriptor = fixture.manifest.sequences[sequenceIndex].legs[leg];
  const file = path.join(fixture.root, descriptor.path);
  const run = JSON.parse(fs.readFileSync(file));
  mutate(run);
  const bytes = Buffer.from(JSON.stringify(run));
  fs.writeFileSync(file, bytes);
  descriptor.sha256 = sha256(bytes);
}

test('coverage construction is exactly Web438 + Native70 = 508', () => {
  const coverage = expectedVueVaporCoverage({
    nativeEnvironment: NATIVE_ENVIRONMENT,
  });
  assert.equal(coverage.web.length, 438);
  assert.equal(coverage.native.length, 70);
  assert.equal(coverage.keys.length, 508);
});

test('manifest-only analyzer accepts a programmatic complete 508-key fixture', () => {
  const fixture = fullFixture();
  try {
    const analysis = analyzeAbbaManifest(fixture.manifest, { root: fixture.root });
    assert.equal(analysis.coverage.expected, 508);
    assert.equal(analysis.coverage.actual, 508);
    assert.deepEqual(analysis.coverage.missingKeys, []);
    assert.deepEqual(analysis.coverage.extraKeys, []);
    assert.equal(analysis.integrityStatus, 'valid');
    assert.equal(analysis.performanceStatus, 'no-confirmed-effect');
    const bytes = canonicalAnalysisBytes(analysis);
    assert.equal(bytes.at(-1), 0x0a);
    assert.deepEqual(JSON.parse(bytes), analysis);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('manifest requires unique sequences and four distinct raw files', () => {
  const duplicateSequence = fullFixture();
  try {
    duplicateSequence.manifest.sequences.push(
      duplicateSequence.manifest.sequences[0],
    );
    assert.throws(
      () => analyzeAbbaManifest(duplicateSequence.manifest, {
        root: duplicateSequence.root,
      }),
      /sequence IDs must be unique/,
    );
  } finally {
    fs.rmSync(duplicateSequence.root, { recursive: true, force: true });
  }

  const duplicateFile = fullFixture();
  try {
    const sequence = duplicateFile.manifest.sequences[0];
    sequence.legs.B1 = {
      ...sequence.legs.A1,
      runLabel: sequence.legs.B1.runLabel,
    };
    assert.throws(
      () => analyzeAbbaManifest(duplicateFile.manifest, {
        root: duplicateFile.root,
      }),
      /four distinct raw files/,
    );
  } finally {
    fs.rmSync(duplicateFile.root, { recursive: true, force: true });
  }
});

test('missing, extra, hash, label, time, cohort, receipt, and DNF errors block integrity', () => {
  const fixture = fullFixture();
  try {
    const firstSequence = fixture.manifest.sequences[0];
    const firstDescriptor = firstSequence.legs.A1;
    const firstFile = path.join(fixture.root, firstDescriptor.path);
    const original = fs.readFileSync(firstFile);

    fs.appendFileSync(firstFile, 'tamper');
    assert.throws(
      () => analyzeAbbaManifest(fixture.manifest, { root: fixture.root }),
      /sha256 mismatch/,
    );
    fs.writeFileSync(firstFile, original);

    firstDescriptor.runLabel = 'wrong';
    assert.throws(
      () => analyzeAbbaManifest(fixture.manifest, { root: fixture.root }),
      /run label mismatch/,
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('missing and extra expected keys remain integrity failures, not performance conclusions', () => {
  const missing = fullFixture();
  try {
    for (const leg of LEGS) {
      mutateLeg(missing, 0, leg, (run) => {
        run.records.pop();
      });
    }
    const analysis = analyzeAbbaManifest(missing.manifest, { root: missing.root });
    assert.equal(analysis.integrityStatus, 'invalid');
    assert.equal(analysis.performanceStatus, 'not-evaluated');
    assert.equal(analysis.coverage.missingKeys.length, 1);
  } finally {
    fs.rmSync(missing.root, { recursive: true, force: true });
  }

  const extra = fullFixture();
  try {
    for (const leg of LEGS) {
      mutateLeg(extra, 0, leg, (run) => {
        run.records.push({
          ...run.records[0],
          workload: 'unexpected-workload',
        });
      });
    }
    const analysis = analyzeAbbaManifest(extra.manifest, { root: extra.root });
    assert.equal(analysis.integrityStatus, 'invalid');
    assert.equal(analysis.coverage.extraKeys.length, 1);
  } finally {
    fs.rmSync(extra.root, { recursive: true, force: true });
  }
});

test('attempt DNF, mismatched attempt counts, and legacy raw block formal analysis', () => {
  const dnf = fullFixture();
  try {
    for (const leg of LEGS) {
      mutateLeg(dnf, 0, leg, (run) => {
        const record = run.records.find(({ metric }) => metric === 'latency');
        record.attempts[1] = {
          index: 1,
          value: null,
          dnf: true,
          errorKind: 'timeout',
        };
      });
    }
    const analysis = analyzeAbbaManifest(dnf.manifest, { root: dnf.root });
    assert.equal(analysis.integrityStatus, 'invalid');
    assert.ok(analysis.coverage.dnfKeys.length >= 1);
  } finally {
    fs.rmSync(dnf.root, { recursive: true, force: true });
  }

  const mismatch = fullFixture();
  try {
    mutateLeg(mismatch, 0, 'B1', (run) => {
      run.records.find(({ metric }) => metric === 'latency').attempts.pop();
    });
    assert.throws(
      () => analyzeAbbaManifest(mismatch.manifest, { root: mismatch.root }),
      /attempts do not match resolved matrix/,
    );
  } finally {
    fs.rmSync(mismatch.root, { recursive: true, force: true });
  }

  const legacy = fullFixture();
  try {
    mutateLeg(legacy, 0, 'A1', (run) => {
      delete run.meta.campaign;
      delete run.meta.resolvedMatrix;
      delete run.meta.runLabel;
      delete run.meta.startedAt;
      delete run.meta.finishedAt;
    });
    assert.throws(
      () => analyzeAbbaManifest(legacy.manifest, { root: legacy.root }),
      /lacks campaign-v1 metadata/,
    );
  } finally {
    fs.rmSync(legacy.root, { recursive: true, force: true });
  }
});

test('cohort, receipt, and strict time mismatches are rejected', () => {
  for (const [name, leg, mutate, expected] of [
    ['cohort', 'B1', (run) => { run.meta.browser.version = '2'; }, /cohort mismatch/],
    [
      'receipt',
      'A2',
      (run) => {
        const entry = Object.keys(run.meta.entryArtifacts)[0];
        run.meta.entryArtifacts[entry].receiptSha256 = 'different';
      },
      /receipt mismatch/,
    ],
    [
      'time',
      'B1',
      (run) => {
        run.meta.startedAt = '2026-08-15T00:00:00.000Z';
        run.meta.finishedAt = '2026-08-15T00:00:01.000Z';
        run.meta.generatedAt = run.meta.finishedAt;
      },
      /strict A1\/B1\/B2\/A2 time order/,
    ],
  ]) {
    const fixture = fullFixture();
    try {
      mutateLeg(fixture, 0, leg, mutate);
      assert.throws(
        () => analyzeAbbaManifest(fixture.manifest, { root: fixture.root }),
        expected,
        name,
      );
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test('Native cohort comparison excludes receipt and clock calibration but rejects runtime drift', () => {
  const fixture = fullFixture();
  try {
    const sequenceIndex = fixture.manifest.sequences.findIndex(({ id }) =>
      id === 'vapor-native-table');
    for (const [index, leg] of LEGS.entries()) {
      mutateLeg(fixture, sequenceIndex, leg, (run) => {
        run.meta.machine.appApkSha256 = 'a'.repeat(64);
        run.meta.machine.physicalDeviceId = 'device';
        run.meta.machine.deviceClockOffsetMs = index;
        run.meta.machine.deviceClockCalibrationRttMs = index + 1;
        run.meta.nativeCohort = {
          schemaVersion: 1,
          environment: NATIVE_ENVIRONMENT,
          machine: run.meta.machine,
          adapterFingerprint: 'adapter',
          artifactFingerprint: `artifact-${leg}`,
          benchmarkFingerprint: 'benchmark',
          fingerprint: `aggregate-${leg}`,
        };
      });
    }
    assert.doesNotThrow(
      () => analyzeAbbaManifest(fixture.manifest, { root: fixture.root }),
    );

    mutateLeg(fixture, sequenceIndex, 'B1', (run) => {
      run.meta.nativeCohort.adapterFingerprint = 'different';
    });
    assert.throws(
      () => analyzeAbbaManifest(fixture.manifest, { root: fixture.root }),
      /cohort mismatch/,
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('bundle drift and heap 4/5 boundary fail closed', () => {
  const bundle = fullFixture();
  try {
    mutateLeg(bundle, 0, 'A2', (run) => {
      const record = run.records.find(({ suite }) => suite === 'bundle');
      record.value += 1;
    });
    assert.throws(
      () => analyzeAbbaManifest(bundle.manifest, { root: bundle.root }),
      /bundle duplicate drift/,
    );
  } finally {
    fs.rmSync(bundle.root, { recursive: true, force: true });
  }

  const heap = fullFixture();
  try {
    heap.manifest.sequences = heap.manifest.sequences.filter((sequence) =>
      !sequence.id.endsWith('heap-2'));
    assert.throws(
      () => analyzeAbbaManifest(heap.manifest, { root: heap.root }),
      /heap requires at least five observations per arm/,
    );
  } finally {
    fs.rmSync(heap.root, { recursive: true, force: true });
  }
});

test('50k bootstrap is deterministic and invariant to input order', () => {
  const input = {
    a1: [1, 2, 3, 5],
    b1: [2, 3, 4, 7],
    b2: [2.2, 3.1, 4.4, 7.2],
    a2: [1.1, 2.1, 3.2, 5.1],
    comparisonId: 'comparison',
    canonicalKey: 'key',
  };
  const first = pairedAbbaStatistics(input);
  const second = pairedAbbaStatistics({
    ...input,
    a1: [...input.a1].reverse(),
    b1: [...input.b1].reverse(),
    b2: [...input.b2].reverse(),
    a2: [...input.a2].reverse(),
  });
  assert.equal(BOOTSTRAP_REPLICATES, 50000);
  assert.deepEqual(first, second);
  assert.deepEqual(first.ci95, [1.4001578931422987, 1.7368776097749126]);
});

test('forward/reverse stratum swap leaves ratio and CI unchanged', () => {
  const input = {
    a1: [1, 2, 3, 5],
    b1: [2, 3, 4, 7],
    b2: [2.2, 3.1, 4.4, 7.2],
    a2: [1.1, 2.1, 3.2, 5.1],
    comparisonId: 'comparison',
    canonicalKey: 'key',
  };
  const first = pairedAbbaStatistics(input);
  const swapped = pairedAbbaStatistics({
    ...input,
    a1: input.a2,
    b1: input.b2,
    b2: input.b1,
    a2: input.a1,
  });
  assert.equal(first.ratio, swapped.ratio);
  assert.deepEqual(first.ci95, swapped.ci95);
});

test('R7 quantiles and zero semantics are explicit', () => {
  assert.equal(quantileR7([1, 2, 3, 4], 0.5), 2.5);
  const neutral = pairedAbbaStatistics({
    a1: [0],
    b1: [0],
    b2: [0],
    a2: [0],
    comparisonId: 'zero',
    canonicalKey: 'neutral',
  });
  assert.equal(neutral.ratio, 1);
  const regression = pairedAbbaStatistics({
    a1: [0],
    b1: [1],
    b2: [1],
    a2: [0],
    comparisonId: 'zero',
    canonicalKey: 'regression',
  });
  assert.equal(regression.ratio, 'infinite-regression');
});

test('practical thresholds and bundle exact threshold use required boundaries', () => {
  assert.equal(practicalThreshold({
    suite: 'table',
    metric: 'latency',
  }), 0.03);
  assert.equal(practicalThreshold({
    suite: 'table',
    metric: 'btsCpu',
  }), 0.05);
  assert.equal(confirmedEffect({
    ratio: 1.03,
    ci95: [1.01, 1.05],
    sameDirection: true,
  }, 0.03), true);
  assert.equal(confirmedEffect({
    ratio: 1.03,
    ci95: [0.99, 1.05],
    sameDirection: true,
  }, 0.03), false);
});
