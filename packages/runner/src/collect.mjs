// Merge run files into results/latest.json. Newest record wins per
// (machine × harness × environment × entry × workload × scale × metric);
// records from different machines coexist, each tagged with its source run and
// calibration. Featured comparisonRecords always come from one coherent run;
// opt-in Lab records are separate, explicitly calibrated historical estimates.
import fs from 'node:fs';
import path from 'node:path';

import { SCHEMA_VERSION } from '@lynx-bench/shared/schema';

import { repoRoot } from './entries.mjs';

const recordKey = (machineId, r) =>
  [machineId, r.harness, r.environment, r.entry, r.workload, r.scale, r.metric].join('|');

const HUX1_COMMITS = new Set([
  '99cae97204ff9ef2b0cb00765ee648078d7872e7',
  '4a53620fe811a016cb9966fab53ca181a89159c8',
]);

const normalizedEntryId = (run, entry) => {
  if (entry === 'octane-main') return 'octane-prior';
  if (entry === 'octane' && HUX1_COMMITS.has(run.meta.entryCommits?.octane)) {
    return 'octane-hux1';
  }
  return entry;
};

const normalizeRecord = (run, record) => {
  const entry = normalizedEntryId(run, record.entry);
  return entry === record.entry ? record : { ...record, entry, sourceEntry: record.entry };
};

const readEntryTiers = (root) => {
  const entriesDir = path.join(root, 'entries');
  const tiers = new Map();
  for (const dir of fs.readdirSync(entriesDir)) {
    const manifestPath = path.join(entriesDir, dir, 'entry.json');
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    tiers.set(manifest.id, manifest.tier ?? 'featured');
  }
  return tiers;
};

const comparisonRank = (run, featuredIds) => {
  const featuredRecords = run.records.filter((r) => featuredIds.has(r.entry));
  const entries = new Set(featuredRecords.map((r) => r.entry));
  // Prefer broad featured-framework coverage, then full featured matrix coverage.
  // Lab variants never keep an older run as the public comparison cohort.
  return [entries.size, featuredRecords.length];
};

const isBetterComparisonRun = (candidate, current, featuredIds) => {
  if (!current) return true;
  const a = comparisonRank(candidate.run, featuredIds);
  const b = comparisonRank(current.run, featuredIds);
  const candidateTime = candidate.run.meta.generatedAt ?? candidate.file;
  const currentTime = current.run.meta.generatedAt ?? current.file;
  return a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1]
    || (a[1] === b[1] && (candidateTime > currentTime
      || (candidateTime === currentTime && candidate.file > current.file)))));
};

const annotate = (run, file, record, comparisonKind = 'archive') => ({
  ...record,
  machineId: run.meta.machine.id,
  runFile: file,
  runGeneratedAt: run.meta.generatedAt,
  calibration: run.meta.calibration,
  entryCommit: run.meta.entryCommits?.[record.sourceEntry ?? record.entry] ?? null,
  comparisonKind,
});

const scaleNumber = (value, ratio) => value == null ? value : value * ratio;

const calibrateLabRecord = (run, file, record, targetCalibration) => {
  const sourceCalibration = run.meta.calibration;
  const canCalibrate = record.unit === 'ms'
    && sourceCalibration?.probeVersion === targetCalibration?.probeVersion
    && sourceCalibration?.score > 0
    && targetCalibration?.score > 0;
  const ratio = canCalibrate ? sourceCalibration.score / targetCalibration.score : null;
  const annotated = annotate(
    run,
    file,
    record,
    canCalibrate ? 'calibrated-estimate' : 'historical',
  );
  if (!canCalibrate) return { ...annotated, targetCalibration, calibrationRatio: null };
  return {
    ...annotated,
    median: scaleNumber(record.median, ratio),
    mean: scaleNumber(record.mean, ratio),
    std: scaleNumber(record.std, ratio),
    min: scaleNumber(record.min, ratio),
    p95: scaleNumber(record.p95, ratio),
    ci95: scaleNumber(record.ci95, ratio),
    samples: record.samples?.map((value) => scaleNumber(value, ratio)) ?? record.samples,
    sourceMedian: record.median,
    targetCalibration,
    calibrationRatio: ratio,
  };
};

const isBetterLabRun = (candidate, current, entryId) => {
  if (!current) return true;
  const count = candidate.run.records.filter((r) => r.entry === entryId).length;
  const currentCount = current.run.records.filter((r) => r.entry === entryId).length;
  const time = candidate.run.meta.generatedAt ?? candidate.file;
  const currentTime = current.run.meta.generatedAt ?? current.file;
  return count > currentCount || (count === currentCount && (time > currentTime
    || (time === currentTime && candidate.file > current.file)));
};

export function collectRuns({
  log = console.log,
  root = repoRoot(),
  generatedAt = new Date().toISOString(),
  entryTiers = readEntryTiers(root),
} = {}) {
  const runsDir = path.join(root, 'results/runs');
  const outPath = path.join(root, 'results/latest.json');
  if (!fs.existsSync(runsDir)) throw new Error(`no runs directory at ${runsDir}`);

  const runFiles = fs.readdirSync(runsDir).filter((f) => f.endsWith('.json')).sort();
  const machines = {};
  const merged = new Map();
  const runs = [];
  let comparisonRun = null;
  let runsSeen = 0;
  const featuredIds = new Set([...entryTiers].filter(([, tier]) => tier !== 'lab').map(([id]) => id));
  const labIds = [...entryTiers].filter(([, tier]) => tier === 'lab').map(([id]) => id);

  for (const file of runFiles) {
    const rawRun = JSON.parse(fs.readFileSync(path.join(runsDir, file), 'utf-8'));
    if (rawRun.schemaVersion !== SCHEMA_VERSION) {
      log(`[collect] skip ${file}: schemaVersion ${rawRun.schemaVersion} != ${SCHEMA_VERSION}`);
      continue;
    }
    const run = { ...rawRun, records: rawRun.records.map((r) => normalizeRecord(rawRun, r)) };
    runs.push({ file, run });
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
    if (isBetterComparisonRun(candidate, comparisonRun, featuredIds)) comparisonRun = candidate;
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
  const labEstimates = [];
  const labComparisonRecords = [];
  for (const entryId of labIds) {
    let source = null;
    for (const candidate of runs) {
      if (!candidate.run.records.some((r) => r.entry === entryId)) continue;
      if (isBetterLabRun(candidate, source, entryId)) source = candidate;
    }
    if (!source) continue;
    const records = source.run.records.filter((r) => r.entry === entryId);
    const sameProbe = source.run.meta.calibration?.probeVersion
      === comparisonRun.run.meta.calibration?.probeVersion;
    const calibrationRatio = sameProbe
      ? source.run.meta.calibration.score / comparisonRun.run.meta.calibration.score
      : null;
    labEstimates.push({
      entryId,
      sourceRunFile: source.file,
      sourceGeneratedAt: source.run.meta.generatedAt,
      sourceMachineId: source.run.meta.machine.id,
      sourceCalibration: source.run.meta.calibration,
      targetCalibration: comparisonRun.run.meta.calibration,
      calibrationRatio,
      recordCount: records.length,
    });
    labComparisonRecords.push(...records.map((r) =>
      calibrateLabRecord(source.run, source.file, r, comparisonRun.run.meta.calibration)));
  }
  comparison.labEstimates = labEstimates;

  const out = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt,
    machines,
    records: [...merged.values()],
    comparison,
    comparisonRecords: comparisonRun.run.records.map((r) =>
      annotate(comparisonRun.run, comparisonRun.file, r, 'same-run')),
    labComparisonRecords,
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 1));
  log(`[collect] ${runsSeen} runs → ${out.records.length} merged records; comparison=${comparison.runFile} (${comparison.entryIds.length} entries, ${comparison.recordCount} records) + ${labEstimates.length} calibrated Lab entries → ${path.relative(root, outPath)}`);
  return out;
}
