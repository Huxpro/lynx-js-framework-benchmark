#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const checkout = path.resolve(process.argv[2] ?? process.env.VUE_LYNX_BUILD ?? '');
if (!checkout || !fs.existsSync(path.join(checkout, 'packages/benchmark'))) {
  throw new Error('usage: node scripts/build-vue-featured.mjs <vue-lynx-checkout>');
}

const rowsMatrix = [0, 1000, 10000, 30000];
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

function stage(id, app, rows) {
  const source = path.join(benchmark, `apps/${app}/dist`);
  const target = path.join(out, id, `rows-${rows}`);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  for (const file of ['main.web.bundle', 'main.lynx.bundle']) {
    fs.copyFileSync(path.join(source, file), path.join(target, file));
  }
}

function buildApp({ id, app, rows, ifr = false, elementTemplates = false }) {
  const cwd = path.join(benchmark, `apps/${app}`);
  fs.rmSync(path.join(cwd, 'dist'), { recursive: true, force: true });
  run(path.join(benchmark, 'node_modules/.bin/rspeedy'), ['build'], cwd, {
    BENCH_AUTOROWS: String(rows),
    BENCH_ENABLE_IFR: ifr ? '1' : '0',
    BENCH_ENABLE_ET: elementTemplates ? '1' : '0',
  });
  stage(id, app, rows);
}

ensureSourceSelfLink();
buildPackage('internal', 'tsc', ['-p', 'tsconfig.build.json']);
for (const dir of ['runtime', 'main-thread', 'plugin']) buildPackage(dir, 'rslib', ['build']);
generateVapor();
fs.rmSync(out, { recursive: true, force: true });

for (const rows of rowsMatrix) {
  buildApp({ id: 'react', app: 'ui-react', rows });
  buildApp({ id: 'vue-vdom', app: 'ui-vdom', rows });
  buildApp({ id: 'vue-vdom-ifr-et', app: 'ui-vdom', rows, ifr: true, elementTemplates: true });
  buildApp({ id: 'vue-vapor', app: 'ui-vapor', rows });
  buildApp({ id: 'vue-vapor-ifr', app: 'ui-vapor', rows, ifr: true });
}

console.log(`[build-vue-featured] 20 cells → ${out}`);
