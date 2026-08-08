// Result record schema (v2 of the unified-benchmark lineage). One flat record
// per (entry × workload × scale × metric); a comparison between two records is
// valid only when every COMPARABILITY_KEY agrees.

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
  stat = null,
  value = null,
  samples = null,
  detail = null,
  dnfCount = 0,
}) {
  if (!suite || !entry || !workload || !metric || !boundary || !unit) {
    throw new Error(`incomplete record: ${JSON.stringify({ suite, entry, workload, metric, boundary, unit })}`);
  }
  return {
    suite,
    harness,
    environment,
    entry,
    workload,
    scale,
    metric,
    boundary,
    unit,
    n: stat?.n ?? (value != null ? 1 : 0),
    median: stat?.median ?? value,
    mean: stat?.mean ?? value,
    std: stat?.std ?? null,
    min: stat?.min ?? value,
    p95: stat?.p95 ?? null,
    ci95: stat?.ci95 ?? null,
    samples,
    detail,
    dnfCount,
  };
}

export function comparisonKey(record) {
  return COMPARABILITY_KEYS.map((k) => String(record[k])).join('|');
}
