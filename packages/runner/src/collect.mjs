// Merge run files into results/latest.json. Newest record wins per
// (machine × harness × environment × entry × workload × scale × metric);
// records from different machines coexist, each tagged with its source run and
// calibration. The site consumes comparisonRecords, which always come from one
// coherent run; incremental/partial runs must never create a cross-run ranking.
import fs from 'node:fs';
import path from 'node:path';

import { SCHEMA_VERSION } from '@lynx-bench/shared/schema';

import { repoRoot } from './entries.mjs';

const recordKey = (machineId, r) =>
  [machineId, r.harness, r.environment, r.entry, r.workload, r.scale, r.metric].join('|');

const comparisonRank = (run) => {
  const entries = new Set(run.records.map((r) => r.entry));
  // Prefer broad framework coverage, then matrix coverage.
  return [entries.size, run.records.length];
};

const isBetterComparisonRun = (candidate, current) => {
  if (!current) return true;
  const a = comparisonRank(candidate.run);
  const b = comparisonRank(current.run);
  const candidateTime = candidate.run.meta.generatedAt ?? candidate.file;
  const currentTime = current.run.meta.generatedAt ?? current.file;
  return a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1]
    || (a[1] === b[1] && (candidateTime > currentTime
      || (candidateTime === currentTime && candidate.file > current.file)))));
};

const annotate = (run, file, record) => ({
  ...record,
  machineId: run.meta.machine.id,
  runFile: file,
  runGeneratedAt: run.meta.generatedAt,
  calibration: run.meta.calibration,
});

export function collectRuns({ log = console.log, root = repoRoot(), generatedAt = new Date().toISOString() } = {}) {
  const runsDir = path.join(root, 'results/runs');
  const outPath = path.join(root, 'results/latest.json');
  if (!fs.existsSync(runsDir)) throw new Error(`no runs directory at ${runsDir}`);

  const runFiles = fs.readdirSync(runsDir).filter((f) => f.endsWith('.json')).sort();
  const machines = {};
  const merged = new Map();
  let comparisonRun = null;
  let runsSeen = 0;

  for (const file of runFiles) {
    const run = JSON.parse(fs.readFileSync(path.join(runsDir, file), 'utf-8'));
    if (run.schemaVersion !== SCHEMA_VERSION) {
      log(`[collect] skip ${file}: schemaVersion ${run.schemaVersion} != ${SCHEMA_VERSION}`);
      continue;
    }
    runsSeen += 1;
    const m = run.meta.machine;
    machines[m.id] = {
      ...m,
      latestCalibration: run.meta.calibration,
      latestRunFile: file,
      latestRunGeneratedAt: run.meta.generatedAt,
    };
    for (const r of run.records) {
      // Sort order of runFiles (ISO-timestamped names) makes later files win.
      merged.set(recordKey(m.id, r), annotate(run, file, r));
    }
    const candidate = { file, run };
    if (isBetterComparisonRun(candidate, comparisonRun)) comparisonRun = candidate;
  }

  if (!comparisonRun) throw new Error(`no schema v${SCHEMA_VERSION} runs at ${runsDir}`);
  const comparison = {
    runFile: comparisonRun.file,
    generatedAt: comparisonRun.run.meta.generatedAt,
    machineId: comparisonRun.run.meta.machine.id,
    calibration: comparisonRun.run.meta.calibration,
    entryIds: [...new Set(comparisonRun.run.records.map((r) => r.entry))].sort(),
    recordCount: comparisonRun.run.records.length,
  };

  const out = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt,
    machines,
    records: [...merged.values()],
    comparison,
    comparisonRecords: comparisonRun.run.records.map((r) =>
      annotate(comparisonRun.run, comparisonRun.file, r)),
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 1));
  log(`[collect] ${runsSeen} runs → ${out.records.length} merged records; comparison=${comparison.runFile} (${comparison.entryIds.length} entries, ${comparison.recordCount} records) → ${path.relative(root, outPath)}`);
  return out;
}
