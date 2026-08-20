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

test('new-lynx vendor freezes a clean commit with both Lab contracts and eight bundles', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-new-lynx-'));
  const repo = path.join(dir, 'benchmark');
  const build = path.join(dir, 'octane');
  try {
    fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
    fs.copyFileSync(sourceScript, path.join(repo, 'scripts/vendor-entries.mjs'));
    fs.mkdirSync(path.join(build, 'packages/octane'), { recursive: true });
    fs.writeFileSync(path.join(build, 'packages/octane/package.json'), JSON.stringify({ version: '9.9.9' }));
    const appSrc = path.join(build, 'benchmarks/lynx-table/app/src');
    fs.mkdirSync(appSrc, { recursive: true });
    for (const file of ['App.lynx.tsrx', 'app.css', 'index.ts']) {
      fs.writeFileSync(path.join(appSrc, file), `baseline-${file}\n`);
    }
    const lynxCore = path.join(build, 'packages/lynx/src/core');
    fs.mkdirSync(lynxCore, { recursive: true });
    fs.writeFileSync(path.join(lynxCore, 'transport.ts'), 'baseline-transport\n');
    fs.writeFileSync(path.join(build, 'packages/lynx/src/main-thread.ts'), 'baseline-main-thread\n');
    for (const rows of [0, 1000, 10000, 30000]) {
      const output = path.join(
        build,
        'benchmarks/lynx-table/app',
        rows === 0 ? 'dist' : `dist-rows${rows}`,
      );
      fs.mkdirSync(output, { recursive: true });
      fs.writeFileSync(path.join(output, 'main.web.bundle'), `web-${rows}`);
      fs.writeFileSync(path.join(output, 'main.lynx.bundle'), `lynx-${rows}`);
    }
    git(build, 'init', '-b', 'new-lynx');
    git(build, 'config', 'user.name', 'Vendor Test');
    git(build, 'config', 'user.email', 'vendor@example.test');
    git(build, 'add', '.');
    git(build, 'commit', '-m', 'snapshot');
    const commit = git(build, 'rev-parse', 'HEAD');
    for (const file of ['App.lynx.tsrx', 'app.css', 'index.ts']) {
      fs.appendFileSync(path.join(appSrc, file), `instrumented-${file}\n`);
    }
    fs.appendFileSync(path.join(lynxCore, 'transport.ts'), 'native-string-transport\n');
    fs.appendFileSync(path.join(build, 'packages/lynx/src/main-thread.ts'), 'native-string-transport\n');
    const patchDir = path.join(repo, 'entries/_patches');
    fs.mkdirSync(patchDir, { recursive: true });
    const patchFile = path.join(patchDir, 'octane-new-2026-08-20-bench.patch');
    fs.writeFileSync(patchFile, execFileSync(
      'git', [
        'diff', '--no-color', '--unified=0', '--',
        'benchmarks/lynx-table/app/src',
        'packages/lynx/src/core/transport.ts',
        'packages/lynx/src/main-thread.ts',
      ],
      { cwd: build },
    ));
    const env = {
      ...process.env,
      VENDOR_ONLY: 'octane-new-2026-08-20',
      OCTANE_NEW_BUILD: build,
      OCTANE_NEW_PATCH: patchFile,
    };
    const vendored = spawnSync(process.execPath, [path.join(repo, 'scripts/vendor-entries.mjs')], {
      cwd: repo, env, encoding: 'utf8',
    });
    assert.equal(vendored.status, 0, vendored.stderr);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(repo, 'entries/octane-new-2026-08-20/entry.json'), 'utf8'),
    );
    assert.equal(manifest.label, 'Octane (new-2026-08-20)');
    assert.equal(manifest.provenance.commit, commit);
    assert.equal(manifest.provenance.ref, 'new-lynx');
    assert.equal(manifest.provenance.patched, true);
    assert.equal(manifest.provenance.patchFile, 'entries/_patches/octane-new-2026-08-20-bench.patch');
    assert.deepEqual(manifest.webLab, { enabled: true, contract: 'web-lab-entry-v1' });
    assert.deepEqual(manifest.nativeLab, { enabled: true, contract: 'native-lab-entry-v1' });
    assert.equal(Object.keys(manifest.provenance.sha256).length, 8);

    fs.writeFileSync(path.join(build, 'packages/octane/dirty'), 'dirty');
    const dirty = spawnSync(process.execPath, [path.join(repo, 'scripts/vendor-entries.mjs')], {
      cwd: repo,
      env,
      encoding: 'utf8',
    });
    assert.notEqual(dirty.status, 0);
    assert.match(dirty.stderr, /must contain only the audited Native compatibility patch/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
