import assert from 'node:assert/strict';
import test from 'node:test';

import { nativeObservationStatus } from './native-observation-status.mjs';

const english = (value) => value;
const formatMs = (value) => `${value.toFixed(1)} ms`;

test('threshold capacity probes retain completed outcomes while timing stays disabled', () => {
  const status = nativeObservationStatus({
    suite: 'native-capacity',
    thresholdProbe: true,
    reportability: { status: 'not-reportable' },
    attemptedCount: 5,
    acceptedCount: 0,
    dnfCount: 1,
    outcomeCounts: {
      attempted: 5,
      accepted: 0,
      dnf: 1,
      notMeasured: 0,
      outcomeOnlyCompleted: 4,
      byReason: { timeout: 1 },
    },
  }, { text: english, formatMs });
  assert.equal(
    status,
    'outcome only · 4/5 completed · timing disabled · 1 DNF · 1 timeout',
  );
});

test('Native observation medians preserve non-time units', () => {
  assert.equal(nativeObservationStatus({
    suite: 'list',
    unit: 'count',
    median: 42,
    n: 5,
    dnfCount: 0,
  }, {
    text: english,
    formatMs: () => { throw new Error('non-time values must not use the millisecond formatter'); },
  }), '42 count · n=5');
  assert.equal(nativeObservationStatus({
    suite: 'list',
    unit: 'ms',
    median: 42,
    n: 5,
    dnfCount: 0,
  }, { text: english, formatMs }), '42.0 ms · n=5');
});
