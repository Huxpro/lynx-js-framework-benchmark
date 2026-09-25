import assert from 'node:assert/strict';
import test from 'node:test';

import {
  M4_CAMPAIGN,
  M4_ENTRY_IDS,
  M4_PINNED_SOURCES,
  M4_PLATFORM_LANE,
  M4_ROWS,
} from './m4-artifact-contract.mjs';

test('R11 refresh freezes the current Octane and upstream qualification heads', () => {
  assert.equal(M4_CAMPAIGN, 'octane-roadmap-r11-current-head-list-v1');
  assert.deepEqual(M4_ROWS, [0, 1000, 2000, 3000, 5000, 10000, 20000, 30000]);
  assert.equal(new Set(M4_ENTRY_IDS).size, 8);
  assert.equal(M4_ENTRY_IDS.every((id) => id.includes('m4')), true);
  assert.equal(
    M4_PINNED_SOURCES['octane-m4-final'].ref,
    'feat/optimal-lynx-app-adoption',
  );
  assert.equal(
    M4_PINNED_SOURCES['octane-m4-final'].commit,
    'f57026d29e9bae9c580504069b7fb1cef8207e4f',
  );
  assert.equal(
    M4_PINNED_SOURCES['octane-m4-upstream'].commit,
    'b9b0bc4e561d1ee9efdba9bbb02d8d28d040ad59',
  );
  assert.equal(
    M4_PINNED_SOURCES.comparators.commit,
    '736708bc068a0dbeabefb740ba76d62194371ef2',
  );
  assert.equal(M4_PINNED_SOURCES.comparators.producerPull, 397);
  assert.equal(M4_PLATFORM_LANE.sdk, 'Lynx develop f975a21d');
  assert.equal(
    M4_PLATFORM_LANE.engineCommit,
    'f975a21ddf6052688f41cc8b8f48255344617e11',
  );
  assert.equal(M4_PLATFORM_LANE.engineTree, '50b102720657bb49534a9d4107a9386905d2fcee');
  assert.match(M4_PLATFORM_LANE.explorerSha256, /^[\da-f]{64}$/);
  assert.equal(M4_PLATFORM_LANE.explorerBytes, 55114771);
  assert.equal(
    M4_PLATFORM_LANE.explorerSource,
    'https://github.com/Huxpro/lynx/releases/download/octane-m4-lynx-f975a21d/LynxExplorer-noasan-release.apk',
  );
});
