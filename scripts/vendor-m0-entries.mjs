#!/usr/bin/env node
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  combineWorkloadReceipts,
  hashFiles,
  M0_BUILD_DRIVER_FILES,
  M0_CAMPAIGN,
  M0_ENTRY_IDS,
  M0_PINNED_SOURCES,
  M0_ROWS,
  M0_RUNNER_CONTRACT_FILES,
} from './m0-artifact-contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const only = new Set((process.env.VENDOR_ONLY ?? '').split(',').filter(Boolean));
for (const id of only) {
  if (!M0_ENTRY_IDS.includes(id)) throw new Error(`unknown M0 entry in VENDOR_ONLY: ${id}`);
}
const wants = (id) => only.size === 0 || only.has(id);
const octaneCurrent = process.env.OCTANE_M0_CURRENT_BUILD;
const octaneUpstream = process.env.OCTANE_M0_UPSTREAM_BUILD;
const comparators = process.env.VUE_M0_BUILD;
const runnerReceipt = hashFiles(root, M0_RUNNER_CONTRACT_FILES);
const buildDriverReceipt = hashFiles(root, M0_BUILD_DRIVER_FILES);

const presentation = {
  'reactlynx-0-126-default': { order: 10, colorLight: '#2a78d6', colorDark: '#3987e5' },
  'reactlynx-0-126-et': { order: 11, colorLight: '#165aa8', colorDark: '#78b4f3' },
  'octane-m0-current': { order: 12, colorLight: '#7c3aed', colorDark: '#a78bfa' },
  'octane-m0-upstream': { order: 13, colorLight: '#eb6834', colorDark: '#f08055' },
  'vue-lynx-0-5-vdom-default': { order: 14, colorLight: '#1baf7a', colorDark: '#36c995' },
  'vue-lynx-0-5-vdom-ifr-et': { order: 15, colorLight: '#b7791f', colorDark: '#eda100' },
  'vue-lynx-0-5-vapor-default': { order: 16, colorLight: '#d55181', colorDark: '#e87ba4' },
  'vue-lynx-0-5-vapor-ifr': { order: 17, colorLight: '#008300', colorDark: '#43b843' },
};

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const command = (cwd, file, args) => execFileSync(file, args, { cwd, encoding: 'utf8' }).trim();

function versionCommand(cwd, file) {
  const result = spawnSync(file, ['--version'], { cwd, encoding: 'utf8' });
  const output = result.stdout?.trim() ?? '';
  // Rspeedy 0.16 prints a valid version and exits 1 when invoked only for
  // version discovery. Preserve the actual CLI output, but fail if the tool
  // did not execute or did not identify itself.
  if (result.error != null || output === '' || !/Rspeedy v\d+\./.test(output)) {
    throw result.error ?? new Error(`unable to identify Rspeedy at ${file}: ${result.stderr}`);
  }
  return output;
}

function requirePinnedCleanCheckout(id, checkout, pin) {
  if (!checkout) throw new Error(`${id}: required build checkout environment variable is missing`);
  const resolved = path.resolve(checkout);
  if (!fs.existsSync(resolved)) throw new Error(`${id}: checkout does not exist: ${resolved}`);
  const commit = git(resolved, ['rev-parse', 'HEAD']);
  if (commit !== pin.commit) {
    throw new Error(`${id}: expected pinned commit ${pin.commit}, received ${commit}`);
  }
  const dirty = git(resolved, [
    'status',
    '--porcelain',
    '--untracked-files=all',
    '--',
    'packages',
    'benchmarks',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
  ]);
  if (dirty !== '') throw new Error(`${id}: source checkout has tracked modifications:\n${dirty}`);
  return resolved;
}

function readJson(checkout, relative) {
  return JSON.parse(fs.readFileSync(path.join(checkout, relative), 'utf8'));
}

function toolchainReceipt(checkout, rspeedyDirectory) {
  const rspeedy = path.join(checkout, rspeedyDirectory, 'node_modules/.bin/rspeedy');
  return {
    node: process.version,
    pnpm: command(checkout, 'pnpm', ['--version']),
    rspeedy: versionCommand(path.join(checkout, rspeedyDirectory), rspeedy),
    platform: process.platform,
    architecture: process.arch,
    nodeEnv: 'production',
    buildDriver: buildDriverReceipt,
  };
}

function dependencyLockReceipt(checkout) {
  return {
    path: 'pnpm-lock.yaml',
    sha256: sha256(path.join(checkout, 'pnpm-lock.yaml')),
  };
}

function cellsFromOctane(checkout) {
  return M0_ROWS.map((rows) => ({
    rows,
    from: path.join(
      checkout,
      'benchmarks/lynx-table/app',
      rows === 0 ? 'dist' : `dist-rows${rows}`,
    ),
  }));
}

function cellsFromComparators(checkout, id) {
  return M0_ROWS.map((rows) => ({
    rows,
    from: path.join(checkout, 'bench-out', id, `rows-${rows}`),
  }));
}

function vendor({
  id,
  label,
  framework,
  frameworkVersion,
  config,
  role,
  configuration,
  capabilities,
  pin,
  checkout,
  sourceFiles,
  toolchainDirectory,
  buildCommand,
  cells,
  tags,
  harnesses = ['web', 'native'],
  unsupportedHarnessReasons,
}) {
  if (!wants(id)) return;
  const sourceCheckout = requirePinnedCleanCheckout(id, checkout, pin);
  const dir = path.join(root, 'entries', id);
  const dist = path.join(dir, 'dist');
  fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(dist, { recursive: true });
  const checks = {};
  for (const { rows, from } of cells) {
    const target = path.join(dist, `rows-${rows}`);
    fs.mkdirSync(target, { recursive: true });
    for (const bundle of ['main.web.bundle', 'main.lynx.bundle']) {
      const input = path.join(from, bundle);
      if (!fs.existsSync(input)) throw new Error(`${id}: missing ${input}`);
      const output = path.join(target, bundle);
      fs.copyFileSync(input, output);
      checks[`rows-${rows}/${bundle}`] = sha256(output);
    }
  }
  for (const bundle of ['main.web.bundle', 'main.lynx.bundle']) {
    const scaleHashes = M0_ROWS.map((rows) => checks[`rows-${rows}/${bundle}`]);
    if (new Set(scaleHashes).size !== M0_ROWS.length) {
      throw new Error(`${id}: ${bundle} does not encode each frozen startup scale`);
    }
  }
  const sourceWorkload = hashFiles(sourceCheckout, sourceFiles);
  const receipts = {
    sourceCommit: pin.commit,
    sourcePatch: { present: false, path: null, sha256: null },
    dependencyLock: dependencyLockReceipt(sourceCheckout),
    engineAndToolchain: toolchainReceipt(sourceCheckout, toolchainDirectory),
    configurationCapabilities: capabilities,
    workloadContract: combineWorkloadReceipts(runnerReceipt, sourceWorkload),
    bundleSha256: checks,
  };
  const manifest = {
    id,
    label,
    framework,
    frameworkVersion,
    config,
    tags,
    tier: 'featured',
    harnesses,
    ...(unsupportedHarnessReasons == null ? {} : { unsupportedHarnessReasons }),
    color: presentation[id].colorLight,
    presentation: presentation[id],
    kind: 'vendored',
    roadmap: {
      issue: 282,
      milestone: 'M0',
      campaign: M0_CAMPAIGN,
      role,
      configuration,
    },
    capabilities,
    provenance: {
      source: pin.source,
      ref: pin.ref,
      commit: pin.commit,
      ...(pin.mergedInto == null ? {} : { mergedInto: pin.mergedInto }),
      patched: false,
      patchFile: null,
      buildCommand,
      builtAt: git(sourceCheckout, ['show', '-s', '--format=%cI', 'HEAD']),
      receipts,
      sha256: checks,
    },
    bundles: {
      web: 'dist/rows-0/main.web.bundle',
      lynx: 'dist/rows-0/main.lynx.bundle',
    },
  };
  fs.writeFileSync(path.join(dir, 'entry.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[vendor-m0] ${id}: ${Object.keys(checks).length} immutable bundles`);
}

const octaneSourceFiles = [
  'benchmarks/lynx-table/app/lynx.config.mjs',
  'benchmarks/lynx-table/app/src/App.lynx.tsrx',
  'benchmarks/lynx-table/app/src/app.css',
  'benchmarks/lynx-table/app/src/data.ts',
  'benchmarks/lynx-table/app/src/index.ts',
  'benchmarks/lynx-table/scripts/build-app.mjs',
];

for (const spec of [
  {
    id: 'octane-m0-current',
    label: 'Octane M0 fork',
    role: 'm0-current-fork',
    checkout: octaneCurrent,
    pin: M0_PINNED_SOURCES['octane-m0-current'],
  },
  {
    id: 'octane-m0-upstream',
    label: 'Octane M0 upstream',
    role: 'latest-upstream',
    checkout: octaneUpstream,
    pin: M0_PINNED_SOURCES['octane-m0-upstream'],
  },
]) {
  if (!wants(spec.id)) continue;
  const checkout = requirePinnedCleanCheckout(spec.id, spec.checkout, spec.pin);
  const index = fs.readFileSync(
    path.join(checkout, 'benchmarks/lynx-table/app/src/index.ts'),
    'utf8',
  );
  const nativeStartupReceipt = index.includes('lynx-native-startup-v1');
  vendor({
    ...spec,
    framework: 'octane',
    frameworkVersion: readJson(checkout, 'packages/octane/package.json').version,
    config: '.tsrx, keyed @for; clean production universal core',
    configuration: 'production-default',
    capabilities: {
      production: true,
      sourcePatches: false,
      core: 'universal',
      nativeStartupReceipt,
      elementTemplates: false,
    },
    sourceFiles: octaneSourceFiles,
    toolchainDirectory: 'packages/rspeedy-plugin-octane',
    buildCommand: 'BENCH_ROWS=0,1000,2000,3000,5000,10000 node scripts/build-octane-upstream.mjs <checkout>',
    cells: cellsFromOctane(checkout),
    tags: ['roadmap-m0', 'production-default'],
  });
}

const comparatorPin = M0_PINNED_SOURCES.comparators;
const comparatorCheckout = M0_ENTRY_IDS
  .filter((id) => id.startsWith('reactlynx-') || id.startsWith('vue-lynx-'))
  .some(wants)
  ? requirePinnedCleanCheckout('M0 comparators', comparators, comparatorPin)
  : null;

const comparatorCommon = [
  'packages/benchmark/package.json',
  'packages/vue-lynx/package.json',
];
const comparatorSpecs = [
  {
    id: 'reactlynx-0-126-default',
    label: 'ReactLynx 0.126',
    framework: 'reactlynx',
    frameworkVersion: '0.126.0',
    config: 'React Compiler; production default; Element Template off',
    configuration: 'production-default',
    capabilities: {
      production: true,
      sourcePatches: false,
      reactCompiler: true,
      experimentalUseElementTemplate: false,
    },
    sourceFiles: [
      ...comparatorCommon,
      'packages/benchmark/apps/ui-react/package.json',
      'packages/benchmark/apps/ui-react/lynx.config.ts',
      'packages/benchmark/apps/ui-react/src/App.css',
      'packages/benchmark/apps/ui-react/src/App.tsx',
      'packages/benchmark/apps/ui-react/src/data.ts',
      'packages/benchmark/apps/ui-react/src/index.tsx',
    ],
    toolchainDirectory: 'packages/benchmark/apps/ui-react',
    tags: ['roadmap-m0', 'production-default', 'baseline'],
  },
  {
    id: 'reactlynx-0-126-et',
    label: 'ReactLynx 0.126 +ET',
    framework: 'reactlynx',
    frameworkVersion: '0.126.0',
    config: 'React Compiler; explicit experimental Element Template on',
    configuration: 'explicit-optimized',
    capabilities: {
      production: true,
      sourcePatches: false,
      reactCompiler: true,
      experimentalUseElementTemplate: true,
      lynxForWeb: false,
      lynxForWebReason: 'typed-element-template-papi-unavailable',
    },
    harnesses: ['native'],
    unsupportedHarnessReasons: {
      web: 'ReactLynx Element Template requires __CreateTypedElementTemplate, which Lynx for Web 0.22.1 does not expose',
    },
    sourceFiles: [
      ...comparatorCommon,
      'packages/benchmark/apps/ui-react/package.json',
      'packages/benchmark/apps/ui-react/lynx.config.ts',
      'packages/benchmark/apps/ui-react/src/App.css',
      'packages/benchmark/apps/ui-react/src/App.tsx',
      'packages/benchmark/apps/ui-react/src/data.ts',
      'packages/benchmark/apps/ui-react/src/index.tsx',
    ],
    toolchainDirectory: 'packages/benchmark/apps/ui-react',
    tags: ['roadmap-m0', 'explicit-optimized', 'element-template'],
  },
  {
    id: 'vue-lynx-0-5-vdom-default',
    label: 'Vue Lynx 0.5 VDOM',
    framework: 'vue-lynx',
    frameworkVersion: 'Vue 3.6.0-beta.17 / vue-lynx 0.5.1',
    config: 'VDOM; production default; IFR off; Element Templates off',
    configuration: 'production-default',
    capabilities: {
      production: true,
      sourcePatches: false,
      rendering: 'vdom',
      enableIFR: false,
      enableElementTemplates: false,
    },
    sourceFiles: [
      ...comparatorCommon,
      'packages/benchmark/apps/ui-vdom/lynx.config.ts',
      'packages/benchmark/apps/ui-vdom/src/App.vue',
      'packages/benchmark/apps/ui-vdom/src/index.ts',
    ],
    toolchainDirectory: 'packages/benchmark',
    tags: ['roadmap-m0', 'production-default', 'baseline'],
  },
  {
    id: 'vue-lynx-0-5-vdom-ifr-et',
    label: 'Vue Lynx 0.5 VDOM +IFR +ET',
    framework: 'vue-lynx',
    frameworkVersion: 'Vue 3.6.0-beta.17 / vue-lynx 0.5.1',
    config: 'VDOM; explicit IFR and Element Templates on',
    configuration: 'explicit-optimized',
    capabilities: {
      production: true,
      sourcePatches: false,
      rendering: 'vdom',
      enableIFR: true,
      enableElementTemplates: true,
    },
    sourceFiles: [
      ...comparatorCommon,
      'packages/benchmark/apps/ui-vdom/lynx.config.ts',
      'packages/benchmark/apps/ui-vdom/src/App.vue',
      'packages/benchmark/apps/ui-vdom/src/index.ts',
    ],
    toolchainDirectory: 'packages/benchmark',
    tags: ['roadmap-m0', 'explicit-optimized', 'ifr', 'element-template'],
  },
  {
    id: 'vue-lynx-0-5-vapor-default',
    label: 'Vue Lynx 0.5 Vapor',
    framework: 'vue-lynx',
    frameworkVersion: 'Vue 3.6.0-beta.17 Vapor / vue-lynx 0.5.1',
    config: 'Vapor; production default; IFR off',
    configuration: 'production-default',
    capabilities: {
      production: true,
      sourcePatches: false,
      rendering: 'vapor',
      enableIFR: false,
      enableElementTemplates: false,
    },
    sourceFiles: [
      ...comparatorCommon,
      'packages/benchmark/apps/ui-vapor/lynx.config.ts',
      'packages/benchmark/apps/ui-vapor/src/App.vue',
      'packages/benchmark/apps/ui-vapor/src/index.ts',
    ],
    toolchainDirectory: 'packages/benchmark',
    tags: ['roadmap-m0', 'production-default', 'baseline'],
  },
  {
    id: 'vue-lynx-0-5-vapor-ifr',
    label: 'Vue Lynx 0.5 Vapor +IFR',
    framework: 'vue-lynx',
    frameworkVersion: 'Vue 3.6.0-beta.17 Vapor / vue-lynx 0.5.1',
    config: 'Vapor; explicit IFR on',
    configuration: 'explicit-optimized',
    capabilities: {
      production: true,
      sourcePatches: false,
      rendering: 'vapor',
      enableIFR: true,
      enableElementTemplates: false,
    },
    sourceFiles: [
      ...comparatorCommon,
      'packages/benchmark/apps/ui-vapor/lynx.config.ts',
      'packages/benchmark/apps/ui-vapor/src/App.vue',
      'packages/benchmark/apps/ui-vapor/src/index.ts',
    ],
    toolchainDirectory: 'packages/benchmark',
    tags: ['roadmap-m0', 'explicit-optimized', 'ifr'],
  },
];

for (const spec of comparatorSpecs) {
  if (!wants(spec.id)) continue;
  vendor({
    ...spec,
    role: spec.framework === 'reactlynx'
      ? 'reactlynx'
      : spec.capabilities.rendering === 'vdom' ? 'vue-vdom' : 'vue-vapor',
    pin: comparatorPin,
    checkout: comparatorCheckout,
    buildCommand: 'BENCH_PROFILE=m0 BENCH_ROWS=0,1000,2000,3000,5000,10000 node scripts/build-vue-featured.mjs <vue-lynx-checkout>',
    cells: cellsFromComparators(comparatorCheckout, spec.id),
  });
}

console.log('[vendor-m0] done');
