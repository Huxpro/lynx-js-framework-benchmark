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

test('new-lynx vendor publishes a featured block-core snapshot with one audited patch', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-new-lynx-block-'));
  const repo = path.join(dir, 'benchmark');
  const build = path.join(dir, 'octane');
  try {
    fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
    fs.copyFileSync(sourceScript, path.join(repo, 'scripts/vendor-entries.mjs'));
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
    fs.appendFileSync(patchedSource, 'await-commit\n');
    const patchDir = path.join(repo, 'entries/_patches');
    fs.mkdirSync(patchDir, { recursive: true });
    const patchFile = path.join(patchDir, 'octane-new-2026-08-22-block-storm.patch');
    fs.writeFileSync(patchFile, execFileSync(
      'git',
      ['diff', '--no-color', '--unified=0', '--', 'benchmarks/lynx-table/app/src/block-program.ts'],
      { cwd: build },
    ));

    const vendored = spawnSync(
      process.execPath,
      [path.join(repo, 'scripts/vendor-entries.mjs')],
      {
        cwd: repo,
        env: {
          ...process.env,
          VENDOR_ONLY: 'octane-new-2026-08-22',
          OCTANE_NEW_BUILD: build,
          OCTANE_NEW_PATCH: patchFile,
        },
        encoding: 'utf8',
      },
    );
    assert.equal(vendored.status, 0, vendored.stderr);
    const manifest = JSON.parse(fs.readFileSync(
      path.join(repo, 'entries/octane-new-2026-08-22/entry.json'),
      'utf8',
    ));
    assert.equal(manifest.label, 'Octane (new-2026-08-22)');
    assert.equal(manifest.tier, 'featured');
    assert.equal(manifest.provenance.commit, commit);
    assert.equal(manifest.provenance.ref, 'new-lynx');
    assert.equal(manifest.provenance.patched, true);
    assert.equal(
      manifest.provenance.patchFile,
      'entries/_patches/octane-new-2026-08-22-block-storm.patch',
    );
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
          VENDOR_ONLY: 'octane-new-2026-08-22',
          OCTANE_NEW_BUILD: build,
          OCTANE_NEW_PATCH: patchFile,
        },
        encoding: 'utf8',
      },
    );
    assert.notEqual(dirty.status, 0);
    assert.match(dirty.stderr, /must contain only the audited block-storm patch/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
