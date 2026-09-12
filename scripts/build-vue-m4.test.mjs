import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const script = new URL('./build-vue-m4.mjs', import.meta.url).pathname;

function executable(file, source) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/usr/bin/env node\n${source}`);
  fs.chmodSync(file, 0o755);
}

test('M4 builder emits separate default and optimized comparator matrices', () => {
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'build-vue-m4-'));
  try {
    const benchmark = path.join(checkout, 'packages/benchmark');
    const vueLynx = path.join(checkout, 'packages/vue-lynx');
    for (const app of ['ui-react', 'ui-vdom', 'ui-vapor']) {
      fs.mkdirSync(path.join(benchmark, `apps/${app}/src`), { recursive: true });
    }
    for (const directory of ['internal', 'runtime', 'main-thread', 'plugin']) {
      fs.mkdirSync(path.join(vueLynx, directory), { recursive: true });
    }
    const marker = '<!-- BENCH_MODE_SCRIPT --><script setup lang="ts">';
    fs.writeFileSync(path.join(benchmark, 'apps/ui-vdom/src/App.vue'), `${marker}\n</script>\n`);
    fs.writeFileSync(path.join(benchmark, 'apps/ui-vapor/src/App.vue'), 'generated later\n');

    const listMarker = '<!-- BENCH_LIST_MODE_SCRIPT --><script setup lang="ts">';
    fs.writeFileSync(
      path.join(benchmark, 'apps/ui-vdom/src/ListApp.vue'),
      `${listMarker}\n</script>\n`,
    );
    fs.writeFileSync(path.join(benchmark, 'apps/ui-vapor/src/ListApp.vue'), 'generated later\n');

    const noop = 'process.exit(0);\n';
    executable(path.join(vueLynx, 'node_modules/.bin/tsc'), noop);
    executable(path.join(vueLynx, 'node_modules/.bin/rslib'), noop);
    const rspeedy = (toolchain) => `
      const fs = require('node:fs');
      const path = require('node:path');
      const app = path.basename(process.cwd());
      const cell = process.env.BENCH_CELL;
      const listRows = Number(process.env.BENCH_LIST_ROWS);
      const baseDist = app === 'ui-react' || cell === 'off' ? 'dist' : 'dist-' + cell;
      const dist = baseDist + (listRows > 0 ? '-list-rows' + listRows : '');
      const out = path.join(process.cwd(), dist);
      fs.mkdirSync(out, { recursive: true });
      const receipt = [
        app,
        process.env.BENCH_AUTOROWS,
        process.env.BENCH_LIST_ROWS,
        process.env.BENCH_ENABLE_IFR,
        process.env.BENCH_ENABLE_ET,
        process.env.BENCH_CELL,
        process.env.NODE_ENV,
        ${JSON.stringify(toolchain)},
      ].join(':');
      fs.writeFileSync(path.join(out, 'main.web.bundle'), 'web:' + receipt);
      fs.writeFileSync(path.join(out, 'main.lynx.bundle'), 'lynx:' + receipt);
    `;
    executable(path.join(benchmark, 'node_modules/.bin/rspeedy'), rspeedy('vue-rspeedy'));
    executable(
      path.join(benchmark, 'apps/ui-react/node_modules/.bin/rspeedy'),
      rspeedy('react-rspeedy'),
    );

    const result = spawnSync(process.execPath, [script, checkout], {
      env: { ...process.env, BENCH_ROWS: '0,30000' },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\[build-vue-m4\] 24 cells/);

    const out = path.join(checkout, 'bench-out');
    for (const id of [
      'reactlynx-m4-default',
      'reactlynx-m4-et',
      'vue-lynx-m4-vdom-default',
      'vue-lynx-m4-vdom-ifr-et',
      'vue-lynx-m4-vapor-default',
      'vue-lynx-m4-vapor-ifr',
    ]) {
      for (const rows of [0, 30000]) {
        assert.equal(fs.existsSync(path.join(out, id, `rows-${rows}/main.lynx.bundle`)), true);
      }
      for (const rows of [1000, 10000]) {
        assert.equal(fs.existsSync(path.join(out, id, `list/rows-${rows}/main.lynx.bundle`)), true);
      }
    }
    assert.match(
      fs.readFileSync(path.join(out, 'reactlynx-m4-et/rows-0/main.web.bundle'), 'utf8'),
      /ui-react:0:0:0:1:et:production:react-rspeedy/,
    );
    assert.match(
      fs.readFileSync(path.join(out, 'vue-lynx-m4-vdom-ifr-et/rows-30000/main.web.bundle'), 'utf8'),
      /ui-vdom:30000:0:1:1:ifr-et:production:vue-rspeedy/,
    );
  } finally {
    fs.rmSync(checkout, { recursive: true, force: true });
  }
});
