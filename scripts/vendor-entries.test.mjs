import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const sourceScript = new URL('./vendor-entries.mjs', import.meta.url).pathname;
const listWorkloadsSource = new URL(
  '../packages/shared/src/list-workloads.mjs',
  import.meta.url,
).pathname;
const CAPACITY_SCALES = [1000, 6000, 7000, 7500, 8000, 10000];
const LIST_SCALES = [1000, 10000];

function stageVendorScript(repo) {
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  fs.copyFileSync(sourceScript, path.join(repo, 'scripts/vendor-entries.mjs'));
  const listWorkloads = path.join(repo, 'packages/shared/src/list-workloads.mjs');
  fs.mkdirSync(path.dirname(listWorkloads), { recursive: true });
  fs.copyFileSync(listWorkloadsSource, listWorkloads);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function writeNativeBuildReceipt(build, sourceCommit) {
  const payload = {
    protocol: 'octane-native-diagnostic-build-v3',
    sourceCommit,
    artifacts: {
      table: {
        path: 'benchmarks/lynx-table/app/dist/main.lynx.bundle',
        sha256: sha256(fs.readFileSync(path.join(
          build,
          'benchmarks/lynx-table/app/dist/main.lynx.bundle',
        ))),
      },
      capacity: Object.fromEntries(CAPACITY_SCALES.map((rows) => [String(rows), {
        path: `benchmarks/lynx-table/app/dist-rows${rows}/main.lynx.bundle`,
        sha256: sha256(fs.readFileSync(path.join(
          build,
          `benchmarks/lynx-table/app/dist-rows${rows}/main.lynx.bundle`,
        ))),
      }])),
      list: Object.fromEntries(LIST_SCALES.map((rows) => [String(rows), {
        path: `benchmarks/lynx-list/app/dist/rows-${rows}/main.lynx.bundle`,
        sha256: sha256(fs.readFileSync(path.join(
          build,
          `benchmarks/lynx-list/app/dist/rows-${rows}/main.lynx.bundle`,
        ))),
      }])),
    },
  };
  const receipt = { ...payload, sha256: sha256(JSON.stringify(payload)) };
  fs.writeFileSync(
    path.join(build, 'benchmarks/lynx-list/app/dist/octane-native-diagnostic-build.json'),
    JSON.stringify(receipt, null, 2),
  );
  return receipt;
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

test('new-lynx vendor publishes the clean featured Web-only Octane Hux identity', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-new-lynx-block-'));
  const repo = path.join(dir, 'benchmark');
  const build = path.join(dir, 'octane');
  try {
    stageVendorScript(repo);
    fs.mkdirSync(path.join(build, 'packages/octane'), { recursive: true });
    fs.writeFileSync(
      path.join(build, 'packages/octane/package.json'),
      JSON.stringify({ version: '9.9.9' }),
    );
    for (const rows of [0, 1000, 10000, 30000]) {
      const output = path.join(
        build,
        'benchmarks/lynx-table/app',
        rows === 0 ? 'dist-block' : `dist-block-rows${rows}`,
      );
      fs.mkdirSync(output, { recursive: true });
      fs.writeFileSync(path.join(output, 'main.web.bundle'), `block-web-${rows}`);
      fs.writeFileSync(path.join(output, 'main.lynx.bundle'), `block-lynx-${rows}`);
    }
    git(build, 'init', '-b', 'new-lynx');
    git(build, 'config', 'user.name', 'Vendor Test');
    git(build, 'config', 'user.email', 'vendor@example.test');
    git(build, 'add', '.');
    git(build, 'commit', '-m', 'block snapshot');
    const patchedSource = path.join(
      build,
      'benchmarks/lynx-table/app/src/block-program.ts',
    );
    fs.mkdirSync(path.dirname(patchedSource), { recursive: true });
    fs.writeFileSync(patchedSource, 'baseline\n');
    git(build, 'add', '.');
    git(build, 'commit', '-m', 'block source');
    const commit = git(build, 'rev-parse', 'HEAD');
    const vendored = spawnSync(
      process.execPath,
      [path.join(repo, 'scripts/vendor-entries.mjs')],
      {
        cwd: repo,
        env: {
          ...process.env,
          VENDOR_ONLY: 'octane-hux',
          OCTANE_NEW_BUILD: build,
        },
        encoding: 'utf8',
      },
    );
    assert.equal(vendored.status, 0, vendored.stderr);
    const manifest = JSON.parse(fs.readFileSync(
      path.join(repo, 'entries/octane-hux/entry.json'),
      'utf8',
    ));
    assert.equal(manifest.id, 'octane-hux');
    assert.equal(manifest.label, 'Octane (Hux)');
    assert.equal(manifest.tier, 'featured');
    assert.deepEqual(manifest.harnesses, ['web']);
    assert.equal(manifest.provenance.commit, commit);
    assert.equal(manifest.provenance.ref, 'new-lynx');
    assert.equal(manifest.provenance.patched, false);
    assert.equal(manifest.provenance.patchFile, null);
    assert.deepEqual(manifest.provenance.buildEnv, {
      BENCH_CORE: 'block',
      BENCH_BLOCK_MODE: 'scoped',
    });
    assert.match(manifest.provenance.buildCommand, /BENCH_CORE=block/);
    assert.equal(Object.keys(manifest.provenance.sha256).length, 8);
    assert.equal(manifest.webLab, undefined);
    assert.equal(manifest.nativeLab, undefined);

    fs.writeFileSync(path.join(build, 'packages/octane/dirty'), 'dirty');
    const dirty = spawnSync(
      process.execPath,
      [path.join(repo, 'scripts/vendor-entries.mjs')],
      {
        cwd: repo,
        env: {
          ...process.env,
          VENDOR_ONLY: 'octane-hux',
          OCTANE_NEW_BUILD: build,
        },
        encoding: 'utf8',
      },
    );
    assert.notEqual(dirty.status, 0);
    assert.match(dirty.stderr, /must be built from a clean checkout/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PR #791 vendor keeps a clean Web-only archive entry', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-octane-pr-791-'));
  const repo = path.join(dir, 'benchmark');
  const build = path.join(dir, 'octane');
  try {
    stageVendorScript(repo);
    fs.mkdirSync(path.join(build, 'packages/octane'), { recursive: true });
    fs.writeFileSync(
      path.join(build, 'packages/octane/package.json'),
      JSON.stringify({ version: '0.1.41' }),
    );
    for (const rows of [0, 1000, 10000, 30000]) {
      const output = path.join(
        build,
        'benchmarks/lynx-table/app',
        rows === 0 ? 'dist' : `dist-rows${rows}`,
      );
      fs.mkdirSync(output, { recursive: true });
      fs.writeFileSync(path.join(output, 'main.web.bundle'), `pr-web-${rows}`);
      fs.writeFileSync(path.join(output, 'main.lynx.bundle'), `pr-lynx-${rows}`);
    }
    const patchedPaths = [
      'benchmarks/lynx-table/app/src/App.lynx.tsrx',
      'benchmarks/lynx-table/app/src/app.css',
      'benchmarks/lynx-table/app/src/index.ts',
      'packages/lynx/src/core/transport.ts',
      'packages/lynx/src/main-thread.ts',
    ];
    for (const relative of patchedPaths) {
      const file = path.join(build, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'baseline\n');
    }
    git(build, 'init', '-b', 'pr-791');
    git(build, 'config', 'user.name', 'Vendor Test');
    git(build, 'config', 'user.email', 'vendor@example.test');
    git(build, 'add', '.');
    git(build, 'commit', '-m', 'PR snapshot');
    const commit = git(build, 'rev-parse', 'HEAD');
    const vendored = spawnSync(process.execPath, [path.join(repo, 'scripts/vendor-entries.mjs')], {
      cwd: repo,
      env: {
        ...process.env,
        VENDOR_ONLY: 'octane-pr-791',
        OCTANE_PR_791_BUILD: build,
      },
      encoding: 'utf8',
    });
    assert.equal(vendored.status, 0, vendored.stderr);
    const manifest = JSON.parse(fs.readFileSync(
      path.join(repo, 'entries/octane-pr-791/entry.json'),
      'utf8',
    ));
    assert.equal(manifest.label, 'Octane (PR #791)');
    assert.equal(manifest.tier, 'archive');
    assert.equal(manifest.supersededBy, 'octane');
    assert.deepEqual(manifest.harnesses, ['web']);
    assert.equal(manifest.provenance.commit, commit);
    assert.equal(manifest.provenance.ref, 'pull/791/head');
    assert.equal(manifest.provenance.mergedInto, '939c64dc9d9f0fd5c5fe50255fe75ce592d0b31a');
    assert.equal(manifest.provenance.patched, false);
    assert.equal(manifest.provenance.patchFile, null);
    assert.equal(Object.keys(manifest.provenance.sha256).length, 8);

    fs.appendFileSync(path.join(build, 'packages/lynx/src/core/transport.ts'), 'instrumented\n');
    const dirty = spawnSync(process.execPath, [path.join(repo, 'scripts/vendor-entries.mjs')], {
      cwd: repo,
      env: {
        ...process.env,
        VENDOR_ONLY: 'octane-pr-791',
        OCTANE_PR_791_BUILD: build,
      },
      encoding: 'utf8',
    });
    assert.notEqual(dirty.status, 0);
    assert.match(dirty.stderr, /must be built from a clean checkout/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('native diagnostic vendor generates all immutable Native fixture inputs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-octane-native-diagnostic-'));
  const repo = path.join(dir, 'benchmark');
  const build = path.join(dir, 'octane');
  try {
    stageVendorScript(repo);
    const featuredManifest = path.join(repo, 'entries/octane/entry.json');
    fs.mkdirSync(path.dirname(featuredManifest), { recursive: true });
    fs.writeFileSync(featuredManifest, '{"featured":"unchanged"}\n');
    const featuredBefore = fs.readFileSync(featuredManifest);

    fs.mkdirSync(path.join(build, 'packages/octane'), { recursive: true });
    fs.writeFileSync(
      path.join(build, 'packages/octane/package.json'),
      JSON.stringify({ version: '0.2.2' }),
    );
    const tableBundle = path.join(
      build,
      'benchmarks/lynx-table/app/dist/main.lynx.bundle',
    );
    const listBundles = Object.fromEntries(LIST_SCALES.map((rows) => [
      String(rows),
      path.join(build, `benchmarks/lynx-list/app/dist/rows-${rows}/main.lynx.bundle`),
    ]));
    fs.mkdirSync(path.dirname(tableBundle), { recursive: true });
    fs.writeFileSync(tableBundle, 'empty-table-native');
    for (const rows of CAPACITY_SCALES) {
      const capacityBundle = path.join(
        build,
        `benchmarks/lynx-table/app/dist-rows${rows}/main.lynx.bundle`,
      );
      fs.mkdirSync(path.dirname(capacityBundle), { recursive: true });
      fs.writeFileSync(capacityBundle, `lynx-native-startup-v1 eager-table-native-${rows}`);
    }
    for (const rows of LIST_SCALES) {
      fs.mkdirSync(path.dirname(listBundles[String(rows)]), { recursive: true });
      fs.writeFileSync(listBundles[String(rows)], `bounded-list-native-${rows}`);
    }
    fs.writeFileSync(
      path.join(build, '.gitignore'),
      'benchmarks/lynx-table/app/dist*/\nbenchmarks/lynx-list/app/dist/\n',
    );

    git(build, 'init', '-b', 'main');
    git(build, 'config', 'user.name', 'Vendor Test');
    git(build, 'config', 'user.email', 'vendor@example.test');
    git(build, 'add', '.');
    git(build, 'commit', '-m', 'native fixtures');
    const commit = git(build, 'rev-parse', 'HEAD');
    const buildReceipt = writeNativeBuildReceipt(build, commit);

    const vendored = spawnSync(
      process.execPath,
      [path.join(repo, 'scripts/vendor-entries.mjs')],
      {
        cwd: repo,
        env: {
          ...process.env,
          VENDOR_ONLY: 'octane-native-diagnostic',
          OCTANE_BUILD: build,
        },
        encoding: 'utf8',
      },
    );

    assert.equal(vendored.status, 0, vendored.stderr);
    const entryDir = path.join(repo, 'entries/octane-native-diagnostic');
    const manifest = JSON.parse(fs.readFileSync(path.join(entryDir, 'entry.json'), 'utf8'));
    const tableSha256 = sha256('empty-table-native');
    const list = Object.fromEntries(LIST_SCALES.map((rows) => {
      const contents = `bounded-list-native-${rows}`;
      return [String(rows), {
        bundle: `dist/list/rows-${rows}/main.lynx.bundle`,
        sha256: sha256(contents),
      }];
    }));
    const capacity = Object.fromEntries(CAPACITY_SCALES.map((rows) => {
      const contents = `lynx-native-startup-v1 eager-table-native-${rows}`;
      return [String(rows), {
        bundle: `dist/capacity/rows-${rows}/main.lynx.bundle`,
        sha256: sha256(contents),
      }];
    }));
    assert.equal(manifest.id, 'octane-native-diagnostic');
    assert.equal(manifest.tier, 'lab');
    assert.deepEqual(manifest.harnesses, ['native']);
    assert.deepEqual(manifest.tags, ['diagnostic', 'capacity-probe']);
    assert.deepEqual(manifest.bundles, {
      lynx: 'dist/table/main.lynx.bundle',
    });
    assert.deepEqual(manifest.capacityFixture, {
      protocol: 'lynx-native-capacity-fixture-v1',
      fixtureRole: 'eager-capacity-probe',
      topology: { elementsPerRow: 7, chromeElements: 42 },
      scales: capacity,
    });
    assert.deepEqual(manifest.listFixture, {
      protocol: 'lynx-list-fixture-v2',
      workloadProtocol: 'lynx-list-fixture-v1',
      contractSha256: '8cc9d901f97e6e17ac6207b13d9bb9afb5163ce0d1142cffd1b1921726a2f87b',
      scales: list,
    });
    assert.equal(manifest.provenance.commit, commit);
    assert.equal(manifest.provenance.ref, commit);
    assert.equal(manifest.provenance.patched, false);
    assert.equal(manifest.provenance.patchFile, null);
    assert.deepEqual(manifest.provenance.buildReceipt, buildReceipt);
    assert.deepEqual(manifest.provenance.sha256, {
      'table/main.lynx.bundle': tableSha256,
      ...Object.fromEntries(CAPACITY_SCALES.map((rows) => [
        `capacity/rows-${rows}/main.lynx.bundle`,
        capacity[String(rows)].sha256,
      ])),
      ...Object.fromEntries(LIST_SCALES.map((rows) => [
        `list/rows-${rows}/main.lynx.bundle`,
        list[String(rows)].sha256,
      ])),
    });
    assert.equal(
      fs.readFileSync(path.join(entryDir, manifest.bundles.lynx), 'utf8'),
      'empty-table-native',
    );
    for (const rows of CAPACITY_SCALES) {
      assert.equal(
        fs.readFileSync(
          path.join(entryDir, manifest.capacityFixture.scales[String(rows)].bundle),
          'utf8',
        ),
        `lynx-native-startup-v1 eager-table-native-${rows}`,
      );
    }
    for (const rows of LIST_SCALES) {
      assert.equal(
        fs.readFileSync(path.join(entryDir, manifest.listFixture.scales[String(rows)].bundle), 'utf8'),
        `bounded-list-native-${rows}`,
      );
    }
    assert.deepEqual(fs.readFileSync(featuredManifest), featuredBefore);

    const manifestBeforeRepeat = fs.readFileSync(path.join(entryDir, 'entry.json'));
    const repeated = spawnSync(
      process.execPath,
      [path.join(repo, 'scripts/vendor-entries.mjs')],
      {
        cwd: repo,
        env: {
          ...process.env,
          VENDOR_ONLY: 'octane-native-diagnostic',
          OCTANE_BUILD: build,
        },
        encoding: 'utf8',
      },
    );
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.deepEqual(fs.readFileSync(path.join(entryDir, 'entry.json')), manifestBeforeRepeat);
    assert.deepEqual(fs.readFileSync(featuredManifest), featuredBefore);

    fs.writeFileSync(listBundles['1000'], 'tampered-list-native');
    const tampered = spawnSync(
      process.execPath,
      [path.join(repo, 'scripts/vendor-entries.mjs')],
      {
        cwd: repo,
        env: {
          ...process.env,
          VENDOR_ONLY: 'octane-native-diagnostic',
          OCTANE_BUILD: build,
        },
        encoding: 'utf8',
      },
    );
    assert.notEqual(tampered.status, 0);
    assert.match(tampered.stderr, /list 1000 Native bundle does not match its build receipt/);

    fs.writeFileSync(listBundles['1000'], 'bounded-list-native-1000');
    fs.rmSync(listBundles['10000']);
    const missingListScale = spawnSync(
      process.execPath,
      [path.join(repo, 'scripts/vendor-entries.mjs')],
      {
        cwd: repo,
        env: {
          ...process.env,
          VENDOR_ONLY: 'octane-native-diagnostic',
          OCTANE_BUILD: build,
        },
        encoding: 'utf8',
      },
    );
    assert.notEqual(missingListScale.status, 0);
    assert.match(missingListScale.stderr, /missing list 10000 Native bundle/);

    fs.writeFileSync(listBundles['10000'], 'bounded-list-native-10000');
    const receiptPath = path.join(
      build,
      'benchmarks/lynx-list/app/dist/octane-native-diagnostic-build.json',
    );
    const extraListScaleReceipt = structuredClone(buildReceipt);
    extraListScaleReceipt.artifacts.list['2000'] = {
      path: 'benchmarks/lynx-list/app/dist/rows-2000/main.lynx.bundle',
      sha256: 'd'.repeat(64),
    };
    const { sha256: _receiptSha256, ...extraListScalePayload } = extraListScaleReceipt;
    extraListScaleReceipt.sha256 = sha256(JSON.stringify(extraListScalePayload));
    fs.writeFileSync(receiptPath, JSON.stringify(extraListScaleReceipt, null, 2));
    const extraListScale = spawnSync(
      process.execPath,
      [path.join(repo, 'scripts/vendor-entries.mjs')],
      {
        cwd: repo,
        env: {
          ...process.env,
          VENDOR_ONLY: 'octane-native-diagnostic',
          OCTANE_BUILD: build,
        },
        encoding: 'utf8',
      },
    );
    assert.notEqual(extraListScale.status, 0);
    assert.match(extraListScale.stderr, /must bind exactly the supported list scales/);
    fs.writeFileSync(receiptPath, JSON.stringify(buildReceipt, null, 2));

    const capacityBundle = path.join(
      build,
      'benchmarks/lynx-table/app/dist-rows7000/main.lynx.bundle',
    );
    fs.writeFileSync(capacityBundle, 'tampered-capacity-native');
    const tamperedCapacity = spawnSync(
      process.execPath,
      [path.join(repo, 'scripts/vendor-entries.mjs')],
      {
        cwd: repo,
        env: {
          ...process.env,
          VENDOR_ONLY: 'octane-native-diagnostic',
          OCTANE_BUILD: build,
        },
        encoding: 'utf8',
      },
    );
    assert.notEqual(tamperedCapacity.status, 0);
    assert.match(tamperedCapacity.stderr, /capacity 7000 Native bundle does not match its build receipt/);

    fs.writeFileSync(capacityBundle, 'lynx-native-startup-v1 eager-table-native-7000');
    fs.writeFileSync(path.join(build, 'packages/octane/revision-marker'), 'next revision\n');
    git(build, 'add', 'packages/octane/revision-marker');
    git(build, 'commit', '-m', 'move source revision');
    const staleRevision = spawnSync(
      process.execPath,
      [path.join(repo, 'scripts/vendor-entries.mjs')],
      {
        cwd: repo,
        env: {
          ...process.env,
          VENDOR_ONLY: 'octane-native-diagnostic',
          OCTANE_BUILD: build,
        },
        encoding: 'utf8',
      },
    );
    assert.notEqual(staleRevision.status, 0);
    assert.match(staleRevision.stderr, /build receipt source .* does not match checkout/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
