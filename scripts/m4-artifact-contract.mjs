import { combineWorkloadReceipts, hashFiles } from './m0-artifact-contract.mjs';

export { combineWorkloadReceipts, hashFiles };

export const M4_CAMPAIGN = 'octane-roadmap-r11-current-head-list-v1';
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
    ref: 'feat/optimal-lynx-app-adoption',
    commit: 'f57026d29e9bae9c580504069b7fb1cef8207e4f',
  }),
  'octane-m4-upstream': Object.freeze({
    source: 'https://github.com/octanejs/octane',
    ref: 'main',
    commit: 'b9b0bc4e561d1ee9efdba9bbb02d8d28d040ad59',
  }),
  comparators: Object.freeze({
    source: 'https://github.com/Huxpro/vue-lynx',
    ref: 'huxcx/native-benchmark-commit-ack-291',
    commit: '736708bc068a0dbeabefb740ba76d62194371ef2',
    producerPull: 397,
  }),
});

export const M4_PLATFORM_LANE = Object.freeze({
  sdk: 'Lynx develop f975a21d',
  engineCommit: 'f975a21ddf6052688f41cc8b8f48255344617e11',
  engineTree: '50b102720657bb49534a9d4107a9386905d2fcee',
  explorerArtifact: 'LynxExplorer-noasan-release.apk',
  explorerSha256: '455e03f3cdfc13b4076c729fa93c3088655cdbf08f1acc7a4210e09cabd0d9e0',
  explorerBytes: 55114771,
  explorerSource:
    'https://github.com/Huxpro/lynx/releases/download/octane-m4-lynx-f975a21d/LynxExplorer-noasan-release.apk',
  explorerBuildCommand:
    './gradlew :LynxExplorer:assembleNoasanRelease -Penable_trace=perfetto -PabiList=arm64-v8a --no-daemon',
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
