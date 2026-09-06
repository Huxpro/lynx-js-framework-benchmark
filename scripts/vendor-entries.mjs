// Vendor built entry bundles from local checkouts into entries/<id>/dist,
// generating entry.json manifests with provenance + sha256 checksums.
//
// Sources (override with env):
//   VUE_LYNX_BUILD   a vue-lynx checkout where bench-build-matrix.mjs ran
//   OCTANE_BUILD     the latest upstream octane main checkout with autoRows builds
//   OCTANE_HUX1_BUILD an optional Hux1 checkout with the same autoRows builds
//   OCTANE_HUX2_BUILD an optional Octane S3 checkout with the same autoRows builds
//   OCTANE_DOM_BUILD an optional octanejs/octane PR #693 checkout with the same builds
//   OCTANE_PRIOR_BUILD an optional prior upstream-main checkout
//   OCTANE_HUX_BUILD an optional #269 + #272 composite checkout with the
//                    checked-in Native benchmark instrumentation applied
//   OCTANE_PR_791_BUILD an optional clean octanejs/octane PR #791 checkout
//
// Usage: node scripts/vendor-entries.mjs
//        VENDOR_ONLY=octane-hux2 OCTANE_HUX2_BUILD=<checkout> node scripts/vendor-entries.mjs
//        VENDOR_ONLY=octane-dom OCTANE_DOM_BUILD=<checkout> node scripts/vendor-entries.mjs
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VUE_BUILD = process.env.VUE_LYNX_BUILD
  ?? path.join(os.homedir(), 'github/vue-lynx-bench-build');
const OCTANE_BUILD = process.env.OCTANE_BUILD
  ?? path.join(os.homedir(), 'github/octane-upstream-main-build');
const OCTANE_HUX1_BUILD = process.env.OCTANE_HUX1_BUILD ?? null;
const OCTANE_HUX2_BUILD = process.env.OCTANE_HUX2_BUILD ?? null;
const OCTANE_DOM_BUILD = process.env.OCTANE_DOM_BUILD ?? null;
const OCTANE_PRIOR_BUILD = process.env.OCTANE_PRIOR_BUILD ?? null;
const OCTANE_HUX_BUILD = process.env.OCTANE_HUX_BUILD
  ?? process.env.OCTANE_NEW_BUILD
  ?? null;
const OCTANE_HUX_WEB_BUILD = process.env.OCTANE_HUX_WEB_BUILD ?? null;
const OCTANE_PR_791_BUILD = process.env.OCTANE_PR_791_BUILD ?? null;

const AUTOROWS = [0, 1000, 10000, 30000];
const OCTANE_HUX_INPUT_COMMITS = {
  'pull/269/head': process.env.OCTANE_HUX_PR_269_SHA
    ?? 'b166e43f9a59864c1c887f24e8448d6014542631',
  'pull/272/head': process.env.OCTANE_HUX_PR_272_SHA
    ?? '66ff34a3f50d6b53fdb7b55e594c4fa11e4bfe6f',
};
const OCTANE_HUX_INSTRUMENTATION = 'entries/_patches/octane-hux-native-bench.patch';
const ONLY = new Set((process.env.VENDOR_ONLY ?? '').split(',').filter(Boolean));
const wants = (id) => ONLY.size === 0 || ONLY.has(id);

// Presentation metadata is source configuration, colocated with the manifest
// generator so re-vendoring cannot silently reset legend order or chart colors.
const PRESENTATION = {
  react: { order: 0, colorLight: '#2a78d6', colorDark: '#3987e5' },
  octane: { order: 1, colorLight: '#eb6834', colorDark: '#d95926' },
  'octane-pr-791': { order: 1.25, colorLight: '#2563eb', colorDark: '#60a5fa' },
  'octane-hux': { order: 1.5, colorLight: '#7c3aed', colorDark: '#a78bfa' },
  'vue-vdom': { order: 2, colorLight: '#1baf7a', colorDark: '#199e70' },
  'vue-vdom-ifr-et': { order: 3, colorLight: '#eda100', colorDark: '#c98500' },
  'vue-vapor': { order: 4, colorLight: '#e87ba4', colorDark: '#d55181' },
  'vue-vapor-ifr': { order: 5, colorLight: '#008300', colorDark: '#008300' },
  'octane-prior': { order: 100, colorLight: '#bd4c18', colorDark: '#f59e72' },
  'octane-hux1': { order: 101, colorLight: '#9f3c0d', colorDark: '#ffaf87' },
  'octane-hux2': { order: 102, colorLight: '#702a08', colorDark: '#ffc09f' },
  'octane-dom': { order: 103, colorLight: '#4f1d05', colorDark: '#ffd6bf' },
};

const sha256 = (file) =>
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const sourceDate = (dir) => execFileSync(
  'git', ['show', '-s', '--format=%cI', 'HEAD'], { cwd: dir },
).toString().trim();

const gitInfo = (dir) => ({
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim(),
  dirty: execFileSync(
    'git',
    ['status', '--porcelain', '--', 'packages', 'benchmarks', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'],
    { cwd: dir },
  )
    .toString().trim().length > 0,
});

const gitOutput = (dir, args) => execFileSync('git', args, { cwd: dir }).toString().trim();
const gitRawOutput = (dir, args) => execFileSync('git', args, { cwd: dir }).toString();

function requireCleanOctaneCheckout(id, dir) {
  const sourceGit = gitInfo(dir);
  if (sourceGit.dirty) {
    throw new Error(
      `${id}: Octane entries must be built from a clean checkout; benchmark and runtime patches are not allowed`,
    );
  }
  return sourceGit;
}

function vendor({
  id, label, framework, frameworkVersion, config, historyChannel, configuration,
  supersededBy, tags, tier = 'lab', harnesses, color, source, ref, buildCommand, cells,
}) {
  if (!wants(id)) return;
  const dir = path.join(root, 'entries', id);
  const dist = path.join(dir, 'dist');
  fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(dist, { recursive: true });
  const checks = {};
  for (const { rows, from, webFrom, lynxFrom } of cells) {
    const destDir = path.join(dist, `rows-${rows}`);
    fs.mkdirSync(destDir, { recursive: true });
    for (const f of ['main.web.bundle', 'main.lynx.bundle']) {
      const sourceDir = f === 'main.web.bundle' ? (webFrom ?? from) : (lynxFrom ?? from);
      const src = path.join(sourceDir, f);
      if (!fs.existsSync(src)) continue;
      const dest = path.join(destDir, f);
      fs.copyFileSync(src, dest);
      checks[`rows-${rows}/${f}`] = sha256(dest);
    }
    if (!fs.existsSync(path.join(destDir, 'main.web.bundle'))) {
      throw new Error(`${id}: missing web bundle for rows-${rows} (${from})`);
    }
  }
  const manifest = {
    id,
    label,
    framework,
    frameworkVersion,
    config,
    ...(historyChannel == null ? {} : { historyChannel }),
    ...(configuration == null ? {} : { configuration }),
    ...(supersededBy == null ? {} : { supersededBy }),
    tags,
    tier,
    ...(harnesses == null ? {} : { harnesses }),
    color,
    presentation: PRESENTATION[id] ?? { order: 999, colorLight: color, colorDark: color },
    kind: 'vendored',
    provenance: {
      source: source.url,
      ref,
      commit: source.commit,
      ...(source.inputCommits == null ? {} : { inputCommits: source.inputCommits }),
      ...(source.mergedInto == null ? {} : { mergedInto: source.mergedInto }),
      patched: source.dirty,
      patchFile: source.dirty ? `entries/_patches/${source.patchName}` : null,
      buildCommand,
      builtAt: source.builtAt,
      ...(source.buildEnv == null ? {} : { buildEnv: source.buildEnv }),
      sha256: checks,
    },
    bundles: { web: 'dist/rows-0/main.web.bundle', lynx: 'dist/rows-0/main.lynx.bundle' },
  };
  fs.writeFileSync(path.join(dir, 'entry.json'), JSON.stringify(manifest, null, 2));
  console.log(`[vendor] ${id}: ${Object.keys(checks).length} bundles`);
}

function vendorOctanePr791(buildDir) {
  const id = 'octane-pr-791';
  if (!wants(id)) return;
  const appDir = path.join(buildDir ?? '', 'benchmarks/lynx-table/app');
  if (!buildDir || !fs.existsSync(path.join(appDir, 'dist'))) {
    console.log(`[vendor] ${id} skipped (set OCTANE_PR_791_BUILD to the built PR checkout)`);
    return;
  }
  const sourceGit = requireCleanOctaneCheckout(id, buildDir);
  const version = JSON.parse(
    fs.readFileSync(path.join(buildDir, 'packages/octane/package.json'), 'utf-8'),
  ).version;
  vendor({
    id,
    tier: 'archive',
    harnesses: ['web'],
    label: 'Octane (PR #791)',
    framework: 'octane',
    frameworkVersion: version,
    config: `.tsrx, keyed @for; merged upstream PR snapshot ${sourceGit.commit.slice(0, 12)}`,
    historyChannel: 'merged upstream PR snapshot; archive evidence',
    supersededBy: 'octane',
    tags: ['optimized', 'snapshot', 'pr'],
    color: '#2563eb',
    source: {
      url: 'https://github.com/octanejs/octane',
      commit: sourceGit.commit,
      mergedInto: '939c64dc9d9f0fd5c5fe50255fe75ce592d0b31a',
      dirty: false,
      builtAt: sourceDate(buildDir),
    },
    ref: 'pull/791/head',
    buildCommand: 'node scripts/build-octane-upstream.mjs <octane-pr-791-checkout>',
    cells: AUTOROWS.map((rows) => ({
      rows,
      from: path.join(appDir, rows === 0 ? 'dist' : `dist-rows${rows}`),
    })),
  });
}

function vendorHuxCompositeSnapshot(id, label, buildDir) {
  if (!wants(id)) return;
  const appDir = path.join(buildDir ?? '', 'benchmarks/lynx-table/app');
  if (!buildDir || !fs.existsSync(path.join(appDir, 'dist'))) {
    console.log(`[vendor] ${id} skipped (set OCTANE_HUX_BUILD to the composite build)`);
    return;
  }
  const sourceGit = gitInfo(buildDir);
  const webBuildDir = OCTANE_HUX_WEB_BUILD;
  const webAppDir = path.join(webBuildDir ?? '', 'benchmarks/lynx-table/app');
  if (!webBuildDir || !fs.existsSync(path.join(webAppDir, 'dist'))) {
    throw new Error(`${id}: set OCTANE_HUX_WEB_BUILD to the clean composite Web build`);
  }
  const webSourceGit = requireCleanOctaneCheckout(`${id} Web`, webBuildDir);
  if (webSourceGit.commit !== sourceGit.commit) {
    throw new Error(`${id}: clean Web build and instrumented Native build use different commits`);
  }
  const parents = new Set(gitOutput(buildDir, ['show', '-s', '--format=%P', 'HEAD']).split(/\s+/));
  for (const [ref, commit] of Object.entries(OCTANE_HUX_INPUT_COMMITS)) {
    if (!parents.has(commit)) {
      throw new Error(`${id}: composite HEAD is missing ${ref} ${commit} as a direct parent`);
    }
  }
  const instrumentedFiles = [
    'benchmarks/lynx-table/app/src/App.lynx.tsrx',
    'benchmarks/lynx-table/app/src/index.ts',
  ];
  const changedFiles = gitOutput(buildDir, ['diff', '--name-only', '--', ...instrumentedFiles])
    .split('\n').filter(Boolean);
  const allChangedFiles = gitRawOutput(buildDir, [
    '-c', 'color.status=false', 'status', '--porcelain', '--',
    'packages', 'benchmarks', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
  ]).split('\n').filter(Boolean).map((line) => line.slice(3));
  if (JSON.stringify(changedFiles) !== JSON.stringify(instrumentedFiles)
    || JSON.stringify(allChangedFiles) !== JSON.stringify(instrumentedFiles)) {
    throw new Error(`${id}: checkout differs outside the two reviewed instrumentation files`);
  }
  const expectedPatch = fs.readFileSync(path.join(root, OCTANE_HUX_INSTRUMENTATION), 'utf8').trim();
  const actualPatch = gitOutput(buildDir, [
    '-c', 'color.ui=false', 'diff', '--binary', '--', ...instrumentedFiles,
  ]);
  if (actualPatch !== expectedPatch) {
    throw new Error(`${id}: Native benchmark instrumentation does not match ${OCTANE_HUX_INSTRUMENTATION}`);
  }
  const version = JSON.parse(
    fs.readFileSync(path.join(buildDir, 'packages/octane/package.json'), 'utf-8'),
  ).version;
  vendor({
    id,
    tier: 'featured',
    harnesses: ['web', 'native'],
    label,
    framework: 'octane',
    frameworkVersion: version,
    config: `.tsrx, keyed @for; compiled create + FCP; Huxpro/octane #269 ${OCTANE_HUX_INPUT_COMMITS['pull/269/head'].slice(0, 12)} + #272 ${OCTANE_HUX_INPUT_COMMITS['pull/272/head'].slice(0, 12)}`,
    historyChannel: 'Huxpro composite PR-head attempt',
    tags: ['optimized', 'snapshot', 'compiled-create', 'fcp', 'native'],
    color: '#7c3aed',
    source: {
      url: 'https://github.com/Huxpro/octane',
      commit: sourceGit.commit,
      inputCommits: OCTANE_HUX_INPUT_COMMITS,
      dirty: true,
      patchName: path.basename(OCTANE_HUX_INSTRUMENTATION),
      builtAt: sourceDate(buildDir),
      buildEnv: {
        BENCH_CORE: 'universal',
        WEB_SOURCE: 'clean-composite',
        NATIVE_SOURCE: 'reviewed-instrumentation-patch',
        NATIVE_TABLE_PROTOCOL: 'lynx-native-bench-v2',
        NATIVE_STARTUP_PROTOCOL: 'lynx-native-startup-v1',
      },
    },
    ref: 'composite:pull/269/head+pull/272/head',
    buildCommand: 'node scripts/build-octane-upstream.mjs <clean-#269+#272-composite> && node scripts/build-octane-upstream.mjs <same-composite-with-reviewed-native-instrumentation>',
    cells: AUTOROWS.map((rows) => ({
      rows,
      from: path.join(appDir, rows === 0 ? 'dist' : `dist-rows${rows}`),
      webFrom: path.join(webAppDir, rows === 0 ? 'dist' : `dist-rows${rows}`),
    })),
  });
}

// -- capture patches applied to the source checkouts -------------------------
const patchesDir = path.join(root, 'entries', '_patches');
fs.mkdirSync(patchesDir, { recursive: true });

const vueIds = ['react', 'vue-vdom', 'vue-vdom-ifr-et', 'vue-vapor', 'vue-vapor-ifr'];
const vueGit = vueIds.some(wants) ? gitInfo(VUE_BUILD) : null;
if (vueGit?.dirty) {
  const patch = execFileSync(
    'git',
    ['diff', '--no-color', '--unified=0', '--', 'packages', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'],
    { cwd: VUE_BUILD },
  ).toString();
  fs.writeFileSync(path.join(patchesDir, 'vue-lynx-bench.patch'), patch);
}
const octaneGit = wants('octane') ? gitInfo(OCTANE_BUILD) : null;
if (octaneGit?.dirty) {
  throw new Error(
    'octane: Octane entries must be built from a clean checkout; benchmark and runtime patches are not allowed',
  );
}

const vueSource = vueGit === null ? null : {
  url: 'https://github.com/Huxpro/vue-lynx',
  commit: vueGit.commit,
  dirty: vueGit.dirty,
  patchName: 'vue-lynx-bench.patch',
  builtAt: sourceDate(VUE_BUILD),
};
const octaneSource = octaneGit === null ? null : {
  url: 'https://github.com/octanejs/octane',
  commit: octaneGit.commit,
  dirty: octaneGit.dirty,
  builtAt: sourceDate(OCTANE_BUILD),
};

const vueCells = (entryId) =>
  AUTOROWS.map((rows) => ({
    rows,
    from: path.join(VUE_BUILD, 'bench-out', entryId, `rows-${rows}`),
  }));

vendor({
  id: 'react',
  tier: 'featured',
  label: 'ReactLynx 0.124',
  framework: 'reactlynx',
  frameworkVersion: '0.124.0',
  config: 'idiomatic keyed hooks (memo + useCallback)',
  tags: ['baseline'],
  color: '#1e93b0',
  source: vueSource,
  ref: 'huxcx/unify-benchmark-system',
  buildCommand: 'node scripts/build-vue-featured.mjs <vue-lynx-checkout>',
  cells: vueCells('react'),
});
vendor({
  id: 'vue-vdom',
  tier: 'featured',
  label: 'Vue',
  framework: 'vue-lynx',
  frameworkVersion: `vue ${'3.6.0-beta.17'} / vue-lynx 0.4.2`,
  config: 'vdom, IFR off, ET off',
  tags: ['baseline'],
  color: '#42b883',
  source: vueSource,
  ref: 'huxcx/unify-benchmark-system',
  buildCommand: 'node scripts/build-vue-featured.mjs <vue-lynx-checkout>',
  cells: vueCells('vue-vdom'),
});
vendor({
  id: 'vue-vdom-ifr-et',
  tier: 'featured',
  label: 'Vue +IFR',
  framework: 'vue-lynx',
  frameworkVersion: `vue ${'3.6.0-beta.17'} / vue-lynx 0.4.2`,
  config: 'vdom, enableIFR + enableElementTemplates',
  configuration: {
    summary: 'pluginVueLynx({ optionsApi: false, enableIFR: true, enableElementTemplates: true })',
    href: 'https://github.com/Huxpro/lynx-js-framework-benchmark/blob/e62f054/entries/_patches/vue-lynx-bench.patch#L537-L550',
  },
  tags: ['optimized'],
  color: '#2f855a',
  source: vueSource,
  ref: 'huxcx/unify-benchmark-system',
  buildCommand: 'node scripts/build-vue-featured.mjs <vue-lynx-checkout>',
  cells: vueCells('vue-vdom-ifr-et'),
});
vendor({
  id: 'vue-vapor',
  tier: 'featured',
  label: 'Vue Vapor',
  framework: 'vue-lynx',
  frameworkVersion: `vue ${'3.6.0-beta.17'} vapor / vue-lynx 0.4.2`,
  config: 'vapor mode, IFR off',
  tags: ['baseline'],
  color: '#e06ec4',
  source: vueSource,
  ref: 'huxcx/unify-benchmark-system',
  buildCommand: 'node scripts/build-vue-featured.mjs <vue-lynx-checkout>',
  cells: vueCells('vue-vapor'),
});
vendor({
  id: 'vue-vapor-ifr',
  tier: 'featured',
  label: 'Vue Vapor +IFR',
  framework: 'vue-lynx',
  frameworkVersion: `vue ${'3.6.0-beta.17'} vapor / vue-lynx 0.4.2`,
  config: 'vapor mode, enableIFR',
  configuration: {
    summary: 'pluginVueLynx({ optionsApi: false, vapor: true, enableIFR: true, enableElementTemplates: false })',
    href: 'https://github.com/Huxpro/lynx-js-framework-benchmark/blob/e62f054/entries/_patches/vue-lynx-bench.patch#L307-L319',
  },
  tags: ['optimized'],
  color: '#9d4b8f',
  source: vueSource,
  ref: 'huxcx/unify-benchmark-system',
  buildCommand: 'node scripts/build-vue-featured.mjs <vue-lynx-checkout>',
  cells: vueCells('vue-vapor-ifr'),
});
const octaneVersion = wants('octane')
  ? JSON.parse(
      fs.readFileSync(path.join(OCTANE_BUILD, 'packages/octane/package.json'), 'utf-8'),
    ).version
  : null;
vendor({
  id: 'octane',
  tier: 'featured',
  harnesses: ['web'],
  label: 'Octane',
  framework: 'octane',
  frameworkVersion: octaneVersion,
  config: '.tsrx, keyed @for; latest upstream main',
  historyChannel: 'upstream HEAD at measurement time',
  tags: ['optimized'],
  color: '#ff415a',
  source: octaneSource,
  ref: 'main',
  buildCommand: 'node scripts/build-octane-upstream.mjs <octane-checkout>',
  cells: AUTOROWS.map((rows) => ({
    rows,
    from: path.join(
      OCTANE_BUILD,
      'benchmarks/lynx-table/app',
      rows === 0 ? 'dist' : `dist-rows${rows}`,
    ),
  })),
});

if (
  wants('octane-hux1')
  && OCTANE_HUX1_BUILD
  && fs.existsSync(path.join(OCTANE_HUX1_BUILD, 'benchmarks/lynx-table/app/dist'))
) {
  const hux1Git = gitInfo(OCTANE_HUX1_BUILD);
  if (hux1Git.dirty) {
    fs.writeFileSync(
      path.join(patchesDir, 'octane-hux1-bench.patch'),
      execFileSync('git', ['diff', '--no-color', '--', 'packages', 'benchmarks'], { cwd: OCTANE_HUX1_BUILD }),
    );
  }
  const hux1Version = JSON.parse(
    fs.readFileSync(path.join(OCTANE_HUX1_BUILD, 'packages/octane/package.json'), 'utf-8'),
  ).version;
  vendor({
    id: 'octane-hux1',
    tier: 'archive',
    supersededBy: 'octane-hux',
    label: 'Octane (Hux1)',
    framework: 'octane',
    frameworkVersion: hux1Version,
    config: '.tsrx, keyed @for; hux perf stack tip (PR#15 lynx/receiver-diet, stacks #1→#10…#14)',
    historyChannel: 'Huxpro branch-head attempt',
    tags: ['optimized'],
    color: '#9f3c0d',
    source: {
      url: 'https://github.com/Huxpro/octane',
      commit: hux1Git.commit,
      dirty: hux1Git.dirty,
      patchName: 'octane-hux1-bench.patch',
    },
    ref: 'lynx/receiver-diet',
    buildCommand: 'BENCH_AUTOROWS=<n> node benchmarks/lynx-table/scripts/build-app.mjs',
    cells: AUTOROWS.map((rows) => ({
      rows,
      from: path.join(
        OCTANE_HUX1_BUILD,
        'benchmarks/lynx-table/app',
        rows === 0 ? 'dist' : `dist-rows${rows}`,
      ),
    })),
  });
} else if (wants('octane-hux1')) {
  console.log('[vendor] octane-hux1 skipped (set OCTANE_HUX1_BUILD to a built checkout)');
}

if (
  wants('octane-hux2')
  && OCTANE_HUX2_BUILD
  && fs.existsSync(path.join(OCTANE_HUX2_BUILD, 'benchmarks/lynx-table/app/dist'))
) {
  const hux2Git = gitInfo(OCTANE_HUX2_BUILD);
  if (hux2Git.dirty) {
    fs.writeFileSync(
      path.join(patchesDir, 'octane-hux2-bench.patch'),
      execFileSync('git', ['diff', '--no-color', '--', 'packages', 'benchmarks'], { cwd: OCTANE_HUX2_BUILD }),
    );
  }
  const hux2Version = JSON.parse(
    fs.readFileSync(path.join(OCTANE_HUX2_BUILD, 'packages/octane/package.json'), 'utf-8'),
  ).version;
  vendor({
    id: 'octane-hux2',
    tier: 'archive',
    supersededBy: 'octane-hux',
    label: 'Octane (Hux2)',
    framework: 'octane',
    frameworkVersion: hux2Version,
    config: '.tsrx, keyed @for; S3 final stack (#25→#31→#32→#33), BTS materialization and retained-state diet',
    historyChannel: 'Huxpro branch-head attempt',
    tags: ['optimized'],
    color: '#d63384',
    source: {
      url: 'https://github.com/Huxpro/octane',
      commit: hux2Git.commit,
      dirty: hux2Git.dirty,
      patchName: 'octane-hux2-bench.patch',
    },
    ref: 'perf/lynx-s3-teardown-constants',
    buildCommand: 'BENCH_AUTOROWS=<n> node benchmarks/lynx-table/scripts/build-app.mjs',
    cells: AUTOROWS.map((rows) => ({
      rows,
      from: path.join(
        OCTANE_HUX2_BUILD,
        'benchmarks/lynx-table/app',
        rows === 0 ? 'dist' : `dist-rows${rows}`,
      ),
    })),
  });
} else if (wants('octane-hux2')) {
  console.log('[vendor] octane-hux2 skipped (set OCTANE_HUX2_BUILD to a built checkout)');
}

if (
  wants('octane-dom')
  && OCTANE_DOM_BUILD
  && fs.existsSync(path.join(OCTANE_DOM_BUILD, 'benchmarks/lynx-table/app/dist'))
) {
  const domGit = gitInfo(OCTANE_DOM_BUILD);
  if (domGit.dirty) {
    fs.writeFileSync(
      path.join(patchesDir, 'octane-dom-bench.patch'),
      execFileSync('git', ['diff', '--no-color', '--', 'packages', 'benchmarks'], { cwd: OCTANE_DOM_BUILD }),
    );
  }
  const domVersion = JSON.parse(
    fs.readFileSync(path.join(OCTANE_DOM_BUILD, 'packages/octane/package.json'), 'utf-8'),
  ).version;
  vendor({
    id: 'octane-dom',
    tier: 'lab',
    label: 'Octane (DOM)',
    framework: 'octane',
    frameworkVersion: domVersion,
    config: '.tsrx, keyed @for; octanejs/octane PR #693, shared template programs, compact ACKs, and lazy handles',
    tags: ['optimized'],
    color: '#a14718',
    source: {
      url: 'https://github.com/octanejs/octane',
      commit: domGit.commit,
      dirty: domGit.dirty,
      patchName: 'octane-dom-bench.patch',
    },
    ref: 'fix/lynx-renderer-performance',
    buildCommand: 'BENCH_AUTOROWS=<n> node benchmarks/lynx-table/scripts/build-app.mjs',
    cells: AUTOROWS.map((rows) => ({
      rows,
      from: path.join(
        OCTANE_DOM_BUILD,
        'benchmarks/lynx-table/app',
        rows === 0 ? 'dist' : `dist-rows${rows}`,
      ),
    })),
  });
} else if (wants('octane-dom')) {
  console.log('[vendor] octane-dom skipped (set OCTANE_DOM_BUILD to a built checkout)');
}

// Historical upstream main retained as a calibration-only Lab comparison.
if (
  wants('octane-prior')
  && OCTANE_PRIOR_BUILD
  && fs.existsSync(path.join(OCTANE_PRIOR_BUILD, 'benchmarks/lynx-table/app/dist'))
) {
  const priorGit = gitInfo(OCTANE_PRIOR_BUILD);
  // The app sources sit on top of main as untracked files; capture them (app +
  // scripts only, not the vendored reference bundles) as the provenance patch.
  execFileSync('git', ['add', '-N', 'benchmarks/lynx-table/app', 'benchmarks/lynx-table/scripts'], { cwd: OCTANE_PRIOR_BUILD });
  fs.writeFileSync(
    path.join(patchesDir, 'octane-prior-bench.patch'),
    execFileSync('git', ['diff', '--no-color', '--', 'benchmarks/lynx-table/app', 'benchmarks/lynx-table/scripts'], {
      cwd: OCTANE_PRIOR_BUILD,
      maxBuffer: 64 * 1024 * 1024,
    }),
  );
  const priorVersion = JSON.parse(
    fs.readFileSync(path.join(OCTANE_PRIOR_BUILD, 'packages/octane/package.json'), 'utf-8'),
  ).version;
  vendor({
    id: 'octane-prior',
    tier: 'lab',
    label: 'Octane (prior)',
    framework: 'octane',
    frameworkVersion: priorVersion,
    config: '.tsrx, keyed @for; prior upstream main before the Lynx renderer performance stack',
    tags: ['baseline'],
    color: '#4a3aa7',
    source: {
      url: 'https://github.com/octanejs/octane',
      commit: priorGit.commit,
      dirty: true, // benchmarks/lynx-table app is copied in from the PR branch
      patchName: 'octane-prior-bench.patch',
    },
    ref: 'main',
    buildCommand: 'cp -r <pr>/benchmarks/lynx-table . && BENCH_AUTOROWS=<n> node benchmarks/lynx-table/scripts/build-app.mjs',
    cells: AUTOROWS.map((rows) => ({
      rows,
      from: path.join(
        OCTANE_PRIOR_BUILD,
        'benchmarks/lynx-table/app',
        rows === 0 ? 'dist' : `dist-rows${rows}`,
      ),
    })),
  });
} else if (wants('octane-prior')) {
  console.log('[vendor] octane-prior skipped (set OCTANE_PRIOR_BUILD to a built checkout)');
}

vendorHuxCompositeSnapshot(
  'octane-hux',
  'Octane (Hux)',
  OCTANE_HUX_BUILD,
);

vendorOctanePr791(OCTANE_PR_791_BUILD);

console.log('[vendor] done');
