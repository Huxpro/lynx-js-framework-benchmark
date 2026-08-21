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
//   OCTANE_NEW_BUILD an optional dated new-lynx snapshot checkout
//   OCTANE_NEW_PATCH the exact app-only Native instrumentation patch applied to that checkout
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
const OCTANE_NEW_BUILD = process.env.OCTANE_NEW_BUILD ?? null;
const OCTANE_NEW_PATCH = process.env.OCTANE_NEW_PATCH ?? null;

const AUTOROWS = [0, 1000, 10000, 30000];
const ONLY = new Set((process.env.VENDOR_ONLY ?? '').split(',').filter(Boolean));
const wants = (id) => ONLY.size === 0 || ONLY.has(id);

// Presentation metadata is source configuration, colocated with the manifest
// generator so re-vendoring cannot silently reset legend order or chart colors.
const PRESENTATION = {
  react: { order: 0, colorLight: '#2a78d6', colorDark: '#3987e5' },
  octane: { order: 1, colorLight: '#eb6834', colorDark: '#d95926' },
  'vue-vdom': { order: 2, colorLight: '#1baf7a', colorDark: '#199e70' },
  'vue-vdom-ifr-et': { order: 3, colorLight: '#eda100', colorDark: '#c98500' },
  'vue-vapor': { order: 4, colorLight: '#e87ba4', colorDark: '#d55181' },
  'vue-vapor-ifr': { order: 5, colorLight: '#008300', colorDark: '#008300' },
  'octane-prior': { order: 100, colorLight: '#bd4c18', colorDark: '#f59e72' },
  'octane-hux1': { order: 101, colorLight: '#9f3c0d', colorDark: '#ffaf87' },
  'octane-hux2': { order: 102, colorLight: '#702a08', colorDark: '#ffc09f' },
  'octane-dom': { order: 103, colorLight: '#4f1d05', colorDark: '#ffd6bf' },
  'octane-new-2026-08-20': { order: 104, colorLight: '#7c3aed', colorDark: '#a78bfa' },
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

function vendor({
  id, label, framework, frameworkVersion, config, tags, tier = 'lab', color, source, ref,
  buildCommand, cells, nativeLab = null, webLab = null, ranking = null,
}) {
  if (!wants(id)) return;
  const dir = path.join(root, 'entries', id);
  const dist = path.join(dir, 'dist');
  fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(dist, { recursive: true });
  const checks = {};
  for (const { rows, from } of cells) {
    const destDir = path.join(dist, `rows-${rows}`);
    fs.mkdirSync(destDir, { recursive: true });
    for (const f of ['main.web.bundle', 'main.lynx.bundle']) {
      const src = path.join(from, f);
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
    tags,
    tier,
    color,
    presentation: PRESENTATION[id] ?? { order: 999, colorLight: color, colorDark: color },
    ...(ranking == null ? {} : { ranking }),
    ...(nativeLab == null ? {} : { nativeLab }),
    ...(webLab == null ? {} : { webLab }),
    kind: 'vendored',
    provenance: {
      source: source.url,
      ref,
      commit: source.commit,
      patched: source.dirty,
      patchFile: source.dirty ? `entries/_patches/${source.patchName}` : null,
      buildCommand,
      builtAt: source.builtAt,
      sha256: checks,
    },
    bundles: { web: 'dist/rows-0/main.web.bundle', lynx: 'dist/rows-0/main.lynx.bundle' },
  };
  fs.writeFileSync(path.join(dir, 'entry.json'), JSON.stringify(manifest, null, 2));
  console.log(`[vendor] ${id}: ${Object.keys(checks).length} bundles`);
}

function vendorNewLynxSnapshot(id, label, buildDir, patchFile) {
  if (!wants(id)) return;
  if (!buildDir || !fs.existsSync(path.join(buildDir, 'benchmarks/lynx-table/app/dist'))) {
    console.log(`[vendor] ${id} skipped (set OCTANE_NEW_BUILD to a built checkout)`);
    return;
  }
  const sourceGit = gitInfo(buildDir);
  const expectedPaths = [
    'benchmarks/lynx-table/app/src/App.lynx.tsrx',
    'benchmarks/lynx-table/app/src/app.css',
    'benchmarks/lynx-table/app/src/index.ts',
    'packages/lynx/src/core/transport.ts',
    'packages/lynx/src/main-thread.ts',
  ];
  const statusPaths = execFileSync(
    'git',
    ['status', '--porcelain', '--', 'packages', 'benchmarks', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'],
    { cwd: buildDir },
  ).toString().trimEnd().split('\n').filter(Boolean).map((line) => line.slice(3)).sort();
  const resolvedPatch = patchFile == null || !fs.existsSync(patchFile)
    ? null
    : fs.realpathSync(path.resolve(patchFile));
  const patchRoot = path.join(root, 'entries', '_patches');
  if (
    !sourceGit.dirty
    || resolvedPatch == null
    || path.dirname(resolvedPatch) !== patchRoot
    || JSON.stringify(statusPaths) !== JSON.stringify(expectedPaths)
  ) {
    throw new Error(`${id}: frozen new-lynx must contain only the audited Native compatibility patch`);
  }
  const actualPatch = execFileSync(
    'git', [
      'diff', '--no-color', '--unified=0', '--',
      'benchmarks/lynx-table/app/src',
      'packages/lynx/src/core/transport.ts',
      'packages/lynx/src/main-thread.ts',
    ],
    { cwd: buildDir },
  ).toString();
  if (actualPatch !== fs.readFileSync(resolvedPatch, 'utf8')) {
    throw new Error(`${id}: applied Native compatibility patch does not match ${path.basename(resolvedPatch)}`);
  }
  const version = JSON.parse(
    fs.readFileSync(path.join(buildDir, 'packages/octane/package.json'), 'utf-8'),
  ).version;
  vendor({
    id,
    tier: 'lab',
    label,
    framework: 'octane',
    frameworkVersion: version,
    config: `.tsrx, keyed @for; Huxpro/octane new-lynx immutable snapshot ${sourceGit.commit.slice(0, 12)}`,
    tags: ['optimized', 'snapshot'],
    color: '#7c3aed',
    source: {
      url: 'https://github.com/Huxpro/octane',
      commit: sourceGit.commit,
      dirty: true,
      patchName: path.basename(resolvedPatch),
    },
    ref: 'new-lynx',
    buildCommand: 'node scripts/build-octane-upstream.mjs <clean-new-lynx-checkout>',
    nativeLab: { enabled: true, contract: 'native-lab-entry-v1' },
    webLab: { enabled: true, contract: 'web-lab-entry-v1' },
    ranking: { enabled: true },
    cells: AUTOROWS.map((rows) => ({
      rows,
      from: path.join(
        buildDir,
        'benchmarks/lynx-table/app',
        rows === 0 ? 'dist' : `dist-rows${rows}`,
      ),
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
  const patch = execFileSync(
    'git',
    ['diff', '--no-color', '--unified=0', '--', 'packages', 'benchmarks'],
    { cwd: OCTANE_BUILD },
  ).toString();
  fs.writeFileSync(path.join(patchesDir, 'octane-bench.patch'), patch);
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
  patchName: 'octane-bench.patch',
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
  label: 'Vue-Lynx VDOM',
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
  label: 'Vue-Lynx VDOM +IFR+ET',
  framework: 'vue-lynx',
  frameworkVersion: `vue ${'3.6.0-beta.17'} / vue-lynx 0.4.2`,
  config: 'vdom, enableIFR + enableElementTemplates',
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
  label: 'Vue-Lynx Vapor',
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
  label: 'Vue-Lynx Vapor +IFR',
  framework: 'vue-lynx',
  frameworkVersion: `vue ${'3.6.0-beta.17'} vapor / vue-lynx 0.4.2`,
  config: 'vapor mode, enableIFR',
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
  label: 'Octane',
  framework: 'octane',
  frameworkVersion: octaneVersion,
  config: '.tsrx, keyed @for; latest upstream main',
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
    tier: 'lab',
    label: 'Octane (Hux1)',
    framework: 'octane',
    frameworkVersion: hux1Version,
    config: '.tsrx, keyed @for; hux perf stack tip (PR#15 lynx/receiver-diet, stacks #1→#10…#14)',
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
    tier: 'lab',
    label: 'Octane (Hux2)',
    framework: 'octane',
    frameworkVersion: hux2Version,
    config: '.tsrx, keyed @for; S3 final stack (#25→#31→#32→#33), BTS materialization and retained-state diet',
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

vendorNewLynxSnapshot(
  'octane-new-2026-08-20',
  'Octane (new-2026-08-20)',
  OCTANE_NEW_BUILD,
  OCTANE_NEW_PATCH,
);

console.log('[vendor] done');
