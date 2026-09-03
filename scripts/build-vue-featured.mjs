#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseVueFeaturedRows,
  vueFeaturedBuildPlan,
  vueFeaturedSupportsAutoRows,
} from './vue-featured-plan.mjs';
import { assertContainedPath } from '../packages/runner/src/path-safety.mjs';
import {
  createVueArtifactAssertions,
  vueArtifactAssertionsBytes,
} from '../packages/runner/src/vue-artifact-assertions.mjs';
import {
  prepareVueFeaturedBuildTools,
  writeVueFeaturedBuildMetadata,
} from '../packages/runner/src/vue-build-tools.mjs';

const argv = process.argv.slice(2);
const lab = argv.includes('--lab');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function option(name) {
  const index = argv.findIndex((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
  if (index < 0) return null;
  const arg = argv[index];
  if (arg.includes('=')) return arg.slice(arg.indexOf('=') + 1);
  return argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[index + 1] : null;
}

const checkoutArg = lab && process.argv[2]?.startsWith('--') ? null : process.argv[2];
const checkout = path.resolve(checkoutArg ?? process.env.VUE_LYNX_BUILD ?? '');
if (!checkout || !fs.existsSync(path.join(checkout, 'packages/benchmark'))) {
  throw new Error(
    'usage: node scripts/build-vue-featured.mjs <vue-lynx-checkout> '
    + '[--lab --variant vapor|ifr --rows 0,1k,10k,30k --out <dir>]',
  );
}

const variant = lab ? option('variant') : null;
const rowsMatrix = lab
  ? parseVueFeaturedRows(option('rows') ?? '0,1k,10k,30k')
  : [0, 1000, 10000, 30000];
if (lab && rowsMatrix.some((rows) => rows !== 0) && !vueFeaturedSupportsAutoRows(checkout)) {
  throw new Error(
    `${checkout}: packages/benchmark has no autoRows build support; `
    + 'this checkout can only build --rows 0',
  );
}
const buildPlan = vueFeaturedBuildPlan({ lab, variant, rows: rowsMatrix });
const preparedBuilds = prepareVueFeaturedBuildTools(checkout, buildPlan);
const benchmark = path.join(checkout, 'packages/benchmark');
const vueLynx = path.join(checkout, 'packages/vue-lynx');
const out = lab
  ? path.resolve(option('out') ?? '')
  : path.join(checkout, 'bench-out');
if (lab && !option('out')) throw new Error('--lab requires --out <dir>');
if (lab) {
  assertContainedPath(root, out, { requiredTopLevel: '.tmp', label: '--lab --out' });
}

function run(file, args, cwd, env = {}) {
  const childEnv = { ...process.env, NODE_ENV: 'production', ...env };
  delete childEnv.BENCH_ENABLE_IFR;
  delete childEnv.BENCH_ENABLE_ET;
  if (!Object.hasOwn(env, 'BENCH_CELL')) delete childEnv.BENCH_CELL;
  execFileSync(file, args, {
    cwd,
    stdio: 'inherit',
    env: childEnv,
  });
}

function buildPackage(dir, tool, args) {
  run(path.join(checkout, 'node_modules/.bin', tool), args, path.join(vueLynx, dir));
}

function assertGeneratedVapor() {
  const vdomPath = path.join(benchmark, 'apps/ui-vdom/src/App.vue');
  const vaporPath = path.join(benchmark, 'apps/ui-vapor/src/App.vue');
  const marker = '<!-- BENCH_MODE_SCRIPT --><script setup lang="ts">';
  const source = fs.readFileSync(vdomPath, 'utf8');
  if (!source.startsWith(marker)) throw new Error('ui-vdom App.vue lost BENCH_MODE_SCRIPT marker');
  const expected =
    `<!-- GENERATED from apps/ui-vdom/src/App.vue — do not edit -->\n`
    + source.replace(marker, '<script setup vapor lang="ts">');
  if (fs.readFileSync(vaporPath, 'utf8') !== expected) {
    throw new Error('ui-vapor App.vue is stale; regenerate it in the source checkout');
  }
}

function stage(configuration, source) {
  const { id, rows } = configuration;
  const target = path.join(out, id, `rows-${rows}`);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  const bundleFiles = Object.fromEntries(
    ['main.web.bundle', 'main.lynx.bundle'].map((name) => {
      const staged = path.join(target, name);
      fs.copyFileSync(path.join(source, name), staged);
      return [name, staged];
    }),
  );
  const {
    mode, rows: expectedRows, ifr, et,
  } = configuration;
  const assertions = createVueArtifactAssertions(
    { mode, rows: expectedRows, ifr, et },
    bundleFiles,
  );
  fs.writeFileSync(
    path.join(target, 'artifact-assertions.json'),
    vueArtifactAssertionsBytes(assertions),
  );
}

function buildApp(configuration, tool) {
  const {
    app, benchCell, outputDir, rows,
  } = configuration;
  const cwd = path.join(benchmark, `apps/${app}`);
  const source = path.join(cwd, outputDir);
  fs.rmSync(path.join(cwd, 'node_modules/.cache'), { recursive: true, force: true });
  fs.rmSync(source, { recursive: true, force: true });
  run(process.execPath, [tool.absoluteBinaryPath, 'build'], cwd, {
    BENCH_AUTOROWS: String(rows),
    ...(benchCell ? { BENCH_CELL: benchCell } : {}),
  });
  stage(configuration, source);
}

buildPackage('internal', 'tsc', ['-p', 'tsconfig.build.json']);
for (const dir of ['runtime', 'main-thread', 'plugin']) buildPackage(dir, 'rslib', ['build']);
assertGeneratedVapor();

for (const { cell, tool } of preparedBuilds) buildApp(cell, tool);
writeVueFeaturedBuildMetadata(out, preparedBuilds);

if (lab) {
  console.log(`[build-vue-featured:lab] ${buildPlan.length} cells (${buildPlan[0].id}) → ${out}`);
} else {
  console.log(`[build-vue-featured] 20 cells → ${out}`);
}
