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
  assert.equal(M4_CAMPAIGN, 'octane-roadmap-m4-final-4.1-v3');
  assert.deepEqual(M4_ROWS, [0, 1000, 2000, 3000, 5000, 10000, 20000, 30000]);
  assert.equal(new Set(M4_ENTRY_IDS).size, 8);
  assert.equal(M4_ENTRY_IDS.every((id) => id.includes('m4')), true);
  assert.equal(
    M4_PINNED_SOURCES['octane-m4-final'].ref,
    'new-lynx',
  );
  assert.equal(
    M4_PINNED_SOURCES['octane-m4-final'].commit,
    '7a523bf20d04578c39fe0b5fe532cdef6dab3e9e',
  );
  assert.equal(
    M4_PINNED_SOURCES['octane-m4-upstream'].commit,
    '8e5ca22a6e17582b4293232406a2c0420509f4a4',
  );
  assert.equal(
    M4_PINNED_SOURCES.comparators.commit,
    'f43b859f70519fda37fd155741bef66b9dc544e0',
  );
  assert.equal(M4_PINNED_SOURCES.comparators.producerPull, 397);
  assert.equal(M4_PLATFORM_LANE.sdk, 'Lynx 4.1.0');
  assert.match(M4_PLATFORM_LANE.explorerSha256, /^[\da-f]{64}$/);
  assert.equal(M4_PLATFORM_LANE.explorerBytes, 173293606);
});
