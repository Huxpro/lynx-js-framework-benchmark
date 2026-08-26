// Result record schema (v2 of the unified-benchmark lineage). One flat record
// per (entry × workload × scale × metric); a comparison between two records is
// valid only when every COMPARABILITY_KEY agrees.
//
// Source-of-truth rule:
// - repeated observations live in `samples`
// - one-shot observations live in `value`
// - DNF observations live in `dnfCount`
// - structured DNF evidence lives in `failures`
// - wire endpoint observations live in `detailSamples`
//
// n/median/mean/std/min/max/p95/ci95 and `detail` are materialized derivatives.
// They are emitted for convenient inspection, but every downstream consumer
// must call deriveRecord() instead of trusting a stored snapshot.

import { summarize } from './stats.mjs';

export const SCHEMA_VERSION = 2;

export const COMPARABILITY_KEYS = [
  'harness',
  'environment',
  'workload',
  'scale',
  'metric',
  'boundary',
  'unit',
  'contractVersion',
  'commitPolicy',
  'comparabilityCohort',
];

export const BOUNDARIES = {
  latency: 'pointerdown-to-dom-predicate',
  fcp: 'view-attach-to-first-content',
  settled: 'view-attach-to-dom-settled',
  btsCpu: 'sampled-js-cpu-background-realm',
  mtsCpu: 'sampled-js-cpu-ui-thread',
  wire: 'web-core-rpc-channel',
  pipelineOperation: 'pipeline-page-pointerdown-to-dom-predicate',
  pipelineResidual: 'pipeline-operation-minus-synchronous-element-papi-self-time',
  papiSelfTime: 'synchronous-element-papi-host-boundary-self-time',
  papiCalls: 'synchronous-element-papi-host-boundary-call-count',
  stormOperation: 'storm-first-pointerdown-to-terminal-observed-frame',
  stormInput: 'storm-real-pointer-input-schedule',
  stormCommits: 'storm-raf-observable-state-transition-count',
  stormContract: 'storm-observed-commit-contract-outcome',
  stormCoalescing: 'storm-committed-frames-divided-by-issued-ticks',
  stormPerTick: 'storm-total-divided-by-issued-ticks',
  listRecyclePerCell: 'list-one-viewport-scroll-total-divided-by-recycled-cells',
  listFlingRate: 'list-fixed-velocity-fling-materialized-cells-divided-by-elapsed',
  listMaterializationDistribution: 'list-visible-cell-materialization-distribution',
  bundle: 'static',
};

const STAT_FIELDS = ['n', 'median', 'mean', 'std', 'min', 'max', 'p95', 'ci95'];

function legacyValue(record) {
  // v2 records written before `value` existed stored one-shot observations in
  // the statistic fields. Keep them readable without making those fields
  // authoritative for records that have raw samples.
  return record.samples == null
    && record.n === 1
    && typeof record.median === 'number'
    && Number.isFinite(record.median)
    ? record.median
    : null;
}

function nearestMedianDetail(samples, detailSamples, median) {
  if (!Array.isArray(samples) || !Array.isArray(detailSamples) || median == null) return null;
  let best = null;
  for (let i = 0; i < Math.min(samples.length, detailSamples.length); i++) {
    if (!Number.isFinite(samples[i]) || detailSamples[i] == null) continue;
    const distance = Math.abs(samples[i] - median);
    if (best == null || distance < best.distance) best = { distance, detail: detailSamples[i] };
  }
  return best?.detail ?? null;
}

/** Recompute every statistical/display derivative from a record's source observations. */
export function deriveRecord(record) {
  const explicitValue = typeof record.value === 'number' && Number.isFinite(record.value)
    ? record.value
    : null;
  const inferredLegacyValue = explicitValue == null ? legacyValue(record) : null;
  const value = explicitValue ?? inferredLegacyValue;
  const observations = Array.isArray(record.samples)
    ? record.samples
    : value == null ? [] : [value];
  const stat = summarize(observations);
  const derived = { ...record };
  for (const field of STAT_FIELDS) derived[field] = stat?.[field] ?? null;
  derived.n = stat?.n ?? 0;
  if (inferredLegacyValue != null && !Object.hasOwn(record, 'value')) derived.value = inferredLegacyValue;

  const detail = nearestMedianDetail(record.samples, record.detailSamples, stat?.median ?? null);
  if (detail != null) {
    derived.detail = detail;
    derived.detailKind = 'sample-nearest-median';
  } else if (record.detail != null) {
    // Old source files retained only the final endpoint sample. Preserve it as
    // explicitly labelled legacy source data; never present it as an aggregate.
    derived.detail = record.detail;
    derived.detailKind = record.detailKind ?? 'legacy-last-sample';
  } else {
    derived.detail = null;
    derived.detailKind = null;
  }
  return derived;
}

export function makeRecord({
  suite,
  harness = 'web',
  environment = 'lynx-for-web',
  entry,
  workload,
  scale,
  metric,
  boundary,
  unit,
  value = null,
  samples = null,
  detailSamples = null,
  detail = null,
  dnfCount = 0,
  failures = [],
  attemptedCount = null,
  acceptedCount = null,
  contractVersion = null,
  commitPolicy = null,
}) {
  if (!suite || !entry || !workload || !metric || !boundary || !unit) {
    throw new Error(`incomplete record: ${JSON.stringify({ suite, entry, workload, metric, boundary, unit })}`);
  }
  const record = {
    suite,
    harness,
    environment,
    entry,
    workload,
    scale,
    contractVersion,
    commitPolicy,
    metric,
    boundary,
    unit,
    comparabilityCohort: null,
    value,
    samples,
    detailSamples,
    detail,
    dnfCount,
    failures,
  };
  if (attemptedCount != null) record.attemptedCount = attemptedCount;
  if (acceptedCount != null) record.acceptedCount = acceptedCount;
  return deriveRecord(record);
}

export function comparisonKey(record) {
  // Optional prospective dimensions normalize to null so legacy records that
  // predate a field remain comparable to modern records that explicitly emit
  // the neutral value.
  return COMPARABILITY_KEYS.map((k) => String(record[k] ?? null)).join('|');
}
