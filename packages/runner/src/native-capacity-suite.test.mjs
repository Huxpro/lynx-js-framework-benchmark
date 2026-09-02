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

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

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
        protocol: 'octane-native-diagnostic-build-v1',
        sourceCommit: 'a'.repeat(40),
        artifacts: {
          table: {
            path: 'benchmarks/lynx-table/app/dist/main.lynx.bundle',
            sha256: null,
          },
        },
      },
      sha256: { 'table/main.lynx.bundle': null },
    },
    ...overrides,
  };
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-capacity-suite-'));
  const runner = path.join(root, 'packages/runner/src');
  fs.mkdirSync(runner, { recursive: true });
  for (const relative of [
    'cli.mjs', 'connector-receipt.mjs', 'harness-native.mjs', 'native-capacity-suite.mjs',
    'native-inputs.mjs', 'native-protocol.mjs', 'run-matrix.mjs',
  ]) fs.writeFileSync(path.join(runner, relative), `source:${relative}`);
  const shared = path.join(root, 'packages/shared/src');
  fs.mkdirSync(shared, { recursive: true });
  for (const relative of ['schema.mjs', 'stats.mjs']) {
    fs.writeFileSync(path.join(shared, relative), `source:${relative}`);
  }
  const adapterPath = path.join(root, 'adapter.mjs');
  fs.writeFileSync(adapterPath, 'adapter');
  const entryDir = path.join(root, `entries/${NATIVE_CAPACITY_ENTRY_ID}`);
  const distDir = path.join(entryDir, 'dist');
  fs.mkdirSync(path.join(distDir, 'table'), { recursive: true });
  const bundle = Buffer.from('lynx-native-startup-v1 capacity-fixture');
  const bundlePath = path.join(distDir, 'table/main.lynx.bundle');
  fs.writeFileSync(bundlePath, bundle);
  const bundleSha = sha256(bundle);
  const entry = diagnosticEntry();
  entry.dir = entryDir;
  entry.distDir = distDir;
  entry.provenance.sha256['table/main.lynx.bundle'] = bundleSha;
  entry.provenance.buildReceipt.artifacts.table.sha256 = bundleSha;
  entry.provenance.buildReceipt.sha256 = sha256(JSON.stringify(entry.provenance.buildReceipt));
  fs.writeFileSync(path.join(entryDir, 'entry.json'), JSON.stringify(entry));
  return { root, runner, shared, adapterPath, bundlePath, entry };
}

test('capacity suite is opt-in and defaults to the exact diagnostic entry and 1k/10k', () => {
  const entry = diagnosticEntry();
  assert.equal(resolveNativeCapacitySuite({ entries: [entry] }), null);
  const suite = resolveNativeCapacitySuite({ requested: true, entries: [entry] });
  assert.equal(suite.entry.id, NATIVE_CAPACITY_ENTRY_ID);
  assert.deepEqual(suite.scales, NATIVE_CAPACITY_DEFAULT_SCALES);
  assert.equal(suite.cells.every((cell) => cell.diagnostic && !cell.rankingEligible), true);
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

test('capacity receipt binds contract, policy, source revision, bundle, and runner sources', () => {
  const current = fixture();
  try {
    const suite = resolveNativeCapacitySuite({ requested: true, entries: [current.entry] });
    const snapshot = (runtimePolicy = { timeoutMs: 180_000 }) => snapshotNativeCapacityInputs({
      entry: current.entry,
      contract: suite.contract,
      runtimePolicy,
      adapterPath: current.adapterPath,
      root: current.root,
    });
    const initial = snapshot();
    assert.equal(initial.bundle.sha256, current.entry.provenance.sha256['table/main.lynx.bundle']);
    assert.equal(initial.receipt.sourceCommit, current.entry.provenance.commit);
    assert.doesNotThrow(() => assertNativeCapacityInputsUnchanged(initial));

    const policyChanged = snapshot({ timeoutMs: 180_001 });
    assert.notEqual(policyChanged.receipt.sha256, initial.receipt.sha256);
    const thresholdSuite = resolveNativeCapacitySuite({
      requested: true,
      includeThresholds: true,
      entries: [current.entry],
    });
    const scalesChanged = snapshotNativeCapacityInputs({
      entry: current.entry,
      contract: thresholdSuite.contract,
      runtimePolicy: { timeoutMs: 180_000 },
      adapterPath: current.adapterPath,
      root: current.root,
    });
    assert.notEqual(scalesChanged.receipt.sha256, initial.receipt.sha256);

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

test('capacity receipt fails closed on source revision and bundle checksum drift', () => {
  const current = fixture();
  try {
    const suite = resolveNativeCapacitySuite({ requested: true, entries: [current.entry] });
    current.entry.provenance.ref = 'b'.repeat(40);
    assert.throws(
      () => snapshotNativeCapacityInputs({
        entry: current.entry,
        contract: suite.contract,
        runtimePolicy: {},
        adapterPath: current.adapterPath,
        root: current.root,
      }),
      /source revision/,
    );
    current.entry.provenance.ref = current.entry.provenance.commit;
    current.entry.provenance.sha256['table/main.lynx.bundle'] = '0'.repeat(64);
    assert.throws(
      () => snapshotNativeCapacityInputs({
        entry: current.entry,
        contract: suite.contract,
        runtimePolicy: {},
        adapterPath: current.adapterPath,
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
    fs.writeFileSync(current.bundlePath, wrongBundle);
    current.entry.provenance.sha256['table/main.lynx.bundle'] = wrongSha;
    current.entry.provenance.buildReceipt.artifacts.table.sha256 = wrongSha;
    const { sha256: _receiptSha256, ...receiptPayload } = current.entry.provenance.buildReceipt;
    current.entry.provenance.buildReceipt.sha256 = sha256(JSON.stringify(receiptPayload));
    fs.writeFileSync(path.join(current.entry.dir, 'entry.json'), JSON.stringify(current.entry));
    assert.throws(
      () => snapshotNativeCapacityInputs({
        entry: current.entry,
        contract: suite.contract,
        runtimePolicy: {},
        adapterPath: current.adapterPath,
        root: current.root,
      }),
      /lacks lynx-native-startup-v1/,
    );
  } finally {
    fs.rmSync(current.root, { recursive: true, force: true });
  }
});

test('capacity receipt changes for a coherently updated table bundle', () => {
  const current = fixture();
  try {
    const suite = resolveNativeCapacitySuite({ requested: true, entries: [current.entry] });
    const snapshot = () => snapshotNativeCapacityInputs({
      entry: current.entry,
      contract: suite.contract,
      runtimePolicy: {},
      adapterPath: current.adapterPath,
      root: current.root,
    });
    const initial = snapshot();
    const changedBundle = Buffer.from('lynx-native-startup-v1 capacity-fixture-changed');
    const changedSha = sha256(changedBundle);
    fs.writeFileSync(current.bundlePath, changedBundle);
    current.entry.provenance.sha256['table/main.lynx.bundle'] = changedSha;
    current.entry.provenance.buildReceipt.artifacts.table.sha256 = changedSha;
    const { sha256: _receiptSha256, ...receiptPayload } = current.entry.provenance.buildReceipt;
    current.entry.provenance.buildReceipt.sha256 = sha256(JSON.stringify(receiptPayload));
    fs.writeFileSync(path.join(current.entry.dir, 'entry.json'), JSON.stringify(current.entry));
    const changed = snapshot();
    assert.notEqual(changed.receipt.sha256, initial.receipt.sha256);
    assert.equal(changed.receipt.bundle.sha256, changedSha);
  } finally {
    fs.rmSync(current.root, { recursive: true, force: true });
  }
});

test('capacity execution requires the dedicated adapter hook and retains zero-sample DNF', async () => {
  const entry = diagnosticEntry();
  const suite = resolveNativeCapacitySuite({ requested: true, entries: [entry], reps: 1 });
  await assert.rejects(
    () => runNativeCapacitySuite({
      adapter: { environment: 'android' }, entry, contract: suite.contract, bundle: {},
    }),
    /runCapacityProbe/,
  );
  const records = await runNativeCapacitySuite({
    adapter: {
      environment: 'android',
      async runCapacityProbe(_entry, { scale }) {
        return {
          dnf: true,
          failure: { category: scale === 10_000 ? 'capacity/test' : 'timeout' },
        };
      },
    },
    entry,
    contract: suite.contract,
    bundle: {
      bundlePath: '/fixture/main.lynx.bundle',
      bundleBytes: Buffer.from('fixture'),
      sha256: '1'.repeat(64),
    },
  });
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
  const records = await runNativeCapacitySuite({
    adapter: {
      environment: 'android',
      async runCapacityProbe() {
        return { latencyMs: 12, detail: { receipt: 'valid' } };
      },
    },
    entry,
    contract: suite.contract,
    bundle: {
      bundlePath: '/fixture/main.lynx.bundle',
      bundleBytes: Buffer.from('fixture'),
      sha256: '1'.repeat(64),
    },
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
});
