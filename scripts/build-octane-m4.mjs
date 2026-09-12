#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const checkout = path.resolve(process.argv[2] ?? process.env.OCTANE_BUILD ?? '');
const buildScript = path.join(checkout, 'benchmarks/lynx-table/scripts/build-app.mjs');
if (!checkout || !fs.existsSync(buildScript)) {
  throw new Error('usage: node scripts/build-octane-m4.mjs <octane-checkout>');
}

const requestedCore = process.env.BENCH_CORE ?? 'universal';
if (!['automatic', 'universal', 'block'].includes(requestedCore)) {
  throw new Error(`BENCH_CORE must be automatic, universal, or block; received ${requestedCore}`);
}
const blockMode = process.env.BENCH_BLOCK_MODE === 'reconcile' ? 'reconcile' : 'scoped';
const coreSuffix = requestedCore === 'automatic'
  ? '-automatic'
  : requestedCore === 'block'
    ? (blockMode === 'reconcile' ? '-block-reconcile' : '-block')
    : '';

function rowsFromEnvironment() {
  const raw = process.env.BENCH_ROWS;
  if (raw == null || raw === '') return [0, 1000, 10000, 30000];
  const rows = raw.split(',').map((value) => Number(value));
  if (
    rows.length === 0
    || rows.some((value) => !Number.isSafeInteger(value) || value < 0)
    || new Set(rows).size !== rows.length
  ) {
    throw new Error(`BENCH_ROWS must be a unique comma-separated list of non-negative integers, received ${JSON.stringify(raw)}`);
  }
  return rows;
}

const rowsMatrix = rowsFromEnvironment();
const listRowsMatrix = [1000, 10000];

for (const rows of rowsMatrix) {
  execFileSync(process.execPath, [buildScript], {
    cwd: checkout,
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      BENCH_AUTOROWS: String(rows),
      BENCH_LIST_ROWS: '0',
      BENCH_CORE: requestedCore,
      BENCH_BLOCK_MODE: blockMode,
    },
  });
  const suffix = coreSuffix + (rows === 0 ? '' : `-rows${rows}`);
  const dist = path.join(checkout, `benchmarks/lynx-table/app/dist${suffix}`);
  for (const file of ['main.web.bundle', 'main.lynx.bundle']) {
    if (!fs.existsSync(path.join(dist, file))) throw new Error(`missing ${dist}/${file}`);
  }
}

for (const rows of listRowsMatrix) {
  execFileSync(process.execPath, [buildScript], {
    cwd: checkout,
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      BENCH_AUTOROWS: '0',
      BENCH_LIST_ROWS: String(rows),
      BENCH_CORE: requestedCore,
      BENCH_BLOCK_MODE: blockMode,
    },
  });
  const dist = path.join(checkout, `benchmarks/lynx-table/app/dist${coreSuffix}-list-rows${rows}`);
  for (const file of ['main.web.bundle', 'main.lynx.bundle']) {
    if (!fs.existsSync(path.join(dist, file))) throw new Error(`missing ${dist}/${file}`);
  }
}

console.log(
  `[build-octane-m4] ${requestedCore}/${blockMode} table ${rowsMatrix.join('/')} list ${listRowsMatrix.join('/')} complete`,
);
