import assert from 'node:assert/strict';
import test from 'node:test';

import { discoverEntries } from './entries.mjs';

test('an explicit entry subset preserves requested benchmark order', () => {
  assert.deepEqual(
    discoverEntries({ only: ['octane-main', 'octane-hux2', 'octane-main'] })
      .map(({ id }) => id),
    ['octane-main', 'octane-hux2'],
  );
});
