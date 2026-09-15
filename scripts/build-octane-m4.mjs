#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const checkout = path.resolve(process.argv[2] ?? process.env.OCTANE_BUILD ?? '');
const buildScript = path.join(checkout, 'benchmarks/lynx-table/scripts/build-app.mjs');
if (!checkout || !fs.existsSync(buildScript)) {
  throw new Error('usage: node scripts/build-octane-m4.mjs <octane-checkout>');
}

const externalListFixture = process.env.OCTANE_M4_LIST_FIXTURE_BUILD;
const listFixtureCheckout = externalListFixture == null || externalListFixture === ''
  ? null
  : path.resolve(externalListFixture);
const listFixtureFiles = ['ListApp.lynx.tsrx', 'list-index.ts', 'list.css'];
if (listFixtureCheckout != null) {
  for (const file of listFixtureFiles) {
    const source = path.join(listFixtureCheckout, 'benchmarks/lynx-table/app/src', file);
    if (!fs.existsSync(source)) throw new Error(`missing frozen list fixture source ${source}`);
  }
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
const tableElementTemplate = process.env.BENCH_ELEMENT_TEMPLATE === '1';
const listElementTemplate = process.env.BENCH_LIST_ELEMENT_TEMPLATE === '1';
const tableCoreSuffix = coreSuffix + (tableElementTemplate ? '-element-template' : '');
const listCoreSuffix = coreSuffix + (listElementTemplate ? '-element-template' : '');

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

function buildExternalListFixture(rows) {
  const pluginDir = path.join(checkout, 'packages/rspeedy-plugin-octane');
  const stageName = 'lynx-m4-list-bench';
  const stage = path.join(pluginDir, 'examples', stageName);
  const stageSource = path.join(stage, 'src');
  const sourceRoot = path.join(listFixtureCheckout, 'benchmarks/lynx-table/app');
  const output = path.join(stage, `dist-list-rows${rows}`);
  const destination = path.join(
    checkout,
    'benchmarks/lynx-table/app',
    `dist${listCoreSuffix}-list-rows${rows}`,
  );
  const config = `import { defineConfig } from '@lynx-js/rspeedy';
import { pluginOctane } from '@octanejs/rspeedy-plugin';

const listRows = Number(process.env.BENCH_LIST_ROWS);
export default defineConfig({
  mode: 'production',
  environments: { lynx: {}, web: {} },
  output: {
    cleanDistPath: true,
    filename: { bundle: '[name].[platform].bundle' },
    filenameHash: false,
    distPath: { root: 'dist-list-rows' + listRows },
  },
  source: {
    entry: { main: './src/list-index.ts' },
    define: { __BENCH_LIST_ROWS__: JSON.stringify(listRows) },
  },
  splitChunks: false,
  plugins: [pluginOctane({
    dev: false,
    hmr: false,
    ...(process.env.BENCH_ELEMENT_TEMPLATE === '1'
      ? { experimentalElementTemplate: true }
      : null),
  })],
});
`;

  fs.rmSync(stage, { recursive: true, force: true });
  try {
    fs.mkdirSync(stageSource, { recursive: true });
    fs.copyFileSync(
      path.join(checkout, 'benchmarks/lynx-table/app/tsconfig.json'),
      path.join(stage, 'tsconfig.json'),
    );
    fs.writeFileSync(path.join(stage, 'lynx.config.mjs'), config);
    for (const file of listFixtureFiles) {
      fs.copyFileSync(path.join(sourceRoot, 'src', file), path.join(stageSource, file));
    }
    execFileSync('npx', ['rspeedy', 'build', '--root', `examples/${stageName}`], {
      cwd: pluginDir,
      stdio: 'inherit',
      env: {
        ...process.env,
        NODE_ENV: 'production',
        BENCH_ELEMENT_TEMPLATE: listElementTemplate ? '1' : '0',
        BENCH_LIST_ROWS: String(rows),
      },
    });
    for (const file of ['main.web.bundle', 'main.lynx.bundle']) {
      if (!fs.existsSync(path.join(output, file))) throw new Error(`missing ${output}/${file}`);
    }
    fs.rmSync(destination, { recursive: true, force: true });
    fs.cpSync(output, destination, { recursive: true });
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

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
      BENCH_ELEMENT_TEMPLATE: tableElementTemplate ? '1' : '0',
    },
  });
  const suffix = tableCoreSuffix + (rows === 0 ? '' : `-rows${rows}`);
  const dist = path.join(checkout, `benchmarks/lynx-table/app/dist${suffix}`);
  for (const file of ['main.web.bundle', 'main.lynx.bundle']) {
    if (!fs.existsSync(path.join(dist, file))) throw new Error(`missing ${dist}/${file}`);
  }
}

for (const rows of listRowsMatrix) {
  if (listFixtureCheckout == null) {
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
        BENCH_ELEMENT_TEMPLATE: listElementTemplate ? '1' : '0',
      },
    });
  } else {
    buildExternalListFixture(rows);
  }
  const dist = path.join(
    checkout,
    `benchmarks/lynx-table/app/dist${listCoreSuffix}-list-rows${rows}`,
  );
  for (const file of ['main.web.bundle', 'main.lynx.bundle']) {
    if (!fs.existsSync(path.join(dist, file))) throw new Error(`missing ${dist}/${file}`);
  }
}

console.log(
  `[build-octane-m4] ${requestedCore}/${blockMode} table${tableElementTemplate ? '+et' : ''} ${rowsMatrix.join('/')} list${listElementTemplate ? '+et' : ''} ${listRowsMatrix.join('/')} complete`,
);
