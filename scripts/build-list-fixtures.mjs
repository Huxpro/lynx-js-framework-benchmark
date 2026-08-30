#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checkout = path.resolve(process.argv[2] ?? process.env.VUE_LYNX_BUILD ?? '');
if (!checkout || !fs.existsSync(path.join(checkout, 'packages/benchmark'))) {
  throw new Error('usage: node scripts/build-list-fixtures.mjs <vue-lynx-checkout>');
}

const benchmark = path.join(checkout, 'packages/benchmark');
const vueLynx = path.join(checkout, 'packages/vue-lynx');

function run(file, args, cwd) {
  execFileSync(file, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'production' },
  });
}

function copy(source, target) {
  fs.copyFileSync(path.join(root, source), path.join(checkout, target));
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

function build({ id, app, files = ['main.web.bundle', 'main.lynx.bundle'] }) {
  const cwd = path.join(benchmark, `apps/${app}`);
  const dist = path.join(cwd, 'dist');
  const target = path.join(root, `entries/${id}/dist/list`);
  fs.rmSync(dist, { recursive: true, force: true });
  run(path.join(benchmark, 'node_modules/.bin/rspeedy'), ['build'], cwd);
  fs.mkdirSync(target, { recursive: true });
  for (const file of files) {
    fs.copyFileSync(path.join(dist, file), path.join(target, file));
  }
}

copy('fixtures/list/react/App.tsx', 'packages/benchmark/apps/ui-react/src/App.tsx');
copy('fixtures/list/react/App.css', 'packages/benchmark/apps/ui-react/src/App.css');
copy('fixtures/list/react/lynx.config.ts', 'packages/benchmark/apps/ui-react/lynx.config.ts');
copy('fixtures/list/vue/App.vue', 'packages/benchmark/apps/ui-vdom/src/App.vue');
copy('fixtures/list/vue/lynx.config.ts', 'packages/benchmark/apps/ui-vdom/lynx.config.ts');

ensureSourceSelfLink();
buildPackage('internal', 'tsc', ['-p', 'tsconfig.build.json']);
for (const dir of ['runtime', 'main-thread', 'plugin']) buildPackage(dir, 'rslib', ['build']);
build({ id: 'react', app: 'ui-react' });
build({ id: 'vue-vdom', app: 'ui-vdom', files: ['main.web.bundle'] });

console.log('[build-list-fixtures] react web/native + vue-vdom web bundles staged');
