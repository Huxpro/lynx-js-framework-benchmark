// Prospective run receipts. A benchmark source SHA alone is not enough to
// reproduce a result: the harness may be dirty, lockfile resolutions may have
// changed, and vendored bundles may not match their manifest. Keep the exact
// execution inputs beside every raw run.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { STORM_SELECT_TICKS, STORM_UPDATE_TICKS } from '@lynx-bench/shared/workloads';

import { repoRoot } from './entries.mjs';

const RUNTIME_PACKAGES = new Set([
  '@lynx-js/web-core',
  '@lynx-js/web-elements',
  '@lynx-js/web-worker-rpc',
  'playwright-core',
]);

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const fileSha256 = (file) => sha256(fs.readFileSync(file));
const HARNESS_PATHS = [
  '.',
  ':(exclude)results/runs/**',
  ':(exclude)results/audits/**',
  ':(exclude)results/latest.json',
  ':(exclude)site/dist/**',
];

function git(root, args, options = {}) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: options.encoding ?? 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function repositoryReceipt(root = repoRoot()) {
  const commit = git(root, ['rev-parse', 'HEAD']).trim();
  const status = git(root, [
    'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...HARNESS_PATHS,
  ]);
  if (status.length === 0) return { commit, dirty: false, diffSha256: null };

  // `git diff HEAD` covers staged and unstaged tracked changes. Hash untracked
  // content separately so two dirty trees with the same filenames cannot share
  // a receipt. The raw diff is intentionally not embedded in result files.
  const trackedDiff = git(root, [
    'diff', '--binary', '--no-ext-diff', 'HEAD', '--', ...HARNESS_PATHS,
  ]);
  const untracked = git(root, [
    'ls-files', '--others', '--exclude-standard', '-z', '--', ...HARNESS_PATHS,
  ])
    .split('\0')
    .filter(Boolean)
    .sort();
  const digest = crypto.createHash('sha256');
  digest.update('status\0').update(status).update('\0tracked\0').update(trackedDiff);
  for (const relative of untracked) {
    digest.update('\0untracked\0').update(relative).update('\0');
    digest.update(fs.readFileSync(path.join(root, relative)));
  }
  return {
    commit,
    dirty: true,
    diffSha256: digest.digest('hex'),
    ignoredGeneratedPaths: ['results/runs/**', 'results/audits/**', 'results/latest.json', 'site/dist/**'],
  };
}
function lockPackages(lockText) {
  const packages = [];
  const lines = lockText.split('\n');
  let inPackages = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === 'packages:') {
      inPackages = true;
      continue;
    }
    if (inPackages && /^\S/.test(lines[i]) && lines[i] !== '') break;
    if (!inPackages) continue;
    const match = lines[i].match(/^  ['"]?(.+?)@([^'"]+)['"]?:$/);
    if (!match || !RUNTIME_PACKAGES.has(match[1])) continue;
    const resolution = lines[i + 1]?.match(/^    resolution: \{integrity: ([^}]+)\}$/);
    packages.push({
      name: match[1],
      version: match[2],
      integrity: resolution?.[1] ?? null,
    });
  }
  return packages.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

export function runtimeReceipt(root = repoRoot()) {
  const lockfile = path.join(root, 'pnpm-lock.yaml');
  const lockText = fs.readFileSync(lockfile, 'utf8');
  return {
    lockfile: 'pnpm-lock.yaml',
    lockfileSha256: sha256(lockText),
    packages: lockPackages(lockText),
  };
}

export function workloadReceipt(root = repoRoot()) {
  const files = [
    'packages/shared/src/workloads.mjs',
    'packages/shared/src/page-instrument.mjs',
    'packages/shared/src/pipeline.mjs',
    'packages/runner/src/pipeline-attribution.mjs',
  ];
  const hashes = Object.fromEntries(files.map((relative) => [
    relative, fileSha256(path.join(root, relative)),
  ]));
  return {
    files: hashes,
    sha256: sha256(JSON.stringify(hashes)),
    stormTicks: { updateStorm: STORM_UPDATE_TICKS, selectStorm: STORM_SELECT_TICKS },
  };
}

function walkFiles(dir, prefix = '') {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const relative = path.join(prefix, entry.name);
      return entry.isDirectory() ? walkFiles(path.join(dir, entry.name), relative) : [relative];
    });
}

export function entryBundleReceipts(entries) {
  return Object.fromEntries(entries.map((entry) => [
    entry.id,
    Object.fromEntries(walkFiles(entry.distDir).map((relative) => [
      relative.split(path.sep).join('/'),
      fileSha256(path.join(entry.distDir, relative)),
    ])),
  ]));
}

export function samplingPolicy({ reps, stormReps, startupReps }) {
  return {
    repetitions: { table: reps, storm: stormReps, startup: startupReps },
    warmup: {
      table: { createClearCycles: 2, page: 'shared-per-entry' },
      storm: { cycles: 0, page: 'fresh-per-attempt' },
      startup: { cycles: 0, page: 'fresh-per-attempt' },
    },
    acceptance: {
      table: 'dom-predicate-completed-before-timeout',
      pipeline: 'dom-predicate-completed-with-tree-and-call-multiset-controls',
      storm: 'dom-predicate-and-minimum-one-rpc-message-each-direction-per-tick',
      startup: 'first-content-observed-before-timeout',
    },
    aggregation: 'median-with-t-distribution-ci95',
    outliers: 'none-removed',
  };
}

export function runReceipt({
  entries, reps, stormReps, startupReps, execution, root = repoRoot(),
}) {
  const repository = repositoryReceipt(root);
  const runtime = runtimeReceipt(root);
  const workload = workloadReceipt(root);
  const sampling = samplingPolicy({ reps, stormReps, startupReps });
  const cohortDimensions = {
    repository,
    runtime,
    workload,
    execution,
    sampling,
  };
  return {
    repository,
    runtime,
    workload,
    execution,
    sampling,
    entryBundles: entryBundleReceipts(entries),
    comparabilityCohort: `sha256:${sha256(JSON.stringify(cohortDimensions))}`,
  };
}
