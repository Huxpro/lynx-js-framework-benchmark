#!/usr/bin/env node
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

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
const nativeCapacityScales = [1000, 6000, 7000, 7500, 8000, 10000];
const nativeDiagnosticTableScales = [0, ...nativeCapacityScales, 30000];
const nativeListScales = [1000, 10000];
if (buildNativeDiagnostic && (core !== 'universal' || blockMode !== 'scoped')) {
  throw new Error(
    'Octane Native diagnostic artifacts require BENCH_CORE=universal and BENCH_BLOCK_MODE=scoped',
  );
}
const nativeDiagnosticReceipt = path.join(
  checkout,
  'benchmarks/lynx-list/app/dist/octane-native-diagnostic-build.json',
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
  for (const rows of nativeListScales) {
    execFileSync(process.execPath, [listBuildScript], {
      cwd: checkout,
      stdio: 'inherit',
      env: { ...process.env, NODE_ENV: 'production', BENCH_LIST_ROWS: String(rows) },
    });
    const listBundle = path.join(
      checkout,
      `benchmarks/lynx-list/app/dist/rows-${rows}/main.lynx.bundle`,
    );
    if (!fs.existsSync(listBundle)) throw new Error(`missing ${listBundle}`);
  }
  const tableBundle = path.join(
    checkout,
    'benchmarks/lynx-table/app/dist/main.lynx.bundle',
  );
  const artifact = (file) => ({
    path: path.relative(checkout, file),
    sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
  });
  const payload = {
    protocol: 'octane-native-diagnostic-build-v3',
    sourceCommit,
    artifacts: {
      table: artifact(tableBundle),
      capacity: Object.fromEntries(nativeCapacityScales.map((rows) => [
        String(rows),
        artifact(path.join(
          checkout,
          `benchmarks/lynx-table/app/dist-rows${rows}/main.lynx.bundle`,
        )),
      ])),
      list: Object.fromEntries(nativeListScales.map((rows) => [
        String(rows),
        artifact(path.join(
          checkout,
          `benchmarks/lynx-list/app/dist/rows-${rows}/main.lynx.bundle`,
        )),
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
  + (buildNativeDiagnostic ? ` + bounded Native list rows ${nativeListScales.join('/')}` : '')
  + ' complete',
);
