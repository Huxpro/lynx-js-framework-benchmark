function errorKind(error) {
  const text = String(error?.message ?? error).toLowerCase();
  if (text.includes('timeout')) return 'timeout';
  if (text.includes('unsupported')) return 'unsupported';
  return 'error';
}

export function successfulAttempt(index, value) {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new Error('attempt index must be a non-negative safe integer');
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('successful attempt value must be finite');
  }
  return { index, value, dnf: false, errorKind: null };
}

export function dnfAttempt(index, kind) {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new Error('attempt index must be a non-negative safe integer');
  }
  if (typeof kind !== 'string' || kind.length === 0) {
    throw new Error('DNF error kind must be non-empty');
  }
  return { index, value: null, dnf: true, errorKind: kind };
}

export function attemptFromError(index, error) {
  return dnfAttempt(index, errorKind(error));
}

export function alignedMetricAttempts(observations, metric, {
  authority = 'latency',
  missingKind = 'missing-metric',
} = {}) {
  return observations.map((observation, index) => {
    if (observation.dnf) return dnfAttempt(index, observation.errorKind);
    const value = observation.values?.[metric];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return successfulAttempt(index, value);
    }
    if (metric === authority) {
      throw new Error(`authority metric ${metric} is missing at attempt ${index}`);
    }
    return dnfAttempt(index, missingKind);
  });
}
