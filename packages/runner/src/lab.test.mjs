import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';

import { collectRuns } from './collect.mjs';
import { assertStartupRowCount, startupScalesForRun } from './harness-web.mjs';
import {
  captureGitState,
  labArtifactFingerprint,
  verifyPinnedVueVaporLabEntry,
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
  assertContainedPath,
  assertRunLabel,
} from './path-safety.mjs';
import { runFileName, writeRunFile } from './run-files.mjs';

const EMPTY_SHA256 = crypto.createHash('sha256').update('').digest('hex');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

const machine = {
  id: 'machine',
  hostname: 'machine',
  platform: 'test',
  arch: 'x64',
  cpuModel: 'test',
  cores: 1,
  memGB: 1,
  node: 'test',
};

const sourceRecord = (entry) => ({
  suite: 'table',
  harness: 'web',
  environment: 'test',
  entry,
  workload: 'select',
  scale: 1000,
  metric: 'latency',
  boundary: 'test',
  unit: 'ms',
  samples: [1],
  dnfCount: 0,
});

function cohort(seed) {
  const value = {
    receiptSha256: sha256(`receipt:${seed}`),
    sourcePatchSha256: EMPTY_SHA256,
    benchmarkPatchSha256: EMPTY_SHA256,
    bundleSha256: {
      'rows-0/main.web.bundle': sha256(`web:${seed}`),
      'rows-0/main.lynx.bundle': sha256(`lynx:${seed}`),
    },
  };
  return { fingerprint: labArtifactFingerprint(value), benchmarkHead: 'benchmark', ...value };
}

function writeFixtureBuildTools(root, cells) {
  const tools = new Map();
  const metadata = {
    schemaVersion: 1,
    cells: cells.map((cell) => {
      if (!tools.has(cell.rspeedyRoot)) {
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
          toolRoot: cell.rspeedyRoot,
          shimPath: `${cell.rspeedyRoot}/node_modules/.bin/rspeedy`,
          binaryPath:
            `${cell.rspeedyRoot}/node_modules/@lynx-js/rspeedy/bin/rspeedy.js`,
          packagePath:
            `${cell.rspeedyRoot}/node_modules/@lynx-js/rspeedy/package.json`,
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
        tools.set(cell.rspeedyRoot, {
          identity,
          binaryBytes,
          packageBytes,
          packageFiles,
        });
      }
      return {
        id: cell.id,
        rows: cell.rows,
        rspeedy: tools.get(cell.rspeedyRoot).identity,
      };
    }),
  };
  const metadataBytes = vueFeaturedBuildMetadataBytes(metadata);
  fs.writeFileSync(path.join(root, 'build-metadata.json'), metadataBytes);
  for (const tool of tools.values()) {
    const evidence = vueBuildToolEvidencePaths(tool.identity.fingerprint);
    for (const [relative, bytes] of [
      [evidence.binary, tool.binaryBytes],
      [evidence.package, tool.packageBytes],
      [evidence.compilerGraph, Buffer.from(JSON.stringify(tool.identity.compilerGraph))],
    ]) {
      const file = path.join(root, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes);
    }
    for (const [relative, bytes] of Object.entries(tool.packageFiles)) {
      const file = path.join(root, evidence.packageTree, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes);
    }
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

function writeRun(root, file, {
  generatedAt,
  commits,
  entries,
  artifacts = Object.fromEntries(entries.map((entry) => [entry, cohort(entry)])),
}) {
  fs.mkdirSync(path.join(root, 'results/runs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'results/runs', file), JSON.stringify({
    schemaVersion: 2,
    meta: {
      generatedAt,
      machine,
      calibration: { probeVersion: 1, score: 100 },
      entryCommits: commits,
      entryArtifacts: artifacts,
      benchmarkWorktree: {
        head: 'benchmark',
        patchSha256: EMPTY_SHA256,
      },
    },
    records: entries.map(sourceRecord),
  }));
}

function writeEntry(root, id, commit, seed = id, {
  benchmarkState = null,
  buildCells = [vueVaporBuildCell('vapor', 0)],
  verify = true,
} = {}) {
  const dir = path.join(root, 'entries', id);
  const dist = path.join(dir, 'dist/rows-0');
  fs.mkdirSync(dist, { recursive: true });
  const bundleSha256 = {};
  const bundles = {};
  const bundleFiles = {};
  const expectation = vueVaporArtifactExpectation('vapor', 0);
  const marker = expectedVueArtifactMarker(expectation);
  for (const flavor of ['web', 'lynx']) {
    const relative = `rows-0/main.${flavor}.bundle`;
    const bytes = Buffer.from(
      `${flavor}:${seed}:${expectedVueArtifactBanner(marker)}`,
    );
    const bundleFile = path.join(dist, `main.${flavor}.bundle`);
    fs.writeFileSync(bundleFile, bytes);
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
  fs.writeFileSync(path.join(dist, 'artifact-assertions.json'), assertionBytes);
  const benchmark = benchmarkState
    ? {
      checkout: benchmarkState.checkout,
      remote: benchmarkState.remote,
      ref: benchmarkState.ref,
      head: benchmarkState.head,
      dirty: benchmarkState.dirty,
      status: benchmarkState.status,
      patch: {
        path: benchmarkState.patch.length > 0 ? 'benchmark.patch' : null,
        sha256: benchmarkState.patchSha256,
        bytes: benchmarkState.patch.length,
      },
    }
    : {
      head: 'benchmark',
      patch: { path: null, sha256: EMPTY_SHA256, bytes: 0 },
    };
  if (benchmarkState?.patch.length > 0) {
    fs.writeFileSync(path.join(dir, 'benchmark.patch'), benchmarkState.patch);
  }
  const buildTools = writeFixtureBuildTools(dir, buildCells);
  const receipt = {
    schemaVersion: 3,
    kind: 'vue-vapor-ab-lab-receipt',
    entryId: id,
    variant: 'vapor',
    rows: [0],
    source: {
      head: commit,
      dirty: false,
      patch: { path: null, sha256: EMPTY_SHA256, bytes: 0 },
    },
    benchmark,
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
    artifactAssertions: {
      'rows-0/artifact-assertions.json': {
        path: 'dist/rows-0/artifact-assertions.json',
        sha256: sha256(assertionBytes),
        bytes: assertionBytes.length,
        assertions,
      },
    },
  };
  const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'receipt.json'), receiptBytes);
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
      benchmarkCommit: benchmark.head,
      patched: false,
      patchFile: null,
      patchSha256: EMPTY_SHA256,
      benchmarkPatchSha256: benchmark.patch.sha256,
      builtAt: '2026-08-16T00:00:00.000Z',
      toolchain: receipt.toolchain,
      receipt: 'receipt.json',
      receiptSha256: sha256(receiptBytes),
      sha256: bundleSha256,
    },
    bundles: {
      web: 'dist/rows-0/main.web.bundle',
      lynx: 'dist/rows-0/main.lynx.bundle',
    },
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'entry.json'), manifestBytes);
  fs.writeFileSync(path.join(dir, 'artifact-hashes.json'), `${JSON.stringify({
    'entry.json': sha256(manifestBytes),
    'receipt.json': sha256(receiptBytes),
  }, null, 2)}\n`);
  return verify ? verifyVueVaporLabEntry(dir) : { dir };
}

test('pinned lab entry rejects artifacts replaced during a benchmark run', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-vapor-lab-pinned-'));
  try {
    const entry = writeEntry(root, 'vue-vapor-a', 'commit-a', 'before');
    assert.equal(
      verifyPinnedVueVaporLabEntry(
        path.join(root, 'entries/vue-vapor-a'),
        entry.fingerprint,
      ).fingerprint,
      entry.fingerprint,
    );
    writeEntry(root, 'vue-vapor-a', 'commit-a', 'after');
    assert.throws(
      () => verifyPinnedVueVaporLabEntry(
        path.join(root, 'entries/vue-vapor-a'),
        entry.fingerprint,
      ),
      /changed after it was pinned/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('lab startup scales are exact while the formal default keeps its implicit endpoints', () => {
  assert.deepEqual(startupScalesForRun([1000]), [0, 1000, 30000]);
  assert.deepEqual(startupScalesForRun([1000], [1000]), [1000]);
  assert.deepEqual(startupScalesForRun([0, 10000], [0, 10000]), [0, 10000]);
});

test('Web startup rejects a stabilized bundle with the wrong exact row count', () => {
  assert.doesNotThrow(() => assertStartupRowCount('vue-vapor-a', 0, 0, 0));
  assert.doesNotThrow(() => assertStartupRowCount('vue-vapor-a', 30000, 0, 30000));
  assert.throws(
    () => assertStartupRowCount('vue-vapor-a', 30000, 2, 29999),
    /startup@30000 rep2: expected exactly 30000 rendered rows, got 29999/,
  );
});

test('lab-root path rejects symlink escape from the worktree', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-vapor-lab-path-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-vapor-lab-outside-'));
  try {
    fs.symlinkSync(outside, path.join(root, '.tmp'), 'dir');
    assert.throws(
      () => assertContainedPath(root, path.join(root, '.tmp/vue-vapor-lab'), {
        requiredTopLevel: '.tmp',
        label: 'lab root',
      }),
      /traverses a symlink/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('run labels are safe filename tokens for both harness paths', () => {
  for (const label of ['alpha', 'v1.2_3-smoke']) assert.equal(assertRunLabel(label), label);
  for (const label of ['', '.', '..', '../latest', 'a/b', 'a\\b', 'line\nbreak']) {
    assert.throws(() => assertRunLabel(label), /filename token/);
  }

  const cli = path.join(process.cwd(), 'packages/runner/src/cli.mjs');
  for (const harness of ['web', 'native']) {
    const result = spawnSync(process.execPath, [
      cli,
      'run',
      '--harness',
      harness,
      '--label',
      '../results/latest',
    ], { cwd: process.cwd(), encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--label must be a non-empty filename token/);
  }
});

test('malicious lab label cannot normalize into formal results/latest.json', () => {
  const formalLatest = path.join(process.cwd(), 'results/latest.json');
  const before = fs.readFileSync(formalLatest);
  const cli = path.join(process.cwd(), 'packages/runner/src/cli.mjs');
  const result = spawnSync(process.execPath, [
    cli,
    'run',
    '--lab-root',
    '.tmp/vue-vapor-lab',
    '--entry',
    'vue-vapor-baseline-7fe932bd',
    '--suite',
    'startup',
    '--scale',
    '0',
    '--label',
    '../../../results/latest',
  ], { cwd: process.cwd(), encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--label must be a non-empty filename token/);
  assert.deepEqual(fs.readFileSync(formalLatest), before);
});

test('run output rejects results/runs symlinks and exclusive collisions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-vapor-lab-run-files-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-vapor-lab-run-outside-'));
  const date = new Date('2026-08-16T00:00:00.123Z');
  const run = {
    meta: { generatedAt: date.toISOString() },
    records: [],
  };
  try {
    fs.mkdirSync(path.join(root, 'results'), { recursive: true });
    fs.symlinkSync(outside, path.join(root, 'results/runs'), 'dir');
    assert.throws(
      () => writeRunFile({ root, run, machineId: 'machine', label: 'smoke' }),
      /traverses a symlink/,
    );
    fs.rmSync(path.join(root, 'results/runs'));
    const file = writeRunFile({ root, run, machineId: 'machine', label: 'smoke' });
    assert.equal(path.basename(file), '2026-08-16T00-00-00-123Z-machine-smoke.json');
    assert.throws(
      () => writeRunFile({ root, run, machineId: 'machine', label: 'smoke' }),
      /EEXIST/,
    );
    assert.equal(
      runFileName({ date, machineId: 'machine', native: true }),
      '2026-08-16T00-00-00-123Z-machine-native.json',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('collector rejects existing results/latest.json symlink', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-vapor-lab-latest-link-'));
  const outside = path.join(os.tmpdir(), `vue-vapor-lab-latest-${process.pid}.json`);
  try {
    writeRun(root, 'run.json', {
      generatedAt: '2026-08-16T00:00:00.000Z',
      commits: { react: 'commit' },
      entries: ['react'],
    });
    fs.writeFileSync(outside, 'sentinel');
    fs.symlinkSync(outside, path.join(root, 'results/latest.json'));
    assert.throws(
      () => collectRuns({
        root,
        log: () => {},
        entryTiers: new Map([['react', 'featured']]),
        entries: [],
      }),
      /symlink/,
    );
    assert.equal(fs.readFileSync(outside, 'utf8'), 'sentinel');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { force: true });
  }
});

test('lab collector keeps commit cohorts and compares all-lab A/B entries', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-vapor-lab-collect-'));
  try {
    const currentA = writeEntry(root, 'vue-vapor-a', 'commit-a');
    const currentB = writeEntry(root, 'vue-vapor-b', 'commit-b');
    const sameCommit = 'same-commit';
    const sameA = cohort('same-receipt-a');
    const sameB = cohort('same-receipt-b');
    writeRun(root, 'same-a.json', {
      generatedAt: '2026-08-16T00:00:00.000Z',
      commits: { 'vue-vapor-same': sameCommit },
      entries: ['vue-vapor-same'],
      artifacts: { 'vue-vapor-same': sameA },
    });
    writeRun(root, 'same-b.json', {
      generatedAt: '2026-08-16T00:01:00.000Z',
      commits: { 'vue-vapor-same': sameCommit },
      entries: ['vue-vapor-same'],
      artifacts: { 'vue-vapor-same': sameB },
    });
    writeRun(root, 'abba.json', {
      generatedAt: '2026-08-16T00:02:00.000Z',
      commits: { 'vue-vapor-a': 'commit-a', 'vue-vapor-b': 'commit-b' },
      entries: ['vue-vapor-a', 'vue-vapor-b'],
      artifacts: {
        'vue-vapor-a': { fingerprint: currentA.fingerprint, ...currentA.cohort },
        'vue-vapor-b': { fingerprint: currentB.fingerprint, ...currentB.cohort },
      },
    });
    const tiers = new Map([
      ['vue-vapor-same', 'featured'],
      ['vue-vapor-a', 'featured'],
      ['vue-vapor-b', 'featured'],
    ]);

    const formal = collectRuns({
      root,
      generatedAt: 'test',
      log: () => {},
      entryTiers: tiers,
      entries: [],
    });
    assert.equal(
      formal.records.filter(({ entry }) => entry === 'vue-vapor-same').length,
      1,
    );

    const lab = collectRuns({
      root,
      generatedAt: 'test',
      log: () => {},
      entryTiers: tiers,
      entries: [],
      labMode: true,
    });
    assert.deepEqual(
      lab.records
        .filter(({ entry }) => entry === 'vue-vapor-same')
        .map(({ entryArtifactFingerprint }) => entryArtifactFingerprint)
        .sort(),
      [sameA.fingerprint, sameB.fingerprint].sort(),
    );
    assert.deepEqual(
      lab.records
        .filter(({ entry }) => entry === 'vue-vapor-a' || entry === 'vue-vapor-b')
        .map(({ entry }) => entry)
        .sort(),
      ['vue-vapor-a', 'vue-vapor-b'],
    );

    const allLab = collectRuns({ root, generatedAt: 'test', log: () => {}, labMode: true });
    assert.deepEqual(allLab.comparison.entryIds, ['vue-vapor-a', 'vue-vapor-b']);
    assert.equal(fs.existsSync(path.join(root, 'results/latest.json')), true);

    const staleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-vapor-lab-stale-'));
    try {
      const current = writeEntry(staleRoot, 'vue-vapor-a', 'commit-a', 'current');
      writeRun(staleRoot, 'stale.json', {
        generatedAt: '2026-08-16T00:00:00.000Z',
        commits: { 'vue-vapor-a': 'commit-a' },
        entries: ['vue-vapor-a'],
        artifacts: { 'vue-vapor-a': cohort('stale') },
      });
      assert.throws(
        () => collectRuns({ root: staleRoot, log: () => {}, labMode: true }),
        /no schema v2 runs/,
      );
      assert.notEqual(current.fingerprint, cohort('stale').fingerprint);
    } finally {
      fs.rmSync(staleRoot, { recursive: true, force: true });
    }

    writeRun(root, 'missing-commit.json', {
      generatedAt: '2026-08-16T00:03:00.000Z',
      commits: {},
      entries: ['vue-vapor-a'],
      artifacts: {
        'vue-vapor-a': { fingerprint: currentA.fingerprint, ...currentA.cohort },
      },
    });
    assert.throws(
      () => collectRuns({
        root,
        generatedAt: 'test',
        log: () => {},
        entryTiers: tiers,
        entries: [],
        labMode: true,
      }),
      /missing meta\.entryCommits/,
    );

    writeRun(root, 'missing-artifact.json', {
      generatedAt: '2026-08-16T00:04:00.000Z',
      commits: { 'vue-vapor-a': 'commit-a' },
      entries: ['vue-vapor-a'],
      artifacts: {},
    });
    assert.throws(
      () => collectRuns({
        root,
        generatedAt: 'test',
        log: () => {},
        entryTiers: tiers,
        entries: [],
        labMode: true,
      }),
      /missing meta\.entryArtifacts/,
    );

    const invalidRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-vapor-lab-invalid-cohort-'));
    try {
      const current = writeEntry(invalidRoot, 'vue-vapor-a', 'commit-a');
      writeRun(invalidRoot, 'invalid.json', {
        generatedAt: '2026-08-16T00:00:00.000Z',
        commits: { 'vue-vapor-a': 'commit-a' },
        entries: ['vue-vapor-a'],
        artifacts: {
          'vue-vapor-a': {
            fingerprint: 'forged',
            ...current.cohort,
          },
        },
      });
      assert.throws(
        () => collectRuns({ root: invalidRoot, log: () => {}, labMode: true }),
        /invalid receipt cohort/,
      );
    } finally {
      fs.rmSync(invalidRoot, { recursive: true, force: true });
    }

    const benchmarkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-vapor-lab-benchmark-'));
    try {
      const current = writeEntry(benchmarkRoot, 'vue-vapor-a', 'commit-a');
      const file = path.join(benchmarkRoot, 'results/runs/run.json');
      writeRun(benchmarkRoot, 'run.json', {
        generatedAt: '2026-08-16T00:00:00.000Z',
        commits: { 'vue-vapor-a': 'commit-a' },
        entries: ['vue-vapor-a'],
        artifacts: {
          'vue-vapor-a': { fingerprint: current.fingerprint, ...current.cohort },
        },
      });
      const run = JSON.parse(fs.readFileSync(file));
      delete run.meta.benchmarkWorktree;
      fs.writeFileSync(file, JSON.stringify(run));
      assert.throws(
        () => collectRuns({ root: benchmarkRoot, log: () => {}, labMode: true }),
        /missing meta\.benchmarkWorktree/,
      );
      run.meta.benchmarkWorktree = {
        head: 'other-benchmark',
        patchSha256: EMPTY_SHA256,
      };
      fs.writeFileSync(file, JSON.stringify(run));
      assert.throws(
        () => collectRuns({ root: benchmarkRoot, log: () => {}, labMode: true }),
        /mismatched benchmark worktree/,
      );
    } finally {
      fs.rmSync(benchmarkRoot, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('lab CLI rejects unknown/missing args and invalid artifacts before browser launch', () => {
  const cli = path.join(process.cwd(), 'packages/runner/src/cli.mjs');
  for (const argv of [
    ['list', '--lab-root'],
    ['list', '--lab-root', '.tmp/vue-vapor-lab', '--bogus'],
  ]) {
    const result = spawnSync(process.execPath, [cli, ...argv], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /requires a non-empty path|unknown list lab argument/);
  }

  const root = path.join(process.cwd(), '.tmp', `invalid-lab-${process.pid}`);
  try {
    writeEntry(root, 'vue-vapor-invalid', 'commit');
    const manifestPath = path.join(root, 'entries/vue-vapor-invalid/entry.json');
    const hashesPath = path.join(root, 'entries/vue-vapor-invalid/artifact-hashes.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath));
    manifest.tier = 'featured';
    const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    fs.writeFileSync(manifestPath, bytes);
    const hashes = JSON.parse(fs.readFileSync(hashesPath));
    hashes['entry.json'] = sha256(bytes);
    fs.writeFileSync(hashesPath, `${JSON.stringify(hashes, null, 2)}\n`);
    const result = spawnSync(process.execPath, [
      cli,
      'run',
      '--lab-root',
      root,
      '--entry',
      'vue-vapor-invalid',
      '--suite',
      'startup',
      '--scale',
      '0',
      '--label',
      'smoke',
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, PLAYWRIGHT_CHROMIUM_PATH: '/must-not-launch' },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /manifest tier/);
    assert.doesNotMatch(result.stderr, /executable doesn't exist|No Chromium/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Web and Native CLI matrix rejection touches no browser, adapter, or run output', () => {
  const cli = path.join(process.cwd(), 'packages/runner/src/cli.mjs');
  const root = path.join(process.cwd(), '.tmp', `invalid-matrix-lab-${process.pid}`);
  const browserMarker = path.join(os.tmpdir(), `invalid-matrix-browser-${process.pid}`);
  const adapterMarker = path.join(os.tmpdir(), `invalid-matrix-adapter-${process.pid}`);
  const browser = path.join(os.tmpdir(), `invalid-matrix-browser-${process.pid}.sh`);
  const adapter = path.join(os.tmpdir(), `invalid-matrix-adapter-${process.pid}.mjs`);
  const sentinel = path.join(root, 'results/sentinel');
  writeEntry(
    root,
    'vue-vapor-sentinel',
    'source-commit',
    'fixture',
    { benchmarkState: captureGitState(process.cwd()) },
  );
  fs.mkdirSync(path.dirname(sentinel), { recursive: true });
  fs.writeFileSync(sentinel, 'untouched');
  fs.writeFileSync(browser, `#!/bin/sh
printf launched > ${JSON.stringify(browserMarker)}
exit 99
`);
  fs.chmodSync(browser, 0o755);
  fs.writeFileSync(adapter, `
    import fs from 'node:fs';
    fs.writeFileSync(${JSON.stringify(adapterMarker)}, 'imported');
    export default () => { throw new Error('adapter should not be imported'); };
  `);

  const cases = [
    ['web', ['--reps', '0'], /--reps must be a positive safe integer/],
    ['native', ['--reps', 'NaN'], /--reps must be a positive safe integer/],
    ['web', ['--storm-reps', '1.5'], /--storm-reps must be a positive safe integer/],
    ['native', ['--startup-reps', 'Infinity'], /--startup-reps must be a positive safe integer/],
    ['web', ['--scale', '1000,'], /--scale must not contain blank tokens/],
    ['native', ['--scale', '-1'], /--scale must contain non-negative safe integers/],
    ['web', ['--scale', '1.5'], /--scale must contain non-negative safe integers/],
    ['native', ['--scale', '9007199254740992'], /--scale must contain non-negative safe integers/],
    ['web', ['--scale', '1000,1e3'], /--scale must not contain duplicate scales/],
    ['native', ['--suite', 'table,table'], /--suite must not contain duplicate tokens/],
    ['web', ['--suite', 'startup,'], /--suite must not contain blank tokens/],
    ['native', ['--case', 'create,create'], /--case must not contain duplicate tokens/],
    ['web', ['--case', 'clear,'], /--case must not contain blank tokens/],
    [
      'web',
      ['--suite', 'table', '--case', 'clear', '--scale', '1000'],
      /requested table matrix drops case clear/,
    ],
    [
      'native',
      ['--suite', 'table', '--case', 'clear', '--scale', '1000'],
      /requested table matrix drops case clear/,
    ],
  ];

  try {
    for (const [harness, matrixArgs, expected] of cases) {
      fs.rmSync(browserMarker, { force: true });
      fs.rmSync(adapterMarker, { force: true });
      const result = spawnSync(process.execPath, [
        cli,
        'run',
        '--lab-root',
        root,
        '--entry',
        'vue-vapor-sentinel',
        '--harness',
        harness,
        ...(harness === 'native' ? ['--adapter', adapter] : []),
        ...matrixArgs,
      ], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          PLAYWRIGHT_CHROMIUM_PATH: browser,
        },
      });
      assert.equal(result.status, 1, `${harness} ${matrixArgs.join(' ')}`);
      assert.match(result.stderr, expected, `${harness} ${matrixArgs.join(' ')}`);
      assert.equal(fs.existsSync(browserMarker), false);
      assert.equal(fs.existsSync(adapterMarker), false);
      assert.equal(fs.readFileSync(sentinel, 'utf8'), 'untouched');
      assert.equal(fs.existsSync(path.join(root, 'results/runs')), false);
      assert.equal(fs.existsSync(path.join(root, 'results/latest.json')), false);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(browser, { force: true });
    fs.rmSync(adapter, { force: true });
    fs.rmSync(browserMarker, { force: true });
    fs.rmSync(adapterMarker, { force: true });
  }
});

test('lab CLI rejects unreceipted rows before browser launch or adapter import', () => {
  const cli = path.join(process.cwd(), 'packages/runner/src/cli.mjs');
  const root = path.join(process.cwd(), '.tmp', `missing-row-lab-${process.pid}`);
  const browserMarker = path.join(os.tmpdir(), `missing-row-browser-${process.pid}`);
  const adapterMarker = path.join(os.tmpdir(), `missing-row-adapter-${process.pid}`);
  const adapter = path.join(os.tmpdir(), `missing-row-adapter-${process.pid}.mjs`);
  try {
    writeEntry(
      root,
      'vue-vapor-missing-row',
      'source-commit',
      'fixture',
      { benchmarkState: captureGitState(process.cwd()) },
    );
    fs.writeFileSync(adapter, `
      import fs from 'node:fs';
      fs.writeFileSync(${JSON.stringify(adapterMarker)}, 'imported');
      export default () => { throw new Error('adapter should not be imported'); };
    `);

    const common = [
      'run',
      '--lab-root',
      root,
      '--entry',
      'vue-vapor-missing-row',
      '--suite',
      'startup',
      '--scale',
      '1000',
      '--label',
      'missing-row',
    ];
    const web = spawnSync(process.execPath, [cli, ...common], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        PLAYWRIGHT_CHROMIUM_PATH: browserMarker,
      },
    });
    assert.equal(web.status, 1);
    assert.match(web.stderr, /selected row 1000 is not receipted/);
    assert.doesNotMatch(web.stderr, /executable doesn't exist|No Chromium/);
    assert.equal(fs.existsSync(browserMarker), false);

    const native = spawnSync(process.execPath, [
      cli,
      ...common,
      '--harness',
      'native',
      '--adapter',
      adapter,
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    assert.equal(native.status, 1);
    assert.match(native.stderr, /selected row 1000 is not receipted/);
    assert.equal(fs.existsSync(adapterMarker), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(browserMarker, { force: true });
    fs.rmSync(adapterMarker, { force: true });
    fs.rmSync(adapter, { force: true });
  }
});

test('lab CLI rejects a wrong producer cell before browser launch', () => {
  const cli = path.join(process.cwd(), 'packages/runner/src/cli.mjs');
  const root = path.join(process.cwd(), '.tmp', `wrong-cell-lab-${process.pid}`);
  const browserMarker = path.join(os.tmpdir(), `wrong-cell-browser-${process.pid}`);
  const wrongCell = {
    ...vueVaporBuildCell('vapor', 0),
    outputPath: 'packages/benchmark/apps/ui-vapor/dist-ifr',
  };
  try {
    writeEntry(
      root,
      'vue-vapor-wrong-cell',
      'source-commit',
      'fixture',
      {
        benchmarkState: captureGitState(process.cwd()),
        buildCells: [wrongCell],
        verify: false,
      },
    );
    const result = spawnSync(process.execPath, [
      cli,
      'run',
      '--lab-root',
      root,
      '--entry',
      'vue-vapor-wrong-cell',
      '--suite',
      'table',
      '--case',
      'create',
      '--scale',
      '1000',
      '--label',
      'wrong-cell',
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        PLAYWRIGHT_CHROMIUM_PATH: browserMarker,
      },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /receipt build cells/);
    assert.doesNotMatch(result.stderr, /executable doesn't exist|No Chromium/);
    assert.equal(fs.existsSync(browserMarker), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(browserMarker, { force: true });
  }
});
