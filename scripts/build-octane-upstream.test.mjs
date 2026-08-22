import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const script = new URL('./build-octane-upstream.mjs', import.meta.url).pathname;

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
