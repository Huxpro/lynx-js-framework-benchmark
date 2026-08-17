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
import { STORM_SELECT_TICKS, STORM_UPDATE_TICKS } from '@lynx-bench/shared/workloads';

import { bundleRecords } from './bundles.mjs';
import { discoverEntries, repoRoot } from './entries.mjs';

const recordKey = (machineId, r) =>
  [machineId, r.entry, r.suite, comparisonKey(r)].join('|');

const cellKey = (r) => [r.suite, comparisonKey(r)].join('|');
const isBenchmarkRecord = (r) => r.suite !== 'bundle';
const isRankingEligible = (record) => record.rankingEligible !== false;
const isComparisonVisible = (record) => isRankingEligible(record)
  || (record.comparabilityStatus === 'incomplete-work'
    && observationValues(record).length === 0
    && (record.dnfCount ?? 0) > 0);

const STORM_TICKS = new Map([
  ['updateStorm', STORM_UPDATE_TICKS],
  ['selectStorm', STORM_SELECT_TICKS],
]);

const observationValues = (record) => {
  if (Array.isArray(record?.samples)) return record.samples.filter(Number.isFinite);
  if (Number.isFinite(record?.value)) return [record.value];
  if (record?.samples == null && record?.n === 1 && Number.isFinite(record?.median)) {
    return [record.median];
  }
  return [];
};

const operationCellKey = (record) => [
  record.suite,
  record.harness,
  record.environment,
  record.entry,
  record.workload,
  record.scale,
].join('|');

function stormWorkClassification(records, record) {
  const expected = STORM_TICKS.get(record.workload);
  if (expected == null || record.suite !== 'table' || record.harness !== 'web') return null;
  const siblings = records.filter((candidate) => operationCellKey(candidate) === operationCellKey(record));
  const failure = siblings.flatMap((candidate) => candidate.failures ?? [])
    .find((candidate) => candidate.category === 'incomplete-storm-transport');
  if (failure) {
    return {
      status: 'incomplete',
      expectedSequentialCommits: expected,
      observed: failure.evidence ?? null,
    };
  }
  const toMts = observationValues(siblings.find((candidate) => candidate.metric === 'wireToMtsMsgs'));
  const toBts = observationValues(siblings.find((candidate) => candidate.metric === 'wireToBtsMsgs'));
  const observed = {
    toMtsMessages: toMts.length ? { min: Math.min(...toMts), max: Math.max(...toMts) } : null,
    toBtsMessages: toBts.length ? { min: Math.min(...toBts), max: Math.max(...toBts) } : null,
  };
  if (toMts.some((value) => value < expected) || toBts.some((value) => value < expected)) {
    return { status: 'incomplete', expectedSequentialCommits: expected, observed };
  }
  if (toMts.length > 0 && toBts.length > 0) {
    return { status: 'complete', expectedSequentialCommits: expected, observed };
  }
  return { status: 'unverified', expectedSequentialCommits: expected, observed };
}

function samplingProblems(run, record) {
  if (!run.meta.receipt || !isBenchmarkRecord(record) || record.workload === 'memory') return [];
  const problems = [];
  const sourceCount = Array.isArray(record.samples)
    ? record.samples.length
    : Number.isFinite(record.value) ? 1 : 0;
  if (!Number.isInteger(record.acceptedCount) || record.acceptedCount !== sourceCount) {
    problems.push('accepted-count-mismatch');
  }
  if (!Number.isInteger(record.attemptedCount) || record.attemptedCount < sourceCount) {
    problems.push('attempted-count-invalid');
  }
  if (record.metric === 'latency' || record.metric === 'fcp' || record.metric === 'settled') {
    if (Number.isInteger(record.attemptedCount)) {
      const accounted = sourceCount + (record.dnfCount ?? 0);
      if (accounted < record.attemptedCount) problems.push('attempt-accounting-underflow');
      if (accounted > record.attemptedCount) problems.push('attempt-accounting-overflow');
    }
  }
  return problems;
}

function classifyComparability(run, records) {
  const cohort = run.meta.receipt?.comparabilityCohort ?? null;
  return records.map((record) => {
    const work = stormWorkClassification(records, record);
    const problems = samplingProblems(run, record);
    let comparabilityStatus = null;
    const comparabilityReasons = [];
    if (problems.length) {
      comparabilityStatus = 'incompatible-sampling';
      comparabilityReasons.push(...problems);
    }
    if (problems.length) {
      // Sampling accounting is a prospective source-integrity contract and
      // takes precedence over any derived work classification.
    } else if (work?.status === 'incomplete') {
      comparabilityStatus = 'incomplete-work';
      comparabilityReasons.push('storm-transport-below-sequential-tick-contract');
    } else if (work?.status === 'unverified') {
      comparabilityStatus = 'unverified-work';
      comparabilityReasons.push('storm-transport-counts-unavailable');
    } else if (work?.status === 'complete') {
      comparabilityStatus = cohort ? 'comparable' : 'legacy-complete-work';
      if (!cohort) comparabilityReasons.push('run-has-no-prospective-receipt');
    } else if (cohort) {
      comparabilityStatus = 'comparable';
    }
    const rankingEligible = comparabilityStatus !== 'incomplete-work'
      && comparabilityStatus !== 'unverified-work'
      && comparabilityStatus !== 'incompatible-sampling';
    if (comparabilityStatus === null && cohort === null) {
      return { ...record, comparabilityStatus: 'legacy-unverified' };
    }
    return {
      ...record,
      comparabilityStatus: comparabilityStatus ?? 'legacy-unverified',
      ...(comparabilityReasons.length ? { comparabilityReasons } : {}),
      ...(cohort ? { comparabilityCohort: cohort } : {}),
      rankingEligible,
      ...(work ? { workClassification: work } : {}),
    };
  });
}

const HUX1_COMMITS = new Set([
  '99cae97204ff9ef2b0cb00765ee648078d7872e7',
  '4a53620fe811a016cb9966fab53ca181a89159c8',
]);

const TIMELINE_SPECS = [
  {
    id: '2026-08-11-main',
    label: 'Aug 11',
    description: 'Upstream main after the first storm-focused optimization pass.',
    webRunFile: '2026-08-11T13-03-50-65160668d8d9-upstream-main-9b147781-featured.json',
    nativeRunFiles: [],
  },
  {
    id: '2026-08-12-main',
    label: 'Aug 12',
    description: 'Fast-storm main checkpoint before the later transport/runtime regressions.',
    webRunFile: '2026-08-12T18-02-55-65160668d8d9-upstream-main-6079a680-featured.json',
    nativeRunFiles: [],
  },
  {
    id: '2026-08-15-main',
    label: 'Aug 15',
    description: 'Runtime transition checkpoint; Web storms had already slowed, Native was five-entry.',
    webRunFile: '2026-08-15T18-26-24-65160668d8d9-latest-featured-upstream.json',
    nativeRunFiles: [
      '2026-08-15T17-27-13-lynx-native-android-aries_10-10-native-sandbox-android-final3-react.json',
      '2026-08-15T17-33-56-lynx-native-android-aries_10-10-native-sandbox-android-final-vue-vdom.json',
      '2026-08-15T17-39-24-lynx-native-android-aries_10-10-native-sandbox-android-final-vue-vdom-ifr-et.json',
      '2026-08-15T17-45-08-lynx-native-android-aries_10-10-native-sandbox-android-final-vue-vapor.json',
      '2026-08-15T17-50-38-lynx-native-android-aries_10-10-native-sandbox-android-final-vue-vapor-ifr.json',
    ],
    nativeObservationFiles: [
      '2026-08-15T20-37-10-lynx-native-android-aries_10-10-500bb13edb96-native-final-octane-upstream-native-table-verified.json',
      '2026-08-15T20-40-25-lynx-native-android-aries_10-10-500bb13edb96-native-final-octane-upstream-native-startup-verified.json',
    ],
  },
];

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
  const normalizedRecords = rawRun.records.map((record, index) => {
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
  const records = classifyComparability(rawRun, normalizedRecords);
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
  // Fail-closed DNF records remain visible in an exact snapshot, but cannot
  // make a run look broader or more complete during cohort selection.
  const featuredRecords = run.records.filter((r) =>
    featuredIds.has(r.entry) && isBenchmarkRecord(r) && isRankingEligible(r));
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
    && isComparisonVisible(record)
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
      const cohort = candidate.run.meta.receipt?.comparabilityCohort ?? 'legacy-unverified';
      const groupKey = `${candidate.run.meta.machine.id}|${environment}|${cohort}`;
      const group = groups.get(groupKey) ?? {
        machineId: candidate.run.meta.machine.id,
        environment,
        comparabilityCohort: cohort,
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

const timelineRecord = (run, file, record, comparisonKind) => {
  const sourceEntry = record.sourceEntry ?? record.entry;
  const entry = sourceEntry === 'octane-main' ? 'octane' : record.entry;
  return {
    ...annotate(run, file, { ...record, entry }, comparisonKind),
    ...(sourceEntry === entry ? {} : { sourceEntry }),
  };
};

const timelineMachine = (run, file) => ({
  ...run.meta.machine,
  latestCalibration: run.meta.calibration,
  latestRunFile: file,
  latestRunGeneratedAt: run.meta.generatedAt,
});

const buildTimelineSnapshots = ({ runs, featuredIds, current }) => {
  const byFile = new Map(runs.map((candidate) => [candidate.file, candidate]));
  const snapshots = [];
  for (const spec of TIMELINE_SPECS) {
    const web = byFile.get(spec.webRunFile);
    if (!web) continue;
    const webAuditSourceRecords = web.run.records
      .filter((record) => featuredIds.has(record.entry) && isPublishableRecord(web.run, record));
    const webRecords = webAuditSourceRecords
      .map((record) => timelineRecord(web.run, web.file, record, 'same-run'));
    const nativeSources = (spec.nativeRunFiles ?? []).map((file) => byFile.get(file)).filter(Boolean);
    const nativeRecords = nativeSources.flatMap((source) => source.run.records
      .filter((record) => featuredIds.has(record.entry)
        && isBenchmarkRecord(record)
        && isComparisonVisible(record)
        && isPublishableRecord(source.run, record))
      .map((record) => timelineRecord(source.run, source.file, record, 'same-machine')));
    const observationSources = (spec.nativeObservationFiles ?? [])
      .map((file) => byFile.get(file))
      .filter(Boolean);
    const nativeObservationRecords = observationSources.flatMap((source) => source.run.records
      .filter((record) => record.entry === 'octane'
        && isBenchmarkRecord(record)
        && isComparisonVisible(record)
        && isPublishableRecord(source.run, record))
      .map((record) => timelineRecord(source.run, source.file, record, 'isolated-observation')));
    const nativeObservationMachineIds = [...new Set(
      nativeObservationRecords.map((record) => record.machineId),
    )];
    const nativeObservations = nativeObservationRecords.length === 0 ? [] : [{
      entryId: 'octane',
      harness: 'native',
      environment: nativeObservationRecords[0].environment,
      generatedAt: observationSources.reduce((latest, source) =>
        latest == null || source.run.meta.generatedAt > latest
          ? source.run.meta.generatedAt
          : latest, null),
      machineId: nativeObservationMachineIds.length === 1 ? nativeObservationMachineIds[0] : null,
      sourceRunFile: observationSources.map((source) => source.file).join(', '),
      sourceRecordCount: nativeObservationRecords.length,
    }];
    const sourceCandidates = [web, ...nativeSources, ...observationSources];
    const snapshotMachines = Object.fromEntries(sourceCandidates.map((source) => [
      source.run.meta.machine.id,
      timelineMachine(source.run, source.file),
    ]));
    const nativeEntryIds = [...new Set(nativeRecords.map((record) => record.entry))].sort();
    const webEntryIds = [...new Set(webRecords
      .filter(isBenchmarkRecord)
      .map((record) => record.entry))].sort();
    const octaneCommit = web.run.meta.entryCommits?.octane
      ?? web.run.meta.entryCommits?.['octane-main']
      ?? null;
    const generatedAt = sourceCandidates.reduce((latest, source) =>
      latest == null || source.run.meta.generatedAt > latest
        ? source.run.meta.generatedAt
        : latest, null);
    snapshots.push({
      id: spec.id,
      label: spec.label,
      description: spec.description,
      generatedAt,
      octaneCommit,
      records: [...webRecords, ...nativeRecords],
      comparison: {
        runFile: web.file,
        generatedAt: web.run.meta.generatedAt,
        machineId: web.run.meta.machine.id,
        calibration: web.run.meta.calibration,
        entryIds: webEntryIds,
        sourceRecordCount: webRecords.filter(isBenchmarkRecord).length,
        recordCount: webRecords.length + nativeRecords.length,
        harnesses: [
          {
            harness: 'web',
            environment: webRecords[0]?.environment ?? null,
            generatedAt: web.run.meta.generatedAt,
            machineId: web.run.meta.machine.id,
            calibration: web.run.meta.calibration,
            sourceRunFiles: [web.file],
            entryIds: webEntryIds,
            sourceRecordCount: webRecords.filter(isBenchmarkRecord).length,
            recordCount: webRecords.length,
          },
          ...(nativeRecords.length ? [{
            harness: 'native',
            environment: nativeRecords[0].environment,
            generatedAt,
            machineId: nativeRecords[0].machineId,
            calibration: null,
            sourceRunFiles: nativeSources.map((source) => source.file),
            entryIds: nativeEntryIds,
            sourceRecordCount: nativeRecords.length,
            recordCount: nativeRecords.length,
          }] : []),
        ],
        labEstimates: [],
      },
      machines: snapshotMachines,
      nativeObservations,
      nativeObservationRecords,
    });
  }
  snapshots.push({
    id: 'current-main',
    label: 'Current',
    description: 'Current upstream main with the fresh six-framework Web and Native cohorts.',
    generatedAt: current.generatedAt,
    octaneCommit: current.octaneCommit,
    records: current.records,
    comparison: current.comparison,
    machines: current.machines,
    nativeObservations: current.nativeObservations,
    nativeObservationRecords: current.nativeObservationRecords,
  });
  return snapshots;
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
    .filter((r) => r.entry === entryId && isBenchmarkRecord(r) && isRankingEligible(r))
    .map(cellKey)).size;
  const currentCount = new Set(current.run.records
    .filter((r) => r.entry === entryId && isBenchmarkRecord(r) && isRankingEligible(r))
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
  const comparisonCohort = comparisonRun.run.meta.receipt?.comparabilityCohort ?? null;
  for (const entryId of labIds) {
    let source = null;
    for (const candidate of runs) {
      const candidateCohort = candidate.run.meta.receipt?.comparabilityCohort ?? null;
      if (candidateCohort !== comparisonCohort) continue;
      if (!candidate.run.records.some((r) =>
        r.entry === entryId && isBenchmarkRecord(r) && isRankingEligible(r))) continue;
      if (isBetterLabRun(candidate, source, entryId)) source = candidate;
    }
    if (!source) continue;
    const records = source.run.records.filter((r) =>
      r.entry === entryId && isBenchmarkRecord(r) && isRankingEligible(r));
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
  out.timelineSnapshots = buildTimelineSnapshots({
    runs,
    featuredIds,
    current: {
      generatedAt: out.generatedAt,
      octaneCommit: entryById.get('octane')?.provenance?.commit ?? null,
      records: comparisonRecords,
      comparison,
      machines,
      nativeObservations: out.nativeObservations,
      nativeObservationRecords: out.nativeObservationRecords,
    },
  });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 1));
  log(`[collect] ${runsSeen} runs → ${out.records.length} merged records; comparison=${comparison.runFile} (${comparison.entryIds.length} web entries, ${nativeComparison?.entryIds.length ?? 0} native entries, ${comparison.recordCount} records) + ${nativeObservations.observations.length} isolated Native observations + ${labEstimates.length} calibrated Lab entries → ${path.relative(root, outPath)}`);
  return out;
}
