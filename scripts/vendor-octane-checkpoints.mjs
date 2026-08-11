// Vendor the exact Octane Hux2 stack checkpoints without rewriting unrelated
// framework entries. Each input must be a clean checkout at the expected SHA
// with all four BENCH_AUTOROWS variants already built.
//
// Defaults point at the worktrees used by the published Hux2 benchmark run:
//   /tmp/octane-bench-{b0,p2,p3,p6,p7}
// Override any checkout with OCTANE_<CHECKPOINT>_BUILD.
//
// Usage:
//   pnpm vendor:octane-checkpoints
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AUTOROWS = [0, 1000, 10000, 30000];

const CHECKPOINTS = [
  {
    key: 'B0',
    id: 'octane-hux2-b0',
    label: 'Octane (Hux2 B0)',
    commit: '1fbf224c36608067694d32c23d227291fec52d60',
    ref: 'upstream-main-before-hux2-stack',
    config: '.tsrx, keyed @for; upstream baseline before the Hux2 stack',
    tags: ['baseline'],
    color: '#6b7280',
  },
  {
    key: 'P2',
    id: 'octane-hux2-p2',
    label: 'Octane (Hux2 P2)',
    commit: '71e1b8a88a8c3e37cc005d37a8e6f75cf31088b4',
    ref: 'perf/lynx-upstream-snapshot',
    config: '.tsrx, keyed @for; Hux2 compact snapshot checkpoint (P0–P2)',
    tags: ['checkpoint'],
    color: '#8b5cf6',
  },
  {
    key: 'P3',
    id: 'octane-hux2-p3',
    label: 'Octane (Hux2 P3)',
    commit: '4a444b1b9665d8b4020d774a220bd0e21933cdb2',
    ref: 'perf/lynx-upstream-protocol',
    config: '.tsrx, keyed @for; Hux2 compact receiver protocol checkpoint (P0–P3)',
    tags: ['checkpoint'],
    color: '#6366f1',
  },
  {
    key: 'P6',
    id: 'octane-hux2-p6',
    label: 'Octane (Hux2 P6)',
    commit: '68b2b0546b28d54b7cd8d44665f95d36b58e48b3',
    ref: 'perf/lynx-upstream-serialization',
    config: '.tsrx, keyed @for; Hux2 direct serialization checkpoint (P0–P6)',
    tags: ['checkpoint'],
    color: '#2563eb',
  },
  {
    key: 'P7',
    id: 'octane-hux2',
    label: 'Octane (Hux2)',
    commit: 'ff7d2c71c2296b7936f17c809e46637a18963338',
    ref: 'perf/lynx-upstream-materialization',
    config: '.tsrx, keyed @for; complete mergeable Hux2 performance stack (P0–P7)',
    tags: ['optimized'],
    color: '#dc2626',
  },
];

const sha256 = (file) =>
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function sourceDir(checkpoint) {
  return process.env[`OCTANE_${checkpoint.key}_BUILD`]
    ?? `/tmp/octane-bench-${checkpoint.key.toLowerCase()}`;
}

function assertCheckout(checkpoint, dir) {
  if (!fs.existsSync(dir)) throw new Error(`${checkpoint.key}: checkout does not exist: ${dir}`);
  const actual = git(dir, 'rev-parse', 'HEAD');
  if (actual !== checkpoint.commit) {
    throw new Error(`${checkpoint.key}: expected ${checkpoint.commit}, found ${actual}`);
  }
  const dirty = git(
    dir,
    'status',
    '--porcelain',
    '--untracked-files=no',
    '--',
    'packages',
    'benchmarks',
    'package.json',
    'pnpm-lock.yaml',
  );
  if (dirty) throw new Error(`${checkpoint.key}: source checkout is dirty:\n${dirty}`);
}

function buildDir(dir, rows) {
  return path.join(
    dir,
    'benchmarks/lynx-table/app',
    rows === 0 ? 'dist' : `dist-rows${rows}`,
  );
}

function vendor(checkpoint) {
  const source = sourceDir(checkpoint);
  assertCheckout(checkpoint, source);

  const entryDir = path.join(root, 'entries', checkpoint.id);
  const distDir = path.join(entryDir, 'dist');
  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });

  const checks = {};
  for (const rows of AUTOROWS) {
    const from = buildDir(source, rows);
    const to = path.join(distDir, `rows-${rows}`);
    fs.mkdirSync(to, { recursive: true });
    for (const file of ['main.web.bundle', 'main.lynx.bundle']) {
      const input = path.join(from, file);
      if (!fs.existsSync(input)) {
        throw new Error(`${checkpoint.key}: missing rows-${rows}/${file} in ${from}`);
      }
      const output = path.join(to, file);
      fs.copyFileSync(input, output);
      checks[`rows-${rows}/${file}`] = sha256(output);
    }
  }

  const packageManager = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'))
    .packageManager;
  const frameworkVersion = JSON.parse(
    fs.readFileSync(path.join(source, 'packages/octane/package.json'), 'utf8'),
  ).version;
  const manifest = {
    id: checkpoint.id,
    label: checkpoint.label,
    framework: 'octane',
    frameworkVersion,
    config: checkpoint.config,
    tags: checkpoint.tags,
    tier: 'lab',
    color: checkpoint.color,
    kind: 'vendored',
    provenance: {
      source: 'https://github.com/Huxpro/octane',
      ref: checkpoint.ref,
      commit: checkpoint.commit,
      patched: false,
      patchFile: null,
      buildCommand:
        'BENCH_AUTOROWS=<0|1000|10000|30000> node benchmarks/lynx-table/scripts/build-app.mjs',
      packageManager,
      sourceLockSha256: sha256(path.join(source, 'pnpm-lock.yaml')),
      sourceBenchmarkTree: git(
        source,
        'rev-parse',
        'HEAD:benchmarks/lynx-table/app',
      ),
      sourceBuildScriptBlob: git(
        source,
        'rev-parse',
        'HEAD:benchmarks/lynx-table/scripts/build-app.mjs',
      ),
      builtAt: new Date().toISOString(),
      sha256: checks,
    },
    bundles: {
      web: 'dist/rows-0/main.web.bundle',
      lynx: 'dist/rows-0/main.lynx.bundle',
    },
  };
  fs.writeFileSync(
    path.join(entryDir, 'entry.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  console.log(`[vendor] ${checkpoint.id}: ${Object.keys(checks).length} bundles from ${checkpoint.commit}`);
}

for (const checkpoint of CHECKPOINTS) vendor(checkpoint);
console.log('[vendor] Octane Hux2 checkpoints done');
