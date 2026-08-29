import assert from 'node:assert/strict';
import test from 'node:test';

import { makeRecord } from '@lynx-bench/shared/schema';

import { chromiumArgs } from './browser.mjs';
import { setCPUThrottlingRate } from './cdp.mjs';

test('default Chromium arguments remain byte-for-byte identical', () => {
  assert.deepEqual(chromiumArgs(), [
    '--js-flags=--expose-gc',
    '--enable-precise-memory-info',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
  ]);
});

test('jitless keeps expose-gc in the same V8 flag payload', () => {
  assert.equal(chromiumArgs({ jit: 'jitless' })[0], '--js-flags=--expose-gc --jitless');
  assert.throws(() => chromiumArgs({ jit: 'other' }), /invalid jit regime/);
});

test('CPU throttling uses the attached page session and validates the rate', async () => {
  const calls = [];
  const client = { send: async (...args) => calls.push(args) };
  await setCPUThrottlingRate(client, 'page-session', 4);
  assert.deepEqual(calls, [[
    'Emulation.setCPUThrottlingRate',
    { rate: 4 },
    'page-session',
  ]]);
  await assert.rejects(() => setCPUThrottlingRate(client, 'page-session', 0), /invalid CPU/);
});

test('schema records Web regimes and rejects applying them to Native', () => {
  const base = {
    suite: 'table', entry: 'react', workload: 'create', scale: 1000,
    metric: 'latency', boundary: 'test', unit: 'ms', samples: [1],
  };
  const legacyDefault = makeRecord(base);
  assert.equal(legacyDefault.jsRegime, 'jit');
  assert.equal(legacyDefault.cpuThrottle, 1);
  const probe = makeRecord({ ...base, jsRegime: 'jitless', cpuThrottle: 4 });
  assert.equal(probe.jsRegime, 'jitless');
  assert.equal(probe.cpuThrottle, 4);
  assert.throws(() => makeRecord({
    ...base,
    harness: 'native',
    environment: 'device',
    jsRegime: 'jitless',
    cpuThrottle: 4,
  }), /Web-only/);
});
