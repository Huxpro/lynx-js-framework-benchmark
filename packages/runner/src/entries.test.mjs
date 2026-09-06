import assert from 'node:assert/strict';
import test from 'node:test';

import { selectEntriesForHarness } from './entries.mjs';

test('harness selection skips implicit unsupported entries and explains explicit requests', () => {
  const entries = [
    { id: 'both', harnesses: ['web', 'native'] },
    {
      id: 'native-only',
      harnesses: ['native'],
      unsupportedHarnessReasons: { web: 'typed PAPI unavailable' },
    },
  ];

  assert.deepEqual(
    selectEntriesForHarness(entries, 'web').map(({ id }) => id),
    ['both'],
  );
  assert.throws(
    () => selectEntriesForHarness(entries, 'web', { explicit: true }),
    /native-only does not support the web harness: typed PAPI unavailable/,
  );
  assert.deepEqual(
    selectEntriesForHarness(entries, 'native', { explicit: true }).map(({ id }) => id),
    ['both', 'native-only'],
  );
});
