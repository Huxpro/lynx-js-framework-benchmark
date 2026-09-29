import assert from 'node:assert/strict';
import test from 'node:test';

import { LIST_CONFIG } from '../../shared/src/list-workloads.mjs';
import { playwrightViewport } from './harness-web-list.mjs';

test('list contract viewport is translated to Playwright width and height', () => {
  assert.deepEqual(playwrightViewport(LIST_CONFIG.viewport), {
    width: 390,
    height: 640,
  });
});
