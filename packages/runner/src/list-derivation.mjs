import { BOUNDARIES, deriveRecord } from '../../shared/src/schema.mjs';

const groupKey = (record) => [
  record.entry,
  record.harness,
  record.environment,
  record.workload,
  record.scale,
  record.contractVersion,
  record.comparabilityCohort,
  record.machineId,
  record.runFile,
].join('|');

function percentile(values, probability) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function derivedRecord(base, {
  metric, boundary, unit, samples = null, value = null, derivedFrom,
}) {
  const record = deriveRecord({
    ...base,
    metric,
    boundary,
    unit,
    samples,
    value,
    detailSamples: null,
    detail: null,
    dnfCount: 0,
    failures: [],
    rankingEligible: false,
    descriptiveEligible: true,
    derivedFrom: { kind: 'collector-list-derivation', metrics: derivedFrom },
  });
  return record;
}

function alignedRatio(numerator, denominator, label, multiplier = 1) {
  if (!Array.isArray(numerator?.samples) || !Array.isArray(denominator?.samples)
    || numerator.samples.length !== denominator.samples.length) {
    throw new Error(`${label} list source samples are not aligned`);
  }
  return numerator.samples.map((value, index) => {
    const divisor = denominator.samples[index];
    if (!Number.isFinite(value) || !Number.isFinite(divisor) || divisor <= 0) {
      throw new Error(`${label} list source contains a non-finite value or zero divisor`);
    }
    return value * multiplier / divisor;
  });
}

export function deriveListRecords(sourceRecords) {
  const groups = new Map();
  for (const record of sourceRecords.filter((candidate) => candidate.suite === 'list')) {
    const key = groupKey(record);
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  const out = [];
  for (const records of groups.values()) {
    const byMetric = new Map(records.map((record) => [record.metric, record]));
    const base = records[0];
    if (base.workload === 'list-recycle') {
      const recycled = byMetric.get('recycledCells');
      for (const spec of [
        ['operationTimeMs', 'timePerRecycledCellMs', BOUNDARIES.listRecyclePerCell, 'ms/cell'],
        ['wireToMtsBytes', 'wireToMtsBytesPerCell', BOUNDARIES.listRecyclePerCell, 'bytes/cell'],
        ['wireToBtsBytes', 'wireToBtsBytesPerCell', BOUNDARIES.listRecyclePerCell, 'bytes/cell'],
      ]) {
        const [sourceMetric, metric, boundary, unit] = spec;
        const source = byMetric.get(sourceMetric);
        if (source == null || recycled == null) continue;
        out.push(derivedRecord(source, {
          metric, boundary, unit,
          samples: alignedRatio(source, recycled, metric),
          derivedFrom: [sourceMetric, 'recycledCells'],
        }));
      }
    }
    if (base.workload === 'list-fling') {
      const elapsed = byMetric.get('elapsedMs');
      const materialized = byMetric.get('materializedCells');
      if (elapsed != null && materialized != null) {
        out.push(derivedRecord(materialized, {
          metric: 'materializedCellsPerSecond',
          boundary: BOUNDARIES.listFlingRate,
          unit: 'cells/s',
          samples: alignedRatio(materialized, elapsed, 'materializedCellsPerSecond', 1000),
          derivedFrom: ['materializedCells', 'elapsedMs'],
        }));
      }
      const timings = byMetric.get('materializationTimesMs');
      if (Array.isArray(timings?.samples) && timings.samples.length > 0) {
        for (const [metric, probability] of [
          ['materializationP50Ms', 0.5],
          ['materializationP99Ms', 0.99],
        ]) out.push(derivedRecord(timings, {
          metric,
          boundary: BOUNDARIES.listMaterializationDistribution,
          unit: 'ms',
          value: percentile(timings.samples, probability),
          derivedFrom: ['materializationTimesMs'],
        }));
      }
    }
  }
  return out;
}
