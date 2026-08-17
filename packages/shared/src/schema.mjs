// Result record schema (v2 of the unified-benchmark lineage). One flat record
// per (entry × workload × scale × metric); a comparison between two records is
// valid only when every COMPARABILITY_KEY agrees.
//
// Source-of-truth rule:
// - formal repeated observations live losslessly in `attempts`
// - legacy repeated observations live in `samples`
// - one-shot observations live in `value`
// - DNF observations live in `dnfCount`
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
];

export const BOUNDARIES = {
  latency: 'pointerdown-to-dom-predicate',
  fcp: 'view-attach-to-first-content',
  settled: 'view-attach-to-dom-settled',
  btsCpu: 'sampled-js-cpu-background-realm',
  mtsCpu: 'sampled-js-cpu-ui-thread',
  wire: 'web-core-rpc-channel',
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

export function validateAttempts(attempts, label = 'attempts') {
  if (!Array.isArray(attempts)) throw new Error(`${label} must be an array`);
  return attempts.map((attempt, index) => {
    if (!attempt || typeof attempt !== 'object' || Array.isArray(attempt)) {
      throw new Error(`${label}[${index}] must be an object`);
    }
    const keys = Object.keys(attempt).sort();
    if (JSON.stringify(keys) !== JSON.stringify(['dnf', 'errorKind', 'index', 'value'])) {
      throw new Error(`${label}[${index}] has invalid keys`);
    }
    if (attempt.index !== index) {
      throw new Error(`${label} indices must be contiguous from zero`);
    }
    if (typeof attempt.dnf !== 'boolean') {
      throw new Error(`${label}[${index}].dnf must be boolean`);
    }
    if (attempt.dnf) {
      if (attempt.value !== null) {
        throw new Error(`${label}[${index}] DNF value must be null`);
      }
      if (typeof attempt.errorKind !== 'string' || attempt.errorKind.length === 0) {
        throw new Error(`${label}[${index}] DNF errorKind must be non-empty`);
      }
    } else {
      if (typeof attempt.value !== 'number' || !Number.isFinite(attempt.value)) {
        throw new Error(`${label}[${index}] success value must be finite`);
      }
      if (attempt.errorKind !== null) {
        throw new Error(`${label}[${index}] success errorKind must be null`);
      }
    }
    return { ...attempt };
  });
}

/** Recompute every statistical/display derivative from a record's source observations. */
export function deriveRecord(record) {
  const attempts = record.attempts == null
    ? null
    : validateAttempts(record.attempts, 'record.attempts');
  const explicitValue = typeof record.value === 'number' && Number.isFinite(record.value)
    ? record.value
    : null;
  const inferredLegacyValue = explicitValue == null ? legacyValue(record) : null;
  const value = explicitValue ?? inferredLegacyValue;
  const observations = attempts
    ? attempts.filter(({ dnf }) => !dnf).map(({ value: attemptValue }) => attemptValue)
    : Array.isArray(record.samples)
    ? record.samples
    : value == null ? [] : [value];
  const stat = summarize(observations);
  const derived = {
    ...record,
    ...(attempts ? {
      attempts,
      samples: observations,
      dnfCount: attempts.filter(({ dnf }) => dnf).length,
      detailSamples: null,
    } : {}),
  };
  for (const field of STAT_FIELDS) derived[field] = stat?.[field] ?? null;
  derived.n = stat?.n ?? 0;
  if (inferredLegacyValue != null && !Object.hasOwn(record, 'value')) derived.value = inferredLegacyValue;

  const detail = attempts
    ? null
    : nearestMedianDetail(record.samples, record.detailSamples, stat?.median ?? null);
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
  attempts = null,
}) {
  if (!suite || !entry || !workload || !metric || !boundary || !unit) {
    throw new Error(`incomplete record: ${JSON.stringify({ suite, entry, workload, metric, boundary, unit })}`);
  }
  return deriveRecord({
    suite,
    harness,
    environment,
    entry,
    workload,
    scale,
    metric,
    boundary,
    unit,
    value,
    samples,
    detailSamples,
    detail,
    dnfCount,
    attempts,
  });
}

export function comparisonKey(record) {
  return COMPARABILITY_KEYS.map((k) => String(record[k])).join('|');
}

export function canonicalMetricKey(record, variant) {
  if (variant !== 'vapor' && variant !== 'ifr') {
    throw new Error(`invalid metric variant: ${variant}`);
  }
  return JSON.stringify([
    variant,
    record.suite,
    record.harness,
    record.environment,
    record.workload,
    record.scale,
    record.metric,
    record.boundary,
    record.unit,
  ]);
}
