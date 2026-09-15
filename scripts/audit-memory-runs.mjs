#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { qualifyPairedScorecard } from '../packages/shared/src/qualification.mjs';

const args = process.argv.slice(2);
const options = {
  candidate: null,
  baseline: null,
  upstream: null,
  output: null,
  runs: [],
};
for (let index = 0; index < args.length; index += 2) {
  const name = args[index];
  const value = args[index + 1];
  if (value == null || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  if (name === '--candidate') options.candidate = value;
  else if (name === '--baseline') options.baseline = value;
  else if (name === '--upstream') options.upstream = value;
  else if (name === '--output') options.output = value;
  else if (name === '--run') options.runs.push(value);
  else throw new Error(`unknown option: ${name}`);
}

const { candidate, baseline, upstream, output } = options;
if (
  candidate == null
  || baseline == null
  || upstream == null
  || output == null
  || options.runs.length < 10
) {
  throw new Error(
    'usage: audit-memory-runs --candidate <id> --baseline <m0-id> '
      + '--upstream <id> --output <audit.json> --run <run.json>...',
  );
}
if (new Set([candidate, baseline, upstream]).size !== 3) {
  throw new Error('candidate, baseline, and upstream must differ.');
}

const sources = options.runs.map((file) => {
  const contents = fs.readFileSync(path.resolve(file));
  return {
    file,
    sha256: crypto.createHash('sha256').update(contents).digest('hex'),
    run: JSON.parse(contents),
  };
});
const first = sources[0].run;
const receipt = first.meta.receipt;
const identity = (run) => JSON.stringify({
  machine: run.meta.machine,
  browser: run.meta.browser,
  environment: run.meta.environment,
  repository: run.meta.receipt.repository,
  cohort: run.meta.receipt.comparabilityCohort,
  candidateCommit: run.meta.entryCommits[candidate],
  baselineCommit: run.meta.entryCommits[baseline],
  upstreamCommit: run.meta.entryCommits[upstream],
});
if (new Set(sources.map(({ run }) => identity(run))).size !== 1) {
  throw new Error('memory runs do not share one execution identity.');
}
if (receipt.repository.dirty) {
  throw new Error('memory qualification rejects dirty repository receipts.');
}

const metricSpecs = [
  ['mtsPeak', 'memoryPeak', 'heapMtsPeak'],
  ['btsPeak', 'memoryPeak', 'heapBtsPeak'],
  ['mtsSettled', 'memory', 'heapMts'],
  ['btsSettled', 'memory', 'heapBts'],
  ['mtsAfterClear', 'memoryAfterClear', 'heapMtsAfterClear'],
  ['btsAfterClear', 'memoryAfterClear', 'heapBtsAfterClear'],
];

function metric(run, entry, workload, name) {
  const matches = run.records.filter(
    (record) => record.suite === 'table'
      && record.harness === 'web'
      && record.entry === entry
      && record.workload === workload
      && record.scale === 10000
      && record.metric === name,
  );
  if (matches.length !== 1) {
    throw new Error(`${run.meta.sessionId} requires exactly one ${entry} ${name} record.`);
  }
  const [record] = matches;
  if (record.dnfCount !== 0 || record.failures.length !== 0) {
    throw new Error(`DNF or failure in ${run.meta.sessionId} ${entry} ${name}.`);
  }
  if (typeof record.value !== 'number' || !Number.isFinite(record.value) || record.value <= 0) {
    throw new Error(`${run.meta.sessionId} lacks positive ${entry} ${name}.value.`);
  }
  return record.value;
}

const orderCounts = {
  baseline: { candidateFirst: 0, comparatorFirst: 0 },
  upstream: { candidateFirst: 0, comparatorFirst: 0 },
};
for (const { run } of sources) {
  const order = run.meta.entryOrder;
  if (
    order.length !== 3
    || new Set(order).size !== 3
    || !order.includes(candidate)
    || !order.includes(baseline)
    || !order.includes(upstream)
  ) {
    throw new Error(`invalid three-arm entry order in ${run.meta.sessionId}.`);
  }
  for (const [label, comparator] of [['baseline', baseline], ['upstream', upstream]]) {
    const key = order.indexOf(candidate) < order.indexOf(comparator)
      ? 'candidateFirst'
      : 'comparatorFirst';
    orderCounts[label][key]++;
  }
  for (const [, workload, name] of metricSpecs) {
    for (const entry of [candidate, baseline, upstream]) metric(run, entry, workload, name);
  }
}
for (const [label, counts] of Object.entries(orderCounts)) {
  if (Math.abs(counts.candidateFirst - counts.comparatorFirst) > 1) {
    throw new Error(
      `${label} pair order is imbalanced (${counts.candidateFirst}/${counts.comparatorFirst}).`,
    );
  }
}

function geomean(entry, workload, name) {
  return Math.exp(
    sources.reduce(
      (sum, { run }) => sum + Math.log(metric(run, entry, workload, name)),
      0,
    ) / sources.length,
  );
}

function qualifyComparator(comparator, orderLabel) {
  return Object.fromEntries(metricSpecs.map(([label, workload, name], metricIndex) => {
    const pairs = sources.map(({ run }) => ({
      session: run.meta.sessionId,
      order: run.meta.entryOrder.indexOf(candidate) < run.meta.entryOrder.indexOf(comparator)
        ? 'AB'
        : 'BA',
      cells: {
        value: {
          candidate: metric(run, candidate, workload, name),
          comparator: metric(run, comparator, workload, name),
        },
      },
    }));
    const qualified = qualifyPairedScorecard({
      pairs,
      cells: [{ key: 'value', weight: 1 }],
      minimumPairs: sources.length,
      seed: 0x28229100 + metricIndex + (orderLabel === 'upstream' ? 32 : 0),
    }).cells.value;
    return [label, {
      boundary: sources[0].run.records.find(
        (record) => record.entry === candidate && record.metric === name,
      ).boundary,
      candidateGeomean: geomean(candidate, workload, name),
      comparatorGeomean: geomean(comparator, workload, name),
      ...qualified,
      nonInferior: qualified.upper <= 1.05,
    }];
  }));
}

const versusM0 = qualifyComparator(baseline, 'baseline');
const versusUpstream = qualifyComparator(upstream, 'upstream');
const allM0NonInferior = Object.values(versusM0).every(({ upper }) => upper <= 1.05);
const afterClearUpstreamNonInferior = [
  versusUpstream.mtsAfterClear,
  versusUpstream.btsAfterClear,
].every(({ upper }) => upper <= 1.05);

const audit = {
  kind: 'm4-final-web-memory-qualification',
  generatedAt: new Date().toISOString(),
  candidate,
  baseline,
  upstream,
  identities: {
    candidateCommit: first.meta.entryCommits[candidate],
    baselineCommit: first.meta.entryCommits[baseline],
    upstreamCommit: first.meta.entryCommits[upstream],
    benchmarkHarnessCommit: receipt.repository.commit,
    comparabilityCohort: receipt.comparabilityCohort,
    machine: first.meta.machine,
    browser: first.meta.browser,
    environment: first.meta.environment,
    bundles: receipt.entryBundles,
  },
  protocol: {
    sessions: sources.length,
    orderCounts,
    observationsPerArmPerMetric: sources.length,
    resamplingUnit: 'independent physical session with all three arms retained',
    bootstrapResamples: 10000,
    confidence: 0.95,
    outliersRemoved: 0,
    dnf: 0,
    failures: 0,
    peakDefinition: 'post-create 10k heap before explicit GC; an operational high-water checkpoint, not a claim to the maximum transient allocation between polls',
    settledDefinition: 'post-create 10k heap after explicit GC',
    afterClearDefinition: 'post-clear heap after explicit GC',
  },
  versusM0,
  versusUpstream,
  decision: {
    m0PeakSettledAfterClearUpperAtMost1_05: allM0NonInferior,
    upstreamAfterClearUpperAtMost1_05: afterClearUpstreamNonInferior,
    pass: allM0NonInferior && afterClearUpstreamNonInferior,
  },
  sourceRuns: sources.map(({ file, sha256, run }) => ({
    session: run.meta.sessionId,
    entryOrder: run.meta.entryOrder,
    file,
    sha256,
  })),
};

const outputPath = path.resolve(output);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(audit, null, 2)}\n`);
process.stderr.write(`[audit] wrote ${outputPath}\n`);
