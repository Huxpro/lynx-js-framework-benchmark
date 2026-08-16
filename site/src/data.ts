// Data layer. The site build regenerates results/latest.json from immutable
// run observations first; entry manifests are discovered automatically.
import latest from '../../results/latest.json';

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
  detail: { byName?: Record<string, { messages: number; bytes: number }> } | null;
  detailSamples?: { byName?: Record<string, { messages: number; bytes: number }> }[] | null;
  detailKind?: 'sample-nearest-median' | 'legacy-last-sample' | null;
  dnfCount: number;
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
  comparisonKind: 'same-run' | 'same-machine' | 'calibrated-estimate' | 'historical' | 'archive' | 'derived-static';
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
  latestCalibration: { probeVersion: number; score: number } | null;
  latestRunFile: string;
  latestRunGeneratedAt: string;
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

export interface EntryMeta {
  id: string;
  label: string;
  framework: string;
  frameworkVersion: string;
  config: string;
  tags: string[];
  /** featured = default public view; lab = author-development variants
   * (versions/PRs/permutations), hidden until Lab mode is on. */
  tier?: 'featured' | 'lab';
  color: string;
  presentation: { order: number; colorLight: string; colorDark: string };
  provenance: { source: string; ref: string; commit: string; buildCommand: string };
}

// Featured charts use one physical run. Opt-in Lab records are historical and
// explicitly tagged; millisecond values are calibrated to that run's probe.
const collected = latest as {
  comparisonRecords: BenchRecord[];
  labComparisonRecords: BenchRecord[];
};
export const RECORDS = [...collected.comparisonRecords, ...collected.labComparisonRecords];
export const MACHINES = (latest as { machines: Record<string, Machine> }).machines;
export const COMPARISON = (latest as { comparison: ComparisonRun }).comparison;
export const GENERATED_AT = (latest as { generatedAt: string }).generatedAt;

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

export const FEATURED_IDS = ENTRIES.filter((e) => e.tier !== 'lab').map((e) => e.id);
export const LAB_IDS = ENTRIES.filter((e) => e.tier === 'lab').map((e) => e.id);
export const CALIBRATED_LAB_IDS = new Set(COMPARISON.labEstimates.map((e) => e.entryId));

export const ENTRY_BY_ID = new Map(ENTRIES.map((e) => [e.id, e]));

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
}

export function select(filter: RecordFilter): BenchRecord[] {
  return RECORDS.filter((r) =>
    (filter.suite == null || r.suite === filter.suite)
    && (filter.harness == null || r.harness === filter.harness)
    && (filter.entry == null || r.entry === filter.entry)
    && (filter.workload == null || r.workload === filter.workload)
    && (filter.scale == null || r.scale === filter.scale)
    && (filter.metric == null || r.metric === filter.metric)
    && (filter.environment == null || r.environment === filter.environment)
    && (filter.boundary == null || r.boundary === filter.boundary)
    && (filter.unit == null || r.unit === filter.unit),
  );
}

export function one(filter: RecordFilter): BenchRecord | null {
  const rs = select(filter);
  if (rs.length > 1) {
    throw new Error(`ambiguous benchmark record (${rs.length} matches): ${JSON.stringify(filter)}`);
  }
  return rs.length ? rs[0] : null;
}

export const HARNESSES = [...new Set(RECORDS.map((r) => r.harness))];

export function workloadScales(filter: Omit<RecordFilter, 'scale'>): number[] {
  return [...new Set(select(filter).map((r) => r.scale))].sort((a, b) => a - b);
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
