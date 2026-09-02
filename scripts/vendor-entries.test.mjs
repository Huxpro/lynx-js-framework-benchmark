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
    protocol: 'octane-native-diagnostic-build-v1',
    sourceCommit,
    artifacts: {
      table: {
        path: 'benchmarks/lynx-table/app/dist/main.lynx.bundle',
        sha256: sha256(fs.readFileSync(path.join(
          build,
          'benchmarks/lynx-table/app/dist/main.lynx.bundle',
        ))),
      },
      list: {
        path: 'benchmarks/lynx-list/app/dist/main.lynx.bundle',
        sha256: sha256(fs.readFileSync(path.join(
          build,
          'benchmarks/lynx-list/app/dist/main.lynx.bundle',
        ))),
      },
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

test('native diagnostic vendor generates both immutable Native fixture inputs', () => {
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
    const listBundle = path.join(
      build,
      'benchmarks/lynx-list/app/dist/main.lynx.bundle',
    );
    fs.mkdirSync(path.dirname(tableBundle), { recursive: true });
    fs.mkdirSync(path.dirname(listBundle), { recursive: true });
    fs.writeFileSync(tableBundle, 'eager-table-native');
    fs.writeFileSync(listBundle, 'bounded-list-native');
    fs.writeFileSync(
      path.join(build, '.gitignore'),
      'benchmarks/lynx-table/app/dist/\nbenchmarks/lynx-list/app/dist/\n',
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
    const tableSha256 = sha256('eager-table-native');
    const listSha256 = sha256('bounded-list-native');
    assert.equal(manifest.id, 'octane-native-diagnostic');
    assert.equal(manifest.tier, 'lab');
    assert.deepEqual(manifest.harnesses, ['native']);
    assert.deepEqual(manifest.tags, ['diagnostic', 'capacity-probe']);
    assert.deepEqual(manifest.bundles, {
      lynx: 'dist/table/main.lynx.bundle',
    });
    assert.deepEqual(manifest.listFixture, {
      protocol: 'lynx-list-fixture-v1',
      contractSha256: '8cc9d901f97e6e17ac6207b13d9bb9afb5163ce0d1142cffd1b1921726a2f87b',
      bundles: { native: 'dist/list/main.lynx.bundle' },
      sha256: { native: listSha256 },
    });
    assert.equal(manifest.provenance.commit, commit);
    assert.equal(manifest.provenance.ref, commit);
    assert.equal(manifest.provenance.patched, false);
    assert.equal(manifest.provenance.patchFile, null);
    assert.deepEqual(manifest.provenance.buildReceipt, buildReceipt);
    assert.deepEqual(manifest.provenance.sha256, {
      'table/main.lynx.bundle': tableSha256,
      'list/main.lynx.bundle': listSha256,
    });
    assert.equal(
      fs.readFileSync(path.join(entryDir, manifest.bundles.lynx), 'utf8'),
      'eager-table-native',
    );
    assert.equal(
      fs.readFileSync(path.join(entryDir, manifest.listFixture.bundles.native), 'utf8'),
      'bounded-list-native',
    );
    assert.deepEqual(fs.readFileSync(featuredManifest), featuredBefore);

    fs.writeFileSync(listBundle, 'tampered-list-native');
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
    assert.match(tampered.stderr, /list Native bundle does not match its build receipt/);

    fs.writeFileSync(listBundle, 'bounded-list-native');
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
