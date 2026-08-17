const valid = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;

export function geomean(values) {
  const clean = values.filter(valid);
  if (!clean.length) return null;
  return Math.exp(clean.reduce((sum, value) => sum + Math.log(value), 0) / clean.length);
}

/** Score entries over one identical, complete set of cells. */
export function completeEntryScores(ids, cells) {
  const completeIds = ids.filter((id) => cells.length > 0
    && cells.every((cell) => valid(cell.values[id])));
  const ratios = new Map(completeIds.map((id) => [id, []]));
  for (const cell of cells) {
    const fastest = Math.min(...completeIds.map((id) => cell.values[id]));
    for (const id of completeIds) ratios.get(id).push(cell.values[id] / fastest);
  }
  return {
    scores: completeIds.map((id) => ({ id, value: geomean(ratios.get(id)) })),
    missing: ids.filter((id) => !completeIds.includes(id)),
    cellCount: cells.length,
  };
}

/** Geomeans over rows that are complete for every selected entry. */
export function completeRowGeomeans(ids, cells, baselineId = null) {
  if (!ids.length) return { values: new Map(), rowCount: 0 };
  const complete = cells.filter((cell) => {
    if (!ids.every((id) => valid(cell.values[id]))) return false;
    return baselineId == null || valid(cell.values[baselineId]);
  });
  const ratios = new Map(ids.map((id) => [id, []]));
  for (const cell of complete) {
    const baseline = baselineId == null
      ? Math.min(...ids.map((id) => cell.values[id]))
      : cell.values[baselineId];
    for (const id of ids) ratios.get(id).push(cell.values[id] / baseline);
  }
  return {
    values: new Map(ids.map((id) => [id, geomean(ratios.get(id))])),
    rowCount: complete.length,
  };
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
    .filter((record) => record?.rankEligible !== false && valid(record?.median)) : [];
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
    else if (!cohortEligible || eligible.length < 2) status = 'observation';
    else if (record.dnfCount > 0 && !valid(record.median)) status = 'dnf';
    else if (record.rankEligible === false) status = 'incomparable';
    else if (!valid(record.median)) status = 'missing';
    return { entry, record, rank: status === 'ranked' ? ranks.get(entry) ?? null : null, status };
  });
}
