// Data layer: results/latest.json + entries/*/entry.json are imported at
// build time so the site can never drift from the repo's numbers.
import latest from '../../results/latest.json';

import octaneDomManifest from '../../entries/octane-dom/entry.json';
import octaneHux1Manifest from '../../entries/octane-hux1/entry.json';
import octaneHux2Manifest from '../../entries/octane-hux2/entry.json';
import octanePriorManifest from '../../entries/octane-prior/entry.json';
import octaneManifest from '../../entries/octane/entry.json';
import reactManifest from '../../entries/react/entry.json';
import vueVaporManifest from '../../entries/vue-vapor/entry.json';
import vueVaporIfrManifest from '../../entries/vue-vapor-ifr/entry.json';
import vueVdomManifest from '../../entries/vue-vdom/entry.json';
import vueVdomIfrEtManifest from '../../entries/vue-vdom-ifr-et/entry.json';

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
  samples: number[] | null;
  detail: { byName?: Record<string, { messages: number; bytes: number }> } | null;
  dnfCount: number;
  machineId: string;
  runFile: string;
  runGeneratedAt: string;
  calibration: { probeVersion: number; score: number };
  entryCommit: string | null;
  comparisonKind: 'same-run' | 'calibrated-estimate' | 'historical' | 'archive';
  sourceEntry?: string;
  sourceMedian?: number | null;
  targetCalibration?: { probeVersion: number; score: number };
  calibrationRatio?: number | null;
}

export interface Machine {
  id: string;
  hostname: string;
  platform: string;
  arch: string;
  cpuModel: string;
  cores: number;
  node: string;
  latestCalibration: { probeVersion: number; score: number };
  latestRunFile: string;
  latestRunGeneratedAt: string;
}

export interface ComparisonRun {
  runFile: string;
  generatedAt: string;
  machineId: string;
  calibration: { probeVersion: number; score: number };
  entryIds: string[];
  recordCount: number;
  labEstimates: {
    entryId: string;
    sourceRunFile: string;
    sourceGeneratedAt: string;
    sourceMachineId: string;
    sourceCalibration: { probeVersion: number; score: number };
    targetCalibration: { probeVersion: number; score: number };
    calibrationRatio: number | null;
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

// Fixed entry order = legend order. Featured entries occupy the CVD-validated
// categorical slots (validated adjacency order — don't reorder casually);
// color follows the entity on every chart on every page. Lab entries (same
// framework, different version/PR/flags) wear an ordinal lightness step of
// their framework's hue — identity is carried by direct labels + tables (the
// relief rule), since arbitrary lab permutations cannot be adjacency-validated
// by construction.
export const ENTRIES: (EntryMeta & { colorLight: string; colorDark: string })[] = [
  { ...(reactManifest as EntryMeta), colorLight: '#2a78d6', colorDark: '#3987e5' },
  { ...(octaneManifest as EntryMeta), colorLight: '#eb6834', colorDark: '#d95926' },
  { ...(vueVdomManifest as EntryMeta), colorLight: '#1baf7a', colorDark: '#199e70' },
  { ...(vueVdomIfrEtManifest as EntryMeta), colorLight: '#eda100', colorDark: '#c98500' },
  { ...(vueVaporManifest as EntryMeta), colorLight: '#e87ba4', colorDark: '#d55181' },
  { ...(vueVaporIfrManifest as EntryMeta), colorLight: '#008300', colorDark: '#008300' },
  // lab: octane family ramp (darker step of the octane orange)
  { ...(octanePriorManifest as EntryMeta), colorLight: '#bd4c18', colorDark: '#f59e72' },
  { ...(octaneHux1Manifest as EntryMeta), colorLight: '#9f3c0d', colorDark: '#ffaf87' },
  { ...(octaneHux2Manifest as EntryMeta), colorLight: '#702a08', colorDark: '#ffc09f' },
  { ...(octaneDomManifest as EntryMeta), colorLight: '#4f1d05', colorDark: '#ffd6bf' },
];

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
}

export function select(filter: RecordFilter): BenchRecord[] {
  return RECORDS.filter((r) =>
    (filter.suite == null || r.suite === filter.suite)
    && (filter.harness == null || r.harness === filter.harness)
    && (filter.entry == null || r.entry === filter.entry)
    && (filter.workload == null || r.workload === filter.workload)
    && (filter.scale == null || r.scale === filter.scale)
    && (filter.metric == null || r.metric === filter.metric),
  );
}

export function one(filter: RecordFilter): BenchRecord | null {
  const rs = select(filter);
  return rs.length ? rs[0] : null;
}

export const HARNESSES = [...new Set(RECORDS.map((r) => r.harness))];

export function workloadScales(suite: string, workload: string): number[] {
  return [...new Set(select({ suite, workload }).map((r) => r.scale))].sort((a, b) => a - b);
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
