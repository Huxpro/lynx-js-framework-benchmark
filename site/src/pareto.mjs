const finitePoint = (point) => Number.isFinite(point?.bytes) && Number.isFinite(point?.fcp);

/** Lower is better on both axes. Exact coordinate ties remain co-frontier. */
export function paretoFrontier(points) {
  const valid = points.filter(finitePoint);
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
