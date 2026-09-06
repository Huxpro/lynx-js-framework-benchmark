function finitePositive(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${label} must be a finite number greater than zero.`);
  }
  return value;
}

function percentile(values, probability) {
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const fraction = position - lower;
  return (
    sorted[lower] +
    (sorted[Math.min(lower + 1, sorted.length - 1)] - sorted[lower]) * fraction
  );
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function weightedGeomean(values, weights) {
  const denominator = weights.reduce((sum, weight) => sum + weight, 0);
  return Math.exp(
    values.reduce(
      (sum, value, index) => sum + weights[index] * Math.log(value),
      0,
    ) / denominator,
  );
}

function interval(values, confidence) {
  const tail = (1 - confidence) / 2;
  return {
    lower: percentile(values, tail),
    upper: percentile(values, 1 - tail),
  };
}

/**
 * Candidate/comparator qualification with the session as the resampling unit.
 * Every bootstrap draw keeps all cells and both arms from one physical window
 * together, so a fast or slow host interval cannot be split across entries.
 */
export function qualifyPairedScorecard({
  pairs,
  cells,
  minimumPairs = 10,
  resamples = 10000,
  confidence = 0.95,
  seed = 0x28200291,
  strictWinUpperRatio = 1,
  engineeringPointRatio = 0.95,
  coreCellNonInferiorityUpperRatio = 1.05,
  orderBalanceMaximumDifference = 1,
}) {
  if (!Array.isArray(pairs) || pairs.length < minimumPairs) {
    throw new Error(
      `qualification requires at least ${minimumPairs} independent AB/BA pairs.`,
    );
  }
  if (!Array.isArray(cells) || cells.length === 0) {
    throw new Error(
      'qualification requires at least one frozen scorecard cell.',
    );
  }
  if (!Number.isSafeInteger(resamples) || resamples < 1000) {
    throw new Error(
      'qualification requires at least 1,000 bootstrap resamples.',
    );
  }
  finitePositive(confidence, 'confidence');
  if (confidence >= 1) throw new TypeError('confidence must be less than one.');

  const cellKeys = cells.map((cell) => cell.key);
  if (new Set(cellKeys).size !== cellKeys.length) {
    throw new Error('scorecard cell keys must be unique.');
  }
  const weights = cells.map((cell) =>
    finitePositive(cell.weight, `${cell.key} weight`),
  );
  const orderCounts = { AB: 0, BA: 0 };
  const sessions = new Set();
  const ratios = pairs.map((pair, pairIndex) => {
    if (typeof pair.session !== 'string' || pair.session.length === 0) {
      throw new Error(
        `pair ${pairIndex} requires a non-empty session identity.`,
      );
    }
    if (sessions.has(pair.session)) {
      throw new Error(
        `pair session ${JSON.stringify(pair.session)} is duplicated.`,
      );
    }
    sessions.add(pair.session);
    if (!Object.hasOwn(orderCounts, pair.order)) {
      throw new Error(
        `pair ${pairIndex} has invalid order ${JSON.stringify(pair.order)}.`,
      );
    }
    orderCounts[pair.order]++;
    return cells.map((cell) => {
      const sample = pair.cells?.[cell.key];
      const candidate = finitePositive(
        sample?.candidate,
        `pair ${pairIndex} ${cell.key} candidate`,
      );
      const comparator = finitePositive(
        sample?.comparator,
        `pair ${pairIndex} ${cell.key} comparator`,
      );
      return candidate / comparator;
    });
  });
  if (
    Math.abs(orderCounts.AB - orderCounts.BA) > orderBalanceMaximumDifference
  ) {
    throw new Error(
      `AB/BA order is imbalanced (${orderCounts.AB}/${orderCounts.BA}); maximum difference is ${orderBalanceMaximumDifference}.`,
    );
  }

  const aggregateSamples = ratios.map((values) =>
    weightedGeomean(values, weights),
  );
  const point = weightedGeomean(
    aggregateSamples,
    aggregateSamples.map(() => 1),
  );
  const cellPoints = cellKeys.map((_, cellIndex) =>
    weightedGeomean(
      ratios.map((values) => values[cellIndex]),
      ratios.map(() => 1),
    ),
  );
  const random = mulberry32(seed);
  const aggregateBootstrap = [];
  const cellBootstrap = cellKeys.map(() => []);
  for (let draw = 0; draw < resamples; draw++) {
    const indices = Array.from({ length: pairs.length }, () =>
      Math.floor(random() * pairs.length),
    );
    aggregateBootstrap.push(
      weightedGeomean(
        indices.map((index) => aggregateSamples[index]),
        indices.map(() => 1),
      ),
    );
    for (let cellIndex = 0; cellIndex < cellKeys.length; cellIndex++) {
      cellBootstrap[cellIndex].push(
        weightedGeomean(
          indices.map((index) => ratios[index][cellIndex]),
          indices.map(() => 1),
        ),
      );
    }
  }
  const aggregateInterval = interval(aggregateBootstrap, confidence);
  const cellResults = Object.fromEntries(
    cellKeys.map((key, index) => {
      const cellInterval = interval(cellBootstrap[index], confidence);
      return [
        key,
        {
          point: cellPoints[index],
          ...cellInterval,
          nonInferior: cellInterval.upper <= coreCellNonInferiorityUpperRatio,
        },
      ];
    }),
  );
  return {
    pairCount: pairs.length,
    orderCounts,
    aggregate: {
      point,
      ...aggregateInterval,
      strictWin: aggregateInterval.upper < strictWinUpperRatio,
      engineeringTarget: point <= engineeringPointRatio,
    },
    cells: cellResults,
    pass:
      aggregateInterval.upper < strictWinUpperRatio &&
      point <= engineeringPointRatio &&
      Object.values(cellResults).every((cell) => cell.nonInferior),
  };
}
