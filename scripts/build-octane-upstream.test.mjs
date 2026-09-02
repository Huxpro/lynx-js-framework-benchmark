import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const script = new URL('./build-octane-upstream.mjs', import.meta.url).pathname;

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

test('block build preserves the upstream block-core output namespace', () => {
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'build-octane-block-'));
  try {
    const buildScript = path.join(checkout, 'benchmarks/lynx-table/scripts/build-app.mjs');
    fs.mkdirSync(path.dirname(buildScript), { recursive: true });
    fs.writeFileSync(buildScript, `
      import fs from 'node:fs';
      import path from 'node:path';
      const rows = Number(process.env.BENCH_AUTOROWS);
      if (process.env.BENCH_CORE !== 'block') throw new Error('expected block core');
      if (process.env.BENCH_BLOCK_MODE !== 'scoped') throw new Error('expected scoped mode');
      const suffix = rows === 0 ? '' : '-rows' + rows;
      const out = path.join(process.cwd(), 'benchmarks/lynx-table/app/dist-block' + suffix);
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, 'main.web.bundle'), 'web');
      fs.writeFileSync(path.join(out, 'main.lynx.bundle'), 'lynx');
    `);
    const result = spawnSync(process.execPath, [script, checkout], {
      env: { ...process.env, BENCH_CORE: 'block' },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    for (const rows of [0, 1000, 10000, 30000]) {
      const suffix = rows === 0 ? '' : `-rows${rows}`;
      assert.equal(
        fs.existsSync(path.join(
          checkout,
          `benchmarks/lynx-table/app/dist-block${suffix}/main.web.bundle`,
        )),
        true,
      );
    }
  } finally {
    fs.rmSync(checkout, { recursive: true, force: true });
  }
});

test('upstream build emits distinct eager-table and bounded-list Native bundles', () => {
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'build-octane-native-fixtures-'));
  try {
    const tableBuildScript = path.join(
      checkout,
      'benchmarks/lynx-table/scripts/build-app.mjs',
    );
    fs.mkdirSync(path.dirname(tableBuildScript), { recursive: true });
    fs.writeFileSync(tableBuildScript, `
      import fs from 'node:fs';
      import path from 'node:path';
      const rows = Number(process.env.BENCH_AUTOROWS);
      const suffix = (process.env.BENCH_CORE === 'block' ? '-block' : '')
        + (rows === 0 ? '' : '-rows' + rows);
      const out = path.join(process.cwd(), 'benchmarks/lynx-table/app/dist' + suffix);
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, 'main.web.bundle'), 'table-web-' + rows);
      fs.writeFileSync(path.join(out, 'main.lynx.bundle'), 'table-native-' + rows);
    `);
    const listBuildScript = path.join(
      checkout,
      'benchmarks/lynx-list/scripts/build-app.mjs',
    );
    fs.mkdirSync(path.dirname(listBuildScript), { recursive: true });
    fs.writeFileSync(listBuildScript, `
      import fs from 'node:fs';
      import path from 'node:path';
      if (process.env.BENCH_CORE === 'block') throw new Error('block must not rebuild list');
      const out = path.join(process.cwd(), 'benchmarks/lynx-list/app/dist');
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, 'main.lynx.bundle'), 'bounded-list-native');
    `);
    git(checkout, 'init', '-b', 'main');
    git(checkout, 'config', 'user.name', 'Build Test');
    git(checkout, 'config', 'user.email', 'build@example.test');
    git(checkout, 'add', '.');
    git(checkout, 'commit', '-m', 'fixture sources');
    const commit = git(checkout, 'rev-parse', 'HEAD');

    const result = spawnSync(process.execPath, [script, checkout], {
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    const tableBundle = fs.readFileSync(
      path.join(checkout, 'benchmarks/lynx-table/app/dist/main.lynx.bundle'),
      'utf8',
    );
    const listBundle = fs.readFileSync(
      path.join(checkout, 'benchmarks/lynx-list/app/dist/main.lynx.bundle'),
      'utf8',
    );
    assert.equal(tableBundle, 'table-native-0');
    assert.equal(listBundle, 'bounded-list-native');
    assert.notEqual(tableBundle, listBundle);
    const receipt = JSON.parse(fs.readFileSync(path.join(
      checkout,
      'benchmarks/lynx-list/app/dist/octane-native-diagnostic-build.json',
    ), 'utf8'));
    assert.equal(receipt.protocol, 'octane-native-diagnostic-build-v1');
    assert.equal(receipt.sourceCommit, commit);
    assert.deepEqual(receipt.artifacts, {
      table: {
        path: 'benchmarks/lynx-table/app/dist/main.lynx.bundle',
        sha256: sha256(tableBundle),
      },
      list: {
        path: 'benchmarks/lynx-list/app/dist/main.lynx.bundle',
        sha256: sha256(listBundle),
      },
    });
    const { sha256: receiptSha256, ...payload } = receipt;
    assert.equal(receiptSha256, sha256(JSON.stringify(payload)));

    const blockResult = spawnSync(process.execPath, [script, checkout], {
      env: { ...process.env, BENCH_CORE: 'block' },
      encoding: 'utf8',
    });
    assert.notEqual(blockResult.status, 0);
    assert.match(
      blockResult.stderr,
      /Native diagnostic artifacts require BENCH_CORE=universal and BENCH_BLOCK_MODE=scoped/,
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(
        checkout,
        'benchmarks/lynx-list/app/dist/octane-native-diagnostic-build.json',
      ), 'utf8')),
      receipt,
    );
  } finally {
    fs.rmSync(checkout, { recursive: true, force: true });
  }
});
