import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const sourceScript = new URL('./vendor-entries.mjs', import.meta.url).pathname;

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

test('Hux vendor publishes the reviewed #269 + #272 composite for Web and Native', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-hux-composite-'));
  const repo = path.join(dir, 'benchmark');
  const build = path.join(dir, 'octane');
  const webBuild = path.join(dir, 'octane-web');
  try {
    fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
    fs.copyFileSync(sourceScript, path.join(repo, 'scripts/vendor-entries.mjs'));
    fs.mkdirSync(path.join(repo, 'entries/_patches'), { recursive: true });
    fs.mkdirSync(path.join(build, 'packages/octane'), { recursive: true });
    fs.writeFileSync(
      path.join(build, 'packages/octane/package.json'),
      JSON.stringify({ version: '9.9.9' }),
    );
    for (const rows of [0, 1000, 10000, 30000]) {
      const output = path.join(
        build,
        'benchmarks/lynx-table/app',
        rows === 0 ? 'dist' : `dist-rows${rows}`,
      );
      fs.mkdirSync(output, { recursive: true });
      fs.writeFileSync(path.join(output, 'main.web.bundle'), `universal-web-${rows}`);
      fs.writeFileSync(path.join(output, 'main.lynx.bundle'), `universal-lynx-${rows}`);
    }
    git(build, 'init', '-b', 'new-lynx');
    git(build, 'config', 'user.name', 'Vendor Test');
    git(build, 'config', 'user.email', 'vendor@example.test');
    git(build, 'add', '.');
    const appSource = path.join(build, 'benchmarks/lynx-table/app/src');
    fs.mkdirSync(appSource, { recursive: true });
    fs.writeFileSync(path.join(appSource, 'App.lynx.tsrx'), 'baseline app\n');
    fs.writeFileSync(path.join(appSource, 'index.ts'), 'baseline index\n');
    git(build, 'add', '.');
    git(build, 'commit', '-m', 'base snapshot');
    git(build, 'checkout', '-b', 'pr-269');
    fs.writeFileSync(path.join(build, 'pr-269'), 'compiled create\n');
    git(build, 'add', '.');
    git(build, 'commit', '-m', 'PR 269');
    const pr269 = git(build, 'rev-parse', 'HEAD');
    git(build, 'checkout', '-b', 'pr-272', 'new-lynx');
    fs.writeFileSync(path.join(build, 'pr-272'), 'FCP\n');
    git(build, 'add', '.');
    git(build, 'commit', '-m', 'PR 272');
    const pr272 = git(build, 'rev-parse', 'HEAD');
    git(build, 'merge', '--no-ff', 'pr-269', '-m', 'composite');
    const commit = git(build, 'rev-parse', 'HEAD');
    execFileSync('git', ['clone', build, webBuild], { encoding: 'utf8' });
    fs.writeFileSync(path.join(appSource, 'App.lynx.tsrx'), 'instrumented app\n');
    fs.writeFileSync(path.join(appSource, 'index.ts'), 'instrumented index\n');
    const instrumentation = git(build, '-c', 'color.ui=false', 'diff', '--binary', '--',
      'benchmarks/lynx-table/app/src/App.lynx.tsrx',
      'benchmarks/lynx-table/app/src/index.ts');
    fs.writeFileSync(
      path.join(repo, 'entries/_patches/octane-hux-native-bench.patch'),
      `${instrumentation}\n`,
    );
    const vendored = spawnSync(
      process.execPath,
      [path.join(repo, 'scripts/vendor-entries.mjs')],
      {
        cwd: repo,
        env: {
          ...process.env,
          VENDOR_ONLY: 'octane-hux',
          OCTANE_HUX_BUILD: build,
          OCTANE_HUX_WEB_BUILD: webBuild,
          OCTANE_HUX_PR_269_SHA: pr269,
          OCTANE_HUX_PR_272_SHA: pr272,
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
    assert.deepEqual(manifest.harnesses, ['web', 'native']);
    assert.equal(manifest.provenance.commit, commit);
    assert.equal(manifest.provenance.ref, 'composite:pull/269/head+pull/272/head');
    assert.equal(manifest.provenance.patched, true);
    assert.equal(manifest.provenance.patchFile, 'entries/_patches/octane-hux-native-bench.patch');
    assert.deepEqual(manifest.provenance.inputCommits, {
      'pull/269/head': pr269,
      'pull/272/head': pr272,
    });
    assert.deepEqual(manifest.provenance.buildEnv, {
      BENCH_CORE: 'universal',
      WEB_SOURCE: 'clean-composite',
      NATIVE_SOURCE: 'reviewed-instrumentation-patch',
      NATIVE_TABLE_PROTOCOL: 'lynx-native-bench-v2',
      NATIVE_STARTUP_PROTOCOL: 'lynx-native-startup-v1',
    });
    assert.match(manifest.provenance.buildCommand, /#269\+#272-composite/);
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
          OCTANE_HUX_BUILD: build,
          OCTANE_HUX_WEB_BUILD: webBuild,
          OCTANE_HUX_PR_269_SHA: pr269,
          OCTANE_HUX_PR_272_SHA: pr272,
        },
        encoding: 'utf8',
      },
    );
    assert.notEqual(dirty.status, 0);
    assert.match(dirty.stderr, /differs outside the two reviewed instrumentation files/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PR #791 vendor keeps a clean Web-only archive entry', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-octane-pr-791-'));
  const repo = path.join(dir, 'benchmark');
  const build = path.join(dir, 'octane');
  try {
    fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
    fs.copyFileSync(sourceScript, path.join(repo, 'scripts/vendor-entries.mjs'));
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
