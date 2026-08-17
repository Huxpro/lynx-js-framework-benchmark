// Merge run files into results/latest.json. Newest record wins per
// (machine × entry × suite × every comparability dimension, including
// boundary and unit);
// records from different machines coexist, each tagged with its source run and
// calibration. Web featured comparisonRecords come from one coherent run;
// Native featured records may come from one complete run per entry, but only
// when every run belongs to the same physical device/environment. Opt-in Lab
// records are separate, explicitly calibrated historical estimates.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { comparisonKey, deriveRecord, SCHEMA_VERSION } from '@lynx-bench/shared/schema';

import { bundleRecords } from './bundles.mjs';
import { discoverEntries, repoRoot } from './entries.mjs';

const recordKey = (machineId, r) =>
  [machineId, r.entry, r.suite, comparisonKey(r)].join('|');

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
    if (record.failures != null && !Array.isArray(record.failures)) {
      throw new Error(`${file}: record ${index} failures must be an array`);
    }
    if (Array.isArray(record.failures) && record.failures.length > (record.dnfCount ?? 0)) {
      throw new Error(`${file}: record ${index} failures cannot exceed dnfCount`);
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

const commitMatchesManifest = (run, record, entryById) => {
  const entry = entryById.get(record.entry);
  if (!entry) return true;
  const sourceId = record.sourceEntry ?? record.entry;
  const runCommit = run.meta.entryCommits?.[sourceId];
  const manifestCommit = entry.provenance?.commit;
  return Boolean(runCommit && manifestCommit && runCommit === manifestCommit);
};

const isPublishableRecord = (run, record) => !(
  record.harness === 'native'
  && record.entry === 'octane'
  && (
    run.meta.machine?.octaneTriggerMode === 'driver'
    || record.boundary === 'native-devtool-driver-handler-to-second-native-frame'
  )
);

const comparisonView = (run, featuredIds, entryById, harness) => ({
  ...run,
  records: run.records.filter((record) => featuredIds.has(record.entry)
    && isBenchmarkRecord(record)
    && record.harness === harness
    && isPublishableRecord(run, record)
    && commitMatchesManifest(run, record, entryById)),
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

const selectNativeCohort = (runs, featuredIds, entryById) => {
  const groups = new Map();
  for (const candidate of runs) {
    const records = comparisonView(candidate.run, featuredIds, entryById, 'native').records;
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

const selectNativeObservations = (runs, featuredIds, entryById, nativeCohort) => {
  const cohortEntries = new Set(nativeCohort?.entries.keys() ?? []);
  const observations = [];
  const records = [];
  for (const entryId of featuredIds) {
    if (cohortEntries.has(entryId)) continue;
    let selected = null;
    for (const candidate of runs) {
      const candidateRecords = comparisonView(
        candidate.run,
        featuredIds,
        entryById,
        'native',
      ).records.filter((record) => record.entry === entryId);
      for (const environment of new Set(candidateRecords.map((record) => record.environment))) {
        const environmentRecords = candidateRecords.filter((record) =>
          record.environment === environment);
        if (environmentRecords.length === 0) continue;
        const candidateTime = candidate.run.meta.generatedAt ?? candidate.file;
        if (
          !selected
          || environmentRecords.length > selected.records.length
          || (environmentRecords.length === selected.records.length
            && (candidateTime > selected.time
              || (candidateTime === selected.time && candidate.file > selected.file)))
        ) {
          selected = {
            ...candidate,
            environment,
            records: environmentRecords,
            time: candidateTime,
          };
        }
      }
    }
    if (!selected) continue;
    const annotated = selected.records.map((record) =>
      annotate(selected.run, selected.file, record, 'isolated-observation'));
    observations.push({
      entryId,
      harness: 'native',
      environment: selected.environment,
      generatedAt: selected.run.meta.generatedAt,
      machineId: selected.run.meta.machine.id,
      sourceRunFile: selected.file,
      sourceRecordCount: annotated.length,
    });
    records.push(...annotated);
  }
  return { observations, records };
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

const annotateStatic = (entry, record) => ({
  ...deriveRecord(record),
  machineId: null,
  runFile: null,
  runGeneratedAt: entry.provenance?.builtAt ?? null,
  calibration: null,
  entryCommit: entry.provenance?.commit ?? null,
  comparisonKind: 'derived-static',
});

const historyId = (generatedAt, sourceFiles) => {
  const stamp = generatedAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const hash = crypto.createHash('sha256').update(sourceFiles.join('\n')).digest('hex').slice(0, 8);
  return `${stamp}-${hash}`;
};

const publicHistoryEntry = (run, record) => {
  const sourceEntry = record.sourceEntry ?? record.entry;
  if (sourceEntry === 'octane-main') return 'octane';
  if (record.entry === 'octane' && !HUX1_COMMITS.has(run.meta.entryCommits?.octane)) return 'octane';
  return record.entry;
};

const sourceCommit = (run, record) =>
  run.meta.entryCommits?.[record.sourceEntry ?? record.entry] ?? null;

const stormTransportEvidence = (run, record) => {
  if (record.harness !== 'web' || record.metric !== 'latency'
    || !['updateStorm', 'selectStorm'].includes(record.workload)) return null;
  const expectedSequentialCommits = record.workload === 'updateStorm' ? 50 : 30;
  const findMessages = (metric) => run.records.find((candidate) =>
    candidate.entry === record.entry
    && candidate.suite === record.suite
    && candidate.harness === record.harness
    && candidate.environment === record.environment
    && candidate.workload === record.workload
    && candidate.scale === record.scale
    && candidate.metric === metric)?.median ?? null;
  const toMtsMessages = findMessages('wireToMtsMsgs');
  const toBtsMessages = findMessages('wireToBtsMsgs');
  if (toMtsMessages == null || toBtsMessages == null) return {
    comparable: false,
    issue: 'missing-storm-transport-evidence',
    expectedSequentialCommits,
    toMtsMessages,
    toBtsMessages,
  };
  return {
    comparable: toMtsMessages >= expectedSequentialCommits
      && toBtsMessages >= expectedSequentialCommits,
    issue: toMtsMessages >= expectedSequentialCommits && toBtsMessages >= expectedSequentialCommits
      ? null
      : 'incomplete-storm-transport',
    expectedSequentialCommits,
    toMtsMessages,
    toBtsMessages,
  };
};

const historyRecord = (run, file, record, comparisonKind, cohortId) => {
  const sourceEntry = record.sourceEntry ?? record.entry;
  const entry = publicHistoryEntry(run, record);
  const transport = stormTransportEvidence(run, record);
  return {
    suite: record.suite,
    harness: record.harness,
    environment: record.environment,
    entry,
    ...(sourceEntry === entry ? {} : { sourceEntry }),
    workload: record.workload,
    scale: record.scale,
    metric: record.metric,
    boundary: record.boundary,
    unit: record.unit,
    n: record.n,
    median: record.median,
    ci95: record.ci95,
    dnfCount: record.dnfCount,
    detail: record.detail,
    detailKind: record.detailKind,
    ...(record.failures?.length ? { failures: record.failures } : {}),
    machineId: run.meta.machine.id,
    runFile: file,
    runGeneratedAt: run.meta.generatedAt,
    entryCommit: sourceCommit(run, record),
    comparisonKind,
    cohortId,
    rankEligible: transport?.comparable ?? true,
    ...(transport ? { transport } : {}),
  };
};

const historySourceSummary = ({ file, run }, recordCount, entryIds, rankEligible, reason) => ({
  runFile: file,
  generatedAt: run.meta.generatedAt,
  machineId: run.meta.machine.id,
  harnesses: [...new Set(run.records.map((record) => record.harness))].sort(),
  environments: [...new Set(run.records.map((record) => record.environment))].sort(),
  entryIds: [...entryIds].sort(),
  entryCommits: Object.fromEntries(Object.entries(run.meta.entryCommits ?? {}).sort()),
  machine: run.meta.machine,
  calibration: run.meta.calibration,
  sourceRecordCount: run.records.length,
  historyRecordCount: recordCount,
  rankEligible,
  reason,
});

const buildHistory = ({ runs, featuredIds, current }) => {
  const records = [];
  const sources = [];
  const checkpoints = [];
  const nativeGroups = new Map();

  for (const candidate of runs) {
    const { file, run } = candidate;
    const publishable = run.records.filter((record) => isPublishableRecord(run, record));
    const benchmark = publishable.filter(isBenchmarkRecord);
    const web = benchmark.filter((record) => record.harness === 'web');
    const native = benchmark.filter((record) => record.harness === 'native');
    const webPublic = publishable.filter((record) => record.harness === 'web' && (() => {
      const entry = publicHistoryEntry(run, record);
      return featuredIds.has(entry);
    })());
    const webEntries = new Set(web.map((record) => publicHistoryEntry(run, record))
      .filter((entry) => featuredIds.has(entry)));
    const webCohort = web.length > 0 && webEntries.size >= 2;
    const hasUpstreamOctane = web.some((record) => publicHistoryEntry(run, record) === 'octane');
    const sourceIndex = sources.length;
    const sourceHistoryRecords = [];

    if (hasUpstreamOctane) {
      const cohortId = `web:${run.meta.machine.id}:${file}`;
      sourceHistoryRecords.push(...webPublic.map((record) =>
        historyRecord(run, file, record, webCohort ? 'same-run' : 'isolated-observation',
          cohortId)));
      const currentMainRecords = sourceHistoryRecords.filter((record) => record.entry === 'octane');
      if (currentMainRecords.length) {
        const generatedAt = run.meta.generatedAt;
        checkpoints.push({
          id: historyId(generatedAt, [file]),
          generatedAt,
          label: new Date(generatedAt).toISOString(),
          description: webCohort
            ? `Exact Web cohort from ${file}.`
            : `Exact Octane observation from ${file}; no cross-framework rank is inferred.`,
          octaneCommit: currentMainRecords[0].entryCommit,
          activeRecordIndexes: sourceHistoryRecords.map((_, index) => records.length + index),
          sourceIndexes: [sourceIndex],
          harnesses: [{
            harness: 'web',
            environment: webPublic[0].environment,
            machineId: run.meta.machine.id,
            sourceRunFiles: [file],
            entryIds: [...webEntries].sort(),
            rankEligible: webCohort,
          }],
        });
      }
    }

    if (native.length) {
      const key = `${run.meta.machine.id}|${native[0].environment}`;
      const group = nativeGroups.get(key) ?? [];
      group.push(candidate);
      nativeGroups.set(key, group);
    }

    records.push(...sourceHistoryRecords);
    const normalizedEntries = new Set(benchmark.map((record) => publicHistoryEntry(run, record)));
    sources.push(historySourceSummary(
      candidate,
      sourceHistoryRecords.length + native.filter((record) =>
        featuredIds.has(publicHistoryEntry(run, record))).length,
      normalizedEntries,
      webCohort,
      webPublic.length === 0
        ? (native.length ? 'native run; evaluated with its exact machine/environment cohort' : 'no featured benchmark observations')
        : webCohort ? 'exact same-run Web cohort' : 'exact observation only; fewer than two eligible entries',
    ));
  }

  for (const candidates of nativeGroups.values()) {
    const ordered = [...candidates].sort((a, b) =>
      a.run.meta.generatedAt.localeCompare(b.run.meta.generatedAt) || a.file.localeCompare(b.file));
    const cells = new Map();
    const sourceIndexes = [];
    const files = [];
    const recordIndexesByCell = new Map();
    let hasOctane = false;
    for (const candidate of ordered) {
      const sourceIndex = runs.indexOf(candidate);
      sourceIndexes.push(sourceIndex);
      files.push(candidate.file);
      for (const record of candidate.run.records.filter((item) => isBenchmarkRecord(item)
        && item.harness === 'native'
        && isPublishableRecord(candidate.run, item))) {
        const entry = publicHistoryEntry(candidate.run, record);
        if (!featuredIds.has(entry)) continue;
        if (entry === 'octane') hasOctane = true;
        const key = `${entry}|${cellKey(record)}`;
        cells.set(key, { candidate, record });
        const history = historyRecord(
          candidate.run, candidate.file, record,
          'same-machine',
          `native:${candidate.run.meta.machine.id}:${candidate.run.records[0]?.environment}`,
        );
        recordIndexesByCell.set(key, records.push(history) - 1);
      }
      if (!hasOctane) continue;
      const groupRecords = [...cells.values()];
      const entryIds = new Set(groupRecords.map(({ candidate: source, record }) =>
        publicHistoryEntry(source.run, record)));
      const rankEligible = entryIds.size >= 2;
      const activeRecordIndexes = [...cells.keys()].map((key) => recordIndexesByCell.get(key));
      checkpoints.push({
        id: historyId(candidate.run.meta.generatedAt, [...files].sort()),
        generatedAt: candidate.run.meta.generatedAt,
        label: new Date(candidate.run.meta.generatedAt).toISOString(),
        description: rankEligible
          ? `Exact Native machine/environment cohort from ${files.length} source run${files.length === 1 ? '' : 's'}.`
          : `Exact Native Octane observation; no other framework shares its machine/environment identity.`,
        octaneCommit: activeRecordIndexes.map((index) => records[index])
          .find((record) => record.entry === 'octane')?.entryCommit ?? null,
        activeRecordIndexes,
        sourceIndexes: [...sourceIndexes],
        harnesses: [{
          harness: 'native',
          environment: groupRecords[0].record.environment,
          machineId: candidate.run.meta.machine.id,
          sourceRunFiles: [...files],
          entryIds: [...entryIds].sort(),
          rankEligible,
        }],
      });
      for (const usedSourceIndex of new Set(sourceIndexes)) {
        const source = sources[usedSourceIndex];
        source.rankEligible ||= rankEligible;
        source.reason = source.rankEligible
          ? 'exact Native machine/environment cohort'
          : 'exact Native observation only; no second eligible entry in this identity';
      }
    }
  }

  checkpoints.push({
    id: 'current-main',
    generatedAt: current.generatedAt,
    label: 'Current',
    description: 'Current published Web and Native comparison cohorts.',
    octaneCommit: current.octaneCommit,
    current: true,
    activeRecordIndexes: [],
    sourceIndexes: [...new Set(current.records.filter(isBenchmarkRecord)
      .map((record) => sources.findIndex((source) => source.runFile === record.runFile))
      .filter((index) => index >= 0))],
    harnesses: current.comparison.harnesses.map((cohort) => ({
      harness: cohort.harness, environment: cohort.environment, machineId: cohort.machineId,
      sourceRunFiles: cohort.sourceRunFiles, entryIds: cohort.entryIds, rankEligible: true,
    })),
  });

  checkpoints.sort((a, b) => a.generatedAt.localeCompare(b.generatedAt) || a.id.localeCompare(b.id));
  return { records, sources, checkpoints };
};

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
} = {}) {
  const runsDir = path.join(root, 'results/runs');
  const outPath = path.join(root, 'results/latest.json');
  if (!fs.existsSync(runsDir)) throw new Error(`no runs directory at ${runsDir}`);

  const runFiles = fs.readdirSync(runsDir).filter((f) => f.endsWith('.json')).sort();
  const machines = {};
  const merged = new Map();
  const runs = [];
  let comparisonRun = null;
  let latestSourceGeneratedAt = null;
  let runsSeen = 0;
  const resolvedTiers = entryTiers ?? readEntryTiers(root);
  const currentEntries = entries ?? (fs.existsSync(path.join(root, 'entries'))
    ? discoverEntries({ root })
    : []);
  const entryById = new Map(currentEntries.map((entry) => [entry.id, entry]));
  const staticByEntry = new Map(currentEntries.map((entry) => [entry.id, bundleRecords(entry)]));
  const featuredIds = new Set([...resolvedTiers].filter(([, tier]) => tier !== 'lab').map(([id]) => id));
  const labIds = [...resolvedTiers].filter(([, tier]) => tier === 'lab').map(([id]) => id);

  for (const file of runFiles) {
    const rawRun = JSON.parse(fs.readFileSync(path.join(runsDir, file), 'utf-8'));
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
      const key = recordKey(m.id, r);
      const current = merged.get(key);
      const currentTime = current?.runGeneratedAt ?? current?.runFile;
      if (!current || runTime > currentTime || (runTime === currentTime && file > current.runFile)) {
        merged.set(key, annotate(run, file, r));
      }
    }
    const view = comparisonView(run, featuredIds, entryById, 'web');
    const candidate = { file, run: view };
    if (view.records.length > 0
      && isBetterComparisonRun(candidate, comparisonRun, featuredIds)) comparisonRun = candidate;
  }

  if (!comparisonRun) throw new Error(`no schema v${SCHEMA_VERSION} runs at ${runsDir}`);
  if (comparisonRank(comparisonRun.run, featuredIds)[0] === 0) {
    throw new Error(`no featured benchmark records in schema v${SCHEMA_VERSION} runs at ${runsDir}`);
  }
  const comparisonSourceRecords = comparisonRun.run.records.filter((r) =>
    featuredIds.has(r.entry) && isBenchmarkRecord(r));
  for (const entryId of new Set(comparisonSourceRecords.map((record) => record.entry))) {
    assertCurrentEntryCommit(comparisonRun.run, entryId, entryById.get(entryId), 'comparison');
  }
  const comparisonStaticRecords = [...featuredIds].flatMap((entryId) => {
    const entry = entryById.get(entryId);
    return entry ? (staticByEntry.get(entryId) ?? []).map((record) => annotateStatic(entry, record)) : [];
  });
  const comparisonRecords = [
    ...comparisonSourceRecords.map((r) => annotate(comparisonRun.run, comparisonRun.file, r, 'same-run')),
    ...comparisonStaticRecords,
  ];
  const nativeCohort = selectNativeCohort(runs, featuredIds, entryById);
  const nativeSourceRecords = nativeCohort
    ? [...nativeCohort.entries.values()].flatMap((entry) => [...entry.cells.values()].map((source) =>
      annotate(source.run, source.file, source.record, 'same-machine')))
    : [];
  comparisonRecords.push(...nativeSourceRecords);
  const nativeObservations = selectNativeObservations(
    runs,
    featuredIds,
    entryById,
    nativeCohort,
  );
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
  const comparison = {
    runFile: comparisonRun.file,
    generatedAt: comparisonRun.run.meta.generatedAt,
    machineId: comparisonRun.run.meta.machine.id,
    calibration: comparisonRun.run.meta.calibration,
    entryIds: [...new Set(comparisonSourceRecords.map((r) => r.entry))].sort(),
    sourceRecordCount: comparisonSourceRecords.length,
    recordCount: comparisonRecords.length,
    harnesses: [
      {
        harness: 'web',
        environment: comparisonSourceRecords[0]?.environment ?? null,
        generatedAt: comparisonRun.run.meta.generatedAt,
        machineId: comparisonRun.run.meta.machine.id,
        calibration: comparisonRun.run.meta.calibration,
        sourceRunFiles: [comparisonRun.file],
        entryIds: [...new Set(comparisonSourceRecords.map((r) => r.entry))].sort(),
        sourceRecordCount: comparisonSourceRecords.length,
        recordCount: comparisonSourceRecords.length + comparisonStaticRecords.length,
      },
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
    const sourceCalibration = source.run.meta.calibration;
    const targetCalibration = comparisonRun.run.meta.calibration;
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
      targetCalibration: comparisonRun.run.meta.calibration,
      calibrationRatio,
      sourceRecordCount: records.length,
      recordCount: records.length + (staticByEntry.get(entryId)?.length ?? 0),
    });
    labComparisonRecords.push(...records.map((r) =>
      calibrateLabRecord(source.run, source.file, r, comparisonRun.run.meta.calibration)));
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
    nativeObservations: nativeObservations.observations,
    nativeObservationRecords: nativeObservations.records,
  };
  out.history = buildHistory({
    runs,
    featuredIds,
    current: {
      generatedAt: out.generatedAt,
      octaneCommit: entryById.get('octane')?.provenance?.commit ?? null,
      records: comparisonRecords,
      comparison,
    },
  });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 1));
  log(`[collect] ${runsSeen} runs → ${out.records.length} merged records; comparison=${comparison.runFile} (${comparison.entryIds.length} web entries, ${nativeComparison?.entryIds.length ?? 0} native entries, ${comparison.recordCount} records) + ${nativeObservations.observations.length} isolated Native observations + ${labEstimates.length} calibrated Lab entries → ${path.relative(root, outPath)}`);
  return out;
}
