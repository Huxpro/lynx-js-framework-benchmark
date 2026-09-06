import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const M0_CAMPAIGN = 'octane-roadmap-m0-v1';
export const M0_ROWS = Object.freeze([0, 1000, 2000, 3000, 5000, 10000]);
export const M0_ENTRY_IDS = Object.freeze([
  'octane-m0-current',
  'octane-m0-upstream',
  'reactlynx-0-126-default',
  'reactlynx-0-126-et',
  'vue-lynx-0-5-vdom-default',
  'vue-lynx-0-5-vdom-ifr-et',
  'vue-lynx-0-5-vapor-default',
  'vue-lynx-0-5-vapor-ifr',
]);

export const M0_PINNED_SOURCES = Object.freeze({
  'octane-m0-current': Object.freeze({
    source: 'https://github.com/Huxpro/octane',
    ref: 'new-lynx',
    commit: 'e82160fc0e663f52848e2181d83c6203d633bc86',
  }),
  'octane-m0-upstream': Object.freeze({
    source: 'https://github.com/octanejs/octane',
    ref: 'main',
    commit: '184631809c8eb61f5bbf15fa23b2470c1d38eea6',
  }),
  comparators: Object.freeze({
    source: 'https://github.com/Huxpro/vue-lynx',
    ref: 'pull/393/head',
    commit: 'db60b3d32c4253400d0ae3b259ebf522ffdf859d',
    mergedInto: '8b8b81d374fdd680b664ead86c3ea240ba47c7eb',
  }),
});

export const M0_RUNNER_CONTRACT_FILES = Object.freeze([
  'packages/shared/src/scorecard.mjs',
  'packages/shared/src/workloads.mjs',
  'packages/runner/src/browser.mjs',
  'packages/runner/src/entries.mjs',
  'packages/runner/src/harness-native.mjs',
  'packages/runner/src/harness-web.mjs',
  'packages/runner/src/native-protocol.mjs',
  'packages/runner/src/preflight.mjs',
  'packages/runner/src/run-matrix.mjs',
]);

export const M0_BUILD_DRIVER_FILES = Object.freeze([
  'scripts/build-octane-upstream.mjs',
  'scripts/build-vue-featured.mjs',
  'scripts/m0-artifact-contract.mjs',
  'scripts/vendor-m0-entries.mjs',
]);

export function hashFiles(root, relativeFiles) {
  const files = [...relativeFiles].sort();
  const hash = crypto.createHash('sha256');
  for (const relative of files) {
    const file = path.join(root, relative);
    if (!fs.existsSync(file)) throw new Error(`receipt input is missing: ${file}`);
    hash.update(relative);
    hash.update('\0');
    hash.update(fs.readFileSync(file));
    hash.update('\0');
  }
  return { algorithm: 'sha256-path-content-v1', files, sha256: hash.digest('hex') };
}

export function combineWorkloadReceipts(runner, source) {
  return {
    algorithm: 'sha256-runner-source-v1',
    runner,
    source,
    sha256: crypto
      .createHash('sha256')
      .update(`${runner.sha256}\0${source.sha256}`)
      .digest('hex'),
  };
}
