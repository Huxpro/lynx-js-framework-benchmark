// The native harness must be drivable end to end by any adapter that honors
// the documented contract, without this repository ever registering a proxy
// adapter of its own (docs/METHODOLOGY.md "Harness separation").
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { COMPARABILITY_KEYS } from '@lynx-bench/shared/schema';

import { loadNativeAdapter, runNativeHarness, runNativeMatrix } from './harness-native.mjs';

const CASES = [
  { name: 'create', scales: [1000, 10000] },
  { name: 'clear', scales: [10000] },
];

function fakeEntry(dir) {
  for (const rows of [0, 1000]) {
    const dist = path.join(dir, 'dist', `rows-${rows}`);
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(dist, 'main.lynx.bundle'), 'bundle');
    fs.writeFileSync(path.join(dist, 'main.web.bundle'), 'bundle');
  }
  return {
    id: 'fake',
    provenance: { commit: 'test' },
    dir,
    distDir: path.join(dir, 'dist'),
  };
}

function mockAdapter(script) {
  return {
    environment: 'lynx-native-mock-sim',
    calls: script.calls,
    async loadBundle(entry, { rows, bundlePath }) {
      script.calls.push(['loadBundle', entry.id, rows, fs.existsSync(bundlePath)]);
    },
    async driveCase(kase, scale) {
      script.calls.push(['driveCase', kase.name, scale]);
    },
    async collect() {
      return script.collect.shift();
    },
    async collectStartup() {
      return script.startup.shift();
    },
    async dispose() {
      script.calls.push(['dispose']);
    },
  };
}

test('native matrix emits schema-shaped native records with DNF accounting', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-harness-'));
  const entry = fakeEntry(dir);
  const script = {
    calls: [],
    collect: [
      { latencyMs: 12.5, metrics: { nativeWireBytes: { value: 640, unit: 'B', boundary: 'engine-wire' } } },
      { latencyMs: 13.5 },
      { dnf: true },
      { latencyMs: 200 },
      { latencyMs: 210 },
      { latencyMs: 220 },
      { latencyMs: 40 },
      { latencyMs: 41 },
      { latencyMs: 42 },
    ],
    startup: [
      { fcpMs: 90, settledMs: 120 },
      {
        dnf: true,
        failure: { category: 'timeout', phase: 'startup', timeoutMs: 240000 },
        metricContracts: [
          { name: 'octaneCommitAck', unit: 'ms', boundary: 'native-open-request-to-octane-transport-ack' },
          { name: 'octaneSecondFrame', unit: 'ms', boundary: 'native-open-request-to-second-frame-after-octane-transport-ack' },
        ],
      },
    ],
  };
  const progress = [];
  const records = await runNativeMatrix({
    adapter: mockAdapter(script),
    entries: [entry],
    cases: CASES,
    scales: [1000, 10000],
    reps: 3,
    startupReps: 1,
    onProgress: async (partial) => progress.push(partial.length),
  });

  const create1k = records.find(
    (r) => r.workload === 'create' && r.scale === 1000 && r.metric === 'latency',
  );
  assert.equal(create1k.harness, 'native');
  assert.equal(create1k.environment, 'lynx-native-mock-sim');
  assert.equal(create1k.boundary, 'native-input-handler-to-second-native-frame');
  assert.equal(create1k.n, 2);
  assert.equal(create1k.dnfCount, 1);
  for (const key of COMPARABILITY_KEYS) assert.ok(key in create1k, key);

  const wire = records.find((r) => r.metric === 'nativeWireBytes');
  assert.equal(wire.boundary, 'engine-wire');
  assert.equal(wire.unit, 'B');
  assert.equal(wire.median, 640);

  const startupFcp = records.find((r) => r.workload === 'startup' && r.scale === 0);
  assert.equal(startupFcp.metric, 'fcp');
  assert.equal(startupFcp.boundary, 'native-open-to-fcp');
  const settled = records.find((r) => r.metric === 'settled' && r.scale === 0);
  assert.equal(settled.median, 120);
  const octaneAck = records.find((r) => r.metric === 'octaneCommitAck' && r.scale === 1000);
  assert.equal(octaneAck.n, 0);
  assert.equal(octaneAck.dnfCount, 1);
  assert.deepEqual(octaneAck.failures, [{
    rep: 0, category: 'timeout', phase: 'startup', timeoutMs: 240000,
  }]);

  // No record may claim web comparability.
  for (const record of records) {
    assert.equal(record.harness, 'native');
    assert.notEqual(record.environment, 'lynx-for-web');
  }
  assert.equal(progress.length, 5);
  assert.equal(progress.at(-1), records.length);
});

test('known exhausted transport failures become evidenced DNF instead of discarding prior cells', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-transport-dnf-'));
  const entry = fakeEntry(dir);
  const adapter = mockAdapter({ calls: [], collect: [], startup: [] });
  adapter.driveCase = async () => {
    throw new Error('No response found for clientId: device');
  };
  adapter.classifyFailure = async (error, context) => ({
    dnf: true,
    failure: {
      category: 'transport-retries-exhausted',
      workload: context.kase.name,
      message: String(error),
    },
  });
  const checkpoints = [];
  const records = await runNativeMatrix({
    adapter,
    entries: [entry],
    cases: [{ name: 'create', scales: [1000] }],
    suites: ['table'],
    scales: [1000],
    reps: 2,
    onProgress: async (partial) => checkpoints.push(structuredClone(partial)),
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].n, 0);
  assert.equal(records[0].dnfCount, 2);
  assert.deepEqual(records[0].failures.map((failure) => failure.category), [
    'transport-retries-exhausted', 'transport-retries-exhausted',
  ]);
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0][0].dnfCount, 2);
});

test('preclassified startup capability failures still emit every metric and scale', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-startup-capability-'));
  const entry = fakeEntry(dir);
  const adapter = mockAdapter({ calls: [], collect: [], startup: [] });
  adapter.isStartupUnsupported = () => true;
  adapter.startupUnsupportedReason = (_entry, rows) => ({
    category: rows === 0
      ? 'performance-pipeline-unavailable'
      : 'performance-pipeline-unavailable-inherited',
    scale: rows,
    evidence: { performanceEntryCount: 0 },
  });
  adapter.startupUnsupportedContracts = () => [
    { name: 'fcp', unit: 'ms', boundary: 'native-open-to-fcp' },
    { name: 'settled', unit: 'ms', boundary: 'native-open-to-pipeline-end' },
  ];
  const records = await runNativeMatrix({
    adapter,
    entries: [entry],
    cases: [],
    suites: ['startup'],
    startupScales: [0, 1000],
    startupReps: 3,
  });
  assert.equal(records.length, 4);
  for (const rows of [0, 1000]) {
    for (const metric of ['fcp', 'settled']) {
      const record = records.find((candidate) => candidate.scale === rows && candidate.metric === metric);
      assert.equal(record.n, 0);
      assert.equal(record.dnfCount, 3);
      assert.equal(record.failures.length, 3);
      assert.equal(record.failures[0].scale, rows);
    }
  }
  assert.equal(adapter.calls.some(([method]) => method === 'loadBundle'), false);
});

test('adapter modules are validated against the documented contract', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-adapter-'));
  const good = path.join(dir, 'good.mjs');
  fs.writeFileSync(
    good,
    `export default () => ({
      environment: 'lynx-native-mock-sim',
      loadBundle: async () => {},
      driveCase: async () => {},
      collect: async () => ({ latencyMs: 1 }),
      collectStartup: async () => ({ fcpMs: 1 }),
      dispose: async () => {},
    });`,
  );
  const adapter = await loadNativeAdapter(good);
  assert.equal(adapter.environment, 'lynx-native-mock-sim');

  const webEnv = path.join(dir, 'web-env.mjs');
  fs.writeFileSync(
    webEnv,
    `export default () => ({
      environment: 'lynx-for-web',
      loadBundle: async () => {},
      driveCase: async () => {},
      collect: async () => ({}),
      collectStartup: async () => ({}),
      dispose: async () => {},
    });`,
  );
  await assert.rejects(() => loadNativeAdapter(webEnv), /never comparable/);

  const partial = path.join(dir, 'partial.mjs');
  fs.writeFileSync(partial, `export default () => ({ environment: 'x', loadBundle: async () => {} });`);
  await assert.rejects(() => loadNativeAdapter(partial), /missing driveCase/);
});

test('without an adapter the harness still explains itself instead of proxying', async () => {
  await assert.rejects(() => runNativeHarness(), /no device adapter is wired/);
  await assert.rejects(() => runNativeHarness({}), /no device adapter is wired/);
});

test('sandbox adapter imports without the device-only connector installed', async () => {
  const priorSerial = process.env.LYNX_SANDBOX_SERIAL;
  const priorLeaseId = process.env.LYNX_SANDBOX_LEASE_ID;
  delete process.env.LYNX_SANDBOX_SERIAL;
  delete process.env.LYNX_SANDBOX_LEASE_ID;
  try {
    const { default: createAdapter } = await import('../adapters/lynx-sandbox-android.mjs');
    await assert.rejects(() => createAdapter(), /requires LYNX_SANDBOX_SERIAL/);
    process.env.LYNX_SANDBOX_SERIAL = 'reused-device:1234';
    await assert.rejects(() => createAdapter(), /requires LYNX_SANDBOX_LEASE_ID/);
  } finally {
    if (priorSerial === undefined) delete process.env.LYNX_SANDBOX_SERIAL;
    else process.env.LYNX_SANDBOX_SERIAL = priorSerial;
    if (priorLeaseId === undefined) delete process.env.LYNX_SANDBOX_LEASE_ID;
    else process.env.LYNX_SANDBOX_LEASE_ID = priorLeaseId;
  }
});
