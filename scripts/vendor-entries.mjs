// Vendor built entry bundles from local checkouts into entries/<id>/dist,
// generating entry.json manifests with provenance + sha256 checksums.
//
// Sources (override with env):
//   VUE_LYNX_BUILD   a vue-lynx checkout where bench-build-matrix.mjs ran
//   OCTANE_BUILD     an octane checkout where lynx-table autoRows builds ran
//
// Usage: node scripts/vendor-entries.mjs
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VUE_BUILD = process.env.VUE_LYNX_BUILD
  ?? path.join(os.homedir(), 'github/vue-lynx-bench-build');
const OCTANE_BUILD = process.env.OCTANE_BUILD
  ?? path.join(os.homedir(), 'github/octane-bench-build');
const OCTANE_MAIN_BUILD = process.env.OCTANE_MAIN_BUILD
  ?? path.join(os.homedir(), 'github/octane-main-build');

const AUTOROWS = [0, 1000, 10000, 30000];

const sha256 = (file) =>
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const gitInfo = (dir) => ({
  commit: execSync('git rev-parse HEAD', { cwd: dir }).toString().trim(),
  dirty: execSync('git status --porcelain -- packages benchmarks 2>/dev/null || true', { cwd: dir })
    .toString().trim().length > 0,
});

function vendor({ id, label, framework, frameworkVersion, config, tags, color, source, ref, buildCommand, cells }) {
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
    color,
    kind: 'vendored',
    provenance: {
      source: source.url,
      ref,
      commit: source.commit,
      patched: source.dirty,
      patchFile: source.dirty ? `entries/_patches/${source.patchName}` : null,
      buildCommand,
      builtAt: new Date().toISOString(),
      sha256: checks,
    },
    bundles: { web: 'dist/rows-0/main.web.bundle', lynx: 'dist/rows-0/main.lynx.bundle' },
  };
  fs.writeFileSync(path.join(dir, 'entry.json'), JSON.stringify(manifest, null, 2));
  console.log(`[vendor] ${id}: ${Object.keys(checks).length} bundles`);
}

// -- capture patches applied to the source checkouts -------------------------
const patchesDir = path.join(root, 'entries', '_patches');
fs.mkdirSync(patchesDir, { recursive: true });

const vueGit = gitInfo(VUE_BUILD);
if (vueGit.dirty) {
  const patch = execSync('git diff -- packages', { cwd: VUE_BUILD }).toString();
  fs.writeFileSync(path.join(patchesDir, 'vue-lynx-bench.patch'), patch);
}
const octaneGit = gitInfo(OCTANE_BUILD);
if (octaneGit.dirty) {
  const patch = execSync('git diff -- packages benchmarks', { cwd: OCTANE_BUILD }).toString();
  fs.writeFileSync(path.join(patchesDir, 'octane-bench.patch'), patch);
}

const vueSource = {
  url: 'https://github.com/Huxpro/vue-lynx',
  commit: vueGit.commit,
  dirty: vueGit.dirty,
  patchName: 'vue-lynx-bench.patch',
};
const octaneSource = {
  url: 'https://github.com/Huxpro/octane',
  commit: octaneGit.commit,
  dirty: octaneGit.dirty,
  patchName: 'octane-bench.patch',
};

const vueCells = (entryId) =>
  AUTOROWS.map((rows) => ({
    rows,
    from: path.join(VUE_BUILD, 'bench-out', entryId, `rows-${rows}`),
  }));

vendor({
  id: 'react',
  label: 'ReactLynx 0.122',
  framework: 'reactlynx',
  frameworkVersion: '0.122.1',
  config: 'idiomatic keyed hooks (memo + useCallback)',
  tags: ['baseline'],
  color: '#1e93b0',
  source: vueSource,
  ref: 'huxcx/unify-benchmark-system',
  buildCommand: 'node bench-build-matrix.mjs --only react',
  cells: vueCells('react'),
});
vendor({
  id: 'vue-vdom',
  label: 'Vue-Lynx VDOM',
  framework: 'vue-lynx',
  frameworkVersion: `vue ${'3.6.0-beta.17'} / vue-lynx 0.4.2`,
  config: 'vdom, IFR off, ET off',
  tags: ['baseline'],
  color: '#42b883',
  source: vueSource,
  ref: 'huxcx/unify-benchmark-system',
  buildCommand: 'node bench-build-matrix.mjs --only vue-vdom',
  cells: vueCells('vue-vdom'),
});
vendor({
  id: 'vue-vdom-ifr-et',
  label: 'Vue-Lynx VDOM +IFR+ET',
  framework: 'vue-lynx',
  frameworkVersion: `vue ${'3.6.0-beta.17'} / vue-lynx 0.4.2`,
  config: 'vdom, enableIFR + enableElementTemplates',
  tags: ['optimized'],
  color: '#2f855a',
  source: vueSource,
  ref: 'huxcx/unify-benchmark-system',
  buildCommand: 'node bench-build-matrix.mjs --only vue-vdom-ifr-et',
  cells: vueCells('vue-vdom-ifr-et'),
});
vendor({
  id: 'vue-vapor',
  label: 'Vue-Lynx Vapor',
  framework: 'vue-lynx',
  frameworkVersion: `vue ${'3.6.0-beta.17'} vapor / vue-lynx 0.4.2`,
  config: 'vapor mode, IFR off',
  tags: ['baseline'],
  color: '#e06ec4',
  source: vueSource,
  ref: 'huxcx/unify-benchmark-system',
  buildCommand: 'node bench-build-matrix.mjs --only vue-vapor',
  cells: vueCells('vue-vapor'),
});
vendor({
  id: 'vue-vapor-ifr',
  label: 'Vue-Lynx Vapor +IFR',
  framework: 'vue-lynx',
  frameworkVersion: `vue ${'3.6.0-beta.17'} vapor / vue-lynx 0.4.2`,
  config: 'vapor mode, enableIFR',
  tags: ['optimized'],
  color: '#9d4b8f',
  source: vueSource,
  ref: 'huxcx/unify-benchmark-system',
  buildCommand: 'node bench-build-matrix.mjs --only vue-vapor-ifr',
  cells: vueCells('vue-vapor-ifr'),
});
vendor({
  id: 'octane',
  label: 'Octane (wire-fix PR)',
  framework: 'octane',
  frameworkVersion: '0.1.19',
  config: '.tsrx, keyed @for; PR#1: commit wire cost proportional to change size',
  tags: ['optimized'],
  color: '#ff415a',
  source: octaneSource,
  ref: 'claude/octane-lynx-benchmark-payload-a3zaeu',
  buildCommand: 'BENCH_AUTOROWS=<n> node benchmarks/lynx-table/scripts/build-app.mjs',
  cells: AUTOROWS.map((rows) => ({
    rows,
    from: path.join(
      OCTANE_BUILD,
      'benchmarks/lynx-table/app',
      rows === 0 ? 'dist' : `dist-rows${rows}`,
    ),
  })),
});

// Same framework, different ref — the version/commit dimension: octane@main
// with the identical app (benchmarks/lynx-table sources copied from the PR
// branch; only the framework packages differ).
if (fs.existsSync(path.join(OCTANE_MAIN_BUILD, 'benchmarks/lynx-table/app/dist'))) {
  const mainGit = gitInfo(OCTANE_MAIN_BUILD);
  // The app sources sit on top of main as untracked files; capture them (app +
  // scripts only, not the vendored reference bundles) as the provenance patch.
  execSync('git add -N benchmarks/lynx-table/app benchmarks/lynx-table/scripts', { cwd: OCTANE_MAIN_BUILD });
  fs.writeFileSync(
    path.join(patchesDir, 'octane-main-bench.patch'),
    execSync('git diff -- benchmarks/lynx-table/app benchmarks/lynx-table/scripts', {
      cwd: OCTANE_MAIN_BUILD,
      maxBuffer: 64 * 1024 * 1024,
    }),
  );
  const mainVersion = JSON.parse(
    fs.readFileSync(path.join(OCTANE_MAIN_BUILD, 'packages/octane/package.json'), 'utf-8'),
  ).version;
  vendor({
    id: 'octane-main',
    label: 'Octane (main)',
    framework: 'octane',
    frameworkVersion: mainVersion,
    config: '.tsrx, keyed @for; main branch (pre wire-fix)',
    tags: ['baseline'],
    color: '#4a3aa7',
    source: {
      url: 'https://github.com/octanejs/octane',
      commit: mainGit.commit,
      dirty: true, // benchmarks/lynx-table app is copied in from the PR branch
      patchName: 'octane-main-bench.patch',
    },
    ref: 'main',
    buildCommand: 'cp -r <pr>/benchmarks/lynx-table . && BENCH_AUTOROWS=<n> node benchmarks/lynx-table/scripts/build-app.mjs',
    cells: AUTOROWS.map((rows) => ({
      rows,
      from: path.join(
        OCTANE_MAIN_BUILD,
        'benchmarks/lynx-table/app',
        rows === 0 ? 'dist' : `dist-rows${rows}`,
      ),
    })),
  });
} else {
  console.log('[vendor] octane-main skipped (no build at ' + OCTANE_MAIN_BUILD + ')');
}

console.log('[vendor] done');
