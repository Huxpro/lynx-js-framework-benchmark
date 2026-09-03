import {
  DEFAULT_MIN_ACCEPTED_SAMPLES,
  NATIVE_CAPACITY_ANDROID_ART_GLOBAL_REF_FAILURE_CATEGORY,
  NATIVE_CAPACITY_CONTRACT_VERSION,
  NATIVE_CAPACITY_FIXTURE_ROLE,
  NATIVE_CAPACITY_OUTCOME_PROTOCOL,
  NATIVE_CAPACITY_SUITE,
  REPORTABILITY_PROTOCOL,
} from '@lynx-bench/shared/native-diagnostic-contract';

const CLIENT_ID = /\bclientId:\s*\S+/g;

export {
  DEFAULT_MIN_ACCEPTED_SAMPLES,
  NATIVE_CAPACITY_OUTCOME_PROTOCOL,
  REPORTABILITY_PROTOCOL,
};

const CAPACITY_FAILURE_CATEGORIES = new Set([
  NATIVE_CAPACITY_ANDROID_ART_GLOBAL_REF_FAILURE_CATEGORY,
  'timeout',
  'process-failure',
]);
const STAT_FIELDS = ['median', 'mean', 'std', 'min', 'max', 'p95', 'ci95'];

export function redactResultString(value) {
  return value.replace(CLIENT_ID, 'clientId: [redacted]');
}

export function redactCommandArgv(argv) {
  if (!Array.isArray(argv)) throw new Error('result argv must be an array.');
  const redacted = [];
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--lease-receipt') {
      redacted.push(argument);
      if (index + 1 < argv.length) {
        redacted.push('[redacted]');
        index++;
      }
    } else if (typeof argument === 'string' && argument.startsWith('--lease-receipt=')) {
      redacted.push('--lease-receipt=[redacted]');
    } else {
      redacted.push(argument);
    }
  }
  return redacted;
}

function isRecord(value) {
  return value != null
    && typeof value === 'object'
    && typeof value.suite === 'string'
    && typeof value.entry === 'string'
    && typeof value.metric === 'string';
}

function integer(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${label} must be a safe integer >= ${minimum}.`);
  }
  return value;
}

export function resolveReportability(record) {
  if (record?.reportability == null) return null;
  const policy = record.reportability;
  if (policy.protocol !== REPORTABILITY_PROTOCOL) {
    throw new Error(`unknown reportability protocol ${String(policy.protocol)}.`);
  }
  const minAcceptedSamples = integer(
    policy.minAcceptedSamples ?? DEFAULT_MIN_ACCEPTED_SAMPLES,
    'reportability minAcceptedSamples',
    DEFAULT_MIN_ACCEPTED_SAMPLES,
  );
  const acceptedCount = integer(record.acceptedCount, 'reportability acceptedCount');
  const attemptedCount = integer(record.attemptedCount, 'reportability attemptedCount');
  if (acceptedCount > attemptedCount) {
    throw new Error('reportability acceptedCount cannot exceed attemptedCount.');
  }
  const reportable = acceptedCount >= minAcceptedSamples;
  return {
    protocol: REPORTABILITY_PROTOCOL,
    minAcceptedSamples,
    acceptedCount,
    attemptedCount,
    status: reportable ? 'reportable' : 'not-reportable',
    reason: reportable ? null : 'accepted-sample-minimum-not-met',
  };
}

function assertCapacityOutcomeContract(record) {
  if (record.suite !== NATIVE_CAPACITY_SUITE) return;
  if (record.contractVersion !== NATIVE_CAPACITY_CONTRACT_VERSION) {
    throw new Error(`unknown native capacity contract ${String(record.contractVersion)}.`);
  }
  if (record.fixtureRole !== NATIVE_CAPACITY_FIXTURE_ROLE) {
    throw new Error(`unknown native capacity fixture role ${String(record.fixtureRole)}.`);
  }
  if (record.outcomeProtocol !== NATIVE_CAPACITY_OUTCOME_PROTOCOL) {
    throw new Error(`unknown native capacity outcome protocol ${String(record.outcomeProtocol)}.`);
  }
  if (record.reportability?.protocol !== REPORTABILITY_PROTOCOL) {
    throw new Error(
      `unknown native capacity reportability protocol `
      + `${String(record.reportability?.protocol)}.`,
    );
  }
  if (record.reportability.minAcceptedSamples !== DEFAULT_MIN_ACCEPTED_SAMPLES) {
    throw new Error(
      `native capacity reportability must be ${REPORTABILITY_PROTOCOL} with `
      + `${DEFAULT_MIN_ACCEPTED_SAMPLES} accepted samples.`,
    );
  }
  if (!Array.isArray(record.diagnosticOutcomes)) {
    throw new Error('native capacity record must preserve diagnosticOutcomes.');
  }
  const attemptedCount = integer(record.attemptedCount, 'native capacity attemptedCount', 1);
  if (record.diagnosticOutcomes.length !== attemptedCount) {
    throw new Error('native capacity diagnosticOutcomes must align with attemptedCount.');
  }
  const reps = new Set();
  let completedCount = 0;
  let dnfCount = 0;
  for (const outcome of record.diagnosticOutcomes) {
    integer(outcome?.rep, 'native capacity outcome rep');
    if (reps.has(outcome.rep)) throw new Error('native capacity outcome reps must be unique.');
    reps.add(outcome.rep);
    if (outcome.outcome === 'completed') {
      completedCount++;
      if (!Number.isFinite(outcome.latencyMs)) {
        throw new Error('completed native capacity outcome requires latencyMs.');
      }
    } else if (outcome.outcome === 'dnf') {
      dnfCount++;
      if (!CAPACITY_FAILURE_CATEGORIES.has(outcome.failure?.category)) {
        throw new Error(
          `unknown native capacity failure category ${String(outcome.failure?.category)}.`,
        );
      }
    } else {
      throw new Error(`unknown native capacity outcome ${String(outcome.outcome)}.`);
    }
  }
  for (let rep = 0; rep < attemptedCount; rep++) {
    if (!reps.has(rep)) throw new Error('native capacity outcome reps must cover every attempt.');
  }
  const samples = Array.isArray(record.samples) ? record.samples : [];
  const acceptedCount = integer(record.acceptedCount, 'native capacity acceptedCount');
  const recordedDnfCount = integer(record.dnfCount, 'native capacity dnfCount');
  if (completedCount + dnfCount !== attemptedCount
    || dnfCount !== recordedDnfCount
    || (record.failures?.length ?? 0) !== recordedDnfCount) {
    throw new Error('native capacity completed/DNF outcomes do not reconcile with attempt counts.');
  }
  const failuresByRep = new Map((record.failures ?? []).map((item) => [item.rep, item]));
  for (const outcome of record.diagnosticOutcomes.filter((item) => item.outcome === 'dnf')) {
    const recorded = failuresByRep.get(outcome.rep);
    if (recorded?.category !== outcome.failure.category) {
      throw new Error('native capacity DNF outcomes do not reconcile with failure evidence.');
    }
  }
  const outcomeOnly = record.thresholdProbe === true && record.timingEligible === false;
  if ((record.thresholdProbe === true || record.timingEligible === false) && !outcomeOnly) {
    throw new Error('native capacity threshold probes must be explicitly outcome-only.');
  }
  if (outcomeOnly) {
    if (acceptedCount !== 0 || samples.length !== 0) {
      throw new Error('outcome-only native capacity probes must retain zero timing samples.');
    }
  } else if (completedCount !== acceptedCount || samples.length !== acceptedCount) {
    throw new Error('native capacity completed outcomes do not reconcile with accepted samples.');
  }
}

export function deriveOutcomeCounts(record) {
  const attemptedCount = record.attemptedCount;
  const acceptedCount = record.acceptedCount;
  if (!Number.isSafeInteger(attemptedCount) || !Number.isSafeInteger(acceptedCount)) return null;
  integer(record.dnfCount ?? 0, 'dnfCount');
  integer(record.notMeasuredCount ?? 0, 'notMeasuredCount');
  if ((record.failures?.length ?? 0) > (record.dnfCount ?? 0)) {
    throw new Error('failure evidence cannot exceed dnfCount.');
  }
  if (acceptedCount > attemptedCount) {
    throw new Error('acceptedCount cannot exceed attemptedCount.');
  }
  const outcomeOnly = record.suite === NATIVE_CAPACITY_SUITE
    && record.thresholdProbe === true
    && record.timingEligible === false;
  const outcomeOnlyCompleted = outcomeOnly
    ? (record.diagnosticOutcomes ?? []).filter((outcome) => outcome.outcome === 'completed').length
    : 0;
  if (acceptedCount + outcomeOnlyCompleted + (record.dnfCount ?? 0) !== attemptedCount) {
    throw new Error(
      'accepted, outcome-only completed, and DNF counts must account for every attempt.',
    );
  }
  const byReason = {};
  for (const failure of record.failures ?? []) {
    const category = failure?.category;
    if (typeof category !== 'string' || category.length === 0) continue;
    byReason[category] = (byReason[category] ?? 0) + 1;
  }
  if ((record.notMeasuredCount ?? 0) > 0) {
    const category = record.notMeasuredReason?.category;
    if (typeof category !== 'string' || category.length === 0) {
      throw new Error('not-measured outcome requires a typed reason category.');
    }
    byReason[category] = (byReason[category] ?? 0) + record.notMeasuredCount;
  }
  return {
    attempted: attemptedCount,
    accepted: acceptedCount,
    dnf: record.dnfCount ?? 0,
    notMeasured: record.notMeasuredCount ?? 0,
    byReason,
    ...(outcomeOnly ? { outcomeOnlyCompleted } : {}),
  };
}

export function materializeRecordOutcomes(record, {
  publicBoundary = false,
  allowInvalidAccounting = false,
} = {}) {
  assertCapacityOutcomeContract(record);
  if (record.measurementStatus != null
    && !['measured', 'measured-with-dnf', 'dnf', 'not-measured'].includes(
      record.measurementStatus,
    )) {
    throw new Error(`unknown measurement outcome ${String(record.measurementStatus)}.`);
  }
  const reportability = resolveReportability(record);
  let outcomeCounts = record.outcomeCounts ?? null;
  const needsOutcomeCounts = outcomeCounts != null
    || (record.dnfCount ?? 0) > 0
    || record.measurementStatus != null
    || record.reportability != null
    || record.diagnostic === true;
  if (needsOutcomeCounts) {
    try {
      outcomeCounts = deriveOutcomeCounts(record);
    } catch (error) {
      if (!allowInvalidAccounting) throw error;
      outcomeCounts = null;
    }
  }
  let out = {
    ...record,
    ...(reportability == null ? {} : { reportability }),
    ...(outcomeCounts == null ? {} : { outcomeCounts }),
  };
  if (publicBoundary && reportability?.status === 'not-reportable') {
    out = {
      ...out,
      ...Object.fromEntries(STAT_FIELDS.map((field) => [field, null])),
      ...(Object.hasOwn(out, 'score') ? { score: null } : {}),
      ...(Object.hasOwn(out, 'ratio') ? { ratio: null } : {}),
      rankingEligible: false,
      descriptiveEligible: true,
      presentationStatus: 'not-reportable',
    };
  }
  return out;
}

export function stringifyResult(value) {
  return JSON.stringify(
    value,
    (_key, candidate) => {
      if (typeof candidate === 'string') return redactResultString(candidate);
      return isRecord(candidate) ? materializeRecordOutcomes(candidate) : candidate;
    },
    1,
  );
}
