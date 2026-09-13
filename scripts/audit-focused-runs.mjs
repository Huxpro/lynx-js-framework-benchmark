#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { qualifyPairedScorecard } from '../packages/shared/src/qualification.mjs';

const args = process.argv.slice(2);
const options = {
  candidate: null,
  comparator: null,
  output: null,
  workload: null,
  scale: null,
  runs: [],
};
for (let index = 0; index < args.length; index += 2) {
  const name = args[index];
  const value = args[index + 1];
  if (value == null || value.startsWith('--')) {
    throw new Error(`${name} requires a value.`);
  }
  if (name === '--candidate') options.candidate = value;
  else if (name === '--comparator') options.comparator = value;
  else if (name === '--output') options.output = value;
  else if (name === '--workload') options.workload = value;
  else if (name === '--scale') options.scale = Number(value);
  else if (name === '--run') options.runs.push(value);
  else throw new Error(`unknown option: ${name}`);
}

const { candidate, comparator, output, workload, scale } = options;
if (
  candidate == null
  || comparator == null
  || output == null
  || workload == null
  || !Number.isSafeInteger(scale)
  || scale < 0
  || options.runs.length < 10
) {
  throw new Error(
    'usage: audit-focused-runs --candidate <id> --comparator <id> '
      + '--workload <name> --scale <rows> --output <audit.json> '
      + '--run <run.json>...',
  );
}
if (candidate === comparator) throw new Error('candidate and comparator must differ.');

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
  machine: run.meta.machine.id,
  browser: run.meta.browser,
  environment: run.meta.environment,
  repository: run.meta.receipt.repository,
  cohort: run.meta.receipt.comparabilityCohort,
  candidateCommit: run.meta.entryCommits[candidate],
  comparatorCommit: run.meta.entryCommits[comparator],
});
if (new Set(sources.map(({ run }) => identity(run))).size !== 1) {
  throw new Error('focused runs do not share one execution identity.');
}
if (receipt.repository.dirty) {
  throw new Error('focused qualification rejects dirty repository receipts.');
}

const orderCounts = { AB: 0, BA: 0 };
for (const { run } of sources) {
  const order = run.meta.entryOrder;
  if (order.length !== 2 || !order.includes(candidate) || !order.includes(comparator)) {
    throw new Error(`invalid entry order in ${run.meta.sessionId}.`);
  }
  orderCounts[order[0] === candidate ? 'AB' : 'BA']++;
  const selected = run.records.filter(
    (record) => record.suite === 'table'
      && record.workload === workload
      && record.scale === scale,
  );
  if (selected.some((record) => record.dnfCount !== 0 || record.failures.length !== 0)) {
    throw new Error(`DNF or failure in ${run.meta.sessionId}.`);
  }
}
if (Math.abs(orderCounts.AB - orderCounts.BA) > 1) {
  throw new Error(`focused runs have imbalanced order ${orderCounts.AB}/${orderCounts.BA}.`);
}

const metricSpecs = [
  ['latencyMedian', 'latency', 'median'],
  ['latencyP95', 'latency', 'p95'],
  ['btsCpuMedian', 'btsCpu', 'median'],
  ['mtsCpuMedian', 'mtsCpu', 'median'],
  ['wireToBtsBytesMedian', 'wireToBtsBytes', 'median'],
  ['wireToBtsMsgsMedian', 'wireToBtsMsgs', 'median'],
  ['wireToMtsBytesMedian', 'wireToMtsBytes', 'median'],
  ['wireToMtsMsgsMedian', 'wireToMtsMsgs', 'median'],
];
function metric(run, entry, name, field) {
  const record = run.records.find(
    (item) => item.suite === 'table'
      && item.entry === entry
      && item.workload === workload
      && item.scale === scale
      && item.metric === name,
  );
  const value = record?.[field];
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${run.meta.sessionId} lacks positive ${entry} ${name}.${field}.`);
  }
  return value;
}
function geomean(entry, name, field) {
  return Math.exp(
    sources.reduce(
      (sum, { run }) => sum + Math.log(metric(run, entry, name, field)),
      0,
    ) / sources.length,
  );
}

const results = Object.fromEntries(metricSpecs.map(([label, name, field]) => {
  const pairs = sources.map(({ run }) => ({
    session: run.meta.sessionId,
    order: run.meta.entryOrder[0] === candidate ? 'AB' : 'BA',
    cells: {
      value: {
        candidate: metric(run, candidate, name, field),
        comparator: metric(run, comparator, name, field),
      },
    },
  }));
  const qualified = qualifyPairedScorecard({
    pairs,
    cells: [{ key: 'value', weight: 1 }],
    minimumPairs: sources.length,
  }).cells.value;
  return [label, {
    candidateGeomean: geomean(candidate, name, field),
    comparatorGeomean: geomean(comparator, name, field),
    ...qualified,
    strictWin: qualified.upper < 1,
  }];
}));

const repetitions = sources.map(({ run }) => {
  const record = run.records.find(
    (item) => item.suite === 'table'
      && item.entry === candidate
      && item.workload === workload
      && item.scale === scale
      && item.metric === 'latency',
  );
  return record.n;
});
if (new Set(repetitions).size !== 1) {
  throw new Error('focused runs do not share one repetition count.');
}

const audit = {
  kind: 'm4-final-independent-core-cell-replication',
  generatedAt: new Date().toISOString(),
  candidate,
  comparator,
  harness: first.records[0].harness,
  environment: first.meta.environment,
  cell: `${workload}@${scale}`,
  identities: {
    candidateCommit: first.meta.entryCommits[candidate],
    comparatorCommit: first.meta.entryCommits[comparator],
    benchmarkHarnessCommit: receipt.repository.commit,
    comparabilityCohort: receipt.comparabilityCohort,
    machine: first.meta.machine,
    browser: first.meta.browser,
    bundles: first.meta.receipt.entryBundles,
  },
  protocol: {
    purpose: `Independent focused replication of ${workload}@${scale}.`,
    sessions: sources.length,
    orderCounts,
    repetitionsPerArmPerSession: repetitions[0],
    totalRepetitionsPerArm: repetitions[0] * sources.length,
    resamplingUnit: 'independent session median with both arms retained',
    bootstrapResamples: 10000,
    confidence: 0.95,
    outliersRemoved: 0,
    dnf: 0,
    failures: 0,
  },
  results,
  decision: {
    wallNonInferior: results.latencyMedian.upper <= 1.05,
    wallStrictWin: results.latencyMedian.upper < 1,
    tailNonInferior: results.latencyP95.upper <= 1.05,
    pass:
      results.latencyMedian.upper <= 1.05
      && results.latencyP95.upper <= 1.05,
  },
  sourceRuns: sources.map(({ file, sha256, run }) => ({
    session: run.meta.sessionId,
    order: run.meta.entryOrder[0] === candidate ? 'AB' : 'BA',
    file,
    sha256,
  })),
};

const outputPath = path.resolve(output);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(audit, null, 2)}\n`);
process.stderr.write(`[audit] wrote ${outputPath}\n`);
