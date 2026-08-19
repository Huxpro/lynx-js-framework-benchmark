import assert from 'node:assert/strict';
import test from 'node:test';

import { STORM_SELECT_TICKS, STORM_UPDATE_TICKS } from '@lynx-bench/shared/workloads';

import { stormCommitGuard, webTimeoutFailure } from './harness-web.mjs';

const wire = (toMtsMessages, toBtsMessages) => ({
  toMts: { messages: toMtsMessages, bytes: 0, byName: {} },
  toBts: { messages: toBtsMessages, bytes: 0, byName: {} },
});

test('storm guard rejects final-state-only runs with incomplete transport work', () => {
  const failure = stormCommitGuard({ name: 'selectStorm' }, wire(6, 14));
  assert.equal(failure.category, 'incomplete-storm-transport');
  assert.equal(failure.expectedSequentialCommits, STORM_SELECT_TICKS);
  assert.deepEqual(failure.evidence, { toMtsMessages: 6, toBtsMessages: 14 });
});

test('storm guard accepts at least one message per sequential tick in both directions', () => {
  assert.equal(stormCommitGuard(
    { name: 'selectStorm' },
    wire(STORM_SELECT_TICKS * 2, 92),
  ), null);
  assert.equal(stormCommitGuard(
    { name: 'updateStorm' },
    wire(STORM_UPDATE_TICKS, STORM_UPDATE_TICKS),
  ), null);
  assert.equal(stormCommitGuard({ name: 'select' }, wire(1, 1)), null);
});

test('Web timeout evidence retains repetition, phase, ceiling, and observation', () => {
  assert.deepEqual(webTimeoutFailure({
    rep: 2,
    phase: 'startup',
    timeoutMs: 240000,
    evidence: { finalCount: 17 },
  }), {
    rep: 2,
    category: 'timeout',
    phase: 'startup',
    timeoutMs: 240000,
    evidence: { finalCount: 17 },
  });
});
