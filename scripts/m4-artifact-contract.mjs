import { combineWorkloadReceipts, hashFiles } from './m0-artifact-contract.mjs';

export { combineWorkloadReceipts, hashFiles };

export const M4_CAMPAIGN = 'octane-roadmap-m4-final-4.1-v3';
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
    ref: 'new-lynx',
    commit: '7a523bf20d04578c39fe0b5fe532cdef6dab3e9e',
  }),
  'octane-m4-upstream': Object.freeze({
    source: 'https://github.com/octanejs/octane',
    ref: 'main',
    commit: '8e5ca22a6e17582b4293232406a2c0420509f4a4',
  }),
  comparators: Object.freeze({
    source: 'https://github.com/Huxpro/vue-lynx',
    ref: 'huxcx/native-benchmark-commit-ack-291',
    commit: 'f43b859f70519fda37fd155741bef66b9dc544e0',
    producerPull: 397,
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
  'packages/runner/adapters/lynx-sandbox-android.mjs',
  'packages/runner/src/cli.mjs',
  'packages/runner/src/connector-receipt.mjs',
  'packages/runner/src/entry-cohorts.mjs',
  'packages/runner/src/entries.mjs',
  'packages/runner/src/harness-native-list.mjs',
  'packages/runner/src/harness-native.mjs',
  'packages/runner/src/harness-web-list.mjs',
  'packages/runner/src/harness-web.mjs',
  'packages/runner/src/list-coverage.mjs',
  'packages/runner/src/list-derivation.mjs',
  'packages/runner/src/list-native-inputs.mjs',
  'packages/runner/src/list-observation.mjs',
  'packages/runner/src/native-coverage.mjs',
  'packages/runner/src/native-inputs.mjs',
  'packages/runner/src/native-protocol.mjs',
  'packages/runner/src/native-resume.mjs',
  'packages/runner/src/qualification-runs.mjs',
  'packages/runner/src/run-matrix.mjs',
  'packages/runner/src/server.mjs',
  'packages/shared/src/driver-client.mjs',
  'packages/shared/src/list-workloads.mjs',
  'packages/shared/src/qualification.mjs',
  'packages/shared/src/schema.mjs',
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
