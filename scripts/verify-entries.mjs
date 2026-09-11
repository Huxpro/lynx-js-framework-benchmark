// CI guard: every entry manifest is complete and every vendored bundle matches
// its recorded sha256 — a stale or hand-edited bundle cannot pass silently.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  hashFiles,
  M0_BUILD_DRIVER_FILES,
  M0_CAMPAIGN,
  M0_ENTRY_IDS,
  M0_PINNED_SOURCES,
  M0_ROWS,
  M0_RUNNER_CONTRACT_FILES,
} from './m0-artifact-contract.mjs';
import {
  M3_BUILD_DRIVER_FILES,
  M3_CAMPAIGN,
  M3_ENTRY_IDS,
  M3_PINNED_SOURCES,
  M3_PLATFORM_LANE,
  M3_ROWS,
  M3_RUNNER_CONTRACT_FILES,
} from './m3-artifact-contract.mjs';
import {
  M4_BUILD_DRIVER_FILES,
  M4_CAMPAIGN,
  M4_ENTRY_IDS,
  M4_PINNED_SOURCES,
  M4_PLATFORM_LANE,
  M4_ROWS,
  M4_RUNNER_CONTRACT_FILES,
} from './m4-artifact-contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entriesDir = path.join(root, 'entries');

const REQUIRED = ['id', 'label', 'framework', 'frameworkVersion', 'config', 'tier', 'color', 'presentation', 'kind', 'provenance', 'bundles'];
const TIERS = new Set(['featured', 'lab', 'archive']);
const HARNESSES = new Set(['web', 'native']);
const M0_IDS = new Set(M0_ENTRY_IDS);
const M3_IDS = new Set(M3_ENTRY_IDS);
const M0_ROLES = {
  'octane-m0-current': 'm0-current-fork',
  'octane-m0-upstream': 'latest-upstream',
  'reactlynx-0-126-default': 'reactlynx',
  'reactlynx-0-126-et': 'reactlynx',
  'vue-lynx-0-5-vdom-default': 'vue-vdom',
  'vue-lynx-0-5-vdom-ifr-et': 'vue-vdom',
  'vue-lynx-0-5-vapor-default': 'vue-vapor',
  'vue-lynx-0-5-vapor-ifr': 'vue-vapor',
};
const M0_CONFIGURATIONS = {
  'octane-m0-current': 'production-default',
  'octane-m0-upstream': 'production-default',
  'reactlynx-0-126-default': 'production-default',
  'reactlynx-0-126-et': 'explicit-optimized',
  'vue-lynx-0-5-vdom-default': 'production-default',
  'vue-lynx-0-5-vdom-ifr-et': 'explicit-optimized',
  'vue-lynx-0-5-vapor-default': 'production-default',
  'vue-lynx-0-5-vapor-ifr': 'explicit-optimized',
};
const M0_RUNNER_RECEIPT = hashFiles(root, M0_RUNNER_CONTRACT_FILES);
const M0_BUILD_DRIVER_RECEIPT = hashFiles(root, M0_BUILD_DRIVER_FILES);
const M3_RUNNER_RECEIPT = hashFiles(root, M3_RUNNER_CONTRACT_FILES);
const M3_BUILD_DRIVER_RECEIPT = hashFiles(root, M3_BUILD_DRIVER_FILES);
const M4_RUNNER_RECEIPT = hashFiles(root, M4_RUNNER_CONTRACT_FILES);
const M4_BUILD_DRIVER_RECEIPT = hashFiles(root, M4_BUILD_DRIVER_FILES);
const M3_ROLES = {
  'octane-m3-current': 'm3-candidate',
  'octane-m3-upstream': 'latest-upstream',
  'reactlynx-m3-default': 'reactlynx',
  'reactlynx-m3-et': 'reactlynx',
  'vue-lynx-m3-vdom-default': 'vue-vdom',
  'vue-lynx-m3-vdom-ifr-et': 'vue-vdom',
  'vue-lynx-m3-vapor-default': 'vue-vapor',
  'vue-lynx-m3-vapor-ifr': 'vue-vapor',
};
const M3_CONFIGURATIONS = Object.fromEntries(M3_ENTRY_IDS.map((id) => [
  id,
  id.endsWith('-et') || id.endsWith('-ifr') || id.endsWith('-ifr-et')
    ? 'explicit-optimized'
    : 'production-default',
]));
const M4_ROLES = {
  'octane-m4-final': 'final-candidate',
  'octane-m4-upstream': 'latest-upstream',
  'reactlynx-m4-default': 'reactlynx',
  'reactlynx-m4-et': 'reactlynx',
  'vue-lynx-m4-vdom-default': 'vue-vdom',
  'vue-lynx-m4-vdom-ifr-et': 'vue-vdom',
  'vue-lynx-m4-vapor-default': 'vue-vapor',
  'vue-lynx-m4-vapor-ifr': 'vue-vapor',
};
const M4_CONFIGURATIONS = Object.fromEntries(M4_ENTRY_IDS.map((id) => [
  id,
  id.endsWith('-et') || id.endsWith('-ifr') || id.endsWith('-ifr-et')
    ? 'explicit-optimized'
    : 'production-default',
]));

let failures = 0;
const fail = (msg) => {
  console.error('  [FAIL]', msg);
  failures += 1;
};

const ids = fs.readdirSync(entriesDir).filter((d) =>
  fs.existsSync(path.join(entriesDir, d, 'entry.json')));
if (ids.length === 0) fail('no entries found');
for (const id of M0_ENTRY_IDS) {
  if (!ids.includes(id)) fail(`missing frozen M0 identity ${id}`);
}
for (const id of M3_ENTRY_IDS) {
  if (!ids.includes(id)) fail(`missing frozen M3 identity ${id}`);
}
for (const id of M4_ENTRY_IDS) {
  if (!ids.includes(id)) fail(`missing frozen M4 identity ${id}`);
}

for (const id of ids) {
  const dir = path.join(entriesDir, id);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'entry.json'), 'utf-8'));
  console.log(`[verify] ${id}`);
  for (const key of REQUIRED) {
    if (manifest[key] == null) fail(`${id}: missing manifest field "${key}"`);
  }
  if (manifest.id !== id) fail(`${id}: manifest id mismatch (${manifest.id})`);
  if (!TIERS.has(manifest.tier)) fail(`${id}: invalid tier "${manifest.tier}"`);
  if (manifest.tiers != null) {
    if (typeof manifest.tiers !== 'object' || Array.isArray(manifest.tiers)) {
      fail(`${id}: tiers must be an object`);
    } else {
      for (const [harness, tier] of Object.entries(manifest.tiers)) {
        if (!HARNESSES.has(harness) || !TIERS.has(tier)) {
          fail(`${id}: invalid ${harness} harness tier ${JSON.stringify(tier)}`);
        }
      }
    }
  }
  if (manifest.harnesses != null && (
    !Array.isArray(manifest.harnesses)
    || manifest.harnesses.length === 0
    || new Set(manifest.harnesses).size !== manifest.harnesses.length
    || manifest.harnesses.some((harness) => !HARNESSES.has(harness))
  )) fail(`${id}: invalid harnesses ${JSON.stringify(manifest.harnesses)}`);
  if (manifest.unsupportedHarnessReasons != null) {
    if (typeof manifest.unsupportedHarnessReasons !== 'object'
      || Array.isArray(manifest.unsupportedHarnessReasons)) {
      fail(`${id}: unsupportedHarnessReasons must be an object`);
    } else {
      for (const [harness, reason] of Object.entries(manifest.unsupportedHarnessReasons)) {
        if (!HARNESSES.has(harness)
          || manifest.harnesses?.includes(harness)
          || typeof reason !== 'string'
          || reason.length === 0) {
          fail(`${id}: invalid unsupported ${harness} harness reason`);
        }
      }
    }
  }
  if (!/^#[\da-f]{6}$/i.test(manifest.color ?? '')) fail(`${id}: invalid color "${manifest.color}"`);
  if (!Number.isFinite(manifest.presentation?.order)) fail(`${id}: invalid presentation.order`);
  for (const key of ['colorLight', 'colorDark']) {
    if (!/^#[\da-f]{6}$/i.test(manifest.presentation?.[key] ?? '')) {
      fail(`${id}: invalid presentation.${key} "${manifest.presentation?.[key]}"`);
    }
  }
  if (!manifest.provenance?.commit) fail(`${id}: provenance.commit missing`);
  if (manifest.tier === 'featured' && manifest.framework === 'octane' && id !== 'octane-hux') {
    if (manifest.provenance.patched !== false || manifest.provenance.patchFile != null) {
      fail(`${id}: featured Octane entries must use an unpatched source checkout`);
    }
    const expectedHarnesses = M0_IDS.has(id) ? ['web', 'native'] : ['web'];
    if (JSON.stringify(manifest.harnesses) !== JSON.stringify(expectedHarnesses)) {
      fail(`${id}: featured Octane entry must declare ${expectedHarnesses.join(' + ')}`);
    }
  }
  if (M0_IDS.has(id)) {
    const pin = id.startsWith('octane-')
      ? M0_PINNED_SOURCES[id]
      : M0_PINNED_SOURCES.comparators;
    const roadmap = manifest.roadmap;
    const receipts = manifest.provenance?.receipts;
    if (manifest.tier !== 'featured') fail(`${id}: M0 identity must be featured`);
    const expectedHarnesses = id === 'reactlynx-0-126-et'
      ? ['native']
      : ['web', 'native'];
    if (JSON.stringify(manifest.harnesses) !== JSON.stringify(expectedHarnesses)) {
      fail(`${id}: M0 identity has the wrong executable harness set`);
    }
    if (id === 'reactlynx-0-126-et'
      && (manifest.unsupportedHarnessReasons?.web == null
        || manifest.capabilities?.lynxForWeb !== false
        || manifest.capabilities?.lynxForWebReason !== 'typed-element-template-papi-unavailable')) {
      fail(`${id}: ReactLynx ET must retain its observed Lynx-for-Web capability failure`);
    }
    if (roadmap?.issue !== 282 || roadmap?.milestone !== 'M0'
      || roadmap?.campaign !== M0_CAMPAIGN) {
      fail(`${id}: invalid M0 roadmap identity`);
    }
    if (roadmap?.role !== M0_ROLES[id]) fail(`${id}: invalid M0 role ${roadmap?.role}`);
    if (roadmap?.configuration !== M0_CONFIGURATIONS[id]) {
      fail(`${id}: invalid M0 configuration ${roadmap?.configuration}`);
    }
    if (manifest.provenance?.source !== pin.source
      || manifest.provenance?.ref !== pin.ref
      || manifest.provenance?.commit !== pin.commit) {
      fail(`${id}: source identity differs from the frozen M0 pin`);
    }
    if (pin.mergedInto != null && manifest.provenance?.mergedInto !== pin.mergedInto) {
      fail(`${id}: comparator merge provenance differs from the frozen M0 pin`);
    }
    if (manifest.provenance?.patched !== false || manifest.provenance?.patchFile !== null
      || receipts?.sourcePatch?.present !== false
      || receipts?.sourcePatch?.path !== null
      || receipts?.sourcePatch?.sha256 !== null) {
      fail(`${id}: M0 identity must come from an unpatched checkout`);
    }
    if (receipts?.sourceCommit !== pin.commit) fail(`${id}: source-commit receipt mismatch`);
    if (!/^[\da-f]{64}$/.test(receipts?.dependencyLock?.sha256 ?? '')) {
      fail(`${id}: dependency-lock receipt is missing`);
    }
    if (receipts?.dependencyLock?.path !== 'pnpm-lock.yaml') {
      fail(`${id}: dependency-lock receipt path must be pnpm-lock.yaml`);
    }
    const toolchain = receipts?.engineAndToolchain;
    if (!/^v\d+\./.test(toolchain?.node ?? '')
      || !/^\d+\.\d+\.\d+/.test(toolchain?.pnpm ?? '')
      || !/Rspeedy v\d+\./.test(toolchain?.rspeedy ?? '')
      || toolchain?.nodeEnv !== 'production'
      || toolchain?.buildDriver?.sha256 !== M0_BUILD_DRIVER_RECEIPT.sha256
      || JSON.stringify(toolchain?.buildDriver?.files)
        !== JSON.stringify(M0_BUILD_DRIVER_RECEIPT.files)) {
      fail(`${id}: engine-and-toolchain receipt is incomplete`);
    }
    if (JSON.stringify(receipts?.configurationCapabilities)
      !== JSON.stringify(manifest.capabilities)) {
      fail(`${id}: configuration-capabilities receipt mismatch`);
    }
    const workload = receipts?.workloadContract;
    if (workload?.runner?.sha256 !== M0_RUNNER_RECEIPT.sha256
      || JSON.stringify(workload?.runner?.files) !== JSON.stringify(M0_RUNNER_RECEIPT.files)
      || !/^[\da-f]{64}$/.test(workload?.source?.sha256 ?? '')
      || !/^[\da-f]{64}$/.test(workload?.sha256 ?? '')) {
      fail(`${id}: workload-contract receipt is incomplete or stale`);
    }
    const expectedBundles = Object.fromEntries(M0_ROWS.flatMap((rows) => [
      [`rows-${rows}/main.web.bundle`, manifest.provenance?.sha256?.[`rows-${rows}/main.web.bundle`]],
      [`rows-${rows}/main.lynx.bundle`, manifest.provenance?.sha256?.[`rows-${rows}/main.lynx.bundle`]],
    ]));
    if (Object.keys(manifest.provenance?.sha256 ?? {}).length !== M0_ROWS.length * 2
      || Object.values(expectedBundles).some((value) => !/^[\da-f]{64}$/.test(value ?? ''))
      || JSON.stringify(receipts?.bundleSha256) !== JSON.stringify(manifest.provenance?.sha256)) {
      fail(`${id}: frozen M0 row matrix or bundle-sha256 receipt is incomplete`);
    }
    for (const bundle of ['main.web.bundle', 'main.lynx.bundle']) {
      const hashes = M0_ROWS.map((rows) => manifest.provenance.sha256[`rows-${rows}/${bundle}`]);
      if (new Set(hashes).size !== M0_ROWS.length) {
        fail(`${id}: ${bundle} does not encode every startup scale`);
      }
    }
  }
  if (M3_IDS.has(id)) {
    const pin = id.startsWith('octane-')
      ? M3_PINNED_SOURCES[id]
      : M3_PINNED_SOURCES.comparators;
    const roadmap = manifest.roadmap;
    const receipts = manifest.provenance?.receipts;
    const expectedHarnesses = id === 'reactlynx-m3-et' ? ['native'] : ['web', 'native'];
    if (manifest.tier !== 'archive'
      || JSON.stringify(manifest.tiers) !== JSON.stringify({ native: 'featured' })) {
      fail(`${id}: M3 identity must be archive globally and featured only in Native`);
    }
    if (JSON.stringify(manifest.harnesses) !== JSON.stringify(expectedHarnesses)) {
      fail(`${id}: M3 identity has the wrong executable harness set`);
    }
    if (roadmap?.issue !== 282 || roadmap?.milestone !== 'M3'
      || roadmap?.campaign !== M3_CAMPAIGN
      || roadmap?.role !== M3_ROLES[id]
      || roadmap?.configuration !== M3_CONFIGURATIONS[id]) {
      fail(`${id}: invalid M3 roadmap identity`);
    }
    if (manifest.provenance?.source !== pin.source
      || manifest.provenance?.ref !== pin.ref
      || manifest.provenance?.commit !== pin.commit) {
      fail(`${id}: source identity differs from the frozen M3 pin`);
    }
    if (pin.producerPull != null && manifest.provenance?.producerPull !== pin.producerPull) {
      fail(`${id}: comparator producer PR provenance differs from the frozen M3 pin`);
    }
    if (manifest.provenance?.patched !== false || manifest.provenance?.patchFile !== null
      || receipts?.sourcePatch?.present !== false
      || receipts?.sourcePatch?.path !== null
      || receipts?.sourcePatch?.sha256 !== null) {
      fail(`${id}: M3 identity must come from an unpatched checkout`);
    }
    if (receipts?.sourceCommit !== pin.commit
      || JSON.stringify(manifest.platformLane) !== JSON.stringify(M3_PLATFORM_LANE)
      || JSON.stringify(receipts?.platformLane) !== JSON.stringify(M3_PLATFORM_LANE)) {
      fail(`${id}: source or Lynx 4.1 platform-lane receipt mismatch`);
    }
    if (!/^[\da-f]{64}$/.test(receipts?.dependencyLock?.sha256 ?? '')
      || receipts?.dependencyLock?.path !== 'pnpm-lock.yaml') {
      fail(`${id}: dependency-lock receipt is incomplete`);
    }
    const toolchain = receipts?.engineAndToolchain;
    if (!/^v\d+\./.test(toolchain?.node ?? '')
      || !/^\d+\.\d+\.\d+/.test(toolchain?.pnpm ?? '')
      || !/Rspeedy v\d+\./.test(toolchain?.rspeedy ?? '')
      || toolchain?.nodeEnv !== 'production'
      || toolchain?.buildDriver?.sha256 !== M3_BUILD_DRIVER_RECEIPT.sha256
      || JSON.stringify(toolchain?.buildDriver?.files)
        !== JSON.stringify(M3_BUILD_DRIVER_RECEIPT.files)) {
      fail(`${id}: M3 engine-and-toolchain receipt is incomplete`);
    }
    if (JSON.stringify(receipts?.configurationCapabilities)
      !== JSON.stringify(manifest.capabilities)) {
      fail(`${id}: M3 configuration-capabilities receipt mismatch`);
    }
    const workload = receipts?.workloadContract;
    if (workload?.runner?.sha256 !== M3_RUNNER_RECEIPT.sha256
      || JSON.stringify(workload?.runner?.files) !== JSON.stringify(M3_RUNNER_RECEIPT.files)
      || !/^[\da-f]{64}$/.test(workload?.source?.sha256 ?? '')
      || !/^[\da-f]{64}$/.test(workload?.sha256 ?? '')) {
      fail(`${id}: M3 workload-contract receipt is incomplete or stale`);
    }
    const expectedBundleKeys = M3_ROWS.flatMap((rows) => [
      `rows-${rows}/main.web.bundle`,
      `rows-${rows}/main.lynx.bundle`,
    ]);
    if (Object.keys(manifest.provenance?.sha256 ?? {}).length !== expectedBundleKeys.length
      || expectedBundleKeys.some((key) => !/^[\da-f]{64}$/.test(manifest.provenance?.sha256?.[key] ?? ''))
      || JSON.stringify(receipts?.bundleSha256) !== JSON.stringify(manifest.provenance?.sha256)) {
      fail(`${id}: frozen M3 row matrix or bundle-sha256 receipt is incomplete`);
    }
    for (const bundle of ['main.web.bundle', 'main.lynx.bundle']) {
      const hashes = M3_ROWS.map((rows) => manifest.provenance.sha256[`rows-${rows}/${bundle}`]);
      if (new Set(hashes).size !== M3_ROWS.length) {
        fail(`${id}: ${bundle} does not encode every M3 startup scale`);
      }
    }
  }
  if (id === 'octane-hux') {
    if (manifest.label !== 'Octane (Hux)') fail(`${id}: public label must be Octane (Hux)`);
    if (manifest.tier !== 'featured') fail(`${id}: Hux composite entry must be featured`);
    if (manifest.provenance.ref !== 'composite:pull/269/head+pull/272/head') {
      fail(`${id}: provenance.ref must identify the #269 + #272 composite`);
    }
    const expectedInputs = {
      'pull/269/head': 'b166e43f9a59864c1c887f24e8448d6014542631',
      'pull/272/head': '66ff34a3f50d6b53fdb7b55e594c4fa11e4bfe6f',
    };
    if (JSON.stringify(manifest.provenance.inputCommits) !== JSON.stringify(expectedInputs)) {
      fail(`${id}: provenance.inputCommits must pin PR #269 and PR #272 heads`);
    }
    if (manifest.provenance.patched !== true
      || manifest.provenance.patchFile !== 'entries/_patches/octane-hux-native-bench.patch') {
      fail(`${id}: Hux Native instrumentation patch provenance is missing`);
    }
    if (manifest.provenance.buildEnv?.BENCH_CORE !== 'universal'
      || manifest.provenance.buildEnv?.WEB_SOURCE !== 'clean-composite'
      || manifest.provenance.buildEnv?.NATIVE_SOURCE !== 'reviewed-instrumentation-patch'
      || manifest.provenance.buildEnv?.NATIVE_TABLE_PROTOCOL !== 'lynx-native-bench-v2'
      || manifest.provenance.buildEnv?.NATIVE_STARTUP_PROTOCOL !== 'lynx-native-startup-v1') {
      fail(`${id}: Hux composite build environment does not pin the Native producer contracts`);
    }
    if (manifest.webLab != null || manifest.nativeLab != null || manifest.ranking != null) {
      fail(`${id}: Hux new-lynx entry must not use Lab contracts`);
    }
    if (JSON.stringify(manifest.harnesses) !== JSON.stringify(['web', 'native'])) {
      fail(`${id}: Hux composite entry must explicitly support Web and Native`);
    }
  }
  if (id === 'octane-hux1' || id === 'octane-hux2') {
    if (manifest.tier !== 'archive' || manifest.supersededBy !== 'octane-hux') {
      fail(`${id}: historical Hux attempt must be archive evidence superseded by octane-hux`);
    }
  }
  if (id === 'octane-pr-791') {
    if (manifest.tier !== 'archive') fail(`${id}: merged PR #791 entry must be archive evidence`);
    if (manifest.supersededBy !== 'octane') fail(`${id}: merged PR #791 must be superseded by octane`);
    if (manifest.provenance.ref !== 'pull/791/head') fail(`${id}: provenance.ref must be pull/791/head`);
    if (manifest.provenance.mergedInto !== '939c64dc9d9f0fd5c5fe50255fe75ce592d0b31a') {
      fail(`${id}: provenance.mergedInto must identify PR #791's upstream merge commit`);
    }
    if (manifest.provenance.patched !== false || manifest.provenance.patchFile != null) {
      fail(`${id}: archived PR #791 evidence must use a clean source checkout`);
    }
    if (JSON.stringify(manifest.harnesses) !== JSON.stringify(['web'])) {
      fail(`${id}: PR #791 entry must be explicitly Web-only`);
    }
  }
  if (manifest.provenance?.patched && manifest.provenance?.patchFile) {
    if (!fs.existsSync(path.join(root, manifest.provenance.patchFile))) {
      fail(`${id}: provenance.patchFile ${manifest.provenance.patchFile} does not exist`);
    }
  }
  const checks = manifest.provenance?.sha256 ?? {};
  if (Object.keys(checks).length === 0) fail(`${id}: no sha256 checksums`);
  for (const [rel, expected] of Object.entries(checks)) {
    const file = path.join(dir, 'dist', rel);
    if (!fs.existsSync(file)) {
      fail(`${id}: checksummed bundle missing: dist/${rel}`);
      continue;
    }
    const actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    if (actual !== expected) fail(`${id}: sha256 mismatch for dist/${rel}`);
  }
  const web = path.join(dir, manifest.bundles?.web ?? '');
  if (!fs.existsSync(web)) fail(`${id}: bundles.web missing (${manifest.bundles?.web})`);
}

for (const id of M4_ENTRY_IDS) {
  if (!ids.includes(id)) continue;
  const manifest = JSON.parse(fs.readFileSync(path.join(entriesDir, id, 'entry.json'), 'utf8'));
  const pin = id.startsWith('octane-')
    ? M4_PINNED_SOURCES[id]
    : M4_PINNED_SOURCES.comparators;
  const roadmap = manifest.roadmap;
  const receipts = manifest.provenance?.receipts;
  const expectedHarnesses = id === 'reactlynx-m4-et' ? ['native'] : ['web', 'native'];
  if (manifest.tier !== 'archive' || manifest.tiers != null) {
    fail(`${id}: M4 evidence identity must remain explicit-selection archive data`);
  }
  if (JSON.stringify(manifest.harnesses) !== JSON.stringify(expectedHarnesses)) {
    fail(`${id}: M4 identity has the wrong executable harness set`);
  }
  if (roadmap?.issue !== 291 || roadmap?.milestone !== 'M4'
    || roadmap?.campaign !== M4_CAMPAIGN
    || roadmap?.role !== M4_ROLES[id]
    || roadmap?.configuration !== M4_CONFIGURATIONS[id]) {
    fail(`${id}: invalid M4 roadmap identity`);
  }
  if (manifest.provenance?.source !== pin.source
    || manifest.provenance?.ref !== pin.ref
    || manifest.provenance?.commit !== pin.commit) {
    fail(`${id}: source identity differs from the frozen M4 pin`);
  }
  if (pin.producerPull != null && manifest.provenance?.producerPull !== pin.producerPull) {
    fail(`${id}: comparator producer PR provenance differs from the frozen M4 pin`);
  }
  if (manifest.provenance?.patched !== false || manifest.provenance?.patchFile !== null
    || receipts?.sourcePatch?.present !== false
    || receipts?.sourcePatch?.path !== null
    || receipts?.sourcePatch?.sha256 !== null) {
    fail(`${id}: M4 identity must come from an unpatched checkout`);
  }
  if (receipts?.sourceCommit !== pin.commit
    || JSON.stringify(manifest.platformLane) !== JSON.stringify(M4_PLATFORM_LANE)
    || JSON.stringify(receipts?.platformLane) !== JSON.stringify(M4_PLATFORM_LANE)) {
    fail(`${id}: source or Lynx 4.1 platform-lane receipt mismatch`);
  }
  if (!/^[\da-f]{64}$/.test(receipts?.dependencyLock?.sha256 ?? '')
    || receipts?.dependencyLock?.path !== 'pnpm-lock.yaml') {
    fail(`${id}: dependency-lock receipt is incomplete`);
  }
  const toolchain = receipts?.engineAndToolchain;
  if (!/^v\d+\./.test(toolchain?.node ?? '')
    || !/^\d+\.\d+\.\d+/.test(toolchain?.pnpm ?? '')
    || !/Rspeedy v\d+\./.test(toolchain?.rspeedy ?? '')
    || toolchain?.nodeEnv !== 'production'
    || toolchain?.buildDriver?.sha256 !== M4_BUILD_DRIVER_RECEIPT.sha256
    || JSON.stringify(toolchain?.buildDriver?.files)
      !== JSON.stringify(M4_BUILD_DRIVER_RECEIPT.files)) {
    fail(`${id}: M4 engine-and-toolchain receipt is incomplete`);
  }
  if (JSON.stringify(receipts?.configurationCapabilities)
    !== JSON.stringify(manifest.capabilities)) {
    fail(`${id}: M4 configuration-capabilities receipt mismatch`);
  }
  const workload = receipts?.workloadContract;
  if (workload?.runner?.sha256 !== M4_RUNNER_RECEIPT.sha256
    || JSON.stringify(workload?.runner?.files) !== JSON.stringify(M4_RUNNER_RECEIPT.files)
    || !/^[\da-f]{64}$/.test(workload?.source?.sha256 ?? '')
    || !/^[\da-f]{64}$/.test(workload?.sha256 ?? '')) {
    fail(`${id}: M4 workload-contract receipt is incomplete or stale`);
  }
  const expectedBundleKeys = M4_ROWS.flatMap((rows) => [
    `rows-${rows}/main.web.bundle`,
    `rows-${rows}/main.lynx.bundle`,
  ]);
  if (Object.keys(manifest.provenance?.sha256 ?? {}).length !== expectedBundleKeys.length
    || expectedBundleKeys.some((key) => !/^[\da-f]{64}$/.test(manifest.provenance?.sha256?.[key] ?? ''))
    || JSON.stringify(receipts?.bundleSha256) !== JSON.stringify(manifest.provenance?.sha256)) {
    fail(`${id}: frozen M4 row matrix or bundle-sha256 receipt is incomplete`);
  }
  for (const bundle of ['main.web.bundle', 'main.lynx.bundle']) {
    const hashes = M4_ROWS.map((rows) => manifest.provenance.sha256[`rows-${rows}/${bundle}`]);
    if (new Set(hashes).size !== M4_ROWS.length) {
      fail(`${id}: ${bundle} does not encode every M4 startup scale`);
    }
  }
}

for (const [defaultId, optimizedId] of [
  ['reactlynx-0-126-default', 'reactlynx-0-126-et'],
  ['vue-lynx-0-5-vdom-default', 'vue-lynx-0-5-vdom-ifr-et'],
  ['vue-lynx-0-5-vapor-default', 'vue-lynx-0-5-vapor-ifr'],
]) {
  const readManifest = (id) => JSON.parse(
    fs.readFileSync(path.join(entriesDir, id, 'entry.json'), 'utf8'),
  );
  const baseline = readManifest(defaultId).provenance.sha256;
  const optimized = readManifest(optimizedId).provenance.sha256;
  for (const rows of M0_ROWS) {
    for (const bundle of ['main.web.bundle', 'main.lynx.bundle']) {
      const key = `rows-${rows}/${bundle}`;
      if (baseline[key] === optimized[key]) {
        fail(`${defaultId}/${optimizedId}: ${key} does not distinguish the configuration`);
      }
    }
  }
}

for (const [defaultId, optimizedId] of [
  ['reactlynx-m3-default', 'reactlynx-m3-et'],
  ['vue-lynx-m3-vdom-default', 'vue-lynx-m3-vdom-ifr-et'],
  ['vue-lynx-m3-vapor-default', 'vue-lynx-m3-vapor-ifr'],
]) {
  const readManifest = (id) => JSON.parse(
    fs.readFileSync(path.join(entriesDir, id, 'entry.json'), 'utf8'),
  );
  const baseline = readManifest(defaultId).provenance.sha256;
  const optimized = readManifest(optimizedId).provenance.sha256;
  for (const rows of M3_ROWS) {
    for (const bundle of ['main.web.bundle', 'main.lynx.bundle']) {
      const key = `rows-${rows}/${bundle}`;
      if (baseline[key] === optimized[key]) {
        fail(`${defaultId}/${optimizedId}: ${key} does not distinguish the configuration`);
      }
    }
  }
}

for (const [defaultId, optimizedId] of [
  ['reactlynx-m4-default', 'reactlynx-m4-et'],
  ['vue-lynx-m4-vdom-default', 'vue-lynx-m4-vdom-ifr-et'],
  ['vue-lynx-m4-vapor-default', 'vue-lynx-m4-vapor-ifr'],
]) {
  if (!ids.includes(defaultId) || !ids.includes(optimizedId)) continue;
  const readManifest = (id) => JSON.parse(
    fs.readFileSync(path.join(entriesDir, id, 'entry.json'), 'utf8'),
  );
  const baseline = readManifest(defaultId).provenance.sha256;
  const optimized = readManifest(optimizedId).provenance.sha256;
  for (const rows of M4_ROWS) {
    for (const bundle of ['main.web.bundle', 'main.lynx.bundle']) {
      const key = `rows-${rows}/${bundle}`;
      if (baseline[key] === optimized[key]) {
        fail(`${defaultId}/${optimizedId}: ${key} does not distinguish the configuration`);
      }
    }
  }
}

const currentNativeIds = ids.flatMap((id) => {
  const manifest = JSON.parse(fs.readFileSync(path.join(entriesDir, id, 'entry.json'), 'utf8'));
  return manifest.tiers?.native === 'featured' ? [id] : [];
}).sort();
if (JSON.stringify(currentNativeIds) !== JSON.stringify([...M3_ENTRY_IDS].sort())) {
  fail('the explicit current Native cohort must contain exactly the frozen M3 identities');
}

const currentOctaneToolchain = JSON.parse(
  fs.readFileSync(path.join(entriesDir, 'octane-m0-current/entry.json'), 'utf8'),
).provenance.receipts.engineAndToolchain;
const upstreamOctaneToolchain = JSON.parse(
  fs.readFileSync(path.join(entriesDir, 'octane-m0-upstream/entry.json'), 'utf8'),
).provenance.receipts.engineAndToolchain;
for (const key of ['node', 'pnpm', 'rspeedy', 'platform', 'architecture', 'nodeEnv']) {
  if (currentOctaneToolchain[key] !== upstreamOctaneToolchain[key]) {
    fail(`M0 fork/upstream toolchain mismatch for ${key}`);
  }
}

const currentM3Toolchain = JSON.parse(
  fs.readFileSync(path.join(entriesDir, 'octane-m3-current/entry.json'), 'utf8'),
).provenance.receipts.engineAndToolchain;
const upstreamM3Toolchain = JSON.parse(
  fs.readFileSync(path.join(entriesDir, 'octane-m3-upstream/entry.json'), 'utf8'),
).provenance.receipts.engineAndToolchain;
for (const key of ['node', 'pnpm', 'rspeedy', 'platform', 'architecture', 'nodeEnv']) {
  if (currentM3Toolchain[key] !== upstreamM3Toolchain[key]) {
    fail(`M3 candidate/upstream toolchain mismatch for ${key}`);
  }
}

if (ids.includes('octane-m4-final') && ids.includes('octane-m4-upstream')) {
  const finalM4Toolchain = JSON.parse(
    fs.readFileSync(path.join(entriesDir, 'octane-m4-final/entry.json'), 'utf8'),
  ).provenance.receipts.engineAndToolchain;
  const upstreamM4Toolchain = JSON.parse(
    fs.readFileSync(path.join(entriesDir, 'octane-m4-upstream/entry.json'), 'utf8'),
  ).provenance.receipts.engineAndToolchain;
  for (const key of ['node', 'pnpm', 'rspeedy', 'platform', 'architecture', 'nodeEnv']) {
    if (finalM4Toolchain[key] !== upstreamM4Toolchain[key]) {
      fail(`M4 candidate/upstream toolchain mismatch for ${key}`);
    }
  }
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log(`\nall ${ids.length} entries verified`);
