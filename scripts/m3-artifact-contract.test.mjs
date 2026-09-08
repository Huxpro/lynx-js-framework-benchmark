import assert from 'node:assert/strict';
import test from 'node:test';

import {
  M3_CAMPAIGN,
  M3_ENTRY_IDS,
  M3_PINNED_SOURCES,
  M3_PLATFORM_LANE,
  M3_ROWS,
} from './m3-artifact-contract.mjs';

test('M3 freezes one complete Lynx 4.1 Native cohort without reusing M0 identities', () => {
  assert.equal(M3_CAMPAIGN, 'octane-roadmap-m3-native-4.1-v1');
  assert.deepEqual(M3_ROWS, [0, 1000, 2000, 3000, 5000, 10000, 20000, 30000]);
  assert.equal(new Set(M3_ENTRY_IDS).size, 8);
  assert.equal(
    M3_ENTRY_IDS.some((id) => id.includes('m0')),
    false,
  );
  assert.equal(M3_PINNED_SOURCES['octane-m3-current'].ref, 'new-lynx');
  assert.equal(
    M3_PINNED_SOURCES['octane-m3-upstream'].commit,
    'd5de04fb99a9a26ba9cd3844949e53d39622b5c5',
  );
  assert.equal(M3_PINNED_SOURCES.comparators.commit, '8e02c0e4e25cd216df080c339cf1ccab855d2c71');
  assert.equal(M3_PLATFORM_LANE.sdk, 'Lynx 4.1.0');
  assert.match(M3_PLATFORM_LANE.explorerSha256, /^[\da-f]{64}$/);
  assert.equal(M3_PLATFORM_LANE.explorerBytes, 173293606);
  assert.equal(
    M3_PLATFORM_LANE.explorerSource,
    'https://github.com/lynx-family/lynx/releases/download/4.1.0/LynxExplorer-noasan-release.apk',
  );
});
