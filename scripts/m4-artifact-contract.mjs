import { combineWorkloadReceipts, hashFiles } from './m0-artifact-contract.mjs';

export { combineWorkloadReceipts, hashFiles };

export const M4_CAMPAIGN = 'octane-roadmap-m4-final-4.1-v1';
export const M4_ROWS = Object.freeze([0, 1000, 2000, 3000, 5000, 10000, 20000, 30000]);
export const M4_ENTRY_IDS = Object.freeze([
  'octane-m4-final',
  'octane-m4-upstream',
  'reactlynx-m4-default',
  'reactlynx-m4-et',
  'vue-lynx-m4-vdom-default',
  'vue-lynx-m4-vdom-ifr-et',
  'vue-lynx-m4-vapor-default',
  'vue-lynx-m4-vapor-ifr',
]);

export const M4_PINNED_SOURCES = Object.freeze({
  'octane-m4-final': Object.freeze({
    source: 'https://github.com/Huxpro/octane',
    ref: 'huxcx/m4-main-thread-capability-payload-291',
    // Pre-merge identity only. The M4 evidence PR must update this to the exact
    // new-lynx merge SHA before any result is accepted as final.
    commit: '805fd9ed861eec7ca8d113039f6722699b6cce1c',
  }),
  'octane-m4-upstream': Object.freeze({
    source: 'https://github.com/octanejs/octane',
    ref: 'main',
    commit: '55a9aa3acd3ffad847d5604ffbdc4342a30a861d',
  }),
  comparators: Object.freeze({
    source: 'https://github.com/Huxpro/vue-lynx',
    ref: 'feat/unified-benchmark-framework-ui',
    commit: '8e02c0e4e25cd216df080c339cf1ccab855d2c71',
    producerPull: 395,
  }),
});

export const M4_PLATFORM_LANE = Object.freeze({
  sdk: 'Lynx 4.1.0',
  explorerArtifact: 'LynxExplorer-noasan-release.apk',
  explorerSha256: '6ae29787a2166974c29c2f23d87f3b20a137abcf9a8c17903ad19f3fb7f00cb6',
  explorerBytes: 173293606,
  explorerSource:
    'https://github.com/lynx-family/lynx/releases/download/4.1.0/LynxExplorer-noasan-release.apk',
});

export const M4_RUNNER_CONTRACT_FILES = Object.freeze([
  'packages/runner/src/entry-cohorts.mjs',
  'packages/runner/src/entries.mjs',
  'packages/runner/src/harness-native.mjs',
  'packages/runner/src/harness-web.mjs',
  'packages/runner/src/native-coverage.mjs',
  'packages/runner/src/native-inputs.mjs',
  'packages/runner/src/native-protocol.mjs',
  'packages/runner/src/qualification-runs.mjs',
  'packages/runner/src/run-matrix.mjs',
  'packages/shared/src/qualification.mjs',
  'packages/shared/src/scorecard.mjs',
  'packages/shared/src/workloads.mjs',
]);

export const M4_BUILD_DRIVER_FILES = Object.freeze([
  'scripts/build-octane-m4.mjs',
  'scripts/build-vue-m4.mjs',
  'scripts/m0-artifact-contract.mjs',
  'scripts/m4-artifact-contract.mjs',
  'scripts/vendor-m4-entries.mjs',
]);
