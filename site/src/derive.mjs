import {
  NATIVE_CAPACITY_ANDROID_ART_GLOBAL_REF_FAILURE_CATEGORY as ANDROID_ART_CATEGORY,
} from '../../packages/shared/src/native-diagnostic-contract.mjs';

export const NATIVE_CAPACITY_ANDROID_ART_GLOBAL_REF_FAILURE_CATEGORY =
  ANDROID_ART_CATEGORY;

const valid = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;
const reportable = (record) => record?.reportability?.status !== 'not-reportable';

export function nativeOutcomeState(record) {
  if (record == null) return 'absent';
  if (record.measurementStatus === 'not-measured') return 'not-measured';
  const categories = new Set((record.failures ?? []).map((failure) => failure.category));
  if (record.reportability?.status === 'not-reportable' && (record.acceptedCount ?? 0) > 0) {
    return 'not-reportable';
  }
  if (categories.has(NATIVE_CAPACITY_ANDROID_ART_GLOBAL_REF_FAILURE_CATEGORY)) return 'capacity';
  if (categories.has('timeout')) return 'timeout';
  if (categories.has('process-failure')) return 'process-failure';
  if (record.reportability?.status === 'not-reportable') return 'not-reportable';
  if ((record.dnfCount ?? 0) > 0 && record.median == null) return 'dnf';
  return 'measured';
}

export function geomean(values) {
  const clean = values.filter(valid);
  if (!clean.length) return null;
  return Math.exp(clean.reduce((sum, value) => sum + Math.log(value), 0) / clean.length);
}

export function weightedGeomean(values, weights) {
  if (values.length !== weights.length || values.length === 0) return null;
  if (!values.every(valid) || !weights.every(valid)) return null;
  const weight = weights.reduce((sum, value) => sum + value, 0);
  return Math.exp(values.reduce(
    (sum, value, index) => sum + weights[index] * Math.log(value),
    0,
  ) / weight);
}

/** Score entries over one identical, complete set of cells. */
export function completeEntryScores(ids, cells, weights = cells.map(() => 1)) {
  if (weights.length !== cells.length || !weights.every(valid)) {
    throw new Error('completeEntryScores requires one positive weight per cell');
  }
  const completeIds = ids.filter((id) => cells.length > 0
    && cells.every((cell) => valid(cell.values[id])));
  const ratios = new Map(completeIds.map((id) => [id, []]));
  for (const cell of cells) {
    const fastest = Math.min(...completeIds.map((id) => cell.values[id]));
    for (const id of completeIds) ratios.get(id).push(cell.values[id] / fastest);
  }
  return {
    scores: completeIds.map((id) => ({ id, value: weightedGeomean(ratios.get(id), weights) })),
    missing: ids.filter((id) => !completeIds.includes(id)),
    cellCount: cells.length,
  };
}

/** Re-express complete formula scores relative to one selected entry. The
 * formula's complete input matrix stays unchanged; only its display baseline
 * changes. A missing baseline makes the whole comparison unavailable. */
export function rebaseEntryScores(ids, scores, baselineId) {
  if (baselineId === 'fastest') return new Map(scores);
  const baseline = scores.get(baselineId);
  return new Map(ids.map((id) => {
    const value = scores.get(id);
    return [id, valid(value) && valid(baseline) ? value / baseline : null];
  }));
}

export function slopeFit(points) {
  const pts = points.filter(([x, y]) => x > 0 && y > 0)
    .map(([x, y]) => [Math.log10(x), Math.log10(y)]);
  if (pts.length < 2) return null;
  const n = pts.length;
  const sx = pts.reduce((sum, point) => sum + point[0], 0);
  const sy = pts.reduce((sum, point) => sum + point[1], 0);
  const sxx = pts.reduce((sum, point) => sum + point[0] * point[0], 0);
  const sxy = pts.reduce((sum, point) => sum + point[0] * point[1], 0);
  const denominator = n * sxx - sx * sx;
  if (Math.abs(denominator) < 1e-12) return null;
  return (n * sxy - sx * sy) / denominator;
}

/** Rank one exact cell. Cohort eligibility is checkpoint-level; record
 * eligibility captures cell-level comparability (for example storm transport). */
export function rankHistoryCell(entryIds, records, cohortEligible = true) {
  const byEntry = new Map(records.map((record) => [record.entry, record]));
  const eligible = cohortEligible ? entryIds.map((entry) => byEntry.get(entry))
    .filter((record) => reportable(record)
      && record?.rankEligible !== false && valid(record?.median)) : [];
  eligible.sort((a, b) => a.median - b.median || a.entry.localeCompare(b.entry));
  const ranks = new Map();
  let priorValue = null;
  let priorRank = 0;
  eligible.forEach((record, index) => {
    const rank = priorValue === record.median ? priorRank : index + 1;
    ranks.set(record.entry, rank);
    priorValue = record.median;
    priorRank = rank;
  });
  return entryIds.map((entry) => {
    const record = byEntry.get(entry) ?? null;
    let status = 'ranked';
    if (!record) status = 'missing';
    else if (!reportable(record)) status = 'observation';
    else if (!cohortEligible || eligible.length < 2) status = 'observation';
    else if (record.dnfCount > 0 && !valid(record.median)) status = 'dnf';
    else if (record.rankEligible === false) status = 'incomparable';
    else if (!valid(record.median)) status = 'missing';
    return { entry, record, rank: status === 'ranked' ? ranks.get(entry) ?? null : null, status };
  });
}

/** Keep only aggregate cells measured comparably for every entry in one
 * checkpoint. This lets historical formulas use the largest complete matrix
 * available in that era without giving any entry a different denominator. */
export function completeHistoryAggregateCells(entryIds, cells) {
  return cells.filter((cell) => entryIds.every((entry) => {
    const record = cell.records.find((candidate) => candidate.entry === entry);
    return reportable(record) && record?.rankEligible !== false && valid(record?.median);
  }));
}

/** Rank a complete matrix of cells without pretending it is one raw record.
 * Each cell is normalized to its fastest eligible entry, then the per-entry
 * score is the unweighted geometric mean of those ratios. */
export function rankHistoryAggregate(
  entryIds,
  cells,
  cohortEligible = true,
  weights = cells.map(() => 1),
) {
  const recordsByCell = cells.map((cell) => ({
    key: cell.key,
    byEntry: new Map(cell.records.map((record) => [record.entry, record])),
  }));
  const recordsFor = (entry) => recordsByCell.map((cell) => cell.byEntry.get(entry) ?? null);
  const completeIds = entryIds.filter((entry) => {
    const records = recordsFor(entry);
    return records.length > 0
      && records.every((record) => reportable(record)
        && record?.rankEligible !== false && valid(record?.median));
  });
  const score = completeEntryScores(completeIds, recordsByCell.map((cell) => ({
    key: cell.key,
    values: Object.fromEntries(completeIds.map((entry) => [entry, cell.byEntry.get(entry)?.median])),
  })), weights);
  const scoreByEntry = new Map(score.scores.map(({ id, value }) => [id, value]));
  const ranked = cohortEligible && completeIds.length >= 2
    ? score.scores.slice().sort((a, b) => a.value - b.value || a.id.localeCompare(b.id))
    : [];
  const ranks = new Map();
  let priorValue = null;
  let priorRank = 0;
  ranked.forEach(({ id, value }, index) => {
    const rank = priorValue === value ? priorRank : index + 1;
    ranks.set(id, rank);
    priorValue = value;
    priorRank = rank;
  });

  return entryIds.map((entry) => {
    const records = recordsFor(entry);
    const present = records.filter(Boolean);
    let status = 'ranked';
    if (present.length !== records.length || records.length === 0) status = 'missing';
    else if (records.some((record) => !reportable(record))) status = 'observation';
    else if (!cohortEligible || completeIds.length < 2) status = 'observation';
    else if (records.some((record) => record.dnfCount > 0 && !valid(record.median))) status = 'dnf';
    else if (records.some((record) => record.rankEligible === false)) status = 'incomparable';
    else if (!records.every((record) => valid(record.median))) status = 'missing';
    return {
      entry,
      records: present,
      value: status === 'ranked' ? scoreByEntry.get(entry) ?? null : null,
      rank: status === 'ranked' ? ranks.get(entry) ?? null : null,
      status,
      cellCount: cells.length,
    };
  });
}
