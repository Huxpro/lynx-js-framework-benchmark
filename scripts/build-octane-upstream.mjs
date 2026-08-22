#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const checkout = path.resolve(process.argv[2] ?? process.env.OCTANE_BUILD ?? '');
const buildScript = path.join(checkout, 'benchmarks/lynx-table/scripts/build-app.mjs');
if (!checkout || !fs.existsSync(buildScript)) {
  throw new Error('usage: node scripts/build-octane-upstream.mjs <octane-checkout>');
}

const core = process.env.BENCH_CORE === 'block' ? 'block' : 'universal';
const blockMode = process.env.BENCH_BLOCK_MODE === 'reconcile' ? 'reconcile' : 'scoped';
const coreSuffix = core === 'block'
  ? (blockMode === 'reconcile' ? '-block-reconcile' : '-block')
  : '';

for (const rows of [0, 1000, 10000, 30000]) {
  execFileSync(process.execPath, [buildScript], {
    cwd: checkout,
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      BENCH_AUTOROWS: String(rows),
      BENCH_CORE: core,
      BENCH_BLOCK_MODE: blockMode,
    },
  });
  const suffix = coreSuffix + (rows === 0 ? '' : `-rows${rows}`);
  const dist = path.join(checkout, `benchmarks/lynx-table/app/dist${suffix}`);
  for (const file of ['main.web.bundle', 'main.lynx.bundle']) {
    if (!fs.existsSync(path.join(dist, file))) throw new Error(`missing ${dist}/${file}`);
  }
}

console.log(`[build-octane-upstream] ${core}/${blockMode} rows 0/1k/10k/30k complete`);
