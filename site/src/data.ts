// Data layer. The site build regenerates results/latest.json from immutable
// run observations first; entry manifests are discovered automatically.
import latest from '../../results/latest.json';

export interface StormDetail {
  contractVersion?: number;
  commitPolicy?: 'every-tick' | 'final-state';
  ticks?: number;
  tickIntervalMs?: number;
  scheduleToleranceMs?: number;
  mutationWidth?: Record<string, unknown>;
  observation?: Record<string, unknown>;
  action?: Record<string, unknown>;
  actualIssueOffsetsMs?: number[];
  transitions?: { atMs: number; state: unknown; issuedTicks: number }[];
  finalState?: unknown;
  expectedFinalState?: unknown;
}

export interface BenchRecord {
  suite: string;
  harness: string;
  environment: string;
  entry: string;
  workload: string;
  scale: number;
  metric: string;
  boundary: string;
  unit: string;
  n: number;
  median: number | null;
  mean: number | null;
  std: number | null;
  min: number | null;
  p95: number | null;
  ci95: number | null;
  max?: number | null;
  value?: number | null;
  samples: number[] | null;
  detail: ({
    byName?: Record<string, { messages: number; bytes: number }>;
    requestedRows?: number;
    committedRows?: number;
    callMultiset?: Record<string, number>;
    surfaceNames?: string[];
  } & StormDetail) | null;
  detailSamples?: ({
    byName?: Record<string, { messages: number; bytes: number }>;
    requestedRows?: number;
    committedRows?: number;
    callMultiset?: Record<string, number>;
    surfaceNames?: string[];
  } & StormDetail)[] | null;
  detailKind?: 'sample-nearest-median' | 'legacy-last-sample' | null;
  dnfCount: number;
  attemptedCount?: number;
  acceptedCount?: number;
  failures?: {
    rep: number;
    category?: string;
    phase?: string;
    timeoutMs?: number;
    triggerMode?: string;
    message?: string;
    evidence?: Record<string, unknown>;
  }[];
  machineId: string | null;
  runFile: string | null;
  runGeneratedAt: string | null;
  calibration: { probeVersion: number; score: number } | null;
  entryCommit: string | null;
  comparisonKind: 'same-run' | 'same-machine' | 'isolated-observation' | 'calibrated-estimate' | 'historical' | 'historical-replay' | 'archive' | 'derived-static';
  comparabilityStatus?: 'comparable' | 'legacy-unverified' | 'legacy-complete-work' | 'incompatible-sampling' | 'incompatible-controls' | 'incomplete-work' | 'unverified-work' | 'contract-failed';
  comparabilityReasons?: string[];
  comparabilityCohort?: string | null;
  rankingEligible?: boolean;
  descriptiveEligible?: boolean;
  contractVersion?: number | string | null;
  commitPolicy?: 'every-tick' | 'final-state' | null;
  derivedFrom?: { kind: string; metrics: string[] };
  artifact?: {
    path: string;
    sha256: string;
    flavor: 'web' | 'lynx';
    section: 'whole-artifact' | 'lepusCode.root';
  };
  workClassification?: {
    status: 'complete' | 'incomplete' | 'unverified';
    expectedSequentialCommits: number;
    observed: Record<string, unknown> | null;
  };
  pipelineControl?: {
    status: 'controlled' | 'invalid' | 'incomplete';
    reason?: string;
    requestedRows?: number;
    committedRows?: number;
    callMultiset?: Record<string, number>;
    surfaceNames?: string[];
  };
  stormControl?: StormDetail & {
    status: 'controlled' | 'invalid' | 'incomplete' | 'contract-failed';
    reason?: string;
    passedSamples?: number;
    observedSamples?: number;
  };
  sourceEntry?: string;
  sourceMedian?: number | null;
  targetCalibration?: { probeVersion: number; score: number };
  calibrationRatio?: number | null;
}

export interface Machine {
  id: string;
  hostname?: string;
  platform: string;
  arch?: string;
  cpuModel: string;
  cores: number;
  memGB?: number;
  node: string | null;
  latestCalibration?: { probeVersion: number; score: number } | null;
  latestRunFile?: string;
  latestRunGeneratedAt?: string;
}

export interface ComparisonRun {
  runFile: string;
  generatedAt: string;
  machineId: string;
  calibration: { probeVersion: number; score: number };
  entryIds: string[];
  sourceRecordCount: number;
  recordCount: number;
  harnesses: {
    harness: string;
    environment: string | null;
    generatedAt: string;
    machineId: string;
    calibration: { probeVersion: number; score: number } | null;
    sourceRunFiles: string[];
    entryIds: string[];
    sourceRecordCount: number;
    recordCount: number;
    cohortIdentity?: string;
    campaign?: NativeCampaign;
    coverage?: Record<NativeCoverageStatus, number>;
  }[];
  labEstimates: {
    entryId: string;
    sourceRunFile: string;
    sourceGeneratedAt: string;
    sourceMachineId: string;
    sourceCalibration: { probeVersion: number; score: number };
    targetCalibration: { probeVersion: number; score: number };
    calibrationRatio: number | null;
    sourceRecordCount: number;
    recordCount: number;
  }[];
}

export type NativeCoverageStatus =
  | 'measured'
  | 'measured-with-dnf'
  | 'dnf'
  | 'unsupported'
  | 'unscheduled'
  | 'invalid-incomparable'
  | 'display-derivation-bug';

export interface NativeCampaign {
  version: string;
  id: string;
  label: string | null;
  matrixContractSha256: string;
  inputReceiptSha256: string;
  resolvedMatrix: {
    suites: string[];
    cases: string[];
    scales: number[];
    startupScales: number[];
    reps: number;
    startupReps: number;
  };
  runtimePolicy: Record<string, string | number>;
}

export interface NativeCoverageCell {
  entry: string;
  suite: string;
  workload: string;
  scale: number;
  metric: string;
  unit: string;
  boundary: string;
  key: string;
  status: NativeCoverageStatus;
  reason: string | null;
  record: {
    n: number;
    dnfCount: number;
    median: number | null;
    boundary: string;
    unit: string;
    runFile: string | null;
    machineId: string | null;
    failureCategories: string[];
  } | null;
}

export interface NativeCoverage {
  version: string;
  contractSha256: string;
  expectedCellCount: number;
  sourceRunFiles: Record<'web' | 'native', string[]>;
  entryIds: string[];
  summary: Partial<Record<NativeCoverageStatus, number>>;
  cells: NativeCoverageCell[];
}

export type PipelineCoverageStatus =
  | 'measured'
  | 'measured-with-dnf'
  | 'dnf'
  | 'unscheduled'
  | 'invalid-incomparable'
  | 'display-derivation-bug';

export interface PipelineCoverageCell {
  entry: string;
  suite: 'pipeline';
  harness: 'web';
  workload: string;
  scale: number;
  metric: 'operationTime';
  unit: 'ms';
  boundary: string;
  key: string;
  status: PipelineCoverageStatus;
  reason: string | null;
  record: {
    n: number;
    dnfCount: number;
    attemptedCount: number | null;
    acceptedCount: number | null;
    median: number | null;
    runFile: string | null;
    machineId: string | null;
    failureCategories: string[];
  } | null;
}

export interface PipelineCoverage {
  version: string;
  contractSha256: string;
  expectedCellCount: number;
  entryIds: string[];
  summary: Partial<Record<PipelineCoverageStatus, number>>;
  cells: PipelineCoverageCell[];
}

export type ListCoverageStatus =
  | 'measured'
  | 'dnf'
  | 'unsupported'
  | 'unscheduled'
  | 'invalid-incomparable';

export interface ListCoverageCell {
  entry: string;
  harness: 'web' | 'native';
  workload: 'list-startup' | 'list-recycle' | 'list-fling';
  scale: number;
  key: string;
  status: ListCoverageStatus;
  reason: string | null;
  recordCount: number;
  fixture: {
    kind: 'entry-manifest' | 'entry-manifest-and-artifact';
    declared: boolean;
    protocol?: string | null;
    contractSha256?: string | null;
    bundle?: string;
    sha256?: string;
    actualSha256?: string;
  };
  sourceMetrics: string[];
  derivedMetrics: string[];
}

export interface ListCoverage {
  version: string;
  contractSha256: string;
  fixtureProtocol: string;
  config: {
    viewport: { widthPx: number; heightPx: number };
    row: { estimatedHeightPx: number; itemKey: string };
    buffer: { leadingRows: number; trailingRows: number };
    recycle: { distancePx: number; repetitions: number };
    fling: { velocityPxPerSecond: number; durationMs: number };
    observation: { web: string; native: string };
    input: Record<'web' | 'native', { recycle: string; fling: string }>;
    semantics: { materializedCell: string; blankFrame: string };
  };
  entryIds: string[];
  expectedCellCount: number;
  summary: Partial<Record<ListCoverageStatus, number>>;
  cells: ListCoverageCell[];
}

export interface NativeObservation {
  entryId: string;
  harness: 'native';
  environment: string;
  generatedAt: string;
  machineId: string;
  sourceRunFile: string;
  sourceRecordCount: number;
}

export interface TimelineSnapshot {
  id: string;
  label: string;
  description: string;
  generatedAt: string;
  identityPointers: HistoryIdentityPointer[];
  records: BenchRecord[];
  comparison: ComparisonRun;
  machines: Record<string, Machine>;
  nativeObservations: NativeObservation[];
  nativeObservationRecords: BenchRecord[];
  nativeCoverage: NativeCoverage;
  pipelineCoverage: PipelineCoverage;
  listCoverage: ListCoverage;
}

export interface HistoryTransportEvidence {
  comparable: boolean;
  issue: 'incomplete-storm-transport' | 'missing-storm-transport-evidence' | null;
  expectedSequentialCommits: number;
  toMtsMessages: number | null;
  toBtsMessages: number | null;
}

export interface HistoryRecord extends BenchRecord {
  cohortId: string;
  rankEligible: boolean;
  transport?: HistoryTransportEvidence;
}

export interface HistoryCohort {
  harness: string;
  environment: string | null;
  machineId: string;
  sourceRunFiles: string[];
  entryIds: string[];
  rankEligible: boolean;
}

export interface EntryConfiguration {
  summary: string;
  href: string;
}

export interface HistoryIdentityPointer {
  entryId: string;
  sourceEntryId: string;
  label: string;
  framework: string | null;
  version: string | null;
  commit: string | null;
  source: string | null;
  ref: string | null;
  href: string | null;
  channel: string | null;
  config: string | null;
  configuration: EntryConfiguration | null;
}

export interface HistoryCheckpoint {
  id: string;
  generatedAt: string;
  label: string;
  description: string;
  identityPointers: HistoryIdentityPointer[];
  current?: boolean;
  activeRecordIndexes: number[];
  sourceIndexes: number[];
  harnesses: HistoryCohort[];
  nativeCoverage?: NativeCoverage;
  pipelineCoverage?: PipelineCoverage;
  listCoverage?: ListCoverage;
}

export interface HistorySource {
  runFile: string;
  generatedAt: string;
  machineId: string;
  harnesses: string[];
  environments: string[];
  entryIds: string[];
  entryCommits: Record<string, string>;
  machine: Machine;
  calibration: { probeVersion: number; score: number } | null;
  sourceRecordCount: number;
  historyRecordCount: number;
  rankEligible: boolean;
  reason: string;
}

export interface HistoryReplayCheckpoint {
  checkpointId: string;
  activeRecordIndexes: number[];
  entryIds: string[];
  sourceByEntry: Record<string, string>;
}

export interface HistoryReplay {
  id: string;
  label: string;
  description: string;
  runFile: string;
  generatedAt: string;
  machineId: string;
  machine: Machine;
  calibration: { probeVersion: number; score: number } | null;
  minimumReps: number;
  cellKeys: string[];
  records: HistoryRecord[];
  checkpoints: HistoryReplayCheckpoint[];
}

export interface BenchmarkHistory {
  records: HistoryRecord[];
  sources: HistorySource[];
  checkpoints: HistoryCheckpoint[];
  replays: HistoryReplay[];
}

export interface EntryMeta {
  id: string;
  label: string;
  framework: string;
  frameworkVersion: string;
  config: string;
  historyChannel?: string;
  supersededBy?: string;
  configuration?: EntryConfiguration;
  tags: string[];
  /** featured = default public view; lab = calibrated author-development
   * variants; archive = source evidence that never enters a public cohort. */
  tier?: 'featured' | 'lab' | 'archive';
  /** Harnesses this public entry is eligible to run in. Omitted means both. */
  harnesses?: ('web' | 'native')[];
  listFixture?: {
    protocol: string;
    contractSha256: string;
    bundles: Partial<Record<'web' | 'native', string>>;
    sha256: Partial<Record<'web' | 'native', string>>;
  };
  color: string;
  presentation: { order: number; colorLight: string; colorDark: string };
  provenance: { source: string; ref: string; commit: string; buildCommand: string };
}

// Featured charts use one physical run. Opt-in Lab records are historical and
// explicitly tagged; millisecond values are calibrated to that run's probe.
const collected = latest as unknown as {
  comparisonRecords: BenchRecord[];
  labComparisonRecords: BenchRecord[];
  nativeObservations: NativeObservation[];
  nativeObservationRecords: BenchRecord[];
  nativeCoverage: NativeCoverage;
  pipelineCoverage: PipelineCoverage;
  listCoverage: ListCoverage;
  history: BenchmarkHistory;
};
export const BENCHMARK_HISTORY = collected.history;
const EMPTY_NATIVE_COVERAGE: NativeCoverage = {
  version: 'history-no-native-data',
  contractSha256: '',
  expectedCellCount: 0,
  sourceRunFiles: { web: [], native: [] },
  entryIds: [],
  summary: {},
  cells: [],
};
const EMPTY_PIPELINE_COVERAGE: PipelineCoverage = {
  version: 'history-no-pipeline-data',
  contractSha256: '',
  expectedCellCount: 0,
  entryIds: [],
  summary: {},
  cells: [],
};
const EMPTY_LIST_COVERAGE: ListCoverage = {
  version: 'history-no-list-contract',
  contractSha256: '',
  fixtureProtocol: '',
  config: {
    viewport: { widthPx: 0, heightPx: 0 },
    row: { estimatedHeightPx: 0, itemKey: '' },
    buffer: { leadingRows: 0, trailingRows: 0 },
    recycle: { distancePx: 0, repetitions: 0 },
    fling: { velocityPxPerSecond: 0, durationMs: 0 },
    observation: { web: '', native: '' },
    input: {
      web: { recycle: '', fling: '' },
      native: { recycle: '', fling: '' },
    },
    semantics: { materializedCell: '', blankFrame: '' },
  },
  entryIds: [],
  expectedCellCount: 0,
  summary: {},
  cells: [],
};
export function historyRecordsForCheckpoint(checkpoint: HistoryCheckpoint): HistoryRecord[] {
  return checkpoint.activeRecordIndexes.map((index) => BENCHMARK_HISTORY.records[index]);
}
export function historyReplayRecordsForCheckpoint(
  replay: HistoryReplay,
  checkpoint: HistoryCheckpoint,
): HistoryRecord[] {
  const replayCheckpoint = replay.checkpoints.find((item) =>
    item.checkpointId === checkpoint.id);
  return replayCheckpoint?.activeRecordIndexes.map((index) => replay.records[index]) ?? [];
}
export const TIMELINE_SNAPSHOTS: TimelineSnapshot[] = BENCHMARK_HISTORY.checkpoints.map((checkpoint) => {
  // Incomparable observations stay in historyRecordsForCheckpoint() for the
  // evidence chart, but comparison consumers see a real gap rather than a
  // deceptively fast value.
  const records = historyRecordsForCheckpoint(checkpoint)
    .filter((record) => record.rankEligible !== false
      || record.descriptiveEligible === true
      || (record.comparabilityStatus === 'incomplete-work'
        && record.n === 0
        && record.dnfCount > 0)) as BenchRecord[];
  const harnesses = checkpoint.harnesses.map((cohort) => ({
    harness: cohort.harness,
    environment: cohort.environment,
    generatedAt: checkpoint.generatedAt,
    machineId: cohort.machineId,
    calibration: null,
    sourceRunFiles: cohort.sourceRunFiles,
    entryIds: cohort.entryIds,
    sourceRecordCount: records.filter((record) => record.harness === cohort.harness).length,
    recordCount: records.filter((record) => record.harness === cohort.harness).length,
  }));
  const sources = checkpoint.sourceIndexes.map((index) => BENCHMARK_HISTORY.sources[index]);
  const machines = Object.fromEntries(sources.map((source) => [source.machineId, {
    ...source.machine,
    latestCalibration: source.calibration,
    latestRunFile: source.runFile,
    latestRunGeneratedAt: source.generatedAt,
  }]));
  return {
    id: checkpoint.id,
    label: checkpoint.label,
    description: checkpoint.description,
    generatedAt: checkpoint.generatedAt,
    identityPointers: checkpoint.identityPointers,
    records,
    comparison: {
      runFile: checkpoint.harnesses[0]?.sourceRunFiles[0] ?? '',
      generatedAt: checkpoint.generatedAt,
      machineId: checkpoint.harnesses[0]?.machineId ?? '',
      calibration: sources[0]?.calibration ?? { probeVersion: 0, score: 0 },
      entryIds: [...new Set(checkpoint.harnesses.flatMap((cohort) => cohort.entryIds))].sort(),
      sourceRecordCount: records.length,
      recordCount: records.length,
      harnesses,
      labEstimates: checkpoint.current ? (latest as unknown as { comparison: ComparisonRun }).comparison.labEstimates : [],
    },
    machines,
    nativeObservations: [],
    nativeObservationRecords: [],
    nativeCoverage: checkpoint.nativeCoverage ?? EMPTY_NATIVE_COVERAGE,
    pipelineCoverage: checkpoint.pipelineCoverage ?? EMPTY_PIPELINE_COVERAGE,
    listCoverage: checkpoint.listCoverage ?? EMPTY_LIST_COVERAGE,
  };
});

const manifestModules = import.meta.glob('../../entries/*/entry.json', {
  eager: true,
  import: 'default',
}) as Record<string, EntryMeta>;

// Entry identity, membership and colors come from manifests. New entries are
// picked up without touching site code; order is deterministic presentation.
export const ENTRIES: (EntryMeta & { colorLight: string; colorDark: string })[] =
  Object.values(manifestModules)
    .sort((a, b) => a.presentation.order - b.presentation.order || a.label.localeCompare(b.label))
    .map((entry) => ({
      ...entry,
      colorLight: entry.presentation.colorLight,
      colorDark: entry.presentation.colorDark,
    }));

export const FEATURED_IDS = ENTRIES.filter((e) => e.tier === 'featured').map((e) => e.id);

export const ENTRY_BY_ID = new Map(ENTRIES.map((e) => [e.id, e]));

export function entrySupportsHarness(entry: EntryMeta, harness: string): boolean {
  return entry.harnesses == null || entry.harnesses.includes(harness as 'web' | 'native');
}

export function entryColor(id: string, theme: 'light' | 'dark'): string {
  const e = ENTRY_BY_ID.get(id);
  if (!e) return theme === 'dark' ? '#c3c2b7' : '#6b6a63';
  return theme === 'dark' ? e.colorDark : e.colorLight;
}

/** Short label for bars ("ReactLynx 0.122" → "ReactLynx"). */
export function shortLabel(id: string): string {
  const label = ENTRY_BY_ID.get(id)?.label ?? id;
  return label.replace(/\s+[\d.]+.*$/, '').trim() || label;
}

export interface RecordFilter {
  suite?: string;
  harness?: string;
  entry?: string;
  workload?: string;
  scale?: number;
  metric?: string;
  environment?: string;
  boundary?: string;
  unit?: string;
  contractVersion?: number;
  commitPolicy?: 'every-tick' | 'final-state';
}

export function filterRecords(records: BenchRecord[], filter: RecordFilter): BenchRecord[] {
  return records.filter((r) =>
    (r.rankingEligible !== false
      || r.descriptiveEligible === true
      || (r.comparabilityStatus === 'incomplete-work' && r.n === 0 && r.dnfCount > 0))
    && (filter.suite == null || r.suite === filter.suite)
    && (filter.harness == null || r.harness === filter.harness)
    && (filter.entry == null || r.entry === filter.entry)
    && (filter.workload == null || r.workload === filter.workload)
    && (filter.scale == null || r.scale === filter.scale)
    && (filter.metric == null || r.metric === filter.metric)
    && (filter.environment == null || r.environment === filter.environment)
    && (filter.boundary == null || r.boundary === filter.boundary)
    && (filter.unit == null || r.unit === filter.unit)
    && (filter.contractVersion == null || r.contractVersion === filter.contractVersion)
    && (filter.commitPolicy == null || r.commitPolicy === filter.commitPolicy),
  );
}

export function oneFrom(records: BenchRecord[], filter: RecordFilter): BenchRecord | null {
  const rs = filterRecords(records, filter);
  if (rs.length > 1) {
    throw new Error(`ambiguous benchmark record (${rs.length} matches): ${JSON.stringify(filter)}`);
  }
  return rs.length ? rs[0] : null;
}

export function workloadScalesFrom(
  records: BenchRecord[],
  filter: Omit<RecordFilter, 'scale'>,
): number[] {
  return [...new Set(filterRecords(records, filter).map((r) => r.scale))].sort((a, b) => a - b);
}

export const fmtMs = (v: number | null): string => {
  if (v == null) return '—';
  if (v >= 10000) return `${(v / 1000).toFixed(1)}s`;
  if (v >= 100) return `${Math.round(v)}ms`;
  if (v >= 10) return `${v.toFixed(1)}ms`;
  return `${v.toFixed(2)}ms`;
};

export const fmtBytes = (v: number | null): string => {
  if (v == null) return '—';
  if (v >= 1024 * 1024) return `${(v / 1024 / 1024).toFixed(2)} MB`;
  if (v >= 1024) return `${(v / 1024).toFixed(1)} kB`;
  return `${Math.round(v)} B`;
};

export const fmtX = (v: number | null): string => {
  if (v == null) return '—';
  if (v >= 100) return `${Math.round(v)}×`;
  if (v >= 10) return `${v.toFixed(0)}×`;
  if (v >= 2) return `${v.toFixed(1)}×`;
  return `${v.toFixed(2)}×`;
};

export const fmtCount = (v: number | null): string => {
  if (v == null) return '—';
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(Math.round(v));
};
