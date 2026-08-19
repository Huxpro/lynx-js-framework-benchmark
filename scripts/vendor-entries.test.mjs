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
    const env = {
      ...process.env,
      VENDOR_ONLY: 'octane-new1',
      OCTANE_NEW1_BUILD: build,
    };
    const vendored = spawnSync(process.execPath, [path.join(repo, 'scripts/vendor-entries.mjs')], {
      cwd: repo, env, encoding: 'utf8',
    });
    assert.equal(vendored.status, 0, vendored.stderr);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(repo, 'entries/octane-new1/entry.json'), 'utf8'),
    );
    assert.equal(manifest.label, 'Octane (new1)');
    assert.equal(manifest.provenance.commit, commit);
    assert.equal(manifest.provenance.ref, 'new-lynx');
    assert.equal(manifest.provenance.patched, false);
    assert.deepEqual(manifest.webLab, { enabled: true, contract: 'web-lab-entry-v1' });
    assert.deepEqual(manifest.nativeLab, { enabled: true, contract: 'native-lab-entry-v1' });
    assert.equal(Object.keys(manifest.provenance.sha256).length, 8);

    fs.writeFileSync(path.join(build, 'packages/octane/dirty'), 'dirty');
    const dirty = spawnSync(process.execPath, [path.join(repo, 'scripts/vendor-entries.mjs')], {
      cwd: repo,
      env: { ...process.env, VENDOR_ONLY: 'octane-new2', OCTANE_NEW2_BUILD: build },
      encoding: 'utf8',
    });
    assert.notEqual(dirty.status, 0);
    assert.match(dirty.stderr, /frozen new-lynx snapshot checkout must be clean/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
