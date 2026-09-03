import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_MIN_ACCEPTED_SAMPLES,
  NATIVE_CAPACITY_OUTCOME_PROTOCOL,
  REPORTABILITY_PROTOCOL,
  materializeRecordOutcomes,
  redactResultString,
  stringifyResult,
} from './result-json.mjs';
import {
  NATIVE_CAPACITY_CONTRACT_VERSION,
  NATIVE_CAPACITY_FIXTURE_ROLE,
  NATIVE_CAPACITY_SUITE,
} from '../../shared/src/native-diagnostic-contract.mjs';

test('result serialization redacts DevTool client IDs at every nesting level', () => {
  const message = 'No response found for clientId: internal.example%3A1234:8901';
  assert.equal(
    redactResultString(`Error: ${message}`),
    'Error: No response found for clientId: [redacted]',
  );

  const serialized = stringifyResult({
    message,
    evidence: {
      recoveries: [{ message: `Error: ${message}` }],
    },
    safe: 'No response found without a client identifier',
  });
  assert.equal(serialized.includes('internal.example'), false);
  assert.deepEqual(JSON.parse(serialized), {
    message: 'No response found for clientId: [redacted]',
    evidence: {
      recoveries: [{ message: 'Error: No response found for clientId: [redacted]' }],
    },
    safe: 'No response found without a client identifier',
  });
});

const capacityRecord = (overrides = {}) => ({
  suite: NATIVE_CAPACITY_SUITE, harness: 'native', environment: 'android',
  entry: 'octane-native-diagnostic', workload: 'create', scale: 10000,
  metric: 'loadToSemanticCompletion', boundary: 'native-launch-to-valid-completion-receipt',
  unit: 'ms', contractVersion: NATIVE_CAPACITY_CONTRACT_VERSION,
  fixtureRole: NATIVE_CAPACITY_FIXTURE_ROLE, outcomeProtocol: NATIVE_CAPACITY_OUTCOME_PROTOCOL,
  samples: [], n: 0, median: null, dnfCount: 5, attemptedCount: 5, acceptedCount: 0,
  failures: Array.from({ length: 5 }, (_, rep) => ({
    rep, category: 'capacity/android-art-global-ref-table',
    loadToCrashMs: 20_000 + rep,
  })),
  diagnosticOutcomes: Array.from({ length: 5 }, (_, rep) => ({
    rep, outcome: 'dnf', failure: {
      category: 'capacity/android-art-global-ref-table', loadToCrashMs: 20_000 + rep,
    },
  })),
  reportability: {
    protocol: REPORTABILITY_PROTOCOL,
    minAcceptedSamples: DEFAULT_MIN_ACCEPTED_SAMPLES,
  },
  ...overrides,
});

test('materialize-on-visit serialization matches recursive preparation for JSON-shaped results', () => {
  const message = 'Failure for clientId: internal.example%3A1234:8901';
  const input = {
    meta: { message },
    nested: [{ records: [capacityRecord()], message }],
  };
  const before = structuredClone(input);
  const prepareRecursively = (value) => {
    if (Array.isArray(value)) return value.map(prepareRecursively);
    if (value == null || typeof value !== 'object') return value;
    const prepared = Object.fromEntries(Object.entries(value)
      .map(([key, child]) => [key, prepareRecursively(child)]));
    return typeof prepared.suite === 'string'
      && typeof prepared.entry === 'string'
      && typeof prepared.metric === 'string'
      ? materializeRecordOutcomes(prepared)
      : prepared;
  };
  const expected = JSON.stringify(
    prepareRecursively(input),
    (_key, value) => typeof value === 'string' ? redactResultString(value) : value,
    1,
  );
  assert.equal(stringifyResult(input), expected);
  assert.deepEqual(input, before);
});

test('capacity DNF serialization retains typed evidence and emits no timing aggregate', () => {
  const parsed = JSON.parse(stringifyResult({ records: [capacityRecord()] })).records[0];
  assert.deepEqual(parsed.outcomeCounts, {
    attempted: 5, accepted: 0, dnf: 5, notMeasured: 0,
    byReason: { 'capacity/android-art-global-ref-table': 5 },
  });
  assert.equal(parsed.median, null);
  assert.equal(parsed.failures[0].loadToCrashMs, 20_000);
  assert.equal(parsed.reportability.status, 'not-reportable');
});

test('public reportability suppresses underfilled aggregates but leaves raw source samples intact', () => {
  const source = capacityRecord({
    scale: 1000,
    samples: [10, 11, 12, 13],
    n: 4,
    median: 11.5,
    mean: 11.5,
    min: 10,
    max: 13,
    p95: 13,
    ci95: 1,
    dnfCount: 1,
    acceptedCount: 4,
    failures: [{ rep: 4, category: 'timeout' }],
    diagnosticOutcomes: [10, 11, 12, 13].map((latencyMs, rep) => ({
      rep, outcome: 'completed', latencyMs,
    })).concat([{ rep: 4, outcome: 'dnf', failure: { category: 'timeout' } }]),
  });
  const persisted = JSON.parse(stringifyResult({ records: [source] })).records[0];
  assert.deepEqual(persisted.samples, [10, 11, 12, 13]);
  assert.equal(persisted.median, 11.5);
  const publicRecord = materializeRecordOutcomes(persisted, { publicBoundary: true });
  assert.equal(publicRecord.median, null);
  assert.deepEqual(publicRecord.samples, [10, 11, 12, 13]);
  assert.equal(publicRecord.presentationStatus, 'not-reportable');
  assert.equal(publicRecord.rankingEligible, false);
});

test('the accepted-sample policy publishes only after its threshold is met', () => {
  const samples = [10, 11, 12, 13, 14];
  const source = capacityRecord({
    scale: 1000,
    samples,
    n: 5,
    median: 12,
    dnfCount: 1,
    attemptedCount: 6,
    acceptedCount: 5,
    failures: [{ rep: 5, category: 'timeout' }],
    diagnosticOutcomes: samples.map((latencyMs, rep) => ({
      rep, outcome: 'completed', latencyMs,
    })).concat([{ rep: 5, outcome: 'dnf', failure: { category: 'timeout' } }]),
    reportability: {
      protocol: REPORTABILITY_PROTOCOL,
      minAcceptedSamples: DEFAULT_MIN_ACCEPTED_SAMPLES,
    },
  });
  const presented = materializeRecordOutcomes(source, { publicBoundary: true });
  assert.equal(presented.reportability.status, 'reportable');
  assert.equal(presented.median, 12);
  assert.equal(presented.presentationStatus, undefined);
});

test('unknown reportability, capacity, fixture, outcome, and failure contracts fail closed', () => {
  for (const [changed, pattern] of [
    [{ reportability: {
      protocol: 'future-v2', minAcceptedSamples: DEFAULT_MIN_ACCEPTED_SAMPLES,
    } }, /reportability protocol/],
    [{ reportability: undefined }, /capacity reportability/],
    [{ reportability: { protocol: REPORTABILITY_PROTOCOL, minAcceptedSamples: 6 } },
      /capacity reportability/],
    [{ contractVersion: 'native-eager-capacity-v3' }, /capacity contract/],
    [{ fixtureRole: 'future-capacity-probe' }, /fixture role/],
    [{ outcomeProtocol: undefined }, /outcome protocol/],
    [{ outcomeProtocol: 'native-capacity-outcomes-v2' }, /outcome protocol/],
    [{ diagnosticOutcomes: [{ rep: 0, outcome: 'future' }] }, /diagnosticOutcomes|outcome/],
    [{
      failures: [{ rep: 0, category: 'future-capacity' }],
      diagnosticOutcomes: Array.from({ length: 5 }, (_, rep) => ({
        rep, outcome: 'dnf', failure: { category: rep === 0 ? 'future-capacity' : 'timeout' },
      })),
    }, /failure category/],
  ]) assert.throws(() => stringifyResult({ records: [capacityRecord(changed)] }), pattern);
});
