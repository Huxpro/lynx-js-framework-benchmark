import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { LIST_CONFIG } from '../../shared/src/list-workloads.mjs';
import { playwrightViewport } from './harness-web-list.mjs';

test('list contract viewport is translated to Playwright width and height', () => {
  assert.deepEqual(playwrightViewport(LIST_CONFIG.viewport), {
    width: 390,
    height: 640,
  });
});

test('CLI passes the publication repetition count to the Web list harness', () => {
  const source = fs.readFileSync(new URL('./cli.mjs', import.meta.url), 'utf8');
  assert.match(source, /reps: suites\.includes\('list'\) \? listReps : reps/);
});
