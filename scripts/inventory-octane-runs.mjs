#!/usr/bin/env node
// Inventory every Octane-family update/select/storm Web record reachable from
// Git. This deliberately scans immutable blob objects instead of latest.json:
// historical run files remain auditable even after refs or paths move.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { stringifyResult } from '../packages/runner/src/result-json.mjs';
import {
  STORM_SELECT_TICKS,
  STORM_UPDATE_TICKS,
} from '../packages/shared/src/workloads.mjs';

const TARGET_WORKLOADS = new Set(['update10th', 'select', 'updateStorm', 'selectStorm']);
const STORM_TICKS = new Map([
  ['updateStorm', STORM_UPDATE_TICKS],
  ['selectStorm', STORM_SELECT_TICKS],
]);
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const root = path.resolve(new URL('..', import.meta.url).pathname);
const outputArg = process.argv[2];
if (!outputArg) throw new Error('usage: node scripts/inventory-octane-runs.mjs <output.json>');

const isOctaneEntry = (entry) => typeof entry === 'string' && /octane/i.test(entry);
const finiteValues = (record) => {
  if (Array.isArray(record?.samples)) return record.samples.filter(Number.isFinite);
  if (Number.isFinite(record?.value)) return [record.value];
  if (record?.samples == null && record?.n === 1 && Number.isFinite(record?.median)) {
    return [record.median];
  }
  return [];
};

function sourceForm(record) {
  if (Array.isArray(record.samples)) return 'repeated-samples';
  if (Number.isFinite(record.value)) return 'one-shot-value';
  if (record.samples == null && record.n === 1 && Number.isFinite(record.median)) {
    return 'legacy-statistics-only';
  }
  if ((record.dnfCount ?? 0) > 0) return 'dnf-only';
  return 'unknown';
}

function parseArgv(argv) {
  const parsed = {};
  if (!Array.isArray(argv)) return parsed;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (typeof arg !== 'string' || !arg.startsWith('--')) continue;
    const equals = arg.indexOf('=');
    if (equals !== -1) parsed[arg.slice(2, equals)] = arg.slice(equals + 1);
    else if (typeof argv[i + 1] === 'string' && !argv[i + 1].startsWith('--')) {
      parsed[arg.slice(2)] = argv[++i];
    } else parsed[arg.slice(2)] = true;
  }
  return parsed;
}

const explicitCount = (parsed, name) => {
  if (!Object.hasOwn(parsed, name)) return null;
  const value = Number(parsed[name]);
  return Number.isInteger(value) && value >= 0 ? value : null;
};

function samplingReceipt(run) {
  const receipt = run.meta?.receipt?.sampling ?? null;
  const args = parseArgv(run.meta?.argv);
  return {
    source: receipt ? 'prospective-receipt' : 'raw-argv-explicit-values-only',
    repetitions: {
      table: receipt?.repetitions?.table ?? explicitCount(args, 'reps'),
      storm: receipt?.repetitions?.storm ?? explicitCount(args, 'storm-reps'),
      startup: receipt?.repetitions?.startup ?? explicitCount(args, 'startup-reps'),
    },
    warmup: receipt?.warmup ?? null,
    acceptance: receipt?.acceptance ?? null,
    aggregation: receipt?.aggregation ?? null,
    outliers: receipt?.outliers ?? null,
  };
}

function samplingProblems(metrics, hasReceipt) {
  if (!hasReceipt) return [];
  const problems = new Set();
  for (const record of Object.values(metrics)) {
    const accepted = finiteValues(record).length;
    if (!Number.isInteger(record.acceptedCount) || record.acceptedCount !== accepted) {
      problems.add('accepted-count-mismatch');
    }
    if (!Number.isInteger(record.attemptedCount) || record.attemptedCount < accepted) {
      problems.add('attempted-count-invalid');
    }
    if (['latency', 'fcp', 'settled'].includes(record.metric)
      && Number.isInteger(record.attemptedCount)) {
      const accounted = accepted + (record.dnfCount ?? 0);
      if (accounted < record.attemptedCount) problems.add('attempt-accounting-underflow');
      if (accounted > record.attemptedCount) problems.add('attempt-accounting-overflow');
    }
  }
  return [...problems].sort();
}

function classifyCell(cell, receipt) {
  const expected = STORM_TICKS.get(cell.workload) ?? null;
  let work = null;
  if (expected != null) {
    const toMts = finiteValues(cell.metrics.wireToMtsMsgs);
    const toBts = finiteValues(cell.metrics.wireToBtsMsgs);
    const observed = {
      toMtsMessages: toMts.length ? { min: Math.min(...toMts), max: Math.max(...toMts) } : null,
      toBtsMessages: toBts.length ? { min: Math.min(...toBts), max: Math.max(...toBts) } : null,
    };
    const failed = Object.values(cell.metrics).flatMap((record) => record.failures ?? [])
      .find((failure) => failure.category === 'incomplete-storm-transport');
    if (failed || toMts.some((value) => value < expected)
      || toBts.some((value) => value < expected)) {
      work = {
        status: 'incomplete',
        expectedSequentialCommits: expected,
        observed: failed?.evidence ?? observed,
      };
    } else if (toMts.length > 0 && toBts.length > 0) {
      work = { status: 'complete', expectedSequentialCommits: expected, observed };
    } else {
      work = { status: 'unverified', expectedSequentialCommits: expected, observed };
    }
  }

  const problems = samplingProblems(cell.metrics, Boolean(receipt));
  let status = receipt ? 'comparable' : 'legacy-unverified';
  const reasons = [...problems];
  if (problems.length) status = 'incompatible-sampling';
  else if (work?.status === 'incomplete') {
    status = 'incomplete-work';
    reasons.push('storm-transport-below-sequential-tick-contract');
  } else if (work?.status === 'unverified') {
    status = 'unverified-work';
    reasons.push('storm-transport-counts-unavailable');
  } else if (work?.status === 'complete' && !receipt) {
    status = 'legacy-complete-work';
    reasons.push('run-has-no-prospective-receipt');
  }
  return {
    status,
    cohort: receipt?.comparabilityCohort ?? null,
    rankingEligible: !['incomplete-work', 'unverified-work', 'incompatible-sampling'].includes(status),
    reasons,
    work,
  };
}

const objectLines = execFileSync('git', [
  'rev-list', '--objects', '--all', '--', 'results/runs',
], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  .trim()
  .split('\n')
  .filter(Boolean);
const objects = new Map();
for (const line of objectLines) {
  const [object, ...pathParts] = line.split(' ');
  const file = pathParts.join(' ');
  if (!file.endsWith('.json')) continue;
  const aliases = objects.get(object) ?? [];
  aliases.push(file);
  objects.set(object, aliases);
}

const inventory = [];
const skipped = [];
for (const [object, paths] of [...objects].sort((a, b) => a[0].localeCompare(b[0]))) {
  const bytes = execFileSync('git', ['cat-file', 'blob', object], {
    cwd: root, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024,
  });
  let run;
  try {
    run = JSON.parse(bytes);
  } catch (error) {
    skipped.push({ object, paths, reason: `invalid JSON: ${error.message}` });
    continue;
  }
  const records = (run.records ?? []).filter((record) =>
    isOctaneEntry(record.entry)
    && record.harness === 'web'
    && TARGET_WORKLOADS.has(record.workload));
  if (records.length === 0) continue;

  const sampling = samplingReceipt(run);
  const cells = new Map();
  for (const record of records) {
    const key = `${record.entry}|${record.workload}@${record.scale}`;
    const cell = cells.get(key) ?? {
      entry: record.entry,
      appCommit: run.meta?.entryCommits?.[record.entry] ?? null,
      workload: record.workload,
      scale: record.scale,
      requestedRepetitions: STORM_TICKS.has(record.workload)
        ? sampling.repetitions.storm
        : sampling.repetitions.table,
      metrics: {},
    };
    if (cell.metrics[record.metric]) {
      throw new Error(`${object}: duplicate ${key} metric ${record.metric}`);
    }
    cell.metrics[record.metric] = {
      ...record,
      sourceForm: sourceForm(record),
      rawObservationCount: finiteValues(record).length,
    };
    cells.set(key, cell);
  }
  for (const cell of cells.values()) {
    cell.comparability = classifyCell(cell, run.meta?.receipt ?? null);
  }

  const entryIds = [...new Set(records.map((record) => record.entry))].sort();
  const receipt = run.meta?.receipt ?? null;
  const targetBundles = receipt?.entryBundles
    ? Object.fromEntries(entryIds.map((entry) => [entry, receipt.entryBundles[entry] ?? null]))
    : null;
  inventory.push({
    object,
    sha256: sha256(bytes),
    paths: paths.sort(),
    schemaVersion: run.schemaVersion ?? null,
    meta: {
      generatedAt: run.meta?.generatedAt ?? null,
      machine: run.meta?.machine ?? null,
      calibration: run.meta?.calibration ?? null,
      harness: run.meta?.harness ?? records[0]?.harness ?? null,
      environment: records[0]?.environment ?? null,
      argv: run.meta?.argv ?? null,
      browser: run.meta?.browser ?? null,
      chromiumExecutablePath: run.meta?.chromium ?? null,
      octaneAppCommits: Object.fromEntries(entryIds.map((entry) => [
        entry, run.meta?.entryCommits?.[entry] ?? null,
      ])),
      harnessGitState: receipt?.repository ?? null,
      lynxRuntimeCommit: receipt?.execution?.runtimeCommit ?? null,
      runtimeLock: receipt?.runtime ?? null,
      workloadContract: receipt?.workload ?? null,
      entryBundleHashes: targetBundles,
      sampling,
      comparabilityCohort: receipt?.comparabilityCohort ?? null,
    },
    cells: [...cells.values()].sort((a, b) =>
      a.entry.localeCompare(b.entry)
        || a.workload.localeCompare(b.workload)
        || a.scale - b.scale),
  });
}

const operationCellCount = inventory.reduce((sum, run) => sum + run.cells.length, 0);
const metricRecordCount = inventory.reduce((sum, run) => sum
  + run.cells.reduce((cellSum, cell) => cellSum + Object.keys(cell.metrics).length, 0), 0);
const out = {
  schemaVersion: 1,
  kind: 'git-reachable-octane-web-update-select-run-inventory',
  generatedFrom: {
    command: 'git rev-list --objects --all -- results/runs',
    entryRule: 'entry id contains octane (case-insensitive)',
    harness: 'web',
    workloads: [...TARGET_WORKLOADS],
  },
  distinctRawRunBlobsScanned: objects.size,
  matchingRuns: inventory.length,
  operationCells: operationCellCount,
  metricRecords: metricRecordCount,
  entryIds: [...new Set(inventory.flatMap((run) => run.cells.map((cell) => cell.entry)))].sort(),
  inventory: inventory.sort((a, b) =>
    String(a.meta.generatedAt).localeCompare(String(b.meta.generatedAt))
      || a.object.localeCompare(b.object)),
  skipped,
};
const output = path.resolve(root, outputArg);
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${stringifyResult(out)}\n`);
console.log(`[inventory] ${objects.size} raw blobs, ${inventory.length} Octane Web runs, `
  + `${operationCellCount} operation cells -> ${path.relative(root, output)}`);
