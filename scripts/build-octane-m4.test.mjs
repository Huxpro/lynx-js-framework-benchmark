import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const script = new URL('./build-octane-m4.mjs', import.meta.url).pathname;

function executable(file, source) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/usr/bin/env node\n${source}`);
  fs.chmodSync(file, 0o755);
}

test('automatic build preserves the product-core output namespace', () => {
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'build-octane-block-'));
  try {
    const buildScript = path.join(checkout, 'benchmarks/lynx-table/scripts/build-app.mjs');
    fs.mkdirSync(path.dirname(buildScript), { recursive: true });
    fs.writeFileSync(buildScript, `
      import fs from 'node:fs';
      import path from 'node:path';
      const rows = Number(process.env.BENCH_AUTOROWS);
      const listRows = Number(process.env.BENCH_LIST_ROWS);
      if (process.env.BENCH_CORE !== 'automatic') throw new Error('expected automatic core');
      if (process.env.BENCH_BLOCK_MODE !== 'scoped') throw new Error('expected scoped mode');
      const suffix = listRows > 0
        ? '-list-rows' + listRows
        : rows === 0 ? '' : '-rows' + rows;
      const out = path.join(process.cwd(), 'benchmarks/lynx-table/app/dist-automatic' + suffix);
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, 'main.web.bundle'), 'web');
      fs.writeFileSync(path.join(out, 'main.lynx.bundle'), 'lynx');
    `);

    const result = spawnSync(process.execPath, [script, checkout], {
      env: { ...process.env, BENCH_CORE: 'automatic' },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    for (const rows of [0, 1000, 10000, 30000]) {
      const suffix = rows === 0 ? '' : `-rows${rows}`;
      assert.equal(
        fs.existsSync(path.join(
          checkout,
          `benchmarks/lynx-table/app/dist-automatic${suffix}/main.web.bundle`,
        )),
        true,
      );
    }
    for (const rows of [1000, 10000]) {
      assert.equal(
        fs.existsSync(
          path.join(
            checkout,
            `benchmarks/lynx-table/app/dist-automatic-list-rows${rows}/main.web.bundle`,
          ),
        ),
        true,
      );
    }
  } finally {
    fs.rmSync(checkout, { recursive: true, force: true });
  }
});

test('BENCH_ROWS builds the exact diagnostic matrix and rejects ambiguous input', () => {
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'build-octane-rows-'));
  try {
    const buildScript = path.join(checkout, 'benchmarks/lynx-table/scripts/build-app.mjs');
    fs.mkdirSync(path.dirname(buildScript), { recursive: true });
    fs.writeFileSync(buildScript, `
      import fs from 'node:fs';
      import path from 'node:path';
      const rows = Number(process.env.BENCH_AUTOROWS);
      const listRows = Number(process.env.BENCH_LIST_ROWS);
      const suffix = listRows > 0
        ? '-list-rows' + listRows
        : rows === 0 ? '' : '-rows' + rows;
      const out = path.join(process.cwd(), 'benchmarks/lynx-table/app/dist' + suffix);
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, 'main.web.bundle'), 'web-' + rows);
      fs.writeFileSync(path.join(out, 'main.lynx.bundle'), 'lynx-' + rows);
    `);

    const result = spawnSync(process.execPath, [script, checkout], {
      env: { ...process.env, BENCH_ROWS: '0,2000,5000' },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /table 0\/2000\/5000 list 1000\/10000 complete/);
    for (const rows of [0, 2000, 5000]) {
      const suffix = rows === 0 ? '' : `-rows${rows}`;
      assert.equal(
        fs.existsSync(path.join(
          checkout,
          `benchmarks/lynx-table/app/dist${suffix}/main.lynx.bundle`,
        )),
        true,
      );
    }
    assert.equal(
      fs.existsSync(path.join(checkout, 'benchmarks/lynx-table/app/dist-rows1000')),
      false,
    );

    const invalid = spawnSync(process.execPath, [script, checkout], {
      env: { ...process.env, BENCH_ROWS: '0,1000,1000' },
      encoding: 'utf8',
    });
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /unique comma-separated list/);
  } finally {
    fs.rmSync(checkout, { recursive: true, force: true });
  }
});

test('external list fixture builds against an unmodified target checkout', () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'build-octane-target-'));
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'build-octane-fixture-'));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'build-octane-bin-'));
  try {
    const buildScript = path.join(target, 'benchmarks/lynx-table/scripts/build-app.mjs');
    fs.mkdirSync(path.dirname(buildScript), { recursive: true });
    fs.writeFileSync(buildScript, `
      import fs from 'node:fs';
      import path from 'node:path';
      if (Number(process.env.BENCH_LIST_ROWS) > 0) throw new Error('target has no list fixture');
      const rows = Number(process.env.BENCH_AUTOROWS);
      const suffix = rows === 0 ? '' : '-rows' + rows;
      const out = path.join(process.cwd(), 'benchmarks/lynx-table/app/dist' + suffix);
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, 'main.web.bundle'), 'table-web-' + rows);
      fs.writeFileSync(path.join(out, 'main.lynx.bundle'), 'table-lynx-' + rows);
    `);
    const targetApp = path.join(target, 'benchmarks/lynx-table/app');
    fs.mkdirSync(targetApp, { recursive: true });
    fs.writeFileSync(path.join(targetApp, 'tsconfig.json'), '{}\n');
    fs.mkdirSync(path.join(target, 'packages/rspeedy-plugin-octane/examples'), { recursive: true });

    const fixtureSource = path.join(fixture, 'benchmarks/lynx-table/app/src');
    fs.mkdirSync(fixtureSource, { recursive: true });
    for (const file of ['ListApp.lynx.tsrx', 'list-index.ts', 'list.css']) {
      fs.writeFileSync(path.join(fixtureSource, file), `${file}: frozen fixture\n`);
    }
    executable(path.join(bin, 'npx'), `
      const fs = require('node:fs');
      const path = require('node:path');
      const stage = path.join(process.cwd(), 'examples/lynx-m4-list-bench');
      const rows = Number(process.env.BENCH_LIST_ROWS);
      const out = path.join(stage, 'dist-list-rows' + rows);
      const fixture = fs.readFileSync(path.join(stage, 'src/ListApp.lynx.tsrx'), 'utf8');
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, 'main.web.bundle'), 'web:' + rows + ':' + fixture);
      fs.writeFileSync(path.join(out, 'main.lynx.bundle'), 'lynx:' + rows + ':' + fixture);
    `);

    const result = spawnSync(process.execPath, [script, target], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        BENCH_ROWS: '0',
        OCTANE_M4_LIST_FIXTURE_BUILD: fixture,
      },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    for (const rows of [1000, 10000]) {
      assert.match(
        fs.readFileSync(
          path.join(target, `benchmarks/lynx-table/app/dist-list-rows${rows}/main.web.bundle`),
          'utf8',
        ),
        new RegExp(`web:${rows}:ListApp\\.lynx\\.tsrx: frozen fixture`),
      );
    }
    assert.equal(
      fs.existsSync(path.join(target, 'packages/rspeedy-plugin-octane/examples/lynx-m4-list-bench')),
      false,
    );
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
    fs.rmSync(fixture, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  }
});
