import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';

import { collectRuns } from './collect.mjs';
import { runNativeMatrix } from './harness-native.mjs';
import {
  labArtifactFingerprint,
  verifyVueVaporLabEntry,
} from './lab-artifacts.mjs';
import {
  createVueArtifactAssertions,
  expectedVueArtifactBanner,
  expectedVueArtifactMarker,
  vueArtifactAssertionsBytes,
  vueVaporBuildCell,
  vueVaporArtifactExpectation,
} from './vue-artifact-assertions.mjs';
import {
  vueBuildToolCompilerGraphIdentity,
  vueBuildToolEvidencePaths,
  vueBuildToolFingerprint,
  vueBuildToolPackageTreeIdentity,
  vueFeaturedBuildMetadataBytes,
} from './vue-build-tools.mjs';
import {
  assertNativeLabBundles,
  executeNativeRun,
} from './native-run.mjs';

const EMPTY_SHA256 = crypto.createHash('sha256').update('').digest('hex');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function writeFixtureBuildTools(root, cells) {
  const binaryBytes = Buffer.from('#!/usr/bin/env node\n');
  const packageBytes = Buffer.from(JSON.stringify({
    name: '@lynx-js/rspeedy',
    version: '0.13.5-test',
    bin: { rspeedy: './bin/rspeedy.js' },
  }));
  const packageFiles = {
    'bin/rspeedy.js': binaryBytes,
    'package.json': packageBytes,
  };
  const identity = {
    package: '@lynx-js/rspeedy',
    toolRoot: cells[0].rspeedyRoot,
    shimPath: `${cells[0].rspeedyRoot}/node_modules/.bin/rspeedy`,
    binaryPath:
      `${cells[0].rspeedyRoot}/node_modules/@lynx-js/rspeedy/bin/rspeedy.js`,
    packagePath:
      `${cells[0].rspeedyRoot}/node_modules/@lynx-js/rspeedy/package.json`,
    version: '0.13.5-test',
    binarySha256: sha256(binaryBytes),
    packageSha256: sha256(packageBytes),
    ...vueBuildToolPackageTreeIdentity(packageFiles),
    compilerGraph: vueBuildToolCompilerGraphIdentity({
      version: '0.13.5-test',
      files: packageFiles,
    }),
  };
  identity.fingerprint = vueBuildToolFingerprint(identity);
  const metadata = {
    schemaVersion: 1,
    cells: cells.map((cell) => ({
      id: cell.id,
      rows: cell.rows,
      rspeedy: identity,
    })),
  };
  const metadataBytes = vueFeaturedBuildMetadataBytes(metadata);
  fs.writeFileSync(path.join(root, 'build-metadata.json'), metadataBytes);
  const evidence = vueBuildToolEvidencePaths(identity.fingerprint);
  for (const [relative, bytes] of [
    [evidence.binary, binaryBytes],
    [evidence.package, packageBytes],
    [evidence.compilerGraph, Buffer.from(JSON.stringify(identity.compilerGraph))],
  ]) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  }
  for (const [relative, bytes] of Object.entries(packageFiles)) {
    const file = path.join(root, evidence.packageTree, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  }
  return {
    descriptor: {
      path: 'build-metadata.json',
      sha256: sha256(metadataBytes),
      bytes: metadataBytes.length,
    },
    tools: metadata.cells,
  };
}

function fakeEntry(root, id, rows = [0, 1000]) {
  const dir = path.join(root, 'entries', id);
  for (const row of rows) {
    const dist = path.join(dir, 'dist', `rows-${row}`);
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(
      path.join(dist, 'main.lynx.bundle'),
      `lynx:${id}:${row}:__NATIVE_BENCH_RESULT__:vue-lynx-native-bench-v1`,
    );
    fs.writeFileSync(path.join(dist, 'main.web.bundle'), `web:${id}:${row}`);
  }
  return {
    id,
    provenance: { commit: `commit-${id}` },
    dir,
    distDir: path.join(dir, 'dist'),
  };
}

function writeVerifiedEntry(root, id, commit, rows = [0]) {
  const entry = fakeEntry(root, id, rows);
  const bundleSha256 = {};
  const bundles = {};
  const artifactAssertions = {};
  for (const row of rows) {
    const bundleFiles = {};
    const expectation = vueVaporArtifactExpectation('vapor', row);
    const marker = expectedVueArtifactMarker(expectation);
    for (const flavor of ['web', 'lynx']) {
      const relative = `rows-${row}/main.${flavor}.bundle`;
      const bundleFile = path.join(entry.dir, 'dist', relative);
      fs.writeFileSync(
        bundleFile,
        `${flavor}:${id}:${row}:${expectedVueArtifactBanner(marker)}`,
      );
      const bytes = fs.readFileSync(bundleFile);
      bundleFiles[`main.${flavor}.bundle`] = bundleFile;
      bundleSha256[relative] = sha256(bytes);
      bundles[relative] = {
        path: `dist/${relative}`,
        sha256: bundleSha256[relative],
        rawBytes: bytes.length,
        gzipBytes: zlib.gzipSync(bytes, { level: 9 }).length,
      };
    }
    const assertions = createVueArtifactAssertions(expectation, bundleFiles);
    const assertionBytes = vueArtifactAssertionsBytes(assertions);
    const relative = `rows-${row}/artifact-assertions.json`;
    fs.writeFileSync(path.join(entry.dir, 'dist', relative), assertionBytes);
    artifactAssertions[relative] = {
      path: `dist/${relative}`,
      sha256: sha256(assertionBytes),
      bytes: assertionBytes.length,
      assertions,
    };
  }
  const buildCells = rows.map((row) => vueVaporBuildCell('vapor', row));
  const buildTools = writeFixtureBuildTools(entry.dir, buildCells);
  const receipt = {
    schemaVersion: 3,
    kind: 'vue-vapor-ab-lab-receipt',
    entryId: id,
    variant: 'vapor',
    rows,
    source: {
      head: commit,
      dirty: false,
      patch: { path: null, sha256: EMPTY_SHA256, bytes: 0 },
    },
    benchmark: {
      head: 'benchmark-head',
      patch: { path: null, sha256: EMPTY_SHA256, bytes: 0 },
    },
    build: {
      startedAt: '2026-08-16T00:00:00.000Z',
      completedAt: '2026-08-16T00:00:00.000Z',
      command: ['fixture-build'],
      cells: buildCells,
      metadata: buildTools.descriptor,
      tools: buildTools.tools,
    },
    toolchain: { node: 'test', pnpm: 'test', declaredPnpm: 'test' },
    bundles,
    artifactAssertions,
  };
  const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  fs.writeFileSync(path.join(entry.dir, 'receipt.json'), receiptBytes);
  const manifest = {
    id,
    label: id,
    framework: 'vue-lynx',
    frameworkVersion: 'test',
    config: 'vapor mode, IFR off; fixture',
    tags: ['experiment'],
    tier: 'lab',
    color: '#000000',
    presentation: { order: 1, colorLight: '#000000', colorDark: '#000000' },
    kind: 'vendored',
    provenance: {
      commit,
      benchmarkCommit: 'benchmark-head',
      patched: false,
      patchFile: null,
      patchSha256: EMPTY_SHA256,
      benchmarkPatchSha256: EMPTY_SHA256,
      builtAt: '2026-08-16T00:00:00.000Z',
      toolchain: receipt.toolchain,
      receipt: 'receipt.json',
      receiptSha256: sha256(receiptBytes),
      sha256: bundleSha256,
    },
    bundles: {
      web: `dist/rows-${rows[0]}/main.web.bundle`,
      lynx: `dist/rows-${rows[0]}/main.lynx.bundle`,
    },
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(entry.dir, 'entry.json'), manifestBytes);
  fs.writeFileSync(path.join(entry.dir, 'artifact-hashes.json'), `${JSON.stringify({
    'entry.json': sha256(manifestBytes),
    'receipt.json': sha256(receiptBytes),
  }, null, 2)}\n`);
  entry.provenance.commit = commit;
  return { entry, verified: verifyVueVaporLabEntry(entry.dir) };
}

const record = (entry, workload = 'create', scale = 1000) => ({
  suite: workload === 'startup' ? 'startup' : 'table',
  harness: 'native',
  environment: 'native-test',
  entry,
  workload,
  scale,
  metric: workload === 'startup' ? 'fcp' : 'latency',
  boundary: 'native-test',
  unit: 'ms',
  samples: [1],
  dnfCount: 0,
});

const nativeMachine = {
  id: 'device-one',
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
  physicalDeviceId: 'device-one',
  leaseId: 'lease-one',
};

function nativeExecutionFakes() {
  return {
    captureBenchmarkFingerprint: () => ({
      schemaVersion: 1,
      files: 1,
      sha256: 'benchmark-fingerprint',
      exclusions: ['results/', '.tmp/'],
    }),
    materializeBundles: ({ entries, suites, startupScales }) => {
      const snapshots = new Map();
      const rows = new Set([
        ...(suites.includes('table') ? [0] : []),
        ...(suites.includes('startup') ? startupScales : []),
      ]);
      for (const entry of entries) {
        for (const row of rows) {
          snapshots.set(`${entry.id}\0${row}`, {
            bundlePath: path.join(entry.distDir, `rows-${row}/main.lynx.bundle`),
            bundleBytes: Buffer.from('snapshot'),
            sha256: `snapshot-${entry.id}-${row}`,
          });
        }
      }
      return {
        snapshots,
        fingerprint: 'artifact-fingerprint',
        dispose() {},
      };
    },
    pinAdapter: (adapterPath) => ({
      originalPath: adapterPath,
      pinnedPath: adapterPath,
      fingerprint: 'adapter-fingerprint',
      factory: async () => {},
      dispose() {},
    }),
  };
}

test('native lab matrix uses exact requested table and startup scales', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-lab-matrix-'));
  try {
    const entry = fakeEntry(root, 'vue-vapor-a');
    const calls = [];
    const adapter = {
      environment: 'native-test',
      machine: nativeMachine,
      async loadBundle(_entry, { rows }) {
        calls.push(['load', rows]);
      },
      async driveCase(kase, scale) {
        calls.push(['case', kase.name, scale]);
      },
      async collect() {
        return { latencyMs: 1 };
      },
      async collectStartup() {
        return { fcpMs: 2 };
      },
    };
    const records = await runNativeMatrix({
      adapter,
      entries: [entry],
      cases: [{ name: 'create', scales: [1000, 10000] }],
      suites: ['table', 'startup'],
      scales: [1000],
      startupScales: [1000],
      reps: 1,
      startupReps: 1,
      bundleSnapshots: nativeExecutionFakes().materializeBundles({
        entries: [entry],
        suites: ['table', 'startup'],
        startupScales: [1000],
      }).snapshots,
    });
    assert.deepEqual(
      calls.filter(([kind]) => kind === 'case'),
      [['case', 'create', 1000]],
    );
    assert.deepEqual(calls.filter(([kind]) => kind === 'load'), [
      ['load', 0],
      ['load', 1000],
    ]);
    assert.deepEqual(
      records.map(({ suite, scale }) => [suite, scale]),
      [['table', 1000], ['startup', 1000], ['startup', 1000]],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('native lab bundle preflight rejects missing requested bundles before adapter work', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-lab-bundles-'));
  try {
    const entry = fakeEntry(root, 'vue-vapor-a', [0]);
    assert.doesNotThrow(() => assertNativeLabBundles([entry], ['table'], [1000]));
    assert.throws(
      () => assertNativeLabBundles([entry], ['startup'], [1000]),
      /startup@1000 requires a rows-1000 Lynx bundle/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('native lab run records receipt metadata, pins twice, and honors no-collect', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-lab-run-'));
  try {
    const { entry, verified } = writeVerifiedEntry(
      root,
      'vue-vapor-a',
      'commit-a',
      [0, 1000],
    );
    const verifiedEntries = new Map([[entry.id, verified]]);
    const calls = [];
    const result = await executeNativeRun({
      adapterPath: './adapter.mjs',
      entries: [entry],
      cases: [{ name: 'create', scales: [1000] }],
      suites: ['table', 'startup'],
      scales: [1000],
      startupScales: [1000],
      reps: 1,
      startupReps: 1,
      label: 'native-smoke',
      root,
      benchmarkRoot: root,
      verifiedLabEntries: verifiedEntries,
      verifiedLabBenchmark: { head: 'benchmark-head', patchSha256: EMPTY_SHA256 },
      noCollect: true,
      argv: ['run', '--harness', 'native'],
      now: () => new Date('2026-08-16T00:00:00.123Z'),
      ...nativeExecutionFakes(),
      runHarness: async (options) => {
        calls.push(['harness', options.scales, options.startupScales]);
        return {
          machine: nativeMachine,
          environment: 'native-test',
          records: [record(entry.id), record(entry.id, 'startup', 1000)],
        };
      },
      verifyPinnedEntry: (_dir, fingerprint) => {
        calls.push(['entry', fingerprint]);
        return verified;
      },
      verifyBenchmarkState: (_root, _entries, state) => {
        calls.push(['benchmark', state?.head ?? null]);
        return state ?? { head: 'benchmark-head', patchSha256: EMPTY_SHA256 };
      },
      collect: () => calls.push(['collect']),
      log: () => {},
    });
    assert.equal(
      path.basename(result.outPath),
      '2026-08-16T00-00-00-123Z-device-one-native-native-smoke.json',
    );
    assert.deepEqual(calls, [
      ['entry', verified.fingerprint],
      ['benchmark', 'benchmark-head'],
      ['harness', [1000], [1000]],
      ['entry', verified.fingerprint],
      ['benchmark', 'benchmark-head'],
    ]);
    assert.equal(result.run.meta.entryCommits[entry.id], 'commit-a');
    assert.equal(
      result.run.meta.entryArtifacts[entry.id].fingerprint,
      verified.fingerprint,
    );
    assert.deepEqual(result.run.meta.benchmarkWorktree, {
      head: 'benchmark-head',
      patchSha256: EMPTY_SHA256,
    });
    assert.equal(result.run.meta.harness, 'native');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('executeNativeRun gates the exact startupScales matrix before the harness', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-lab-startup-gate-'));
  try {
    const { entry, verified } = writeVerifiedEntry(
      root,
      'vue-vapor-a',
      'commit-a',
      [1000],
    );
    let harnessCalled = false;
    let runWritten = false;
    await assert.rejects(
      () => executeNativeRun({
        adapterPath: './adapter.mjs',
        entries: [entry],
        cases: [],
        suites: ['startup'],
        scales: [1000],
        startupScales: [10000],
        reps: 1,
        startupReps: 1,
        root,
        benchmarkRoot: root,
        verifiedLabEntries: new Map([[entry.id, verified]]),
        verifiedLabBenchmark: { head: 'benchmark-head', patchSha256: EMPTY_SHA256 },
        noCollect: true,
        runHarness: async () => {
          harnessCalled = true;
          return { machine: { id: 'device' }, records: [] };
        },
        writeRun: () => {
          runWritten = true;
          return 'run.json';
        },
        log: () => {},
      }),
      /selected row 10000 is not receipted/,
    );
    assert.equal(harnessCalled, false);
    assert.equal(runWritten, false);
    assert.equal(fs.existsSync(path.join(root, 'results/runs')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('executeNativeRun rejects invalid direct matrices before harness or output', async () => {
  let harnessCalled = false;
  let runWritten = false;
  await assert.rejects(
    () => executeNativeRun({
      adapterPath: './adapter.mjs',
      entries: [],
      cases: ['create', 'clear'],
      suites: ['table'],
      scales: [1000],
      startupScales: [],
      reps: 1,
      startupReps: 1,
      root: process.cwd(),
      benchmarkRoot: process.cwd(),
      noCollect: true,
      runHarness: async () => {
        harnessCalled = true;
        return { machine: { id: 'device' }, records: [] };
      },
      writeRun: () => {
        runWritten = true;
        return 'run.json';
      },
      log: () => {},
    }),
    /requested table matrix drops case clear/,
  );
  assert.equal(harnessCalled, false);
  assert.equal(runWritten, false);
});

test('native lab collection is rooted at lab-root with lab receipt semantics', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-lab-collection-root-'));
  try {
    const { entry, verified } = writeVerifiedEntry(root, 'vue-vapor-a', 'commit-a');
    const calls = [];
    await executeNativeRun({
      adapterPath: './adapter.mjs',
      entries: [entry],
      cases: [],
      suites: ['startup'],
      scales: [0],
      startupScales: [0],
      reps: 1,
      startupReps: 1,
      root,
      benchmarkRoot: root,
      verifiedLabEntries: new Map([[entry.id, verified]]),
      verifiedLabBenchmark: { head: 'benchmark-head', patchSha256: EMPTY_SHA256 },
      ...nativeExecutionFakes(),
      runHarness: async () => ({
        machine: nativeMachine,
        environment: 'native-test',
        records: [],
      }),
      verifyPinnedEntry: () => verified,
      verifyBenchmarkState: (_root, _entries, state) =>
        state ?? { head: 'benchmark-head', patchSha256: EMPTY_SHA256 },
      collect: (options) => calls.push(options),
      log: () => {},
    });
    assert.deepEqual(calls, [{ root, labMode: true }]);
    assert.equal(fs.existsSync(path.join(root, 'results/runs')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('native lab run rechecks after device work before writing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-lab-recheck-'));
  try {
    const { entry, verified } = writeVerifiedEntry(root, 'vue-vapor-a', 'commit-a');
    let checks = 0;
    let wrote = false;
    await assert.rejects(
      () => executeNativeRun({
        adapterPath: './adapter.mjs',
        entries: [entry],
        cases: [],
        suites: ['startup'],
        scales: [0],
        startupScales: [0],
        reps: 1,
        startupReps: 1,
        root,
        benchmarkRoot: root,
        verifiedLabEntries: new Map([[entry.id, verified]]),
        verifiedLabBenchmark: { head: 'benchmark-head', patchSha256: EMPTY_SHA256 },
        noCollect: true,
        ...nativeExecutionFakes(),
        runHarness: async () => ({
          machine: nativeMachine,
          environment: 'native-test',
          records: [],
        }),
        verifyPinnedEntry: () => {
          checks++;
          if (checks === 2) throw new Error('entry changed after device work');
          return verified;
        },
        verifyBenchmarkState: (_root, _entries, state) =>
          state ?? { head: 'benchmark-head', patchSha256: EMPTY_SHA256 },
        writeRun: () => {
          wrote = true;
          return 'run.json';
        },
        log: () => {},
      }),
      /entry changed after device work/,
    );
    assert.equal(wrote, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('native lab CLI rejects unknown or missing args before adapter import', () => {
  const cli = path.join(process.cwd(), 'packages/runner/src/cli.mjs');
  const marker = path.join(os.tmpdir(), `native-lab-adapter-marker-${process.pid}`);
  const adapter = path.join(os.tmpdir(), `native-lab-adapter-${process.pid}.mjs`);
  fs.writeFileSync(adapter, `
    import fs from 'node:fs';
    fs.writeFileSync(${JSON.stringify(marker)}, 'imported');
    export default () => { throw new Error('adapter should not be imported'); };
  `);
  try {
    const unknown = spawnSync(process.execPath, [
      cli,
      'run',
      '--lab-root',
      '.tmp/vue-vapor-lab',
      '--entry',
      'vue-vapor-baseline-7fe932bd',
      '--harness',
      'native',
      '--adapter',
      adapter,
      '--unknown-native-option',
      '1',
    ], { cwd: process.cwd(), encoding: 'utf8' });
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /unknown run lab argument/);
    assert.equal(fs.existsSync(marker), false);

    const missing = spawnSync(process.execPath, [
      cli,
      'run',
      '--lab-root',
      '.tmp/vue-vapor-lab',
      '--entry',
      'vue-vapor-baseline-7fe932bd',
      '--harness',
      'native',
    ], { cwd: process.cwd(), encoding: 'utf8' });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /native lab run requires --adapter/);
    assert.equal(fs.existsSync(marker), false);

    for (const unsupported of [
      ['--quick'],
      ['--storm-reps', '1'],
    ]) {
      const result = spawnSync(process.execPath, [
        cli,
        'run',
        '--lab-root',
        '.tmp/vue-vapor-lab',
        '--entry',
        'vue-vapor-baseline-7fe932bd',
        '--harness',
        'native',
        '--adapter',
        adapter,
        ...unsupported,
      ], { cwd: process.cwd(), encoding: 'utf8' });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /not supported by native lab runs/);
      assert.equal(fs.existsSync(marker), false);
    }
  } finally {
    fs.rmSync(adapter, { force: true });
    fs.rmSync(marker, { force: true });
  }
});

test('lab collector keeps Native receipt cohorts on one device', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-lab-collect-'));
  try {
    const a = writeVerifiedEntry(root, 'vue-vapor-a', 'commit-a');
    const b = writeVerifiedEntry(root, 'vue-vapor-b', 'commit-b');
    const runsDir = path.join(root, 'results/runs');
    fs.mkdirSync(runsDir, { recursive: true });
    const write = (file, machineId, generatedAt, entry, verified) => {
      fs.writeFileSync(path.join(runsDir, file), JSON.stringify({
        schemaVersion: 2,
        meta: {
          generatedAt,
          machine: { id: machineId },
          calibration: null,
          harness: 'native',
          nativeCohort: {
            schemaVersion: 1,
            fingerprint: 'native-cohort',
          },
          entryCommits: { [entry]: `commit-${entry.at(-1)}` },
          entryArtifacts: {
            [entry]: { fingerprint: verified.fingerprint, ...verified.cohort },
          },
          benchmarkWorktree: {
            head: 'benchmark-head',
            patchSha256: EMPTY_SHA256,
          },
        },
        records: [{ ...record(entry), nativeCohort: 'native-cohort' }],
      }));
    };
    write('a-device-one.json', 'device-one', '2026-08-16T00:00:00.000Z', a.entry.id, a.verified);
    write('b-device-one.json', 'device-one', '2026-08-16T00:01:00.000Z', b.entry.id, b.verified);
    write('a-device-two.json', 'device-two', '2026-08-16T00:02:00.000Z', a.entry.id, a.verified);
    const output = collectRuns({ root, labMode: true, log: () => {} });
    const native = output.comparison.harnesses.find(({ harness }) => harness === 'native');
    assert.equal(native.machineId, 'device-one');
    assert.deepEqual(native.entryIds, ['vue-vapor-a', 'vue-vapor-b']);
    assert.deepEqual(
      [...new Set(output.comparisonRecords
        .filter(({ harness }) => harness === 'native')
        .map(({ machineId }) => machineId))],
      ['device-one'],
    );
    assert.deepEqual(
      [...new Set(output.records
        .filter(({ harness }) => harness === 'native')
        .map(({ entryArtifactFingerprint }) => entryArtifactFingerprint))]
        .sort(),
      [a.verified.fingerprint, b.verified.fingerprint].sort(),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
