import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  parseVueFeaturedRows,
  vueFeaturedBuildPlan,
  vueFeaturedSupportsAutoRows,
} from '../vue-featured-plan.mjs';
import {
  createVueVaporLabEntry,
  resolveEntryId,
} from './vue-vapor-entry.mjs';
import { verifyVueVaporLabEntry } from './verify-vue-vapor-lab.mjs';
import {
  assertVueVaporLabSelectedRows,
  verifyVueVaporLabBenchmarkState,
  verifyVueVaporLabRoot,
} from '../../packages/runner/src/lab-artifacts.mjs';
import {
  createVueArtifactAssertions,
  expectedVueArtifactBanner,
  expectedVueArtifactMarker,
  vueArtifactAssertionsBytes,
  vueVaporBuildCell,
  vueVaporArtifactExpectation,
} from '../../packages/runner/src/vue-artifact-assertions.mjs';
import {
  vueBuildToolCompilerGraphIdentity,
  vueBuildToolEvidencePaths,
  vueBuildToolFingerprint,
  vueBuildToolPackageTreeIdentity,
  vueFeaturedBuildMetadataBytes,
} from '../../packages/runner/src/vue-build-tools.mjs';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function initializeRepo(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.name', 'Lab Test']);
  git(dir, ['config', 'user.email', 'lab-test@example.com']);
  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(dir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'fixture']);
  return git(dir, ['rev-parse', 'HEAD']);
}

function writeExecutable(file, source) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
  fs.chmodSync(file, 0o755);
}

const sha256 = (value) =>
  crypto.createHash('sha256').update(value).digest('hex');

function fakeBuildTool(cell, {
  version = '0.13.5-test',
  binary = '#!/usr/bin/env node\n',
} = {}) {
  const packageValue = {
    name: '@lynx-js/rspeedy',
    version,
    bin: { rspeedy: './bin/rspeedy.js' },
  };
  const packageBytes = Buffer.from(JSON.stringify(packageValue));
  const binaryBytes = Buffer.from(binary);
  const packageFiles = {
    'bin/rspeedy.js': binaryBytes,
    'package.json': packageBytes,
  };
  const identity = {
    package: '@lynx-js/rspeedy',
    toolRoot: cell.rspeedyRoot,
    shimPath: `${cell.rspeedyRoot}/node_modules/.bin/rspeedy`,
    binaryPath: `${cell.rspeedyRoot}/node_modules/@lynx-js/rspeedy/bin/rspeedy.js`,
    packagePath: `${cell.rspeedyRoot}/node_modules/@lynx-js/rspeedy/package.json`,
    version,
    binarySha256: sha256(binaryBytes),
    packageSha256: sha256(packageBytes),
    ...vueBuildToolPackageTreeIdentity(packageFiles),
    compilerGraph: vueBuildToolCompilerGraphIdentity({
      version,
      files: packageFiles,
    }),
  };
  identity.fingerprint = vueBuildToolFingerprint(identity);
  return {
    identity,
    binaryBytes,
    packageBytes,
    packageFiles,
  };
}

function writeBuildMetadata(buildOut, cells, toolOptions = {}) {
  const tools = new Map();
  const metadata = {
    schemaVersion: 1,
    cells: cells.map((cell) => {
      if (!tools.has(cell.rspeedyRoot)) {
        tools.set(cell.rspeedyRoot, fakeBuildTool(cell, toolOptions));
      }
      return {
        id: cell.id,
        rows: cell.rows,
        rspeedy: tools.get(cell.rspeedyRoot).identity,
      };
    }),
  };
  for (const tool of tools.values()) {
    const evidence = vueBuildToolEvidencePaths(tool.identity.fingerprint);
    for (const [relative, bytes] of [
      [evidence.binary, tool.binaryBytes],
      [evidence.package, tool.packageBytes],
      [evidence.compilerGraph, Buffer.from(JSON.stringify(tool.identity.compilerGraph))],
    ]) {
      const file = path.join(buildOut, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes);
    }
    for (const [relative, bytes] of Object.entries(tool.packageFiles)) {
      const file = path.join(buildOut, evidence.packageTree, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes);
    }
  }
  fs.writeFileSync(
    path.join(buildOut, 'build-metadata.json'),
    vueFeaturedBuildMetadataBytes(metadata),
  );
  return metadata;
}

function makeFixture() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-vapor-lab-'));
  const benchmark = path.join(temporary, 'benchmark');
  const benchmarkHead = initializeRepo(benchmark, {
    '.gitignore': '.tmp/\n',
    'package.json': JSON.stringify({
      name: 'fixture-benchmark',
      private: true,
      packageManager: 'pnpm@10.32.1',
    }),
    'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
  });
  const source = (name, marker) => {
    const checkout = path.join(temporary, name);
    const head = initializeRepo(checkout, {
      '.gitignore': [
        'packages/vue-lynx/**/dist/',
        'packages/vue-lynx/**/.rslib/',
        'packages/vue-lynx/**/*.tsbuildinfo',
        'packages/benchmark/apps/**/dist/',
        'packages/benchmark/apps/**/dist-ifr/',
        'packages/benchmark/apps/**/node_modules/',
        '',
      ].join('\n'),
      'package.json': JSON.stringify({
        name,
        private: true,
        pnpm: { overrides: { vue: '3.6.0-test' } },
      }),
      'packages/benchmark/fixture.txt': marker,
      'packages/vue-lynx/package.json': JSON.stringify({
        name: 'vue-lynx',
        version: `0.5.${marker}`,
      }),
    });
    return { checkout, head };
  };
  return {
    temporary,
    benchmark,
    benchmarkHead,
    sourceA: source('source-a', '1'),
    sourceB: source('source-b', '2'),
    labRoot: path.join(benchmark, '.tmp/vue-vapor-lab'),
  };
}

function stubBuild({ variant, rows, buildOut }, toolOptions = {}) {
  const upstreamId = variant === 'ifr' ? 'vue-vapor-ifr' : 'vue-vapor';
  const cells = rows.map((row) => vueVaporBuildCell(variant, row));
  for (const row of rows) {
    const dir = path.join(buildOut, upstreamId, `rows-${row}`);
    fs.mkdirSync(dir, { recursive: true });
    const expectation = vueVaporArtifactExpectation(variant, row);
    const marker = expectedVueArtifactMarker(expectation);
    const bundleFiles = {};
    for (const flavor of ['web', 'lynx']) {
      const name = `main.${flavor}.bundle`;
      bundleFiles[name] = path.join(dir, name);
      fs.writeFileSync(
        bundleFiles[name],
        `${flavor}:${variant}:${row}:${expectedVueArtifactBanner(marker)}`,
      );
    }
    const assertions = createVueArtifactAssertions(expectation, bundleFiles);
    fs.writeFileSync(
      path.join(dir, 'artifact-assertions.json'),
      vueArtifactAssertionsBytes(assertions),
    );
  }
  writeBuildMetadata(buildOut, cells, toolOptions);
  return ['fixture-build', '--variant', variant, '--rows', rows.join(',')];
}

const toolchain = {
  node: 'v24.0.0-test',
  pnpm: '10.32.1-test',
  declaredPnpm: 'pnpm@10.32.1',
};

function rewriteJson(file, mutate) {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  mutate(value);
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  fs.writeFileSync(file, bytes);
  return bytes;
}

function refreshArtifactHashes(entryDir) {
  const hashes = {
    'entry.json': crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(entryDir, 'entry.json')))
      .digest('hex'),
    'receipt.json': crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(entryDir, 'receipt.json')))
      .digest('hex'),
  };
  fs.writeFileSync(
    path.join(entryDir, 'artifact-hashes.json'),
    `${JSON.stringify(hashes, null, 2)}\n`,
  );
  return hashes;
}

function refreshReceiptLink(entryDir) {
  const receiptSha256 = crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(entryDir, 'receipt.json')))
    .digest('hex');
  rewriteJson(path.join(entryDir, 'entry.json'), (manifest) => {
    manifest.provenance.receiptSha256 = receiptSha256;
  });
  refreshArtifactHashes(entryDir);
}

function treeSnapshot(root) {
  if (!fs.existsSync(root)) return null;
  const entries = [];
  const visit = (directory, prefix = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = path.posix.join(prefix, entry.name);
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        entries.push([relative, 'directory']);
        visit(absolute, relative);
      } else if (entry.isSymbolicLink()) {
        entries.push([relative, 'symlink', fs.readlinkSync(absolute)]);
      } else {
        entries.push([
          relative,
          'file',
          fs.statSync(absolute).mode & 0o777,
          crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex'),
        ]);
      }
    }
  };
  visit(root);
  return entries;
}

test('featured builder default plan remains the original 20 cells in the original order', () => {
  const expectedIds = [
    'react',
    'vue-vdom',
    'vue-vdom-ifr-et',
    'vue-vapor',
    'vue-vapor-ifr',
  ];
  const plan = vueFeaturedBuildPlan();
  assert.equal(plan.length, 20);
  for (let rowIndex = 0; rowIndex < 4; rowIndex++) {
    const slice = plan.slice(rowIndex * 5, rowIndex * 5 + 5);
    assert.deepEqual(slice.map(({ id }) => id), expectedIds);
    assert.deepEqual(
      [...new Set(slice.map(({ rows }) => rows))],
      [[0, 1000, 10000, 30000][rowIndex]],
    );
  }
  assert.deepEqual(
    plan.filter(({ id }) => id === 'vue-vapor-ifr').map(({ ifr }) => ifr),
    [1, 1, 1, 1],
  );
  assert.deepEqual(
    plan.slice(0, 5).map(({
      id, app, benchCell = null, outputDir, mode, ifr, et,
      rspeedyRoot,
    }) => [id, app, rspeedyRoot, benchCell, outputDir, mode, ifr, et]),
    [
      [
        'react', 'ui-react', 'packages/benchmark/apps/ui-react',
        null, 'dist', 'react', 0, 0,
      ],
      [
        'vue-vdom', 'ui-vdom', 'packages/benchmark',
        'off', 'dist', 'vdom', 0, 0,
      ],
      [
        'vue-vdom-ifr-et', 'ui-vdom', 'packages/benchmark',
        'ifr-et', 'dist-ifr-et', 'vdom-ifr-et', 1, 1,
      ],
      [
        'vue-vapor', 'ui-vapor', 'packages/benchmark',
        'off', 'dist', 'vapor', 0, 0,
      ],
      [
        'vue-vapor-ifr', 'ui-vapor', 'packages/benchmark',
        'ifr', 'dist-ifr', 'vapor-ifr', 1, 0,
      ],
    ],
  );
  assert.deepEqual(parseVueFeaturedRows('0,1k,10k,30k'), [0, 1000, 10000, 30000]);
  for (const value of ['', ',', '0,', '1000,1k', ['0', 0], []]) {
    assert.throws(
      () => parseVueFeaturedRows(value),
      /non-empty subset|duplicate rows/,
      JSON.stringify(value),
    );
  }
});

test('lab builder plan selects only the requested Vapor variant and rows', () => {
  assert.deepEqual(
    vueFeaturedBuildPlan({ lab: true, variant: 'vapor', rows: [0, 10000] }),
    [
      {
        id: 'vue-vapor', app: 'ui-vapor', rspeedyRoot: 'packages/benchmark',
        benchCell: 'off',
        outputDir: 'dist', mode: 'vapor', ifr: 0, et: 0, rows: 0,
      },
      {
        id: 'vue-vapor', app: 'ui-vapor', rspeedyRoot: 'packages/benchmark',
        benchCell: 'off',
        outputDir: 'dist', mode: 'vapor', ifr: 0, et: 0, rows: 10000,
      },
    ],
  );
  assert.deepEqual(
    vueFeaturedBuildPlan({ lab: true, variant: 'ifr', rows: [1000] }),
    [{
      id: 'vue-vapor-ifr', app: 'ui-vapor', rspeedyRoot: 'packages/benchmark',
      benchCell: 'ifr',
      outputDir: 'dist-ifr', mode: 'vapor-ifr', ifr: 1, et: 0, rows: 1000,
    }],
  );
  assert.throws(
    () => resolveEntryId({ variant: 'vapor', id: 'vue-vapor' }),
    /formal entry id/,
  );
});

test('lab builder detects whether a checkout supports nonzero startup rows', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-vapor-lab-autorows-'));
  try {
    initializeRepo(root, {
      'packages/benchmark/without-autorows.txt': 'fixture\n',
    });
    assert.equal(vueFeaturedSupportsAutoRows(root), false);
    fs.writeFileSync(
      path.join(root, 'packages/benchmark/with-autorows.txt'),
      'const rows = process.env.BENCH_AUTOROWS\n',
    );
    git(root, ['add', 'packages/benchmark/with-autorows.txt']);
    assert.equal(vueFeaturedSupportsAutoRows(root), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('builder uses BENCH_CELL, clears only exact cache/output, and stages exact output', () => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-featured-builder-'));
  fs.mkdirSync(path.join(process.cwd(), '.tmp'), { recursive: true });
  const out = fs.mkdtempSync(path.join(process.cwd(), '.tmp/vue-featured-builder-'));
  try {
    const benchmark = path.join(source, 'packages/benchmark');
    const app = path.join(benchmark, 'apps/ui-vapor');
    const vdom = '<!-- BENCH_MODE_SCRIPT --><script setup lang="ts">\nconst value = 1\n';
    fs.mkdirSync(path.join(benchmark, 'apps/ui-vdom/src'), { recursive: true });
    fs.mkdirSync(path.join(app, 'src'), { recursive: true });
    fs.writeFileSync(path.join(benchmark, 'apps/ui-vdom/src/App.vue'), vdom);
    fs.writeFileSync(
      path.join(app, 'src/App.vue'),
      '<!-- GENERATED from apps/ui-vdom/src/App.vue — do not edit -->\n'
      + vdom.replace(
        '<!-- BENCH_MODE_SCRIPT --><script setup lang="ts">',
        '<script setup vapor lang="ts">',
      ),
    );
    for (const dir of ['internal', 'runtime', 'main-thread', 'plugin']) {
      fs.mkdirSync(path.join(source, `packages/vue-lynx/${dir}`), { recursive: true });
    }
    const noop = '#!/usr/bin/env node\n';
    writeExecutable(path.join(source, 'node_modules/.bin/tsc'), noop);
    writeExecutable(path.join(source, 'node_modules/.bin/rslib'), noop);
    const rspeedySource = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const cwd = process.cwd();
if (path.basename(cwd) !== 'ui-vapor') throw new Error('unexpected app');
if (process.env.BENCH_CELL !== 'ifr') throw new Error('BENCH_CELL must be ifr');
if ('BENCH_ENABLE_IFR' in process.env || 'BENCH_ENABLE_ET' in process.env) {
  throw new Error('legacy benchmark flags leaked');
}
for (const exact of ['node_modules/.cache', 'dist-ifr']) {
  if (fs.existsSync(path.join(cwd, exact))) throw new Error(exact + ' was not cleared');
}
const output = path.join(cwd, 'dist-ifr');
fs.mkdirSync(output, { recursive: true });
const marker = 'vue-lynx-bench-artifact-v1|mode=vapor-ifr|rows=0|ifr=1|et=0';
for (const flavor of ['web', 'lynx']) {
  fs.writeFileSync(
    path.join(output, 'main.' + flavor + '.bundle'),
    flavor + ':/*! ' + marker + ' */',
  );
}
`;
    writeExecutable(
      path.join(benchmark, 'node_modules/.bin/rspeedy'),
      rspeedySource,
    );
    writeExecutable(
      path.join(benchmark, 'node_modules/@lynx-js/rspeedy/bin/rspeedy.js'),
      rspeedySource,
    );
    fs.writeFileSync(
      path.join(benchmark, 'node_modules/@lynx-js/rspeedy/package.json'),
      JSON.stringify({
        name: '@lynx-js/rspeedy',
        version: '0.13.5',
        bin: { rspeedy: './bin/rspeedy.js' },
      }),
    );
    fs.mkdirSync(path.join(app, 'node_modules/.cache'), { recursive: true });
    fs.writeFileSync(path.join(app, 'node_modules/.cache/stale'), 'stale');
    fs.mkdirSync(path.join(app, 'dist-ifr'), { recursive: true });
    fs.writeFileSync(path.join(app, 'dist-ifr/stale'), 'stale');
    fs.mkdirSync(path.join(app, 'dist'), { recursive: true });
    fs.writeFileSync(
      path.join(app, 'dist/keep'),
      'vue-lynx-bench-artifact-v1|mode=vapor|rows=0|ifr=0|et=0',
    );
    fs.writeFileSync(path.join(out, 'keep'), 'keep');

    execFileSync(process.execPath, [
      path.join(process.cwd(), 'scripts/build-vue-featured.mjs'),
      source,
      '--lab',
      '--variant',
      'ifr',
      '--rows',
      '0',
      '--out',
      out,
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BENCH_CELL: 'off',
        BENCH_ENABLE_IFR: '1',
        BENCH_ENABLE_ET: '1',
      },
      stdio: 'pipe',
    });

    assert.equal(fs.readFileSync(path.join(app, 'dist/keep'), 'utf8').includes('mode=vapor|'), true);
    assert.equal(fs.readFileSync(path.join(out, 'keep'), 'utf8'), 'keep');
    assert.equal(fs.existsSync(path.join(app, 'dist-ifr/stale')), false);
    assert.equal(fs.existsSync(path.join(app, 'node_modules/.cache')), false);
    const assertions = JSON.parse(fs.readFileSync(
      path.join(out, 'vue-vapor-ifr/rows-0/artifact-assertions.json'),
      'utf8',
    ));
    assert.equal(assertions.marker, expectedVueArtifactMarker(
      vueVaporArtifactExpectation('ifr', 0),
    ));
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('receipt issuance rejects non-canonical fixture assertions', () => {
  const fixture = makeFixture();
  try {
    assert.throws(
      () => createVueVaporLabEntry({
        root: fixture.benchmark,
        labRoot: fixture.labRoot,
        sourceCheckout: fixture.sourceA.checkout,
        variant: 'vapor',
        suffix: 'noncanonical-assertions',
        rows: [0],
        runBuild: (options) => {
          const command = stubBuild(options);
          fs.appendFileSync(
            path.join(
              options.buildOut,
              'vue-vapor/rows-0/artifact-assertions.json',
            ),
            ' ',
          );
          return command;
        },
        toolchain,
        now: () => new Date('2026-08-16T00:00:00.000Z'),
      }),
      /artifact assertions are not canonical/,
    );
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test('two checkout builds coexist as distinct lab IDs with reproducible receipts', () => {
  const fixture = makeFixture();
  try {
    const common = {
      root: fixture.benchmark,
      labRoot: fixture.labRoot,
      variant: 'vapor',
      rows: '0,1k',
      runBuild: stubBuild,
      toolchain,
      now: () => new Date('2026-08-16T00:00:00.000Z'),
    };
    const a = createVueVaporLabEntry({
      ...common,
      sourceCheckout: fixture.sourceA.checkout,
      suffix: 'a',
    });
    const b = createVueVaporLabEntry({
      ...common,
      sourceCheckout: fixture.sourceB.checkout,
      id: 'vue-vapor-experiment-b',
    });

    assert.equal(a.entryId, 'vue-vapor-a');
    assert.equal(b.entryId, 'vue-vapor-experiment-b');
    assert.equal(a.receipt.source.head, fixture.sourceA.head);
    assert.equal(b.receipt.source.head, fixture.sourceB.head);
    assert.equal(a.receipt.benchmark.head, fixture.benchmarkHead);
    assert.deepEqual(
      a.receipt.build.cells,
      [vueVaporBuildCell('vapor', 0), vueVaporBuildCell('vapor', 1000)],
    );
    assert.equal(a.manifest.tier, 'lab');
    assert.equal(b.manifest.tier, 'lab');
    assert.equal(fs.existsSync(path.join(fixture.labRoot, 'entries/vue-vapor-a')), true);
    assert.equal(
      fs.existsSync(path.join(fixture.labRoot, 'entries/vue-vapor-experiment-b')),
      true,
    );

    for (const result of [a, b]) {
      const verified = verifyVueVaporLabEntry(result.entryDir);
      assert.equal(verified.bundleCount, 4);
      const receiptBytes = fs.readFileSync(path.join(result.entryDir, 'receipt.json'));
      assert.equal(
        crypto.createHash('sha256').update(receiptBytes).digest('hex'),
        result.artifactHashes['receipt.json'],
      );
      for (const metadata of Object.values(result.receipt.bundles)) {
        assert.ok(metadata.rawBytes > 0);
        assert.ok(metadata.gzipBytes > 0);
        assert.match(metadata.sha256, /^[a-f0-9]{64}$/);
      }
    }

    const tampered = path.join(a.entryDir, 'dist/rows-0/main.web.bundle');
    fs.appendFileSync(tampered, 'tamper');
    assert.throws(() => verifyVueVaporLabEntry(a.entryDir), /raw bytes|sha256/);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test('source and entry locks reject overlapping builds before attribution can mix', () => {
  const fixture = makeFixture();
  try {
    let sameSourceRejected = false;
    let sameEntryRejected = false;
    const outer = createVueVaporLabEntry({
      root: fixture.benchmark,
      labRoot: fixture.labRoot,
      sourceCheckout: fixture.sourceA.checkout,
      variant: 'vapor',
      suffix: 'outer',
      rows: [0],
      runBuild: (options) => {
        assert.throws(
          () => createVueVaporLabEntry({
            root: fixture.benchmark,
            labRoot: fixture.labRoot,
            sourceCheckout: fixture.sourceA.checkout,
            variant: 'vapor',
            suffix: 'same-source',
            rows: [0],
            runBuild: stubBuild,
            toolchain,
          }),
          /build lock is already held/,
        );
        sameSourceRejected = true;
        assert.throws(
          () => createVueVaporLabEntry({
            root: fixture.benchmark,
            labRoot: fixture.labRoot,
            sourceCheckout: fixture.sourceB.checkout,
            variant: 'vapor',
            suffix: 'outer',
            rows: [0],
            runBuild: stubBuild,
            toolchain,
          }),
          /build lock is already held/,
        );
        sameEntryRejected = true;
        return stubBuild(options);
      },
      toolchain,
      now: () => new Date('2026-08-16T00:00:00.000Z'),
    });
    assert.equal(sameSourceRejected, true);
    assert.equal(sameEntryRejected, true);
    assert.equal(outer.receipt.source.head, fixture.sourceA.head);
    assert.equal(
      fs.existsSync(path.join(fixture.labRoot, 'entries/vue-vapor-same-source')),
      false,
    );
    assert.equal(
      fs.readdirSync(path.join(fixture.labRoot, 'work')).length,
      0,
    );
    verifyVueVaporLabEntry(outer.entryDir);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test('portable pnpm override is recorded and version mismatch fails before build work', () => {
  const fixture = makeFixture();
  const matching = path.join(fixture.temporary, 'pnpm-matching');
  const mismatch = path.join(fixture.temporary, 'pnpm-mismatch');
  try {
    writeExecutable(matching, '#!/bin/sh\nprintf "10.32.1\\n"\n');
    writeExecutable(mismatch, '#!/bin/sh\nprintf "9.0.0\\n"\n');
    let mismatchBuildCalled = false;
    assert.throws(
      () => createVueVaporLabEntry({
        root: fixture.benchmark,
        labRoot: fixture.labRoot,
        sourceCheckout: fixture.sourceA.checkout,
        variant: 'vapor',
        suffix: 'pnpm-mismatch',
        rows: [0],
        pnpmExecutable: mismatch,
        runBuild: () => {
          mismatchBuildCalled = true;
        },
      }),
      /pnpm version mismatch: declared 10\.32\.1, actual 9\.0\.0/,
    );
    assert.equal(mismatchBuildCalled, false);

    const result = createVueVaporLabEntry({
      root: fixture.benchmark,
      labRoot: fixture.labRoot,
      sourceCheckout: fixture.sourceA.checkout,
      variant: 'vapor',
      suffix: 'pnpm-matching',
      rows: [0],
      pnpmExecutable: matching,
      runBuild: stubBuild,
      now: () => new Date('2026-08-16T00:00:00.000Z'),
    });
    assert.deepEqual(result.receipt.toolchain, {
      node: process.version,
      pnpm: '10.32.1',
      pnpmCommand: [matching],
      pnpmPath: matching,
      declaredPnpm: 'pnpm@10.32.1',
    });
    verifyVueVaporLabEntry(result.entryDir);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test('failed replace restores ignored source outputs and preserves the prior entry byte-for-byte', () => {
  const fixture = makeFixture();
  try {
    const original = createVueVaporLabEntry({
      root: fixture.benchmark,
      labRoot: fixture.labRoot,
      sourceCheckout: fixture.sourceA.checkout,
      variant: 'vapor',
      suffix: 'rollback',
      rows: [0],
      runBuild: stubBuild,
      toolchain,
      now: () => new Date('2026-08-16T00:00:00.000Z'),
    });
    const sourceOutputs = [
      ['packages/vue-lynx/runtime/dist/keep.js', 'runtime-before'],
      ['packages/vue-lynx/plugin/.rslib/keep.json', 'plugin-before'],
      ['packages/benchmark/apps/ui-vapor/dist/main.web.bundle', 'vapor-before'],
      ['packages/benchmark/apps/ui-vapor/node_modules/.cache/keep', 'cache-before'],
    ];
    for (const [relative, bytes] of sourceOutputs) {
      const file = path.join(fixture.sourceA.checkout, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes);
    }
    const entryBefore = treeSnapshot(original.entryDir);
    const outputsBefore = sourceOutputs.map(([relative]) => [
      relative,
      treeSnapshot(path.join(fixture.sourceA.checkout, path.dirname(relative))),
    ]);

    assert.throws(
      () => createVueVaporLabEntry({
        root: fixture.benchmark,
        labRoot: fixture.labRoot,
        sourceCheckout: fixture.sourceA.checkout,
        variant: 'vapor',
        suffix: 'rollback',
        rows: [0],
        replace: true,
        runBuild: (options) => {
          for (const [relative] of sourceOutputs) {
            fs.writeFileSync(
              path.join(fixture.sourceA.checkout, relative),
              'mutated-during-build',
            );
          }
          stubBuild(options);
          throw new Error('mid-build failure');
        },
        toolchain,
      }),
      /mid-build failure/,
    );

    assert.deepEqual(treeSnapshot(original.entryDir), entryBefore);
    for (const [relative, before] of outputsBefore) {
      assert.deepEqual(
        treeSnapshot(path.join(fixture.sourceA.checkout, path.dirname(relative))),
        before,
      );
    }
    assert.equal(fs.readdirSync(path.join(fixture.labRoot, 'work')).length, 0);
    fs.mkdirSync(
      path.join(fixture.labRoot, 'entries/vue-vapor-rollback.123.tmp'),
      { recursive: true },
    );
    verifyVueVaporLabRoot(fixture.labRoot);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test('Rspeedy package bytes and version split receipts, and evidence tampering is rejected', () => {
  const fixture = makeFixture();
  try {
    const create = (labName, toolOptions) => createVueVaporLabEntry({
      root: fixture.benchmark,
      labRoot: path.join(fixture.benchmark, '.tmp', labName),
      sourceCheckout: fixture.sourceA.checkout,
      variant: 'vapor',
      suffix: 'tool-identity',
      rows: [0],
      runBuild: (options) => stubBuild(options, toolOptions),
      toolchain,
      now: () => new Date('2026-08-16T00:00:00.000Z'),
    });
    const first = create('tool-identity-a', {
      version: '0.13.5',
      binary: '#!/usr/bin/env node\n// first\n',
    });
    const changedBytes = create('tool-identity-b', {
      version: '0.13.5',
      binary: '#!/usr/bin/env node\n// second\n',
    });
    const changedVersion = create('tool-identity-c', {
      version: '0.13.6',
      binary: '#!/usr/bin/env node\n// first\n',
    });
    const identity = (result) => result.receipt.build.tools[0].rspeedy;
    assert.notEqual(identity(first).fingerprint, identity(changedBytes).fingerprint);
    assert.notEqual(identity(first).fingerprint, identity(changedVersion).fingerprint);
    assert.notEqual(
      first.artifactHashes['receipt.json'],
      changedBytes.artifactHashes['receipt.json'],
    );
    assert.notEqual(
      first.artifactHashes['receipt.json'],
      changedVersion.artifactHashes['receipt.json'],
    );

    const evidence = vueBuildToolEvidencePaths(identity(first).fingerprint);
    fs.appendFileSync(
      path.join(first.entryDir, evidence.packageTree, 'bin/rspeedy.js'),
      '// tamper\n',
    );
    assert.throws(
      () => verifyVueVaporLabEntry(first.entryDir),
      /Rspeedy package tree sha256/,
    );
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test('dirty source fails by default and an explicit override records its patch', () => {
  const fixture = makeFixture();
  try {
    const dirtyFile = path.join(fixture.sourceA.checkout, 'packages/benchmark/fixture.txt');
    fs.appendFileSync(dirtyFile, '\ndirty\n');
    const options = {
      root: fixture.benchmark,
      labRoot: fixture.labRoot,
      sourceCheckout: fixture.sourceA.checkout,
      variant: 'ifr',
      suffix: 'dirty',
      rows: [0],
      runBuild: stubBuild,
      toolchain,
      now: () => new Date('2026-08-16T00:00:00.000Z'),
    };
    assert.throws(() => createVueVaporLabEntry(options), /source checkout is dirty/);
    const result = createVueVaporLabEntry({ ...options, allowDirty: true });
    assert.equal(result.receipt.source.dirty, true);
    assert.equal(result.receipt.source.dirtyAllowed, true);
    assert.ok(result.receipt.source.patch.bytes > 0);
    assert.match(result.receipt.source.patch.sha256, /^[a-f0-9]{64}$/);
    assert.equal(fs.existsSync(path.join(result.entryDir, 'source.patch')), true);
    verifyVueVaporLabEntry(result.entryDir);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test('lab runner pins the live benchmark worktree used by every receipt', () => {
  const fixture = makeFixture();
  try {
    const result = createVueVaporLabEntry({
      root: fixture.benchmark,
      labRoot: fixture.labRoot,
      sourceCheckout: fixture.sourceA.checkout,
      variant: 'vapor',
      suffix: 'runner-state',
      rows: [0],
      runBuild: stubBuild,
      toolchain,
      now: () => new Date('2026-08-16T00:00:00.000Z'),
    });
    const verified = verifyVueVaporLabEntry(result.entryDir);
    const pinned = verifyVueVaporLabBenchmarkState(fixture.benchmark, [verified]);
    assert.equal(pinned.head, fixture.benchmarkHead);

    fs.appendFileSync(path.join(fixture.benchmark, 'package.json'), '\n');
    assert.throws(
      () => verifyVueVaporLabBenchmarkState(fixture.benchmark, [verified], pinned),
      /changed while the measurement was running/,
    );
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test('verifier rejects featured tier and unreceipted manifest bundles', () => {
  const fixture = makeFixture();
  try {
    const create = (suffix) => createVueVaporLabEntry({
      root: fixture.benchmark,
      labRoot: fixture.labRoot,
      sourceCheckout: fixture.sourceA.checkout,
      variant: 'vapor',
      suffix,
      rows: [0],
      runBuild: stubBuild,
      toolchain,
      now: () => new Date('2026-08-16T00:00:00.000Z'),
    });

    const featured = create('featured');
    rewriteJson(path.join(featured.entryDir, 'entry.json'), (manifest) => {
      manifest.tier = 'featured';
    });
    refreshArtifactHashes(featured.entryDir);
    assert.throws(
      () => verifyVueVaporLabEntry(featured.entryDir),
      /manifest tier/,
    );

    const unreceipted = create('unreceipted');
    const extra = path.join(unreceipted.entryDir, 'dist/rows-0/unreceipted.web.bundle');
    fs.writeFileSync(extra, 'not in receipt');
    rewriteJson(path.join(unreceipted.entryDir, 'entry.json'), (manifest) => {
      manifest.bundles.web = 'dist/rows-0/unreceipted.web.bundle';
    });
    refreshArtifactHashes(unreceipted.entryDir);
    assert.throws(
      () => verifyVueVaporLabEntry(unreceipted.entryDir),
      /manifest web bundle/,
    );
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test('verifier cross-checks variant, rows, and the exact receipt bundle set', () => {
  const fixture = makeFixture();
  try {
    const create = (suffix) => createVueVaporLabEntry({
      root: fixture.benchmark,
      labRoot: fixture.labRoot,
      sourceCheckout: fixture.sourceA.checkout,
      variant: 'vapor',
      suffix,
      rows: [0],
      runBuild: stubBuild,
      toolchain,
      now: () => new Date('2026-08-16T00:00:00.000Z'),
    });

    const variant = create('variant');
    rewriteJson(path.join(variant.entryDir, 'receipt.json'), (receipt) => {
      receipt.variant = 'ifr';
    });
    refreshReceiptLink(variant.entryDir);
    assert.throws(() => verifyVueVaporLabEntry(variant.entryDir), /receipt variant/);

    const rows = create('rows');
    rewriteJson(path.join(rows.entryDir, 'receipt.json'), (receipt) => {
      receipt.rows = [1000];
    });
    refreshReceiptLink(rows.entryDir);
    assert.throws(
      () => verifyVueVaporLabEntry(rows.entryDir),
      /receipt build cells|receipt bundle set/,
    );

    const bundleSet = create('bundle-set');
    rewriteJson(path.join(bundleSet.entryDir, 'receipt.json'), (receipt) => {
      receipt.bundles['rows-999/main.web.bundle'] = {
        ...receipt.bundles['rows-0/main.web.bundle'],
        path: 'dist/rows-0/main.web.bundle',
      };
    });
    refreshReceiptLink(bundleSet.entryDir);
    assert.throws(() => verifyVueVaporLabEntry(bundleSet.entryDir), /receipt bundle set/);

    const buildCell = create('build-cell');
    rewriteJson(path.join(buildCell.entryDir, 'receipt.json'), (receipt) => {
      receipt.build.cells[0].outputPath = 'packages/benchmark/apps/ui-vapor/dist-ifr';
    });
    refreshReceiptLink(buildCell.entryDir);
    assert.throws(() => verifyVueVaporLabEntry(buildCell.entryDir), /receipt build cells/);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test('legacy receipts fail closed with an explicit rebuild migration error', () => {
  const fixture = makeFixture();
  try {
    const result = createVueVaporLabEntry({
      root: fixture.benchmark,
      labRoot: fixture.labRoot,
      sourceCheckout: fixture.sourceA.checkout,
      variant: 'vapor',
      suffix: 'legacy',
      rows: [0],
      runBuild: stubBuild,
      toolchain,
      now: () => new Date('2026-08-16T00:00:00.000Z'),
    });
    rewriteJson(path.join(result.entryDir, 'receipt.json'), (receipt) => {
      receipt.schemaVersion = 2;
    });
    refreshReceiptLink(result.entryDir);
    assert.throws(
      () => verifyVueVaporLabEntry(result.entryDir),
      /remove and rebuild this legacy \.tmp lab entry/,
    );
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test('verifier rejects artifact assertion file and semantic tampering', () => {
  const fixture = makeFixture();
  try {
    const create = (suffix) => createVueVaporLabEntry({
      root: fixture.benchmark,
      labRoot: fixture.labRoot,
      sourceCheckout: fixture.sourceA.checkout,
      variant: 'vapor',
      suffix,
      rows: [0],
      runBuild: stubBuild,
      toolchain,
      now: () => new Date('2026-08-16T00:00:00.000Z'),
    });

    const fileTamper = create('assertion-file-tamper');
    fs.appendFileSync(
      path.join(fileTamper.entryDir, 'dist/rows-0/artifact-assertions.json'),
      ' ',
    );
    assert.throws(
      () => verifyVueVaporLabEntry(fileTamper.entryDir),
      /artifact-assertions\.json bytes|artifact-assertions\.json sha256/,
    );

    const semanticTamper = create('assertion-semantic-tamper');
    const assertionPath = path.join(
      semanticTamper.entryDir,
      'dist/rows-0/artifact-assertions.json',
    );
    const assertions = JSON.parse(fs.readFileSync(assertionPath, 'utf8'));
    assertions.assertions.mode = 'vapor-ifr';
    const assertionBytes = vueArtifactAssertionsBytes(assertions);
    fs.writeFileSync(assertionPath, assertionBytes);
    rewriteJson(path.join(semanticTamper.entryDir, 'receipt.json'), (receipt) => {
      const metadata = receipt.artifactAssertions['rows-0/artifact-assertions.json'];
      metadata.bytes = assertionBytes.length;
      metadata.sha256 = crypto.createHash('sha256').update(assertionBytes).digest('hex');
      metadata.assertions = assertions;
    });
    refreshReceiptLink(semanticTamper.entryDir);
    assert.throws(
      () => verifyVueVaporLabEntry(semanticTamper.entryDir),
      /artifact assertion mode/,
    );
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test('runtime preflight requires each selected row and matching receipted assertion', () => {
  const fixture = makeFixture();
  try {
    const result = createVueVaporLabEntry({
      root: fixture.benchmark,
      labRoot: fixture.labRoot,
      sourceCheckout: fixture.sourceA.checkout,
      variant: 'vapor',
      suffix: 'runtime-preflight',
      rows: [0],
      runBuild: stubBuild,
      toolchain,
      now: () => new Date('2026-08-16T00:00:00.000Z'),
    });
    const verified = verifyVueVaporLabEntry(result.entryDir);
    const entry = { id: result.entryId, dir: result.entryDir };
    const entries = new Map([[entry.id, verified]]);
    assert.throws(
      () => assertVueVaporLabSelectedRows([entry], entries, ['startup'], [1000]),
      /selected row 1000 is not receipted/,
    );
    fs.appendFileSync(
      path.join(result.entryDir, 'dist/rows-0/main.web.bundle'),
      ':mutated-after-verification',
    );
    assert.throws(
      () => assertVueVaporLabSelectedRows([entry], entries, ['table'], [1000]),
      /raw bytes|sha256/,
    );
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test('verifier rejects symlink artifacts, patches, and bundles', () => {
  const fixture = makeFixture();
  try {
    const create = (suffix, options = {}) => createVueVaporLabEntry({
      root: fixture.benchmark,
      labRoot: fixture.labRoot,
      sourceCheckout: fixture.sourceA.checkout,
      variant: 'vapor',
      suffix,
      rows: [0],
      runBuild: stubBuild,
      toolchain,
      now: () => new Date('2026-08-16T00:00:00.000Z'),
      ...options,
    });

    const artifact = create('artifact-link');
    const receiptPath = path.join(artifact.entryDir, 'receipt.json');
    const receiptCopy = path.join(artifact.entryDir, 'receipt-copy.json');
    fs.copyFileSync(receiptPath, receiptCopy);
    fs.rmSync(receiptPath);
    fs.symlinkSync('receipt-copy.json', receiptPath);
    assert.throws(() => verifyVueVaporLabEntry(artifact.entryDir), /symlink/);

    const bundle = create('bundle-link');
    const bundlePath = path.join(bundle.entryDir, 'dist/rows-0/main.web.bundle');
    const bundleCopy = path.join(bundle.entryDir, 'dist/rows-0/main.web.copy');
    fs.copyFileSync(bundlePath, bundleCopy);
    fs.rmSync(bundlePath);
    fs.symlinkSync('main.web.copy', bundlePath);
    assert.throws(() => verifyVueVaporLabEntry(bundle.entryDir), /symlink/);

    fs.appendFileSync(
      path.join(fixture.sourceA.checkout, 'packages/benchmark/fixture.txt'),
      '\ndirty\n',
    );
    const patch = create('patch-link', { allowDirty: true });
    const patchPath = path.join(patch.entryDir, 'source.patch');
    const patchCopy = path.join(patch.entryDir, 'source.copy.patch');
    fs.copyFileSync(patchPath, patchCopy);
    fs.rmSync(patchPath);
    fs.symlinkSync('source.copy.patch', patchPath);
    assert.throws(() => verifyVueVaporLabEntry(patch.entryDir), /symlink/);
  } finally {
    fs.rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test('verifier CLI rejects comma, missing, and unknown entry arguments', () => {
  const script = path.join(process.cwd(), 'scripts/lab/verify-vue-vapor-lab.mjs');
  for (const argv of [
    ['--entry', 'vue-vapor-a,vue-vapor-b'],
    ['--entry'],
    ['--bogus', 'value'],
  ]) {
    const result = spawnSync(process.execPath, [script, ...argv], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--entry must match|--entry requires a value|unexpected argument/);
  }
});
