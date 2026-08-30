import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { STORM_SELECT_TICKS, STORM_UPDATE_TICKS } from '@lynx-bench/shared/workloads';

import { stormCommitGuard, waitForTransportIdle } from './harness-web.mjs';

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

test('process-cgroup readiness waits for a full quiet transport window', async () => {
  let clock = 0;
  let reads = 0;
  const sequence = [wire(1, 1), wire(2, 1), wire(2, 2), wire(2, 2), wire(2, 2)];
  const result = await waitForTransportIdle(
    async () => sequence[Math.min(reads++, sequence.length - 1)],
    {
      idleMs: 200,
      timeoutMs: 1000,
      pollMs: 100,
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
    },
  );
  assert.equal(result.idleMs, 200);
  assert.equal(reads, 5);
});

test('process-cgroup readiness fails closed when transport never settles', async () => {
  let clock = 0;
  let messages = 0;
  await assert.rejects(
    waitForTransportIdle(
      async () => wire(messages++, messages),
      {
        idleMs: 200,
        timeoutMs: 300,
        pollMs: 100,
        now: () => clock,
        sleep: async (ms) => { clock += ms; },
      },
    ),
    /transport did not become idle for 200ms within 300ms/,
  );
});

test('process-cgroup readiness policy is retained in the run mechanism receipt', () => {
  const source = fs.readFileSync(new URL('./harness-web.mjs', import.meta.url), 'utf8');
  assert.match(source, /method: 'wire-idle-v1'/);
  assert.match(source, /readinessBarrier: PROCESS_CGROUP_READINESS_BARRIER/);
  assert.match(source, /mechanism: processThrottleReceipt/);
});
