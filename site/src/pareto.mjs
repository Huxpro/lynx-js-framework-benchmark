const finitePoint = (point) => Number.isFinite(point?.bytes) && Number.isFinite(point?.fcp);

export const DEFAULT_PARETO_WEB_REGIME = Object.freeze({
  jsRegime: 'jit',
  jsFlags: '--expose-gc',
  cpuThrottle: 1,
});

export function paretoRegimeKey(record) {
  if (record?.harness !== 'web') return record?.harness ?? 'unknown';
  const jsRegime = record.jsRegime ?? DEFAULT_PARETO_WEB_REGIME.jsRegime;
  const jsFlags = record.jsFlags ?? DEFAULT_PARETO_WEB_REGIME.jsFlags;
  const cpuThrottle = record.cpuThrottle ?? DEFAULT_PARETO_WEB_REGIME.cpuThrottle;
  return `web:${jsRegime}:${jsFlags}:${cpuThrottle}`;
}

export function paretoRegimeRecords(records, harness = 'web') {
  const expected = harness === 'web'
    ? `web:${DEFAULT_PARETO_WEB_REGIME.jsRegime}:${DEFAULT_PARETO_WEB_REGIME.jsFlags}:${DEFAULT_PARETO_WEB_REGIME.cpuThrottle}`
    : harness;
  return records.filter((record) =>
    record?.harness === harness && paretoRegimeKey(record) === expected);
}

function assertSingleRegime(points) {
  const regimes = new Set(points.map((point) => point.regimeKey ?? 'legacy-default'));
  if (regimes.size > 1) {
    throw new Error(`Pareto frontier cannot mix regimes: ${[...regimes].sort().join(', ')}`);
  }
}

/** Lower is better on both axes. Exact coordinate ties remain co-frontier. */
export function paretoFrontier(points) {
  const valid = points.filter(finitePoint);
  assertSingleRegime(valid);
  return valid.filter((point) => !valid.some((candidate) =>
    candidate !== point
    && candidate.bytes <= point.bytes
    && candidate.fcp <= point.fcp
    && (candidate.bytes < point.bytes || candidate.fcp < point.fcp)));
}

/** Plot one deterministic path even when multiple entries share one coordinate. */
export function paretoLine(points) {
  const unique = new Map();
  for (const point of paretoFrontier(points)) {
    unique.set(`${point.bytes}|${point.fcp}`, point);
  }
  return [...unique.values()].sort((left, right) =>
    left.bytes - right.bytes || right.fcp - left.fcp || String(left.entry).localeCompare(String(right.entry)));
}
