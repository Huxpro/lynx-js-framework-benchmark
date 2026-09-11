#!/usr/bin/env node
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  combineWorkloadReceipts,
  hashFiles,
  M4_BUILD_DRIVER_FILES,
  M4_CAMPAIGN,
  M4_ENTRY_IDS,
  M4_PINNED_SOURCES,
  M4_PLATFORM_LANE,
  M4_ROWS,
  M4_RUNNER_CONTRACT_FILES,
} from './m4-artifact-contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const only = new Set((process.env.VENDOR_ONLY ?? '').split(',').filter(Boolean));
for (const id of only) {
  if (!M4_ENTRY_IDS.includes(id)) throw new Error(`unknown M4 entry in VENDOR_ONLY: ${id}`);
}
const wants = (id) => only.size === 0 || only.has(id);
const checkouts = {
  current: process.env.OCTANE_M4_FINAL_BUILD,
  upstream: process.env.OCTANE_M4_UPSTREAM_BUILD,
  comparators: process.env.VUE_M4_BUILD,
};
const runnerReceipt = hashFiles(root, M4_RUNNER_CONTRACT_FILES);
const buildDriverReceipt = hashFiles(root, M4_BUILD_DRIVER_FILES);

const presentation = Object.fromEntries(
  M4_ENTRY_IDS.map((id, index) => [
    id,
    {
      order: 40 + index,
      colorLight: [
        '#7c3aed',
        '#eb6834',
        '#2a78d6',
        '#165aa8',
        '#1baf7a',
        '#b7791f',
        '#d55181',
        '#008300',
      ][index],
      colorDark: [
        '#a78bfa',
        '#f08055',
        '#3987e5',
        '#78b4f3',
        '#36c995',
        '#eda100',
        '#e87ba4',
        '#43b843',
      ][index],
    },
  ]),
);

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const command = (cwd, file, args) => execFileSync(file, args, { cwd, encoding: 'utf8' }).trim();

function versionCommand(cwd, file) {
  const result = spawnSync(file, ['--version'], { cwd, encoding: 'utf8' });
  const output = result.stdout?.trim() ?? '';
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

function receiptFor(checkout, rspeedyDirectory, pnpmVersion) {
  const rspeedy = path.join(checkout, rspeedyDirectory, 'node_modules/.bin/rspeedy');
  return {
    node: process.version,
    pnpm: pnpmVersion ?? command(checkout, 'pnpm', ['--version']),
    rspeedy: versionCommand(path.join(checkout, rspeedyDirectory), rspeedy),
    platform: process.platform,
    architecture: process.arch,
    nodeEnv: 'production',
    buildDriver: buildDriverReceipt,
  };
}

function octaneCells(checkout, core) {
  const coreSuffix = core === 'automatic' ? '-automatic' : '';
  return M4_ROWS.map((rows) => ({
    rows,
    from: path.join(
      checkout,
      'benchmarks/lynx-table/app',
      `dist${coreSuffix}${rows === 0 ? '' : `-rows${rows}`}`,
    ),
  }));
}

function comparatorCells(checkout, id) {
  return M4_ROWS.map((rows) => ({
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
  pnpmVersion,
  buildCommand,
  cells,
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
    const hashes = M4_ROWS.map((rows) => checks[`rows-${rows}/${bundle}`]);
    if (new Set(hashes).size !== M4_ROWS.length) {
      throw new Error(`${id}: ${bundle} does not encode every frozen startup scale`);
    }
  }
  const sourceWorkload = hashFiles(sourceCheckout, sourceFiles);
  const receipts = {
    sourceCommit: pin.commit,
    sourcePatch: { present: false, path: null, sha256: null },
    dependencyLock: {
      path: 'pnpm-lock.yaml',
      sha256: sha256(path.join(sourceCheckout, 'pnpm-lock.yaml')),
    },
    engineAndToolchain: receiptFor(sourceCheckout, toolchainDirectory, pnpmVersion),
    platformLane: M4_PLATFORM_LANE,
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
    tags: ['roadmap-m4', 'lynx-4.1', configuration],
    tier: 'archive',
    harnesses,
    ...(unsupportedHarnessReasons == null ? {} : { unsupportedHarnessReasons }),
    color: presentation[id].colorLight,
    presentation: presentation[id],
    kind: 'vendored',
    roadmap: {
      issue: 291,
      milestone: 'M4',
      campaign: M4_CAMPAIGN,
      role,
      configuration,
    },
    capabilities,
    platformLane: M4_PLATFORM_LANE,
    provenance: {
      source: pin.source,
      ref: pin.ref,
      commit: pin.commit,
      ...(pin.producerPull == null ? {} : { producerPull: pin.producerPull }),
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
  console.log(`[vendor-m4] ${id}: ${Object.keys(checks).length} immutable bundles`);
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
    id: 'octane-m4-final',
    label: 'Octane M4 final default',
    role: 'final-candidate',
    checkout: checkouts.current,
    pin: M4_PINNED_SOURCES['octane-m4-final'],
    producerProtocol: true,
    core: 'automatic',
  },
  {
    id: 'octane-m4-upstream',
    label: 'Octane latest upstream',
    role: 'latest-upstream',
    checkout: checkouts.upstream,
    pin: M4_PINNED_SOURCES['octane-m4-upstream'],
    producerProtocol: false,
    core: 'universal',
  },
]) {
  if (!wants(spec.id)) continue;
  vendor({
    ...spec,
    framework: 'octane',
    frameworkVersion: readJson(spec.checkout, 'packages/octane/package.json').version,
    config: `.tsrx keyed table; compiled JS PAPI; production ${spec.core} core`,
    configuration: 'production-default',
    capabilities: {
      production: true,
      sourcePatches: false,
      core: spec.core,
      nativeTableProtocol: spec.producerProtocol ? 'lynx-native-bench-v2' : 'legacy-public-source',
      nativeStartupReceipt: spec.producerProtocol,
      elementTemplates: false,
    },
    sourceFiles: octaneSourceFiles,
    toolchainDirectory: 'packages/rspeedy-plugin-octane',
    buildCommand: `BENCH_CORE=${spec.core} BENCH_ROWS=0,1000,2000,3000,5000,10000,20000,30000 node scripts/build-octane-m4.mjs <checkout>`,
    cells: octaneCells(spec.checkout, spec.core),
  });
}

const comparatorPin = M4_PINNED_SOURCES.comparators;
const comparatorCheckout = M4_ENTRY_IDS.filter(
  (id) => id.startsWith('reactlynx-') || id.startsWith('vue-lynx-'),
).some(wants)
  ? requirePinnedCleanCheckout('M4 comparators', checkouts.comparators, comparatorPin)
  : null;
const comparatorCommon = [
  'packages/benchmark/package.json',
  'packages/benchmark/shared/native-protocol.ts',
  'packages/vue-lynx/package.json',
];
const comparatorSpecs = [
  {
    id: 'reactlynx-m4-default',
    label: 'ReactLynx 0.126',
    framework: 'reactlynx',
    frameworkVersion: '0.126.0',
    config: 'React Compiler; production default; Element Template off',
    role: 'reactlynx',
    configuration: 'production-default',
    app: 'ui-react',
    capabilities: {
      production: true,
      sourcePatches: false,
      reactCompiler: true,
      experimentalUseElementTemplate: false,
    },
  },
  {
    id: 'reactlynx-m4-et',
    label: 'ReactLynx 0.126 +ET',
    framework: 'reactlynx',
    frameworkVersion: '0.126.0',
    config: 'React Compiler; experimental typed Element Template on',
    role: 'reactlynx',
    configuration: 'explicit-optimized',
    app: 'ui-react',
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
  },
  {
    id: 'vue-lynx-m4-vdom-default',
    label: 'Vue Lynx 0.5 VDOM',
    framework: 'vue-lynx',
    frameworkVersion: 'Vue 3.6.0-beta.17 / vue-lynx 0.5.1',
    config: 'VDOM; production default; IFR and ET off',
    role: 'vue-vdom',
    configuration: 'production-default',
    app: 'ui-vdom',
    rendering: 'vdom',
    enableIFR: false,
    enableElementTemplates: false,
  },
  {
    id: 'vue-lynx-m4-vdom-ifr-et',
    label: 'Vue Lynx 0.5 VDOM +IFR +ET',
    framework: 'vue-lynx',
    frameworkVersion: 'Vue 3.6.0-beta.17 / vue-lynx 0.5.1',
    config: 'VDOM; explicit IFR and Element Templates on',
    role: 'vue-vdom',
    configuration: 'explicit-optimized',
    app: 'ui-vdom',
    rendering: 'vdom',
    enableIFR: true,
    enableElementTemplates: true,
  },
  {
    id: 'vue-lynx-m4-vapor-default',
    label: 'Vue Lynx 0.5 Vapor',
    framework: 'vue-lynx',
    frameworkVersion: 'Vue 3.6.0-beta.17 Vapor / vue-lynx 0.5.1',
    config: 'Vapor; production default; IFR off',
    role: 'vue-vapor',
    configuration: 'production-default',
    app: 'ui-vapor',
    rendering: 'vapor',
    enableIFR: false,
    enableElementTemplates: false,
  },
  {
    id: 'vue-lynx-m4-vapor-ifr',
    label: 'Vue Lynx 0.5 Vapor +IFR',
    framework: 'vue-lynx',
    frameworkVersion: 'Vue 3.6.0-beta.17 Vapor / vue-lynx 0.5.1',
    config: 'Vapor; explicit IFR on',
    role: 'vue-vapor',
    configuration: 'explicit-optimized',
    app: 'ui-vapor',
    rendering: 'vapor',
    enableIFR: true,
    enableElementTemplates: false,
  },
];

for (const spec of comparatorSpecs) {
  const capabilities = spec.capabilities ?? {
    production: true,
    sourcePatches: false,
    rendering: spec.rendering,
    enableIFR: spec.enableIFR,
    enableElementTemplates: spec.enableElementTemplates,
  };
  vendor({
    ...spec,
    capabilities: {
      ...capabilities,
      nativeTableProtocol: 'lynx-native-bench-v2',
      nativeStartupReceipt: true,
    },
    pin: comparatorPin,
    checkout: comparatorCheckout,
    sourceFiles: [
      ...comparatorCommon,
      `packages/benchmark/apps/${spec.app}/lynx.config.${spec.app === 'ui-react' ? 'ts' : 'ts'}`,
      `packages/benchmark/apps/${spec.app}/src/${spec.app === 'ui-react' ? 'App.tsx' : 'App.vue'}`,
      `packages/benchmark/apps/${spec.app}/src/index.${spec.app === 'ui-react' ? 'tsx' : 'ts'}`,
      ...(spec.app === 'ui-react'
        ? [
            'packages/benchmark/apps/ui-react/src/App.css',
            'packages/benchmark/apps/ui-react/src/data.ts',
          ]
        : []),
    ],
    toolchainDirectory:
      spec.app === 'ui-react' ? 'packages/benchmark/apps/ui-react' : 'packages/benchmark',
    pnpmVersion: '10.28.2',
    buildCommand:
      'BENCH_ROWS=0,1000,2000,3000,5000,10000,20000,30000 node scripts/build-vue-m4.mjs <vue-lynx-checkout>',
    cells: comparatorCells(comparatorCheckout, spec.id),
  });
}

console.log('[vendor-m4] done');
