import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const script = new URL('./build-octane-m4.mjs', import.meta.url).pathname;

test('automatic build preserves the product-core output namespace', () => {
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'build-octane-block-'));
  try {
    const buildScript = path.join(checkout, 'benchmarks/lynx-table/scripts/build-app.mjs');
    fs.mkdirSync(path.dirname(buildScript), { recursive: true });
    fs.writeFileSync(buildScript, `
      import fs from 'node:fs';
      import path from 'node:path';
      const rows = Number(process.env.BENCH_AUTOROWS);
      if (process.env.BENCH_CORE !== 'automatic') throw new Error('expected automatic core');
      if (process.env.BENCH_BLOCK_MODE !== 'scoped') throw new Error('expected scoped mode');
      const suffix = rows === 0 ? '' : '-rows' + rows;
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
      const suffix = rows === 0 ? '' : '-rows' + rows;
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
    assert.match(result.stdout, /rows 0\/2000\/5000 complete/);
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
