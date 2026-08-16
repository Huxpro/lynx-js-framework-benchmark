import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { executeNativeRun } from './native-run.mjs';
import {
  materializeNativeBundleSnapshots,
  nativeBundleSnapshotFor,
  pinNativeAdapterGraph,
} from './native-inputs.mjs';
import {
  captureNativeBenchmarkFingerprint,
  createNativeCohort,
  validateNativeMachine,
} from './native-cohort.mjs';

function entry(root, id, rows, bytes) {
  const distDir = path.join(root, id, 'dist');
  for (const row of rows) {
    const directory = path.join(distDir, `rows-${row}`);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'main.lynx.bundle'), bytes);
  }
  return {
    id,
    dir: path.join(root, id),
    distDir,
    bundles: { lynx: 'dist/rows-0/main.lynx.bundle' },
  };
}

const tableBytes = Buffer.from(
  '__NATIVE_BENCH_RESULT__ vue-lynx-native-bench-v1',
);

test('Native bundles are immutable snapshots and startup-only rows need no table marker', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-snapshots-'));
  try {
    const candidate = entry(root, 'vue-vapor-a', [0, 1000], tableBytes);
    fs.writeFileSync(
      path.join(candidate.distDir, 'rows-1000/main.lynx.bundle'),
      'startup-only',
    );
    const materialized = materializeNativeBundleSnapshots({
      entries: [candidate],
      suites: ['table', 'startup'],
      startupScales: [1000],
    });
    const snapshot = nativeBundleSnapshotFor(materialized.snapshots, candidate.id, 0);
    fs.writeFileSync(
      path.join(candidate.distDir, 'rows-0/main.lynx.bundle'),
      'mutated-then-restored',
    );
    assert.deepEqual(snapshot.bundleBytes, tableBytes);
    assert.deepEqual(fs.readFileSync(snapshot.bundlePath), tableBytes);
    materialized.dispose();
    assert.equal(fs.existsSync(snapshot.bundlePath), false);

    const startupOnly = entry(root, 'vue-vapor-startup', [0], Buffer.from('no-marker'));
    assert.doesNotThrow(() => {
      const value = materializeNativeBundleSnapshots({
        entries: [startupOnly],
        suites: ['startup'],
        startupScales: [0],
      });
      value.dispose();
    });
    assert.throws(
      () => materializeNativeBundleSnapshots({
        entries: [startupOnly],
        suites: ['table'],
        startupScales: [],
      }),
      /table bundle lacks __NATIVE_BENCH_RESULT__/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('adapter graph fingerprints relative helpers and rejects unsupported dynamic imports', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-adapter-graph-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
    fs.writeFileSync(
      path.join(root, 'adapter.mjs'),
      "import { value } from './helper.mjs'; export default async () => value;\n",
    );
    fs.writeFileSync(path.join(root, 'helper.mjs'), 'export const value = 1;\n');
    const first = pinNativeAdapterGraph(path.join(root, 'adapter.mjs'));
    fs.writeFileSync(path.join(root, 'helper.mjs'), 'export const value = 2;\n');
    const second = pinNativeAdapterGraph(path.join(root, 'adapter.mjs'));
    assert.notEqual(first.fingerprint, second.fingerprint);
    first.dispose();
    second.dispose();

    fs.mkdirSync(path.join(root, 'adapters'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(
      path.join(root, 'adapters', 'nested.mjs'),
      "import { value } from '../src/helper.mjs'; export default async () => value;\n",
    );
    fs.writeFileSync(path.join(root, 'src', 'helper.mjs'), 'export const value = 3;\n');
    const nested = pinNativeAdapterGraph(path.join(root, 'adapters', 'nested.mjs'));
    assert.equal(
      nested.manifest.modules.some(({ path: modulePath }) =>
        modulePath === path.join(root, 'src', 'helper.mjs')),
      true,
    );
    assert.match(nested.pinnedPath, /adapters[/\\]nested\.mjs$/);
    nested.dispose();

    fs.writeFileSync(
      path.join(root, 'dynamic.mjs'),
      "const name = './helper.mjs'; export default () => import(name);\n",
    );
    assert.throws(
      () => pinNativeAdapterGraph(path.join(root, 'dynamic.mjs')),
      /unsupported dynamic Native adapter import/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('machine and cohort require device/runtime identity and split on SDK or adapter bytes', () => {
  const machine = {
    id: 'did-hash',
    platform: 'android',
    osVersion: '10',
    deviceModel: 'device',
    cpuModel: 'board',
    cores: 8,
    app: 'LynxExplorer',
    appVersion: '1',
    sdkVersion: '3.0',
    debugRouterVersion: '1',
    agentLynxVersion: '0.14.4',
    appApkSha256: 'a'.repeat(64),
    physicalDeviceId: 'did-hash',
    leaseId: 'lease-hash',
  };
  assert.throws(() => validateNativeMachine(null), /device-stable machine/);
  assert.throws(
    () => validateNativeMachine({ ...machine, did: 'raw-did' }),
    /must not persist raw device identifiers/,
  );
  const base = createNativeCohort({
    machine,
    environment: 'native-test',
    adapterFingerprint: 'adapter-a',
    artifactFingerprint: 'artifact',
    benchmarkFingerprint: 'benchmark',
  });
  const sdk = createNativeCohort({
    machine: { ...machine, sdkVersion: '3.1' },
    environment: 'native-test',
    adapterFingerprint: 'adapter-a',
    artifactFingerprint: 'artifact',
    benchmarkFingerprint: 'benchmark',
  });
  const adapter = createNativeCohort({
    machine,
    environment: 'native-test',
    adapterFingerprint: 'adapter-b',
    artifactFingerprint: 'artifact',
    benchmarkFingerprint: 'benchmark',
  });
  assert.notEqual(base.fingerprint, sdk.fingerprint);
  assert.notEqual(base.fingerprint, adapter.fingerprint);
});

test('benchmark fingerprint excludes result output churn', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-benchmark-fingerprint-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Native Test'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'native@example.invalid'], { cwd: root });
    fs.mkdirSync(path.join(root, 'results'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), '{}');
    fs.writeFileSync(path.join(root, 'results/latest.json'), '{}');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });
    const first = captureNativeBenchmarkFingerprint(root);
    fs.writeFileSync(path.join(root, 'results/latest.json'), '{"changed":true}');
    const outputOnly = captureNativeBenchmarkFingerprint(root);
    assert.equal(first.sha256, outputOnly.sha256);
    fs.writeFileSync(path.join(root, 'package.json'), '{"changed":true}');
    const codeChanged = captureNativeBenchmarkFingerprint(root);
    assert.notEqual(first.sha256, codeChanged.sha256);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Native finalization attempts every disposer and preserves the primary error', async (t) => {
  const scenarios = [
    {
      adapterError: new Error('adapter cleanup failed'),
      expected: ['adapter cleanup failed'],
    },
    {
      bundleError: new Error('bundle cleanup failed'),
      expected: ['bundle cleanup failed'],
    },
    {
      adapterError: new Error('adapter cleanup failed'),
      bundleError: new Error('bundle cleanup failed'),
      expected: ['adapter cleanup failed', 'bundle cleanup failed'],
    },
    {
      primaryError: new Error('measurement failed'),
      adapterError: new Error('adapter cleanup failed'),
      expected: ['measurement failed', 'adapter cleanup failed'],
    },
  ];
  for (const [index, scenario] of scenarios.entries()) {
    await t.test(`scenario ${index + 1}`, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-cleanup-'));
      const calls = [];
      try {
        const candidate = entry(root, 'entry-a', [0], tableBytes);
        await assert.rejects(
          () => executeNativeRun({
            adapterPath: './adapter.mjs',
            entries: [candidate],
            cases: [{ name: 'create', scales: [1000] }],
            suites: ['table'],
            scales: [1000],
            startupScales: [],
            reps: 1,
            startupReps: 1,
            root,
            benchmarkRoot: root,
            noCollect: true,
            captureBenchmarkFingerprint: () => ({
              sha256: 'benchmark',
              files: 1,
              schemaVersion: 1,
              exclusions: [],
            }),
            materializeBundles: () => ({
              snapshots: new Map(),
              fingerprint: 'artifacts',
              dispose() {
                calls.push('bundle');
                if (scenario.bundleError) throw scenario.bundleError;
              },
            }),
            pinAdapter: () => ({
              pinnedPath: './adapter.mjs',
              originalPath: './adapter.mjs',
              fingerprint: 'adapter',
              factory: async () => {},
              dispose() {
                calls.push('adapter');
                if (scenario.adapterError) throw scenario.adapterError;
              },
            }),
            runHarness: async () => {
              if (scenario.primaryError) throw scenario.primaryError;
              return {
                environment: 'native-test',
                machine: {
                  id: 'device',
                  platform: 'android',
                  osVersion: '10',
                  deviceModel: 'mock',
                  cpuModel: 'mock',
                  cores: 8,
                  app: 'LynxExplorer',
                  appVersion: '1',
                  sdkVersion: '1',
                  debugRouterVersion: '1',
                  agentLynxVersion: '0.14.4',
                  appApkSha256: 'a'.repeat(64),
                  physicalDeviceId: 'device',
                  leaseId: 'lease',
                },
                records: [],
              };
            },
            writeRun: () => path.join(root, 'run.json'),
            log: () => {},
          }),
          (error) => {
            assert.equal(error instanceof AggregateError, true);
            assert.deepEqual(
              error.errors.map((candidateError) => candidateError.message),
              scenario.expected,
            );
            if (scenario.primaryError) {
              assert.equal(error.errors[0], scenario.primaryError);
              assert.equal(error.cause, scenario.primaryError);
            }
            return true;
          },
        );
        assert.deepEqual(calls, ['adapter', 'bundle']);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
