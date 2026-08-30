import assert from 'node:assert/strict';
import test from 'node:test';

import { makeRecord } from '@lynx-bench/shared/schema';

import { chromiumArgs } from './browser.mjs';
import { setCPUThrottlingRate } from './cdp.mjs';
import {
  assertProcessThrottleProbe,
  assertInterpreterFlagProbe,
  assertWebHarnessCapabilities,
  summarizeProcessThrottleProbes,
} from './preflight.mjs';
import { shouldCollectAfterRun } from './run-policy.mjs';

test('default Chromium arguments remain byte-for-byte identical', () => {
  assert.deepEqual(chromiumArgs(), [
    '--js-flags=--expose-gc',
    '--enable-precise-memory-info',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
  ]);
});

test('interp keeps expose-gc and disables every JavaScript compiler tier', () => {
  assert.equal(
    chromiumArgs({ jit: 'interp' })[0],
    '--js-flags=--expose-gc,--no-opt,--no-sparkplug,--no-maglev',
  );
  assert.equal(
    chromiumArgs({ jit: 'interp', allowNativesSyntax: true })[0],
    '--js-flags=--expose-gc,--no-opt,--no-sparkplug,--no-maglev,--allow-natives-syntax',
  );
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

test('Web harness capability check refuses to relabel a non-Wasm stock browser', () => {
  assert.doesNotThrow(() => assertWebHarnessCapabilities({ webAssembly: true }));
  assert.throws(
    () => assertWebHarnessCapabilities({ webAssembly: false }),
    /requires WebAssembly/,
  );
});

test('interpreter preflight requires a JIT control, never-optimized Ignition, and Wasm', () => {
  assert.doesNotThrow(() => assertInterpreterFlagProbe({
    jit: { status: 41, wasmInstantiated: true },
    interp: { status: 67, wasmInstantiated: true },
  }));
  assert.throws(() => assertInterpreterFlagProbe({
    jit: { status: 41, wasmInstantiated: true },
    interp: { status: 41, wasmInstantiated: true },
  }), /flags were ignored/);
  assert.throws(() => assertInterpreterFlagProbe({
    jit: { status: 41, wasmInstantiated: true },
    interp: { status: 67, wasmInstantiated: false },
  }), /WebAssembly/);
});

test('whole-process throttle preflight requires inherited launch and a 3.5–4.5x slowdown', () => {
  assert.deepEqual(assertProcessThrottleProbe({
    control: { score: 100 },
    throttled: { score: 25 },
    cpuThrottle: 4,
    mechanism: {
      scope: 'process-cgroup', backend: 'cgroup-v1-cgexec', inheritance: 'launch-cgroup',
    },
  }).verifiedSlowdown, 4);
  assert.throws(() => assertProcessThrottleProbe({
    control: { score: 100 },
    throttled: { score: 90 },
    cpuThrottle: 4,
    mechanism: {
      scope: 'process-cgroup', backend: 'cgroup-v1-cgexec', inheritance: 'launch-cgroup',
    },
  }), /preflight failed/);
  assert.throws(() => assertProcessThrottleProbe({
    control: { score: 100 },
    throttled: { score: 25 },
    cpuThrottle: 4,
    mechanism: { scope: 'process-cgroup', backend: 'cpulimit' },
  }), /inherited-cgroup/);
  assert.throws(() => assertProcessThrottleProbe({
    control: { score: 100 },
    throttled: { score: 25 },
    cpuThrottle: 4,
    mechanism: null,
  }), /mechanism receipt/);
});

test('whole-process throttle verification uses a fixed three-probe median', () => {
  const summary = summarizeProcessThrottleProbes([
    { probeVersion: 1, score: 20, iterations: 20 },
    { probeVersion: 1, score: 27, iterations: 27 },
    { probeVersion: 1, score: 25, iterations: 25 },
  ]);
  assert.deepEqual(summary, {
    probeVersion: 1,
    score: 25,
    iterations: 25,
    aggregation: 'median',
    repetitions: 3,
    samples: [
      { probeVersion: 1, score: 20, iterations: 20 },
      { probeVersion: 1, score: 27, iterations: 27 },
      { probeVersion: 1, score: 25, iterations: 25 },
    ],
  });
  assert.throws(() => summarizeProcessThrottleProbes(summary.samples.slice(0, 2)), /exactly 3/);
  assert.throws(() => summarizeProcessThrottleProbes([
    summary.samples[0], summary.samples[1], { ...summary.samples[2], probeVersion: 2 },
  ]), /incompatible/);
});

test('no-collect policy applies equally to Web and Native run completion', () => {
  assert.equal(shouldCollectAfterRun({}), true);
  assert.equal(shouldCollectAfterRun({ 'no-collect': true }), false);
});

test('schema records Web regimes and rejects applying them to Native', () => {
  const base = {
    suite: 'table', entry: 'react', workload: 'create', scale: 1000,
    metric: 'latency', boundary: 'test', unit: 'ms', samples: [1],
  };
  const historicalDefault = makeRecord(base);
  assert.deepEqual(historicalDefault.environment, {
    jsRegime: 'jit', jsFlags: '--expose-gc', cpuThrottle: 1, throttleScope: 'none',
  });
  assert.equal(Object.hasOwn(historicalDefault, 'jsRegime'), false);
  assert.equal(Object.hasOwn(historicalDefault, 'cpuThrottle'), false);
  const probe = makeRecord({ ...base, jsRegime: 'interp', cpuThrottle: 4 });
  assert.deepEqual(probe.environment, {
    jsRegime: 'interp',
    jsFlags: '--expose-gc,--no-opt,--no-sparkplug,--no-maglev',
    cpuThrottle: 4,
    throttleScope: 'page-cdp',
  });
  const processProbe = makeRecord({
    ...base, jsRegime: 'interp', cpuThrottle: 4, throttleScope: 'process-cgroup',
    verifiedSlowdown: 4.08,
  });
  assert.equal(processProbe.environment.throttleScope, 'process-cgroup');
  assert.equal(processProbe.environment.verifiedSlowdown, 4.08);
  assert.throws(() => makeRecord({
    ...base, jsRegime: 'interp', cpuThrottle: 4, throttleScope: 'process-cgroup',
  }), /verifiedSlowdown/);
  const native = makeRecord({ ...base, harness: 'native', environment: 'device' });
  assert.equal(native.environment, 'device');
  assert.equal(Object.hasOwn(native, 'jsRegime'), false);
  assert.equal(Object.hasOwn(native, 'cpuThrottle'), false);
  assert.throws(() => makeRecord({
    ...base,
    harness: 'native',
    environment: 'device',
    jsRegime: 'interp',
    jsFlags: '--expose-gc,--no-opt,--no-sparkplug,--no-maglev',
    cpuThrottle: 4,
    throttleScope: 'process-cgroup',
  }), /Web-only/);
});
