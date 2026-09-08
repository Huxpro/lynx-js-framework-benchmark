import { combineWorkloadReceipts, hashFiles } from './m0-artifact-contract.mjs';

export { combineWorkloadReceipts, hashFiles };

export const M3_CAMPAIGN = 'octane-roadmap-m3-native-4.1-v1';
export const M3_ROWS = Object.freeze([0, 1000, 2000, 3000, 5000, 10000, 20000, 30000]);
export const M3_ENTRY_IDS = Object.freeze([
  'octane-m3-current',
  'octane-m3-upstream',
  'reactlynx-m3-default',
  'reactlynx-m3-et',
  'vue-lynx-m3-vdom-default',
  'vue-lynx-m3-vdom-ifr-et',
  'vue-lynx-m3-vapor-default',
  'vue-lynx-m3-vapor-ifr',
]);

export const M3_PINNED_SOURCES = Object.freeze({
  'octane-m3-current': Object.freeze({
    source: 'https://github.com/Huxpro/octane',
    ref: 'new-lynx',
    commit: '47c50db72a5ead917f145af259b2993cc4c97b0f',
  }),
  'octane-m3-upstream': Object.freeze({
    source: 'https://github.com/octanejs/octane',
    ref: 'main',
    commit: 'd5de04fb99a9a26ba9cd3844949e53d39622b5c5',
  }),
  comparators: Object.freeze({
    source: 'https://github.com/Huxpro/vue-lynx',
    ref: 'feat/unified-benchmark-framework-ui',
    commit: '8e02c0e4e25cd216df080c339cf1ccab855d2c71',
    producerPull: 395,
  }),
});

export const M3_PLATFORM_LANE = Object.freeze({
  sdk: 'Lynx 4.1.0',
  explorerArtifact: 'LynxExplorer-noasan-release.apk',
  explorerSha256: '6ae29787a2166974c29c2f23d87f3b20a137abcf9a8c17903ad19f3fb7f00cb6',
  explorerBytes: 173293606,
  explorerSource:
    'https://github.com/lynx-family/lynx/releases/download/4.1.0/LynxExplorer-noasan-release.apk',
});

export const M3_RUNNER_CONTRACT_FILES = Object.freeze([
  'packages/runner/src/entry-cohorts.mjs',
  'packages/runner/src/entries.mjs',
  'packages/runner/src/harness-native.mjs',
  'packages/runner/src/native-coverage.mjs',
  'packages/runner/src/native-inputs.mjs',
  'packages/runner/src/native-protocol.mjs',
  'packages/runner/src/run-matrix.mjs',
  'packages/shared/src/scorecard.mjs',
  'packages/shared/src/workloads.mjs',
]);

export const M3_BUILD_DRIVER_FILES = Object.freeze([
  'scripts/build-octane-upstream.mjs',
  'scripts/build-vue-m3.mjs',
  'scripts/m0-artifact-contract.mjs',
  'scripts/m3-artifact-contract.mjs',
  'scripts/vendor-m3-entries.mjs',
]);
