#!/usr/bin/env node
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  NATIVE_CAPACITY_SCALES,
  NATIVE_CAPACITY_BUILD_PROTOCOL,
  NATIVE_DIAGNOSTIC_BUILD_RECEIPT_PATH,
  NATIVE_DIAGNOSTIC_BUILD_TABLE_PATH,
  NATIVE_LIST_SCALES,
  nativeCapacityBuildPath,
  nativeListBuildPath,
} from '../packages/shared/src/native-diagnostic-contract.mjs';

const checkout = path.resolve(process.argv[2] ?? process.env.OCTANE_BUILD ?? '');
const tableBuildScript = path.join(checkout, 'benchmarks/lynx-table/scripts/build-app.mjs');
const listBuildScript = path.join(checkout, 'benchmarks/lynx-list/scripts/build-app.mjs');
if (!checkout || !fs.existsSync(tableBuildScript)) {
  throw new Error('usage: node scripts/build-octane-upstream.mjs <octane-checkout>');
}

const core = process.env.BENCH_CORE === 'block' ? 'block' : 'universal';
const blockMode = process.env.BENCH_BLOCK_MODE === 'reconcile' ? 'reconcile' : 'scoped';
const buildNativeDiagnostic = fs.existsSync(listBuildScript);
const legacyTableScales = [0, 1000, 10000, 30000];
const nativeDiagnosticTableScales = [0, ...NATIVE_CAPACITY_SCALES, 30000];
if (buildNativeDiagnostic && (core !== 'universal' || blockMode !== 'scoped')) {
  throw new Error(
    'Octane Native diagnostic artifacts require BENCH_CORE=universal and BENCH_BLOCK_MODE=scoped',
  );
}
const nativeDiagnosticReceipt = path.join(
  checkout,
  NATIVE_DIAGNOSTIC_BUILD_RECEIPT_PATH,
);
let sourceCommit = null;
if (buildNativeDiagnostic) {
  const dirty = execFileSync(
    'git',
    ['status', '--porcelain', '--', 'packages', 'benchmarks', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'],
    { cwd: checkout },
  ).toString().trim();
  if (dirty.length > 0) {
    throw new Error('Octane Native diagnostic builds require a clean source checkout');
  }
  sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout })
    .toString().trim();
  fs.rmSync(nativeDiagnosticReceipt, { force: true });
}

const coreSuffix = core === 'block'
  ? (blockMode === 'reconcile' ? '-block-reconcile' : '-block')
  : '';

const tableScales = buildNativeDiagnostic
  ? nativeDiagnosticTableScales
  : legacyTableScales;
for (const rows of tableScales) {
  execFileSync(process.execPath, [tableBuildScript], {
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

if (buildNativeDiagnostic) {
  for (const rows of NATIVE_LIST_SCALES) {
    execFileSync(process.execPath, [listBuildScript], {
      cwd: checkout,
      stdio: 'inherit',
      env: { ...process.env, NODE_ENV: 'production', BENCH_LIST_ROWS: String(rows) },
    });
    const listBundle = path.join(
      checkout,
      nativeListBuildPath(rows),
    );
    if (!fs.existsSync(listBundle)) throw new Error(`missing ${listBundle}`);
  }
  const tableBundle = path.join(
    checkout,
    NATIVE_DIAGNOSTIC_BUILD_TABLE_PATH,
  );
  const artifact = (file) => ({
    path: path.relative(checkout, file),
    sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
  });
  const payload = {
    protocol: NATIVE_CAPACITY_BUILD_PROTOCOL,
    sourceCommit,
    artifacts: {
      table: artifact(tableBundle),
      capacity: Object.fromEntries(NATIVE_CAPACITY_SCALES.map((rows) => [
        String(rows),
        artifact(path.join(checkout, nativeCapacityBuildPath(rows))),
      ])),
      list: Object.fromEntries(NATIVE_LIST_SCALES.map((rows) => [
        String(rows),
        artifact(path.join(checkout, nativeListBuildPath(rows))),
      ])),
    },
  };
  const receipt = {
    ...payload,
    sha256: crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
  };
  fs.writeFileSync(nativeDiagnosticReceipt, JSON.stringify(receipt, null, 2));
}

console.log(
  `[build-octane-upstream] ${core}/${blockMode} table rows ${tableScales.join('/')}`
  + (buildNativeDiagnostic ? ` + bounded Native list rows ${NATIVE_LIST_SCALES.join('/')}` : '')
  + ' complete',
);
