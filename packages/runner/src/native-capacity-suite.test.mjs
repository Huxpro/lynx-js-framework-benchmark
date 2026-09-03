import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildNativeMatrixContract } from './native-coverage.mjs';
import {
  NATIVE_CAPACITY_DEFAULT_SCALES,
  NATIVE_CAPACITY_ENTRY_ID,
  NATIVE_CAPACITY_THRESHOLD_SCALES,
  resolveNativeCapacitySuite,
  runNativeCapacitySuite,
} from './native-capacity-suite.mjs';
import {
  assertNativeCapacityInputsUnchanged,
  snapshotNativeCapacityInputs,
} from './native-inputs.mjs';
import { NATIVE_CAPACITY_POLICY } from './native-protocol.mjs';
import { stringifyResult } from './result-json.mjs';
import {
  DEFAULT_MIN_ACCEPTED_SAMPLES,
  NATIVE_CAPACITY_OUTCOME_PROTOCOL,
  REPORTABILITY_PROTOCOL,
} from '../../shared/src/native-diagnostic-contract.mjs';

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CAPACITY_FIXTURE_PROTOCOL = 'lynx-native-capacity-fixture-v1';
const CAPACITY_BUILD_PROTOCOL = 'octane-native-diagnostic-build-v3';
const ALL_CAPACITY_SCALES = [1000, 6000, 7000, 7500, 8000, 10000];

function capacityArtifacts(make = (rows) => ({
  bundle: `dist/capacity/rows-${rows}/main.lynx.bundle`,
  sha256: '1'.repeat(64),
})) {
  return Object.fromEntries(ALL_CAPACITY_SCALES.map((rows) => [String(rows), make(rows)]));
}

function diagnosticEntry(overrides = {}) {
  return {
    id: NATIVE_CAPACITY_ENTRY_ID,
    tier: 'lab',
    harnesses: ['native'],
    bundles: { lynx: 'dist/table/main.lynx.bundle' },
    provenance: {
      source: 'https://github.com/octanejs/octane',
      ref: 'a'.repeat(40),
      commit: 'a'.repeat(40),
      buildReceipt: {
        protocol: CAPACITY_BUILD_PROTOCOL,
        sourceCommit: 'a'.repeat(40),
        artifacts: {
          table: {
            path: 'benchmarks/lynx-table/app/dist/main.lynx.bundle',
            sha256: '1'.repeat(64),
          },
          capacity: capacityArtifacts((rows) => ({
            path: `benchmarks/lynx-table/app/dist-rows${rows}/main.lynx.bundle`,
            sha256: '1'.repeat(64),
          })),
          list: {
            1000: {
              path: 'benchmarks/lynx-list/app/dist/rows-1000/main.lynx.bundle',
              sha256: '1'.repeat(64),
            },
            10000: {
              path: 'benchmarks/lynx-list/app/dist/rows-10000/main.lynx.bundle',
              sha256: '1'.repeat(64),
            },
          },
        },
      },
      sha256: {
        'table/main.lynx.bundle': '1'.repeat(64),
        ...Object.fromEntries(ALL_CAPACITY_SCALES.map((rows) => [
          `capacity/rows-${rows}/main.lynx.bundle`,
          '1'.repeat(64),
        ])),
        'list/rows-1000/main.lynx.bundle': '1'.repeat(64),
        'list/rows-10000/main.lynx.bundle': '1'.repeat(64),
      },
    },
    capacityFixture: {
      protocol: CAPACITY_FIXTURE_PROTOCOL,
      fixtureRole: 'eager-capacity-probe',
      topology: { elementsPerRow: 7, chromeElements: 42 },
      scales: capacityArtifacts(),
    },
    ...overrides,
  };
}

function executionFixture(scales) {
  const entry = diagnosticEntry({ dir: '/fixture' });
  const bundles = {};
  for (const scale of ALL_CAPACITY_SCALES) {
    const bundleBytes = Buffer.from(`fixture-${scale}`);
    const bundleSha256 = sha256(bundleBytes);
    entry.capacityFixture.scales[String(scale)].sha256 = bundleSha256;
    entry.provenance.sha256[`capacity/rows-${scale}/main.lynx.bundle`] = bundleSha256;
    entry.provenance.buildReceipt.artifacts.capacity[String(scale)].sha256 = bundleSha256;
    if (scales.includes(scale)) {
      const relativePath = entry.capacityFixture.scales[String(scale)].bundle;
      bundles[String(scale)] = {
        bundlePath: path.join(entry.dir, relativePath),
        bundleBytes,
        relativePath,
        sha256: bundleSha256,
      };
    }
  }
  return { entry, bundles };
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-capacity-suite-'));
  const runner = path.join(root, 'packages/runner/src');
  fs.mkdirSync(runner, { recursive: true });
  for (const relative of [
    'android-art-capacity.mjs', 'cli.mjs', 'connector-receipt.mjs', 'harness-native.mjs', 'native-capacity-suite.mjs',
    'native-inputs.mjs', 'native-protocol.mjs', 'run-matrix.mjs',
  ]) fs.writeFileSync(path.join(runner, relative), `source:${relative}`);
  const shared = path.join(root, 'packages/shared/src');
  fs.mkdirSync(shared, { recursive: true });
  for (const relative of [
    'list-workloads.mjs', 'native-diagnostic-contract.mjs', 'schema.mjs', 'stats.mjs',
  ]) {
    fs.writeFileSync(path.join(shared, relative), `source:${relative}`);
  }
  const adapterPath = path.join(root, 'adapter.mjs');
  fs.writeFileSync(adapterPath, 'adapter');
  const preflightPath = path.join(root, 'devtool-disabled.lynx.bundle');
  fs.writeFileSync(preflightPath, 'bundle __OCTANE_DEVTOOL_DISABLED__=true');
  const entryDir = path.join(root, `entries/${NATIVE_CAPACITY_ENTRY_ID}`);
  const distDir = path.join(entryDir, 'dist');
  fs.mkdirSync(path.join(distDir, 'table'), { recursive: true });
  fs.writeFileSync(path.join(distDir, 'table/main.lynx.bundle'), 'empty-table-fixture');
  const entry = diagnosticEntry();
  entry.dir = entryDir;
  entry.distDir = distDir;
  const tableSha = sha256('empty-table-fixture');
  entry.provenance.sha256['table/main.lynx.bundle'] = tableSha;
  entry.provenance.buildReceipt.artifacts.table.sha256 = tableSha;
  const bundlePaths = {};
  for (const rows of ALL_CAPACITY_SCALES) {
    const bundle = Buffer.from(`lynx-native-startup-v1 eager-capacity-${rows}`);
    const bundlePath = path.join(distDir, `capacity/rows-${rows}/main.lynx.bundle`);
    fs.mkdirSync(path.dirname(bundlePath), { recursive: true });
    fs.writeFileSync(bundlePath, bundle);
    const bundleSha = sha256(bundle);
    entry.capacityFixture.scales[String(rows)].sha256 = bundleSha;
    entry.provenance.sha256[`capacity/rows-${rows}/main.lynx.bundle`] = bundleSha;
    entry.provenance.buildReceipt.artifacts.capacity[String(rows)].sha256 = bundleSha;
    bundlePaths[rows] = bundlePath;
  }
  const { sha256: _priorReceipt, ...receiptPayload } = entry.provenance.buildReceipt;
  entry.provenance.buildReceipt.sha256 = sha256(JSON.stringify(receiptPayload));
  fs.writeFileSync(path.join(entryDir, 'entry.json'), JSON.stringify(entry));
  return { root, runner, shared, adapterPath, preflightPath, bundlePaths, entry };
}

test('capacity suite is opt-in and defaults to the exact diagnostic entry and 1k/10k', () => {
  const entry = diagnosticEntry();
  assert.equal(resolveNativeCapacitySuite({ entries: [entry] }), null);
  const suite = resolveNativeCapacitySuite({ requested: true, entries: [entry] });
  assert.equal(suite.entry.id, NATIVE_CAPACITY_ENTRY_ID);
  assert.deepEqual(suite.scales, NATIVE_CAPACITY_DEFAULT_SCALES);
  assert.equal(suite.cells.every((cell) => cell.diagnostic && !cell.rankingEligible), true);
  assert.deepEqual(
    suite.cells.map((cell) => [cell.scale, cell.artifact]),
    NATIVE_CAPACITY_DEFAULT_SCALES.map((scale) => [
      scale,
      entry.capacityFixture.scales[String(scale)],
    ]),
  );
  assert.throws(
    () => resolveNativeCapacitySuite({ includeThresholds: true, entries: [entry] }),
    /requires --native-capacity/,
  );
  assert.throws(
    () => resolveNativeCapacitySuite({ requested: true, entries: [entry], scale: '1000' }),
    /cannot be combined with --scale/,
  );
});

test('CLI routes capacity explicitly and rejects ranked-matrix argument ambiguity', () => {
  const cli = path.join(ROOT, 'packages/runner/src/cli.mjs');
  const run = (...args) => spawnSync(process.execPath, [cli, 'run', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const missingEntry = run('--harness', 'native', '--native-capacity');
  assert.equal(missingEntry.status, 1);
  assert.match(missingEntry.stderr, /requires --entry octane-native-diagnostic/);

  const ambiguousScale = run(
    '--harness', 'native',
    '--native-capacity',
    '--entry', NATIVE_CAPACITY_ENTRY_ID,
    '--scale', '1000',
  );
  assert.equal(ambiguousScale.status, 1);
  assert.match(ambiguousScale.stderr, /cannot be combined with --scale/);

  const web = run('--harness', 'web', '--native-capacity', '--entry', NATIVE_CAPACITY_ENTRY_ID);
  assert.equal(web.status, 1);
  assert.match(web.stderr, /requires --harness native/);
});

test('threshold probes add only 6k/7k/7.5k/8k and remain diagnostic non-ranking cells', () => {
  const suite = resolveNativeCapacitySuite({
    requested: true,
    includeThresholds: true,
    entries: [diagnosticEntry()],
  });
  assert.deepEqual(
    suite.scales,
    [...NATIVE_CAPACITY_DEFAULT_SCALES, ...NATIVE_CAPACITY_THRESHOLD_SCALES]
      .sort((a, b) => a - b),
  );
  assert.deepEqual(
    suite.cells.filter((cell) => cell.thresholdProbe).map((cell) => cell.scale),
    NATIVE_CAPACITY_THRESHOLD_SCALES,
  );
  assert.equal(suite.cells.every((cell) => cell.diagnostic && !cell.rankingEligible), true);
});

test('capacity suite rejects any entry, tier, harness, bundle, or build protocol drift', () => {
  const entry = diagnosticEntry();
  for (const changed of [
    { ...entry, id: 'octane' },
    { ...entry, tier: 'featured' },
    { ...entry, harnesses: ['web'] },
    { ...entry, bundles: { lynx: 'dist/rows-0/main.lynx.bundle' } },
    { ...entry, capacityFixture: undefined },
    {
      ...entry,
      capacityFixture: {
        ...entry.capacityFixture,
        scales: capacityArtifacts(() => ({
          bundle: 'dist/table/main.lynx.bundle',
          sha256: '1'.repeat(64),
        })),
      },
    },
    {
      ...entry,
      capacityFixture: {
        ...entry.capacityFixture,
        scales: {
          ...entry.capacityFixture.scales,
          0: { bundle: 'dist/table/main.lynx.bundle', sha256: '1'.repeat(64) },
        },
      },
    },
    {
      ...entry,
      provenance: {
        ...entry.provenance,
        buildReceipt: { ...entry.provenance.buildReceipt, protocol: 'future-build-v2' },
      },
    },
  ]) {
    assert.throws(
      () => resolveNativeCapacitySuite({ requested: true, entries: [changed] }),
      /capacity diagnostic entry/,
    );
  }
});

test('diagnostic entry never expands featured Native eligibility or its ranked matrix', () => {
  const featured = [
    { id: 'react', framework: 'reactlynx' },
    { id: 'vue', framework: 'vue-lynx' },
  ];
  const before = buildNativeMatrixContract(featured);
  const after = buildNativeMatrixContract([...featured, diagnosticEntry()]);
  assert.deepEqual(after, before);
});

test('capacity receipt binds contract, policy, topology, selected bundles, and runner sources', () => {
  const current = fixture();
  try {
    const suite = resolveNativeCapacitySuite({ requested: true, entries: [current.entry] });
    const snapshot = (runtimePolicy = NATIVE_CAPACITY_POLICY) => snapshotNativeCapacityInputs({
      entry: current.entry,
      contract: suite.contract,
      runtimePolicy,
      adapterPath: current.adapterPath,
      preflightPath: current.preflightPath,
      root: current.root,
    });
    const initial = snapshot();
    assert.deepEqual(Object.keys(initial.bundles), ['1000', '10000']);
    assert.equal(
      initial.bundles['1000'].sha256,
      current.entry.capacityFixture.scales['1000'].sha256,
    );
    assert.equal(initial.receipt.sourceCommit, current.entry.provenance.commit);
    assert.equal(initial.preflight.sha256, sha256(fs.readFileSync(current.preflightPath)));
    assert.equal(initial.receipt.preflight.protocol, 'lynx-devtool-disabled-lifecycle-v1');
    assert.deepEqual(initial.receipt.preflight.requiredEvidence, [
      'DevTool disabled. Transitioning to ATTACHED.',
      '__OCTANE_DEVTOOL_DISABLED__=true',
    ]);
    assert.deepEqual(initial.receipt.capacityFixture, {
      protocol: CAPACITY_FIXTURE_PROTOCOL,
      fixtureRole: 'eager-capacity-probe',
      topology: { elementsPerRow: 7, chromeElements: 42 },
      scales: {
        1000: {
          ...current.entry.capacityFixture.scales['1000'],
          bytes: fs.statSync(current.bundlePaths[1000]).size,
          startupProtocol: 'lynx-native-startup-v1',
        },
        10000: {
          ...current.entry.capacityFixture.scales['10000'],
          bytes: fs.statSync(current.bundlePaths[10000]).size,
          startupProtocol: 'lynx-native-startup-v1',
        },
      },
    });
    assert.doesNotThrow(() => assertNativeCapacityInputsUnchanged(initial));

    const topologyBound = snapshot();
    topologyBound.receipt.capacityFixture.topology.elementsPerRow = 6;
    assert.throws(
      () => assertNativeCapacityInputsUnchanged(topologyBound),
      /input receipt mutated/,
    );
    const pathBound = snapshot();
    pathBound.bundles['1000'].bundlePath = current.bundlePaths[10000];
    assert.throws(
      () => assertNativeCapacityInputsUnchanged(pathBound),
      /1000-row Native capacity bundle mutated/,
    );

    assert.throws(
      () => snapshot({ ...NATIVE_CAPACITY_POLICY, timeoutMs: 180_001 }),
      /dedicated no-CDP policy/,
    );
    const preflightBound = snapshot();
    preflightBound.preflight.bundleBytes = Buffer.from('changed');
    assert.throws(
      () => assertNativeCapacityInputsUnchanged(preflightBound),
      /preflight mutated/,
    );
    const preflightDiskBound = snapshot();
    const preflightOriginal = fs.readFileSync(current.preflightPath);
    fs.appendFileSync(current.preflightPath, 'changed');
    assert.throws(
      () => assertNativeCapacityInputsUnchanged(preflightDiskBound),
      /capacity input changed on disk/,
    );
    fs.writeFileSync(current.preflightPath, preflightOriginal);
    const thresholdSuite = resolveNativeCapacitySuite({
      requested: true,
      includeThresholds: true,
      entries: [current.entry],
    });
    const scalesChanged = snapshotNativeCapacityInputs({
      entry: current.entry,
      contract: thresholdSuite.contract,
      runtimePolicy: NATIVE_CAPACITY_POLICY,
      adapterPath: current.adapterPath,
      preflightPath: current.preflightPath,
      root: current.root,
    });
    assert.notEqual(scalesChanged.receipt.sha256, initial.receipt.sha256);
    assert.deepEqual(
      Object.keys(scalesChanged.receipt.capacityFixture.scales),
      ALL_CAPACITY_SCALES.map(String),
    );

    fs.appendFileSync(path.join(current.runner, 'native-capacity-suite.mjs'), '\nchanged');
    const sourceChanged = snapshot();
    assert.notEqual(sourceChanged.receipt.sha256, initial.receipt.sha256);
    assert.throws(
      () => assertNativeCapacityInputsUnchanged(initial),
      /capacity input changed on disk/,
    );
    fs.writeFileSync(
      path.join(current.runner, 'native-capacity-suite.mjs'),
      'source:native-capacity-suite.mjs',
    );
    const restored = snapshot();
    fs.appendFileSync(path.join(current.shared, 'schema.mjs'), '\nchanged');
    assert.notEqual(snapshot().receipt.sha256, restored.receipt.sha256);
    assert.throws(
      () => assertNativeCapacityInputsUnchanged(restored),
      /capacity input changed on disk/,
    );
  } finally {
    fs.rmSync(current.root, { recursive: true, force: true });
  }
});

test('capacity receipt requires a local disable bundle with its own acknowledgement producer', () => {
  const current = fixture();
  try {
    const suite = resolveNativeCapacitySuite({ requested: true, entries: [current.entry] });
    const snapshot = (preflightPath) => snapshotNativeCapacityInputs({
      entry: current.entry,
      contract: suite.contract,
      runtimePolicy: NATIVE_CAPACITY_POLICY,
      adapterPath: current.adapterPath,
      preflightPath,
      root: current.root,
    });
    assert.throws(() => snapshot(undefined), /require --capacity-disable-file/);
    assert.throws(
      () => snapshot(path.join(current.entry.dir, 'dist/table/main.lynx.bundle')),
      /lacks __OCTANE_DEVTOOL_DISABLED__=true/,
    );
    assert.doesNotThrow(() => snapshot(current.preflightPath));
  } finally {
    fs.rmSync(current.root, { recursive: true, force: true });
  }
});

test('capacity receipt fails closed on source revision and bundle checksum drift', () => {
  const current = fixture();
  try {
    const suite = resolveNativeCapacitySuite({ requested: true, entries: [current.entry] });
    current.entry.provenance.ref = 'b'.repeat(40);
    assert.throws(
      () => snapshotNativeCapacityInputs({
        entry: current.entry,
        contract: suite.contract,
        runtimePolicy: NATIVE_CAPACITY_POLICY,
        adapterPath: current.adapterPath,
        preflightPath: current.preflightPath,
        root: current.root,
      }),
      /source revision/,
    );
    current.entry.provenance.ref = current.entry.provenance.commit;
    current.entry.provenance.sha256['capacity/rows-1000/main.lynx.bundle'] = '0'.repeat(64);
    assert.throws(
      () => snapshotNativeCapacityInputs({
        entry: current.entry,
        contract: suite.contract,
        runtimePolicy: NATIVE_CAPACITY_POLICY,
        adapterPath: current.adapterPath,
        preflightPath: current.preflightPath,
        root: current.root,
      }),
      /bundle checksum/,
    );
  } finally {
    fs.rmSync(current.root, { recursive: true, force: true });
  }
});

test('capacity receipt rejects a checksum-valid bundle with the wrong fixture protocol', () => {
  const current = fixture();
  try {
    const suite = resolveNativeCapacitySuite({ requested: true, entries: [current.entry] });
    const wrongBundle = Buffer.from('future-native-receipt-v2');
    const wrongSha = sha256(wrongBundle);
    fs.writeFileSync(current.bundlePaths[1000], wrongBundle);
    current.entry.capacityFixture.scales['1000'].sha256 = wrongSha;
    current.entry.provenance.sha256['capacity/rows-1000/main.lynx.bundle'] = wrongSha;
    current.entry.provenance.buildReceipt.artifacts.capacity['1000'].sha256 = wrongSha;
    const { sha256: _receiptSha256, ...receiptPayload } = current.entry.provenance.buildReceipt;
    current.entry.provenance.buildReceipt.sha256 = sha256(JSON.stringify(receiptPayload));
    fs.writeFileSync(path.join(current.entry.dir, 'entry.json'), JSON.stringify(current.entry));
    assert.throws(
      () => snapshotNativeCapacityInputs({
        entry: current.entry,
        contract: suite.contract,
        runtimePolicy: NATIVE_CAPACITY_POLICY,
        adapterPath: current.adapterPath,
        preflightPath: current.preflightPath,
        root: current.root,
      }),
      /lacks lynx-native-startup-v1/,
    );
  } finally {
    fs.rmSync(current.root, { recursive: true, force: true });
  }
});

test('capacity receipt changes for any coherently updated selected capacity bundle', () => {
  const current = fixture();
  try {
    const suite = resolveNativeCapacitySuite({ requested: true, entries: [current.entry] });
    const snapshot = () => snapshotNativeCapacityInputs({
      entry: current.entry,
      contract: suite.contract,
      runtimePolicy: NATIVE_CAPACITY_POLICY,
      adapterPath: current.adapterPath,
      preflightPath: current.preflightPath,
      root: current.root,
    });
    const initial = snapshot();
    const changedBundle = Buffer.from('lynx-native-startup-v1 capacity-fixture-changed');
    const changedSha = sha256(changedBundle);
    fs.writeFileSync(current.bundlePaths[1000], changedBundle);
    current.entry.capacityFixture.scales['1000'].sha256 = changedSha;
    current.entry.provenance.sha256['capacity/rows-1000/main.lynx.bundle'] = changedSha;
    current.entry.provenance.buildReceipt.artifacts.capacity['1000'].sha256 = changedSha;
    const { sha256: _receiptSha256, ...receiptPayload } = current.entry.provenance.buildReceipt;
    current.entry.provenance.buildReceipt.sha256 = sha256(JSON.stringify(receiptPayload));
    fs.writeFileSync(path.join(current.entry.dir, 'entry.json'), JSON.stringify(current.entry));
    const changed = snapshot();
    assert.notEqual(changed.receipt.sha256, initial.receipt.sha256);
    assert.equal(changed.receipt.capacityFixture.scales['1000'].sha256, changedSha);
  } finally {
    fs.rmSync(current.root, { recursive: true, force: true });
  }
});

test('capacity execution requires the dedicated adapter hook and retains zero-sample DNF', async () => {
  const entry = diagnosticEntry();
  const suite = resolveNativeCapacitySuite({ requested: true, entries: [entry], reps: 1 });
  await assert.rejects(
    () => runNativeCapacitySuite({
      adapter: { environment: 'android' }, entry, contract: suite.contract, bundles: {},
    }),
    /runCapacityProbe/,
  );
  const observedBundles = [];
  const execution = executionFixture(suite.contract.scales);
  const records = await runNativeCapacitySuite({
    adapter: {
      environment: 'android',
      async runCapacityProbe(_entry, probe) {
        observedBundles.push(probe);
        return {
          dnf: true,
          failure: { category: probe.scale === 10_000 ? 'capacity/test' : 'timeout' },
        };
      },
    },
    entry: execution.entry,
    contract: suite.contract,
    bundles: execution.bundles,
  });
  assert.deepEqual(
    observedBundles.map(({ scale, bundlePath, bundleSha256 }) => ({
      scale,
      bundlePath,
      bundleSha256,
    })),
    suite.contract.scales.map((scale) => ({
      scale,
      bundlePath: execution.bundles[String(scale)].bundlePath,
      bundleSha256: execution.bundles[String(scale)].sha256,
    })),
  );
  assert.equal(records.length, 2);
  for (const record of records) {
    assert.deepEqual(record.samples, []);
    assert.equal(record.n, 0);
    assert.equal(record.median, null);
    assert.equal(record.attemptedCount, 1);
    assert.equal(record.acceptedCount, 0);
    assert.equal(record.dnfCount, 1);
    assert.equal(record.rankingEligible, false);
    assert.equal(record.diagnostic, true);
    assert.equal(record.outcomeProtocol, NATIVE_CAPACITY_OUTCOME_PROTOCOL);
    assert.deepEqual(record.reportability, {
      protocol: REPORTABILITY_PROTOCOL,
      minAcceptedSamples: DEFAULT_MIN_ACCEPTED_SAMPLES,
    });
  }
});

test('five ART capacity aborts remain five DNF outcomes with no timing aggregate', async () => {
  const entry = diagnosticEntry();
  const suite = resolveNativeCapacitySuite({ requested: true, entries: [entry], reps: 5 });
  const execution = executionFixture(suite.contract.scales);
  const records = await runNativeCapacitySuite({
    adapter: {
      environment: 'android-capacity-test',
      async runCapacityProbe(_entry, probe) {
        return {
          dnf: true,
          failure: {
            category: 'capacity/android-art-global-ref-table',
            loadToCrashMs: 21_000 + probe.rep,
          },
        };
      },
    },
    entry: execution.entry,
    contract: suite.contract,
    bundles: execution.bundles,
  });
  for (const record of records) {
    assert.equal(record.attemptedCount, 5);
    assert.equal(record.acceptedCount, 0);
    assert.equal(record.dnfCount, 5);
    assert.deepEqual(record.samples, []);
    assert.equal(record.n, 0);
    assert.equal(record.median, null);
    assert.equal(record.failures.every((failure) =>
      failure.category === 'capacity/android-art-global-ref-table'), true);
    assert.equal(record.failures.every((failure) =>
      Number.isFinite(failure.loadToCrashMs)), true);
    assert.equal(record.diagnosticOutcomes.every((outcome) =>
      outcome.failure.category === 'capacity/android-art-global-ref-table'
      && !Object.hasOwn(outcome.failure, 'loadToCrashMs')), true);
  }
});

test('successful threshold outcomes retain evidence without creating timing samples', async () => {
  const entry = diagnosticEntry();
  const suite = resolveNativeCapacitySuite({
    requested: true,
    includeThresholds: true,
    entries: [entry],
    reps: 1,
  });
  const execution = executionFixture(suite.contract.scales);
  const records = await runNativeCapacitySuite({
    adapter: {
      environment: 'android',
      async runCapacityProbe() {
        return { latencyMs: 12, detail: { receipt: 'valid' } };
      },
    },
    entry: execution.entry,
    contract: suite.contract,
    bundles: execution.bundles,
  });
  const defaults = records.filter((record) => !record.thresholdProbe);
  const thresholds = records.filter((record) => record.thresholdProbe);
  assert.equal(defaults.every((record) => record.samples.length === 1), true);
  assert.equal(thresholds.length, 4);
  assert.equal(thresholds.every((record) => record.samples.length === 0), true);
  assert.equal(thresholds.every((record) => record.acceptedCount === 0), true);
  assert.equal(
    thresholds.every((record) => record.diagnosticOutcomes[0].outcome === 'completed'),
    true,
  );
  assert.equal(
    records.every((record) => !Object.hasOwn(record.diagnosticOutcomes[0], 'detail')),
    true,
  );
  assert.deepEqual(defaults[0].detailSamples, [{ receipt: 'valid' }]);

  const persisted = JSON.parse(stringifyResult({ records })).records;
  const persistedThresholds = persisted.filter((record) => record.thresholdProbe);
  for (const record of persistedThresholds) {
    assert.deepEqual(record.outcomeCounts, {
      attempted: 1,
      accepted: 0,
      dnf: 0,
      notMeasured: 0,
      byReason: {},
      outcomeOnlyCompleted: 1,
    });
    assert.equal(record.reportability.status, 'not-reportable');
    assert.equal(record.n, 0);
    assert.deepEqual(record.samples, []);
    for (const field of ['median', 'mean', 'std', 'min', 'max', 'p95', 'ci95']) {
      assert.equal(record[field], null, field);
    }
  }
});
