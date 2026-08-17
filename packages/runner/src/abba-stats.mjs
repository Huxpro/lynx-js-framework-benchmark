import crypto from 'node:crypto';

export const BOOTSTRAP_REPLICATES = 50000;
export const BOOTSTRAP_BASE_SEED = '0x5eed5eed';

export function mean(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function quantileR7(values, probability) {
  if (!Array.isArray(values) || values.length === 0) return null;
  if (probability < 0 || probability > 1) throw new Error('probability must be in [0,1]');
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 1) return sorted[0];
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const fraction = index - lower;
  return sorted[lower] + fraction * (sorted[Math.min(lower + 1, sorted.length - 1)] - sorted[lower]);
}

export function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function keySeed(comparisonId, canonicalKey) {
  const digest = crypto.createHash('sha256')
    .update(`${BOOTSTRAP_BASE_SEED}\0${comparisonId}\0${canonicalKey}`)
    .digest();
  return digest.readUInt32BE(0);
}

function finiteRatio(numerator, denominator) {
  if (denominator === 0 && numerator === 0) return 1;
  if (denominator === 0) return Number.POSITIVE_INFINITY;
  if (numerator === 0) return 0;
  return numerator / denominator;
}

function encodedRatio(value) {
  if (value === Number.POSITIVE_INFINITY) return 'infinite-regression';
  if (value === 0) return 0;
  return value;
}

function logRatio(numerator, denominator) {
  const ratio = finiteRatio(numerator, denominator);
  if (ratio === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
  if (ratio === 0) return Number.NEGATIVE_INFINITY;
  return Math.log(ratio);
}

function combinedRatio(forwardLogs, reverseLogs) {
  const forward = mean(forwardLogs);
  const reverse = mean(reverseLogs);
  if (forward === Number.POSITIVE_INFINITY || reverse === Number.POSITIVE_INFINITY) {
    return Number.POSITIVE_INFINITY;
  }
  if (forward === Number.NEGATIVE_INFINITY || reverse === Number.NEGATIVE_INFINITY) {
    return 0;
  }
  return Math.exp((forward + reverse) / 2);
}

function sampleMean(values, random) {
  let sum = 0;
  for (let index = 0; index < values.length; index++) {
    sum += values[Math.floor(random() * values.length)];
  }
  return sum / values.length;
}

export function pairedAbbaStatistics({
  a1,
  b1,
  b2,
  a2,
  comparisonId,
  canonicalKey,
  replicates = BOOTSTRAP_REPLICATES,
}) {
  const lengths = new Set([a1.length, b1.length, b2.length, a2.length]);
  if (lengths.size !== 1 || a1.length === 0) {
    throw new Error('ABBA attempt strata must have one equal non-zero length');
  }
  const forwardRatios = b1.map((value, index) => finiteRatio(value, a1[index]));
  const reverseRatios = b2.map((value, index) => finiteRatio(value, a2[index]));
  const forwardLogs = b1.map((value, index) => logRatio(value, a1[index]))
    .sort((left, right) => left - right);
  const reverseLogs = b2.map((value, index) => logRatio(value, a2[index]))
    .sort((left, right) => left - right);
  const ratio = combinedRatio(forwardLogs, reverseLogs);
  let ci95;
  if (Number.isFinite(ratio) && ratio > 0) {
    const allLogs = [...forwardLogs, ...reverseLogs];
    if (allLogs.every((value) => value === allLogs[0])) {
      ci95 = [ratio, ratio];
    } else {
      const random = mulberry32(keySeed(comparisonId, canonicalKey));
      const strata = [forwardLogs, reverseLogs]
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
      const bootstrap = new Array(replicates);
      for (let index = 0; index < replicates; index++) {
        bootstrap[index] = Math.exp((
          sampleMean(strata[0], random) + sampleMean(strata[1], random)
        ) / 2);
      }
      ci95 = [quantileR7(bootstrap, 0.025), quantileR7(bootstrap, 0.975)];
    }
  } else {
    ci95 = null;
  }
  const forwardMean = mean(forwardLogs);
  const reverseMean = mean(reverseLogs);
  const forwardRatio = forwardMean === Number.POSITIVE_INFINITY
    ? Number.POSITIVE_INFINITY
    : forwardMean === Number.NEGATIVE_INFINITY ? 0 : Math.exp(forwardMean);
  const reverseRatio = reverseMean === Number.POSITIVE_INFINITY
    ? Number.POSITIVE_INFINITY
    : reverseMean === Number.NEGATIVE_INFINITY ? 0 : Math.exp(reverseMean);
  const forwardDirection = forwardRatio === 1 ? 0 : forwardRatio > 1 ? 1 : -1;
  const reverseDirection = reverseRatio === 1 ? 0 : reverseRatio > 1 ? 1 : -1;
  return {
    ratio: encodedRatio(ratio),
    ci95,
    forwardRatio: encodedRatio(forwardRatio),
    reverseRatio: encodedRatio(reverseRatio),
    sameDirection: forwardDirection === reverseDirection,
    spreadPct: Number.isFinite(forwardRatio) && Number.isFinite(reverseRatio)
      ? Math.abs(forwardRatio - reverseRatio) * 100
      : null,
    drift: {
      a: encodedRatio(finiteRatio(mean(a2), mean(a1))),
      b: encodedRatio(finiteRatio(mean(b2), mean(b1))),
    },
    quantiles: {
      a1: [quantileR7(a1, 0.5), quantileR7(a1, 0.95)],
      b1: [quantileR7(b1, 0.5), quantileR7(b1, 0.95)],
      b2: [quantileR7(b2, 0.5), quantileR7(b2, 0.95)],
      a2: [quantileR7(a2, 0.5), quantileR7(a2, 0.95)],
      forward: [quantileR7(forwardRatios, 0.5), quantileR7(forwardRatios, 0.95)],
      reverse: [quantileR7(reverseRatios, 0.5), quantileR7(reverseRatios, 0.95)],
    },
  };
}

export function practicalThreshold(record) {
  if (record.suite === 'bundle') return null;
  if (record.metric === 'latency' || record.metric === 'fcp' || record.metric === 'settled') {
    return 0.03;
  }
  if (record.metric.includes('Cpu')) return 0.05;
  return 0.05;
}

export function confirmedEffect(stats, threshold) {
  if (threshold == null || !stats.sameDirection) return false;
  if (stats.ratio === 'infinite-regression') return true;
  if (typeof stats.ratio !== 'number' || stats.ci95 == null) return false;
  const practical = Math.abs(stats.ratio - 1) >= threshold;
  const excludesOne = stats.ci95[1] < 1 || stats.ci95[0] > 1;
  return practical && excludesOne;
}
