#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const checkout = path.resolve(process.argv[2] ?? process.env.VUE_LYNX_BUILD ?? '');
if (!checkout || !fs.existsSync(path.join(checkout, 'packages/benchmark'))) {
  throw new Error('usage: node scripts/build-vue-featured.mjs <vue-lynx-checkout>');
}

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
const profile = process.env.BENCH_PROFILE === 'm0' ? 'm0' : 'legacy';
const benchmark = path.join(checkout, 'packages/benchmark');
const vueLynx = path.join(checkout, 'packages/vue-lynx');
const out = path.join(checkout, 'bench-out');

function run(file, args, cwd, env = {}) {
  execFileSync(file, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'production', ...env },
  });
}

function buildPackage(dir, tool, args) {
  run(path.join(vueLynx, 'node_modules/.bin', tool), args, path.join(vueLynx, dir));
}

function ensureSourceSelfLink() {
  const nodeModules = path.join(vueLynx, 'plugin/node_modules');
  const link = path.join(nodeModules, 'vue-lynx');
  fs.mkdirSync(nodeModules, { recursive: true });
  if (!fs.existsSync(link)) fs.symlinkSync('../..', link, 'dir');
}

function generateVapor() {
  const vdomPath = path.join(benchmark, 'apps/ui-vdom/src/App.vue');
  const vaporPath = path.join(benchmark, 'apps/ui-vapor/src/App.vue');
  const marker = '<!-- BENCH_MODE_SCRIPT --><script setup lang="ts">';
  const source = fs.readFileSync(vdomPath, 'utf8');
  if (!source.startsWith(marker)) throw new Error('ui-vdom App.vue lost BENCH_MODE_SCRIPT marker');
  fs.writeFileSync(
    vaporPath,
    `<!-- GENERATED from apps/ui-vdom/src/App.vue — do not edit -->\n${source.replace(marker, '<script setup vapor lang="ts">')}`,
  );
}

function stage(id, source, rows) {
  const target = path.join(out, id, `rows-${rows}`);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  for (const file of ['main.web.bundle', 'main.lynx.bundle']) {
    fs.copyFileSync(path.join(source, file), path.join(target, file));
  }
}

function buildApp({ id, app, rows, ifr = false, elementTemplates = false, cell }) {
  const cwd = path.join(benchmark, `apps/${app}`);
  const rspeedy = app === 'ui-react'
    ? path.join(cwd, 'node_modules/.bin/rspeedy')
    : path.join(benchmark, 'node_modules/.bin/rspeedy');
  const resolvedCell = cell
    ?? (ifr ? (elementTemplates ? 'ifr-et' : 'ifr') : (elementTemplates ? 'et' : 'off'));
  const expectedDist = app === 'ui-react' || resolvedCell === 'off'
    ? path.join(cwd, 'dist')
    : path.join(cwd, `dist-${resolvedCell}`);
  const fallbackDist = path.join(cwd, 'dist');
  for (const directory of new Set([expectedDist, fallbackDist])) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  run(rspeedy, ['build'], cwd, {
    BENCH_AUTOROWS: String(rows),
    BENCH_ENABLE_IFR: ifr ? '1' : '0',
    BENCH_ENABLE_ET: elementTemplates ? '1' : '0',
    BENCH_CELL: resolvedCell,
  });
  const outputs = [...new Set([expectedDist, fallbackDist])].filter((directory) =>
    fs.existsSync(path.join(directory, 'main.web.bundle'))
    && fs.existsSync(path.join(directory, 'main.lynx.bundle')));
  if (outputs.length !== 1) {
    throw new Error(
      `${id}: expected one complete Rspeedy output, found ${outputs.length}: ${outputs.join(', ')}`,
    );
  }
  stage(id, outputs[0], rows);
}

ensureSourceSelfLink();
buildPackage('internal', 'tsc', ['-p', 'tsconfig.build.json']);
for (const dir of ['runtime', 'main-thread', 'plugin']) buildPackage(dir, 'rslib', ['build']);
generateVapor();
fs.rmSync(out, { recursive: true, force: true });

const configurations = profile === 'm0'
  ? [
      { id: 'reactlynx-0-126-default', app: 'ui-react' },
      { id: 'reactlynx-0-126-et', app: 'ui-react', elementTemplates: true },
      { id: 'vue-lynx-0-5-vdom-default', app: 'ui-vdom' },
      {
        id: 'vue-lynx-0-5-vdom-ifr-et',
        app: 'ui-vdom',
        ifr: true,
        elementTemplates: true,
        cell: 'ifr-et',
      },
      { id: 'vue-lynx-0-5-vapor-default', app: 'ui-vapor', cell: 'off' },
      { id: 'vue-lynx-0-5-vapor-ifr', app: 'ui-vapor', ifr: true, cell: 'ifr' },
    ]
  : [
      { id: 'react', app: 'ui-react' },
      { id: 'vue-vdom', app: 'ui-vdom' },
      {
        id: 'vue-vdom-ifr-et',
        app: 'ui-vdom',
        ifr: true,
        elementTemplates: true,
        cell: 'ifr-et',
      },
      { id: 'vue-vapor', app: 'ui-vapor', cell: 'off' },
      { id: 'vue-vapor-ifr', app: 'ui-vapor', ifr: true, cell: 'ifr' },
    ];

for (const rows of rowsMatrix) {
  for (const configuration of configurations) buildApp({ ...configuration, rows });
}

console.log(
  `[build-vue-featured] ${profile}: ${configurations.length * rowsMatrix.length} cells → ${out}`,
);
