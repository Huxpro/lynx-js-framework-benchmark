// Merge run files into results/latest.json. Newest record wins per
// (machine × entry × suite × every comparability dimension, including
// boundary and unit);
// records from different machines coexist, each tagged with its source run and
// calibration. Web featured comparisonRecords come from one coherent run;
// Native featured records may come from one complete run per entry, but only
// when every run belongs to the same physical device/environment. Opt-in Lab
// records are separate, explicitly calibrated historical estimates.
import fs from 'node:fs';
import path from 'node:path';

import { comparisonKey, deriveRecord, SCHEMA_VERSION } from '@lynx-bench/shared/schema';

import { bundleRecords } from './bundles.mjs';
import { discoverEntries, repoRoot } from './entries.mjs';
import {
  labArtifactFingerprint,
  verifyVueVaporLabRoot,
} from './lab-artifacts.mjs';
import {
  assertContainedPath,
  assertDirectory,
  assertRegularFile,
} from './path-safety.mjs';

const sourceEntryCommit = (run, record) =>
  run.meta.entryCommits?.[record.sourceEntry ?? record.entry] ?? null;

const sourceEntryArtifact = (run, record) =>
  run.meta.entryArtifacts?.[record.sourceEntry ?? record.entry] ?? null;

const recordKey = (machineId, r, cohort = null) =>
  [machineId, r.entry, r.suite, comparisonKey(r), ...(cohort == null ? [] : [cohort])].join('|');

const cellKey = (r) => [r.suite, comparisonKey(r)].join('|');
const isBenchmarkRecord = (r) => r.suite !== 'bundle';

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
  const normalized = entry === record.entry ? record : { ...record, entry, sourceEntry: record.entry };
  return deriveRecord(normalized);
};

const normalizeRun = (rawRun, file) => {
  if (!rawRun.meta?.machine?.id) throw new Error(`${file}: missing meta.machine.id`);
  if (!rawRun.meta?.generatedAt || Number.isNaN(Date.parse(rawRun.meta.generatedAt))) {
    throw new Error(`${file}: invalid meta.generatedAt`);
  }
  if (!Array.isArray(rawRun.records)) throw new Error(`${file}: records must be an array`);
  const records = rawRun.records.map((record, index) => {
    const hasRepeatedSource = Array.isArray(record.samples);
    const hasScalarSource = typeof record.value === 'number' && Number.isFinite(record.value);
    const hasLegacyScalar = record.samples == null && record.n === 1
      && typeof record.median === 'number' && Number.isFinite(record.median);
    if (!hasRepeatedSource && !hasScalarSource && !hasLegacyScalar && !(record.dnfCount > 0)) {
      throw new Error(`${file}: record ${index} has no samples, value, legacy scalar, or DNF source`);
    }
    if (record.detailSamples != null
      && (!Array.isArray(record.detailSamples) || record.detailSamples.length !== record.samples?.length)) {
      throw new Error(`${file}: record ${index} detailSamples must align with samples`);
    }
    return normalizeRecord(rawRun, record);
  });
  const seen = new Set();
  for (const record of records) {
    const key = [record.entry, cellKey(record)].join('|');
    if (seen.has(key)) throw new Error(`${file}: duplicate source record ${key}`);
    seen.add(key);
  }
  return { ...rawRun, records };
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
  const featuredRecords = run.records.filter((r) => featuredIds.has(r.entry) && isBenchmarkRecord(r));
  const entries = new Set(featuredRecords.map((r) => r.entry));
  const cellsByEntry = [...entries].map((entry) => new Set(
    featuredRecords.filter((r) => r.entry === entry).map(cellKey),
  ));
  const sharedCells = cellsByEntry.length
    ? [...cellsByEntry[0]].filter((key) => cellsByEntry.every((cells) => cells.has(key))).length
    : 0;
  const minimumCoverage = cellsByEntry.length
    ? Math.min(...cellsByEntry.map((cells) => cells.size))
    : 0;
  const uniqueRecords = new Set(featuredRecords.map((r) => [r.entry, cellKey(r)].join('|'))).size;
  // Prefer broad featured-framework coverage, then the largest balanced matrix.
  // Duplicate records and static bundle snapshots cannot inflate this rank.
  return [entries.size, sharedCells, minimumCoverage, uniqueRecords];
};

const sourceMatchesManifest = (run, record, entryById, artifactById) => {
  const entry = entryById.get(record.entry);
  const currentArtifact = artifactById?.get(record.entry);
  if (artifactById) {
    if (!currentArtifact) return false;
    if (sourceEntryArtifact(run, record)?.fingerprint !== currentArtifact.fingerprint) return false;
  }
  if (!entry) return true;
  const sourceId = record.sourceEntry ?? record.entry;
  const runCommit = run.meta.entryCommits?.[sourceId];
  const manifestCommit = entry.provenance?.commit;
  if (!(runCommit && manifestCommit && runCommit === manifestCommit)) return false;
  return true;
};

const comparisonView = (run, featuredIds, entryById, artifactById, harness) => ({
  ...run,
  records: run.records.filter((record) => featuredIds.has(record.entry)
    && isBenchmarkRecord(record)
    && record.harness === harness
    && sourceMatchesManifest(run, record, entryById, artifactById)),
});

const isBetterComparisonRun = (candidate, current, featuredIds) => {
  if (!current) return true;
  const a = comparisonRank(candidate.run, featuredIds);
  const b = comparisonRank(current.run, featuredIds);
  const candidateTime = candidate.run.meta.generatedAt ?? candidate.file;
  const currentTime = current.run.meta.generatedAt ?? current.file;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return candidateTime > currentTime
    || (candidateTime === currentTime && candidate.file > current.file);
};

const selectNativeCohort = (runs, featuredIds, entryById, artifactById) => {
  const groups = new Map();
  for (const candidate of runs) {
    const records = comparisonView(
      candidate.run,
      featuredIds,
      entryById,
      artifactById,
      'native',
    ).records;
    for (const environment of new Set(records.map((record) => record.environment))) {
      const groupKey = `${candidate.run.meta.machine.id}|${environment}`;
      const group = groups.get(groupKey) ?? {
        machineId: candidate.run.meta.machine.id,
        environment,
        entries: new Map(),
      };
      for (const entry of new Set(records
        .filter((record) => record.environment === environment)
        .map((record) => record.entry))) {
        const entryCohort = group.entries.get(entry) ?? { cells: new Map(), latest: null };
        const candidateTime = candidate.run.meta.generatedAt ?? candidate.file;
        for (const record of records.filter((record) => record.environment === environment
          && record.entry === entry)) {
          const key = cellKey(record);
          const current = entryCohort.cells.get(key);
          const currentTime = current?.run.meta.generatedAt ?? current?.file;
          if (!current || candidateTime > currentTime
            || (candidateTime === currentTime && candidate.file > current.file)) {
            entryCohort.cells.set(key, { ...candidate, record });
          }
        }
        entryCohort.latest = entryCohort.latest == null || candidateTime > entryCohort.latest
          ? candidateTime
          : entryCohort.latest;
        group.entries.set(entry, entryCohort);
      }
      groups.set(groupKey, group);
    }
  }

  let selected = null;
  let selectedRank = null;
  for (const group of groups.values()) {
    const entries = [...group.entries.values()];
    const cellsByEntry = entries.map((entry) => new Set(entry.cells.keys()));
    const sharedCells = cellsByEntry.length
      ? [...cellsByEntry[0]].filter((key) => cellsByEntry.every((cells) => cells.has(key))).length
      : 0;
    const minimumCoverage = cellsByEntry.length
      ? Math.min(...cellsByEntry.map((cells) => cells.size))
      : 0;
    const recordCount = entries.reduce((sum, entry) => sum + entry.cells.size, 0);
    const latest = entries.reduce((value, entry) =>
      value == null || entry.latest > value ? entry.latest : value, null);
    const rank = [entries.length, sharedCells, minimumCoverage, recordCount];
    const better = !selectedRank || rank.some((value, index) => value !== selectedRank[index]
      && rank.slice(0, index).every((prefix, prefixIndex) => prefix === selectedRank[prefixIndex])
      && value > selectedRank[index]);
    if (better || (rank.every((value, index) => value === selectedRank?.[index])
      && latest > selected.latest)) {
      selected = { ...group, latest };
      selectedRank = rank;
    }
  }
  return selected;
};

const annotate = (run, file, record, comparisonKind = 'archive') => ({
  ...record,
  machineId: run.meta.machine.id,
  runFile: file,
  runGeneratedAt: run.meta.generatedAt,
  calibration: run.meta.calibration,
  entryCommit: sourceEntryCommit(run, record),
  entryArtifactFingerprint: sourceEntryArtifact(run, record)?.fingerprint ?? null,
  comparisonKind,
});

const annotateStatic = (entry, record) => ({
  ...deriveRecord(record),
  machineId: null,
  runFile: null,
  runGeneratedAt: entry.provenance?.builtAt ?? null,
  calibration: null,
  entryCommit: entry.provenance?.commit ?? null,
  comparisonKind: 'derived-static',
});

const assertCurrentEntryCommit = (run, entryId, entry, label) => {
  if (!entry) return;
  const record = run.records.find((candidate) => candidate.entry === entryId);
  const sourceId = record?.sourceEntry ?? entryId;
  const runCommit = run.meta.entryCommits?.[sourceId];
  const manifestCommit = entry.provenance?.commit;
  if (!runCommit || !manifestCommit || runCommit !== manifestCommit) {
    throw new Error(
      `${label} ${entryId}: source run commit ${runCommit ?? 'missing'} does not match `
      + `current entry manifest ${manifestCommit ?? 'missing'}; rerun the benchmark`,
    );
  }
};

const assertCurrentEntryArtifact = (run, entryId, artifact, label) => {
  if (!artifact) return;
  const runArtifact = run.meta.entryArtifacts?.[entryId];
  if (!runArtifact || runArtifact.fingerprint !== artifact.fingerprint) {
    throw new Error(
      `${label} ${entryId}: source run receipt cohort `
      + `${runArtifact?.fingerprint ?? 'missing'} does not match current entry manifest `
      + `${artifact.fingerprint}; rerun the benchmark`,
    );
  }
};

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
  const scaled = deriveRecord({
    ...annotated,
    value: scaleNumber(record.value, ratio),
    samples: record.samples?.map((value) => scaleNumber(value, ratio)) ?? record.samples,
  });
  return {
    ...scaled,
    sourceMedian: record.median,
    targetCalibration,
    calibrationRatio: ratio,
  };
};

const isBetterLabRun = (candidate, current, entryId) => {
  if (!current) return true;
  const count = new Set(candidate.run.records
    .filter((r) => r.entry === entryId && isBenchmarkRecord(r))
    .map(cellKey)).size;
  const currentCount = new Set(current.run.records
    .filter((r) => r.entry === entryId && isBenchmarkRecord(r))
    .map(cellKey)).size;
  const time = candidate.run.meta.generatedAt ?? candidate.file;
  const currentTime = current.run.meta.generatedAt ?? current.file;
  return count > currentCount || (count === currentCount && (time > currentTime
    || (time === currentTime && candidate.file > current.file)));
};

export function collectRuns({
  log = console.log,
  root = repoRoot(),
  generatedAt = null,
  entryTiers = null,
  entries = null,
  labMode = false,
} = {}) {
  const entriesDir = path.join(root, 'entries');
  const runsDir = path.join(root, 'results/runs');
  const outPath = path.join(root, 'results/latest.json');
  for (const [target, label] of [
    [entriesDir, 'entries directory'],
    [path.join(root, 'results'), 'results directory'],
    [runsDir, 'results/runs directory'],
    [outPath, 'results/latest.json'],
  ]) {
    assertContainedPath(root, target, { label });
  }
  if (!fs.existsSync(runsDir)) throw new Error(`no runs directory at ${runsDir}`);
  assertDirectory(runsDir, 'results/runs directory');
  if (fs.existsSync(outPath)) assertRegularFile(outPath, 'results/latest.json');
  if (labMode) assertDirectory(entriesDir, 'entries directory');

  const runFiles = fs.readdirSync(runsDir).filter((f) => f.endsWith('.json')).sort();
  const machines = {};
  const merged = new Map();
  const runs = [];
  let comparisonRun = null;
  let latestSourceGeneratedAt = null;
  let runsSeen = 0;
  const verifiedLabArtifacts = labMode ? verifyVueVaporLabRoot(root) : null;
  const currentEntries = entries ?? (fs.existsSync(entriesDir)
    ? discoverEntries({ root })
    : []);
  const entryById = new Map(currentEntries.map((entry) => [entry.id, entry]));
  const artifactById = labMode
    ? new Map(verifiedLabArtifacts.map((artifact) => [artifact.entryId, artifact]))
    : null;
  const resolvedTiers = entryTiers ?? readEntryTiers(root);
  const staticByEntry = new Map(currentEntries.map((entry) => [entry.id, bundleRecords(entry)]));
  const featuredIds = new Set([...resolvedTiers].filter(([, tier]) => tier !== 'lab').map(([id]) => id));
  const comparisonIds = labMode && featuredIds.size === 0
    ? new Set(resolvedTiers.keys())
    : featuredIds;
  const labIds = [...resolvedTiers]
    .filter(([id, tier]) => tier === 'lab' && !comparisonIds.has(id))
    .map(([id]) => id);

  for (const file of runFiles) {
    const runPath = path.join(runsDir, file);
    assertRegularFile(runPath, `run file ${file}`);
    const rawRun = JSON.parse(fs.readFileSync(runPath, 'utf-8'));
    if (rawRun.schemaVersion !== SCHEMA_VERSION) {
      log(`[collect] skip ${file}: schemaVersion ${rawRun.schemaVersion} != ${SCHEMA_VERSION}`);
      continue;
    }
    const run = normalizeRun(rawRun, file);
    runs.push({ file, run });
    runsSeen += 1;
    const m = run.meta.machine;
    const runTime = run.meta.generatedAt ?? file;
    latestSourceGeneratedAt = latestSourceGeneratedAt == null || runTime > latestSourceGeneratedAt
      ? runTime
      : latestSourceGeneratedAt;
    if (!machines[m.id] || runTime > machines[m.id].latestRunGeneratedAt
      || (runTime === machines[m.id].latestRunGeneratedAt && file > machines[m.id].latestRunFile)) {
      machines[m.id] = {
        ...m,
        latestCalibration: run.meta.calibration,
        latestRunFile: file,
        latestRunGeneratedAt: run.meta.generatedAt,
      };
    }
    for (const r of run.records.filter(isBenchmarkRecord)) {
      const entryCommit = sourceEntryCommit(run, r);
      if (labMode && !entryCommit) {
        throw new Error(`${file}: Lab record ${r.entry} is missing meta.entryCommits`);
      }
      const artifact = sourceEntryArtifact(run, r);
      if (labMode) {
        if (!artifact?.fingerprint) {
          throw new Error(`${file}: Lab record ${r.entry} is missing meta.entryArtifacts`);
        }
        const expectedFingerprint = labArtifactFingerprint(artifact);
        if (artifact.fingerprint !== expectedFingerprint) {
          throw new Error(`${file}: Lab record ${r.entry} has an invalid receipt cohort`);
        }
        const benchmarkWorktree = run.meta.benchmarkWorktree;
        if (!benchmarkWorktree?.head || !benchmarkWorktree?.patchSha256) {
          throw new Error(`${file}: Lab record ${r.entry} is missing meta.benchmarkWorktree`);
        }
        if (artifact.benchmarkHead !== benchmarkWorktree.head
          || artifact.benchmarkPatchSha256 !== benchmarkWorktree.patchSha256) {
          throw new Error(`${file}: Lab record ${r.entry} has a mismatched benchmark worktree`);
        }
      }
      const key = recordKey(m.id, r, labMode ? artifact.fingerprint : null);
      const current = merged.get(key);
      const currentTime = current?.runGeneratedAt ?? current?.runFile;
      if (!current || runTime > currentTime || (runTime === currentTime && file > current.runFile)) {
        merged.set(key, annotate(run, file, r));
      }
    }
    const view = comparisonView(run, comparisonIds, entryById, artifactById, 'web');
    const candidate = { file, run: view };
    if (view.records.length > 0
      && isBetterComparisonRun(candidate, comparisonRun, comparisonIds)) comparisonRun = candidate;
  }

  const nativeCohort = selectNativeCohort(runs, comparisonIds, entryById, artifactById);
  if (!comparisonRun && !(labMode && nativeCohort)) {
    throw new Error(`no schema v${SCHEMA_VERSION} runs at ${runsDir}`);
  }
  if (comparisonRun && comparisonRank(comparisonRun.run, comparisonIds)[0] === 0) {
    throw new Error(
      `no ${labMode ? 'Lab' : 'featured'} benchmark records in schema v${SCHEMA_VERSION} runs at ${runsDir}`,
    );
  }
  const comparisonSourceRecords = comparisonRun
    ? comparisonRun.run.records.filter((r) =>
      comparisonIds.has(r.entry) && isBenchmarkRecord(r))
    : [];
  for (const entryId of new Set(comparisonSourceRecords.map((record) => record.entry))) {
    assertCurrentEntryCommit(comparisonRun.run, entryId, entryById.get(entryId), 'comparison');
    assertCurrentEntryArtifact(
      comparisonRun.run,
      entryId,
      artifactById?.get(entryId),
      'comparison',
    );
  }
  const comparisonStaticRecords = [...comparisonIds].flatMap((entryId) => {
    const entry = entryById.get(entryId);
    return entry ? (staticByEntry.get(entryId) ?? []).map((record) => annotateStatic(entry, record)) : [];
  });
  const comparisonRecords = [
    ...comparisonSourceRecords.map((r) => annotate(comparisonRun.run, comparisonRun.file, r, 'same-run')),
    ...comparisonStaticRecords,
  ];
  const nativeSourceRecords = nativeCohort
    ? [...nativeCohort.entries.values()].flatMap((entry) => [...entry.cells.values()].map((source) =>
      annotate(source.run, source.file, source.record, 'same-machine')))
    : [];
  comparisonRecords.push(...nativeSourceRecords);
  const nativeComparison = nativeCohort ? {
    harness: 'native',
    environment: nativeCohort.environment,
    generatedAt: nativeCohort.latest,
    machineId: nativeCohort.machineId,
    calibration: null,
    sourceRunFiles: [...new Set([...nativeCohort.entries.values()].flatMap((entry) =>
      [...entry.cells.values()].map((source) => source.file)))].sort(),
    entryIds: [...nativeCohort.entries.keys()].sort(),
    sourceRecordCount: nativeSourceRecords.length,
    recordCount: nativeSourceRecords.length,
  } : null;
  const nativePrimaryRecord = [...nativeSourceRecords].sort((left, right) =>
    left.runGeneratedAt.localeCompare(right.runGeneratedAt)
    || left.runFile.localeCompare(right.runFile)).at(-1) ?? null;
  const comparisonEntryIds = comparisonRun
    ? [...new Set(comparisonSourceRecords.map((r) => r.entry))].sort()
    : nativeComparison?.entryIds ?? [];
  const comparisonSourceRecordCount = comparisonRun
    ? comparisonSourceRecords.length
    : nativeSourceRecords.length;
  const comparison = {
    runFile: comparisonRun?.file ?? nativePrimaryRecord?.runFile ?? null,
    generatedAt: comparisonRun?.run.meta.generatedAt ?? nativeComparison?.generatedAt ?? null,
    machineId: comparisonRun?.run.meta.machine.id ?? nativeComparison?.machineId ?? null,
    calibration: comparisonRun?.run.meta.calibration ?? null,
    entryIds: comparisonEntryIds,
    sourceRecordCount: comparisonSourceRecordCount,
    recordCount: comparisonRecords.length,
    harnesses: [
      ...(comparisonRun ? [{
        harness: 'web',
        environment: comparisonSourceRecords[0]?.environment ?? null,
        generatedAt: comparisonRun.run.meta.generatedAt,
        machineId: comparisonRun.run.meta.machine.id,
        calibration: comparisonRun.run.meta.calibration,
        sourceRunFiles: [comparisonRun.file],
        entryIds: [...new Set(comparisonSourceRecords.map((r) => r.entry))].sort(),
        sourceRecordCount: comparisonSourceRecords.length,
        recordCount: comparisonSourceRecords.length + comparisonStaticRecords.length,
      }] : []),
      ...(nativeComparison ? [nativeComparison] : []),
    ],
  };
  const labEstimates = [];
  const labComparisonRecords = [];
  for (const entryId of labIds) {
    let source = null;
    for (const candidate of runs) {
      if (!candidate.run.records.some((r) => r.entry === entryId && isBenchmarkRecord(r))) continue;
      if (isBetterLabRun(candidate, source, entryId)) source = candidate;
    }
    if (!source) continue;
    const records = source.run.records.filter((r) => r.entry === entryId && isBenchmarkRecord(r));
    assertCurrentEntryCommit(source.run, entryId, entryById.get(entryId), 'Lab comparison');
    assertCurrentEntryArtifact(
      source.run,
      entryId,
      artifactById?.get(entryId),
      'Lab comparison',
    );
    const sourceCalibration = source.run.meta.calibration;
    const targetCalibration = comparisonRun?.run.meta.calibration ?? null;
    const compatibleCalibration = sourceCalibration?.probeVersion === targetCalibration?.probeVersion
      && sourceCalibration?.score > 0
      && targetCalibration?.score > 0;
    const calibrationRatio = compatibleCalibration
      ? source.run.meta.calibration.score / comparisonRun.run.meta.calibration.score
      : null;
    labEstimates.push({
      entryId,
      sourceRunFile: source.file,
      sourceGeneratedAt: source.run.meta.generatedAt,
      sourceMachineId: source.run.meta.machine.id,
      sourceCalibration: source.run.meta.calibration,
      targetCalibration,
      calibrationRatio,
      sourceRecordCount: records.length,
      recordCount: records.length + (staticByEntry.get(entryId)?.length ?? 0),
    });
    labComparisonRecords.push(...records.map((r) =>
      calibrateLabRecord(source.run, source.file, r, targetCalibration)));
    const entry = entryById.get(entryId);
    if (entry) {
      labComparisonRecords.push(...(staticByEntry.get(entryId) ?? []).map((record) =>
        annotateStatic(entry, record)));
    }
  }
  comparison.labEstimates = labEstimates;

  const archiveStaticRecords = currentEntries.flatMap((entry) =>
    (staticByEntry.get(entry.id) ?? []).map((record) => annotateStatic(entry, record)));

  const out = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: generatedAt ?? latestSourceGeneratedAt,
    sources: {
      runFiles: runs.map(({ file }) => file),
      entryIds: currentEntries.map((entry) => entry.id),
    },
    machines,
    records: [...merged.values(), ...archiveStaticRecords],
    comparison,
    comparisonRecords,
    labComparisonRecords,
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 1));
  log(`[collect] ${runsSeen} runs → ${out.records.length} merged records; comparison=${comparison.runFile} (${comparison.entryIds.length} web entries, ${nativeComparison?.entryIds.length ?? 0} native entries, ${comparison.recordCount} records) + ${labEstimates.length} calibrated Lab entries → ${path.relative(root, outPath)}`);
  return out;
}
