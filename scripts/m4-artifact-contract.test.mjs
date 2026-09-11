import assert from 'node:assert/strict';
import test from 'node:test';

import {
  M4_CAMPAIGN,
  M4_ENTRY_IDS,
  M4_PINNED_SOURCES,
  M4_PLATFORM_LANE,
  M4_ROWS,
} from './m4-artifact-contract.mjs';

test('M4 freezes a distinct final qualification cohort', () => {
  assert.equal(M4_CAMPAIGN, 'octane-roadmap-m4-final-4.1-v1');
  assert.deepEqual(M4_ROWS, [0, 1000, 2000, 3000, 5000, 10000, 20000, 30000]);
  assert.equal(new Set(M4_ENTRY_IDS).size, 8);
  assert.equal(M4_ENTRY_IDS.every((id) => id.includes('m4')), true);
  assert.equal(M4_PINNED_SOURCES['octane-m4-final'].ref, 'huxcx/m3-auto-block-core-290');
  assert.equal(
    M4_PINNED_SOURCES['octane-m4-upstream'].commit,
    'f6a0b41a89e0be005ef53cbbf2ac236db3584ea2',
  );
  assert.equal(M4_PINNED_SOURCES.comparators.commit, '8e02c0e4e25cd216df080c339cf1ccab855d2c71');
  assert.equal(M4_PLATFORM_LANE.sdk, 'Lynx 4.1.0');
  assert.match(M4_PLATFORM_LANE.explorerSha256, /^[\da-f]{64}$/);
  assert.equal(M4_PLATFORM_LANE.explorerBytes, 173293606);
});
