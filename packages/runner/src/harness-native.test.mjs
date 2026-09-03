// The native harness must be drivable end to end by any adapter that honors
// the documented contract, without this repository ever registering a proxy
// adapter of its own (docs/METHODOLOGY.md "Harness separation").
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { COMPARABILITY_KEYS } from '@lynx-bench/shared/schema';
import {
  isNativeTransientTransportFailure,
  nativeTransportFailureDnf,
  createCapacityAdapter,
  createCapacityLogBuffer,
} from '../adapters/lynx-sandbox-android.mjs';

import {
  CONNECTOR_PACKAGE_NAMES,
  CONNECTOR_PACKAGE_TREES_PROTOCOL,
  assertConnectorPackageTrees,
  connectorPackageTreesSha256,
  createPackageTreeReceipt,
  resolveConnectorPackageTrees,
} from './connector-receipt.mjs';
import {
  NATIVE_CAPACITY_POLICY,
  parseNativeLeaseReceipt,
} from './native-protocol.mjs';
import {
  loadNativeAdapter,
  loadNativeCapacityAdapter,
  runNativeHarness,
  runNativeMatrix,
} from './harness-native.mjs';

const CASES = [
  { name: 'create', scales: [1000, 10000] },
  { name: 'clear', scales: [10000] },
];

function fakeEntry(dir, { id = 'fake', framework = 'reactlynx' } = {}) {
  const snapshots = new Map();
  for (const rows of [0, 1000, 10000, 30000]) {
    const dist = path.join(dir, 'dist', `rows-${rows}`);
    fs.mkdirSync(dist, { recursive: true });
    const bundlePath = path.join(dist, 'main.lynx.bundle');
    const bundleBytes = Buffer.from(`bundle:${id}:${rows}`);
    fs.writeFileSync(bundlePath, bundleBytes);
    fs.writeFileSync(path.join(dist, 'main.web.bundle'), 'bundle');
    snapshots.set(`${id}:${rows}`, {
      entryId: id,
      rows,
      bundlePath,
      bundleBytes,
      sha256: crypto.createHash('sha256').update(bundleBytes).digest('hex'),
    });
  }
  const entry = {
    id,
    framework,
    provenance: { commit: 'test' },
    dir,
    distDir: path.join(dir, 'dist'),
  };
  return { entry, snapshots };
}

function mockAdapter(script) {
  return {
    environment: 'lynx-native-mock-sim',
    calls: script.calls,
    async loadBundle(entry, { rows, bundlePath, bundleBytes, bundleSha256 }) {
      script.calls.push([
        'loadBundle', entry.id, rows, fs.existsSync(bundlePath),
        Buffer.isBuffer(bundleBytes),
        crypto.createHash('sha256').update(bundleBytes).digest('hex') === bundleSha256,
      ]);
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
  const { entry, snapshots } = fakeEntry(dir);
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
          { name: 'fcp', unit: 'ms', boundary: 'native-open-to-fcp' },
          { name: 'settled', unit: 'ms', boundary: 'native-open-to-pipeline-end' },
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
    startupScales: [0, 1000],
    startupReps: 1,
    bundleSnapshots: snapshots,
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
  const fcpDnf = records.find((r) => r.metric === 'fcp' && r.scale === 1000);
  assert.equal(fcpDnf.n, 0);
  assert.equal(fcpDnf.dnfCount, 1);
  assert.deepEqual(fcpDnf.failures, [{
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
  const { entry, snapshots } = fakeEntry(dir);
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
    bundleSnapshots: snapshots,
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

test('table loadBundle transport exhaustion maps to the first pending cell and the next cell runs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-table-load-transport-'));
  const { entry, snapshots } = fakeEntry(dir);
  const calls = [];
  let loadAttempts = 0;
  const recoveries = [];
  const adapter = {
    environment: 'lynx-native-mock-sim',
    async loadBundle(_entry, { rows }) {
      calls.push(['loadBundle', rows]);
      loadAttempts++;
      if (loadAttempts <= 3) {
        throw new Error('CDP Runtime.enable failed: Error: timeout waiting 30000ms for Runtime.enable');
      }
    },
    async driveCase(kase, scale) { calls.push(['driveCase', kase.name, scale]); },
    async collect() { return { latencyMs: 9 }; },
    async recoverTransient(error) {
      recoveries.push(String(error));
      return true;
    },
    async classifyFailure(error, context) {
      return nativeTransportFailureDnf(error, context, {
        transientRecoveries: recoveries.map((message) => ({ message })),
      });
    },
  };
  const records = await runNativeMatrix({
    adapter,
    entries: [entry],
    cases: [{ name: 'create', scales: [1000, 3000, 5000] }],
    suites: ['table'],
    scales: [1000, 3000, 5000],
    reps: 1,
    bundleSnapshots: snapshots,
    existingCellKeys: new Set(['fake|table|create|1000|latency']),
  });

  assert.deepEqual(records.map((record) => record.scale), [3000, 5000]);
  const failed = records[0];
  assert.equal(failed.entry, 'fake');
  assert.equal(failed.workload, 'create');
  assert.equal(failed.metric, 'latency');
  assert.equal(failed.n, 0);
  assert.equal(failed.dnfCount, 1);
  assert.deepEqual(failed.samples, []);
  assert.equal(failed.failures[0].category, 'transport-retries-exhausted');
  assert.equal(failed.failures[0].stage, 'loadBundle');
  assert.equal(failed.failures[0].capabilityScope, 'cell');
  assert.equal(failed.failures[0].evidence.failureStage, 'loadBundle');
  assert.equal(failed.failures[0].evidence.transientRecoveries.length, 2);
  assert.equal(records[1].median, 9);
  assert.deepEqual(
    calls.filter(([method]) => method === 'driveCase'),
    [['driveCase', 'create', 5000]],
  );
});

test('startup loadBundle transport exhaustion checkpoints a DNF pair and the next scale runs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-startup-load-transport-'));
  const { entry, snapshots } = fakeEntry(dir);
  const calls = [];
  let loadAttempts = 0;
  const recoveries = [];
  const checkpoints = [];
  const adapter = {
    environment: 'lynx-native-mock-sim',
    async loadBundle(_entry, { rows }) {
      calls.push(['loadBundle', rows]);
      loadAttempts++;
      if (loadAttempts <= 3) {
        throw new Error('CDP Runtime.enable failed: Error: timeout waiting 30000ms for Runtime.enable');
      }
    },
    async collectStartup() { return { fcpMs: 17, settledMs: 23 }; },
    async recoverTransient(error) {
      recoveries.push(String(error));
      return true;
    },
    async classifyFailure(error, context) {
      return nativeTransportFailureDnf(error, context, {
        transientRecoveries: recoveries.map((message) => ({ message })),
      });
    },
  };
  const records = await runNativeMatrix({
    adapter,
    entries: [entry],
    cases: [],
    suites: ['startup'],
    startupScales: [0, 1000],
    startupReps: 1,
    bundleSnapshots: snapshots,
    onProgress: async (partial) => checkpoints.push(structuredClone(partial)),
  });

  assert.deepEqual(checkpoints.map((checkpoint) => checkpoint.length), [2, 4]);
  const failedPair = records.filter((record) => record.scale === 0);
  assert.deepEqual(failedPair.map((record) => record.metric), ['fcp', 'settled']);
  for (const record of failedPair) {
    assert.equal(record.n, 0);
    assert.equal(record.dnfCount, 1);
    assert.deepEqual(record.samples, []);
    assert.equal(record.value, null);
    assert.equal(record.median, null);
    assert.equal(record.failures[0].category, 'transport-retries-exhausted');
    assert.equal(record.failures[0].stage, 'loadBundle');
    assert.equal(record.failures[0].capabilityScope, 'cell');
  }
  assert.deepEqual(
    records.filter((record) => record.scale === 1000).map((record) => record.median),
    [17, 23],
  );
  assert.deepEqual(
    calls.filter(([method]) => method === 'loadBundle').map(([, rows]) => rows),
    [0, 0, 0, 1000],
  );
});

test('lease-expiry control flow bypasses transport recovery and classification', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-lease-stop-precedence-'));
  const marker = path.join(dir, 'calls.txt');
  const adapterPath = path.join(dir, 'adapter.mjs');
  const harnessUrl = new URL('./harness-native.mjs', import.meta.url).href;
  fs.writeFileSync(adapterPath, `
    import fs from 'node:fs';
    import { NativeLeaseExpiryStop } from ${JSON.stringify(harnessUrl)};
    const mark = (value) => fs.appendFileSync(${JSON.stringify(marker)}, value + String.fromCharCode(10));
    export default async () => ({
      environment: 'native-test', machine: { id: 'test' },
      loadBundle: async () => { throw new NativeLeaseExpiryStop([]); },
      driveCase: async () => {}, collect: async () => ({ latencyMs: 1 }),
      collectStartup: async () => ({}),
      recoverTransient: async () => { mark('recover'); return true; },
      classifyFailure: async () => { mark('classify'); return { dnf: true }; },
      dispose: async () => { mark('dispose'); },
    });
  `);
  const entry = { id: 'react', framework: 'reactlynx' };
  try {
    const stopped = await runNativeHarness({
      adapterPath,
      entries: [entry],
      cases: [{ name: 'create', scales: [1000] }],
      suites: ['table'],
      scales: [1000],
      reps: 1,
      bundleSnapshots: new Map([
        ['react:0', {
          entryId: 'react', rows: 0, bundlePath: '/unused/0',
          bundleBytes: Buffer.from('react:0'), bundleSha256: 'unused',
        }],
      ]),
    });
    assert.equal(stopped.stoppedForLeaseExpiry, true);
    assert.deepEqual(stopped.records, []);
    assert.deepEqual(fs.readFileSync(marker, 'utf8').trim().split('\n'), ['dispose']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('transport classification is narrow and preserves producer and integrity failures', () => {
  const runtimeFailure = new Error(
    'CDP Runtime.enable failed: Error: timeout waiting 30000ms for Runtime.enable',
  );
  assert.equal(isNativeTransientTransportFailure(runtimeFailure), true);
  assert.equal(
    isNativeTransientTransportFailure(new Error('CDP Runtime.evaluate failed: application error')),
    false,
  );
  assert.equal(
    isNativeTransientTransportFailure(new Error('in-memory bundle sha256 mismatch')),
    false,
  );
  assert.equal(
    isNativeTransientTransportFailure(new Error('Native startup payload.firstFrameMs must be finite.')),
    false,
  );
  assert.equal(nativeTransportFailureDnf(new Error('programming error'), {
    suite: 'table', entry: { id: 'fake' }, kase: { name: 'create' }, scale: 1000,
  }), null);
});

test('startup failures remain per-cell and still emit every expected metric and scale', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-startup-capability-'));
  const { entry, snapshots } = fakeEntry(dir);
  const adapter = mockAdapter({ calls: [], collect: [], startup: [] });
  adapter.isStartupUnsupported = () => true;
  adapter.startupUnsupportedReason = (_entry, rows) => ({
    category: 'performance-pipeline-unavailable',
    scale: rows,
    capabilityScope: 'cell',
    evidence: { performanceEntryCount: 0, capabilityProven: false },
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
    bundleSnapshots: snapshots,
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

test('a startup timeout at scale 0 does not suppress later startup scales', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-startup-cell-scope-'));
  const { entry, snapshots } = fakeEntry(dir);
  const script = {
    calls: [],
    collect: [],
    startup: [
      {
        dnf: true,
        failure: { category: 'timeout', capabilityScope: 'cell', scale: 0 },
        metricContracts: [
          { name: 'fcp', unit: 'ms', boundary: 'native-open-to-fcp' },
          { name: 'settled', unit: 'ms', boundary: 'native-open-to-pipeline-end' },
        ],
      },
      { fcpMs: 42, settledMs: 55 },
    ],
  };
  const records = await runNativeMatrix({
    adapter: mockAdapter(script),
    entries: [entry],
    cases: [],
    suites: ['startup'],
    startupScales: [0, 1000],
    startupReps: 1,
    bundleSnapshots: snapshots,
  });
  assert.equal(records.find((record) => record.scale === 0 && record.metric === 'fcp').dnfCount, 1);
  assert.equal(records.find((record) => record.scale === 1000 && record.metric === 'fcp').median, 42);
  assert.deepEqual(
    script.calls.filter(([method]) => method === 'loadBundle').map(([, , rows]) => rows),
    [0, 1000],
  );
});

test('startup producers use one framework-neutral metric contract', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-startup-contract-'));
  const { entry, snapshots } = fakeEntry(dir, { id: 'octane', framework: 'octane' });
  const adapter = mockAdapter({
    calls: [],
    collect: [],
    startup: [{ fcpMs: 1, settledMs: 2 }],
  });
  const records = await runNativeMatrix({
    adapter,
    entries: [entry],
    cases: [],
    suites: ['startup'],
    startupScales: [0],
    startupReps: 1,
    bundleSnapshots: snapshots,
  });
  assert.deepEqual(records.map(({ metric }) => metric), ['fcp', 'settled']);
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

test('capacity adapter modules use a separate no-CDP contract', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-capacity-adapter-'));
  const adapterPath = path.join(dir, 'adapter.mjs');
  fs.writeFileSync(adapterPath, `export default async (context) => {
    if (context.mode !== 'capacity') throw new Error('wrong mode');
    return {
      environment: 'lynx-native-android-capacity',
      runCapacityProbe: async () => ({ latencyMs: 1 }),
      dispose: async () => {},
    };
  };`);
  const adapter = await loadNativeCapacityAdapter(adapterPath);
  assert.equal(adapter.environment, 'lynx-native-android-capacity');
  assert.equal(typeof adapter.loadBundle, 'undefined');

  const partialPath = path.join(dir, 'partial.mjs');
  fs.writeFileSync(partialPath, `export default async () => ({
    environment: 'lynx-native-android-capacity', dispose: async () => {},
  });`);
  await assert.rejects(
    () => loadNativeCapacityAdapter(partialPath),
    /missing runCapacityProbe/,
  );
});

test('sandbox capacity mode completes through direct ADB logs without initializing CDP', async () => {
  const serial = 'capacity-device:5555';
  let now = 1_700_000_000_000;
  let getBundle = null;
  let marker = null;
  let launchedAtMs = null;
  const commands = [];
  const logcat = createCapacityLogBuffer();
  let logcatStarts = 0;
  const startup = () => ({
    protocol: 'lynx-native-startup-v1',
    moduleStartMs: launchedAtMs + 1,
    commitAckMs: launchedAtMs + 2,
    firstFrameMs: launchedAtMs + 3,
    secondFrameMs: launchedAtMs + 4,
    renderEvidence: { kind: 'native-animation-frame', frames: 2 },
    transportEvidence: {
      kind: 'octane-root.render', acknowledged: true, ackMs: launchedAtMs + 2,
    },
    postState: { rowCount: 1_000 },
  });
  const logLine = (atMs, process, message) =>
    `${(atMs / 1_000).toFixed(3)} ${process} ${process} I Lynx : ${message}`;
  const adb = async (...args) => {
    commands.push(args);
    const text = args.join(' ');
    if (text === 'shell getprop ro.product.model') return 'aries';
    if (text === 'shell getprop ro.build.version.release') return '10';
    if (text === 'shell getprop ro.product.board') return 'aries-board';
    if (text === 'shell nproc') return '8';
    if (text === 'shell dumpsys package com.lynx.explorer') {
      return 'versionName=1.0 versionCode=1';
    }
    if (text === 'shell dumpsys battery') return 'temperature: 340';
    if (text === 'shell dumpsys thermalservice') return 'Thermal Status: 0';
    if (text === 'shell settings get global stay_on_while_plugged_in') return '3';
    if (text === 'shell dumpsys power') return 'mWakefulness=Awake\nDisplay Power: state=ON';
    if (text === 'shell date +%s%3N') return String(now);
    if (text === 'shell pidof com.lynx.explorer') return '3131';
    if (args[0] === 'shell' && args[1] === 'log') {
      marker = args.at(-1);
      return '';
    }
    if (args[0] === 'shell' && args[1] === 'am' && args.includes('start')) {
      await new Promise((resolve) => setImmediate(resolve));
      getBundle().served++;
      if (args.includes('-W')) {
        launchedAtMs = now;
        logcat.append([
          logLine(launchedAtMs - 1, 3131, marker),
          logLine(
            launchedAtMs + 5,
            3131,
            `__NATIVE_BENCH_STARTUP__ ${JSON.stringify(startup())}`,
          ),
          '',
        ].join('\n'));
      } else {
        logcat.append([
          logLine(now - 1, 3131, marker),
          logLine(now, 3131, 'DevTool disabled. Transitioning to ATTACHED.'),
          logLine(now + 1, 3131, '__OCTANE_DEVTOOL_DISABLED__=true'),
          '',
        ].join('\n'));
      }
      return 'Status: ok';
    }
    return '';
  };
  const preflightBytes = Buffer.from('preflight');
  const capacityBytes = Buffer.from('capacity');
  const preflightSha = crypto.createHash('sha256').update(preflightBytes).digest('hex');
  const capacitySha = crypto.createHash('sha256').update(capacityBytes).digest('hex');
  const inputReceiptPayload = {
    version: 'native-capacity-input-receipt-v3',
    runtimePolicy: NATIVE_CAPACITY_POLICY,
    connectorPackageTrees: null,
    contract: { sha256: 'c'.repeat(64) },
    preflight: {
      bundle: 'dist/table/main.lynx.bundle', bytes: preflightBytes.length, sha256: preflightSha,
      protocol: 'lynx-devtool-disabled-lifecycle-v1',
      serving: 'immutable-local-http',
      source: 'operator-supplied-local-bundle',
    },
    capacityFixture: {
      scales: {
        1000: {
          bundle: 'dist/capacity/rows-1000/main.lynx.bundle',
          bytes: capacityBytes.length,
          sha256: capacitySha,
        },
      },
    },
  };
  const inputReceipt = {
    ...inputReceiptPayload,
    sha256: crypto.createHash('sha256')
      .update(JSON.stringify(inputReceiptPayload))
      .digest('hex'),
  };
  const leaseReceipt = parseNativeLeaseReceipt({
    serial, issueId: 'octane-888', expiredAt: now + 600_000,
  }, { serial, now });
  const adapter = await createCapacityAdapter({
    capacityInputs: {
      runtimePolicy: NATIVE_CAPACITY_POLICY,
      receipt: inputReceipt,
      preflight: {
        bundleBytes: preflightBytes,
        relativePath: inputReceipt.preflight.bundle,
        sha256: preflightSha,
      },
    },
    campaignIdentity: {
      campaignId: 'capacity-campaign',
      matrixContractSha256: inputReceipt.contract.sha256,
      inputReceiptSha256: inputReceipt.sha256,
      leaseReceipt,
    },
    capacityRuntime: {
      env: { LYNX_SANDBOX_SERIAL: serial, LYNX_SANDBOX_PORT: '8765' },
      adb,
      now: () => now,
      monotonicNow: () => now,
      wait: async (ms) => { now += ms; },
      startLogcat: async () => {
        logcatStarts++;
        return logcat;
      },
      startBundleServer: async (_port, getter) => {
        getBundle = getter;
        return { close(callback) { callback(); } };
      },
    },
  });
  const observed = await adapter.runCapacityProbe({
    id: 'octane-native-diagnostic', framework: 'octane',
  }, {
    suite: 'native-capacity',
    fixtureRole: 'eager-capacity-probe',
    scale: 1_000,
    rep: 0,
    bundleBytes: capacityBytes,
    bundleSha256: capacitySha,
    contractSha256: inputReceipt.contract.sha256,
  });
  assert.equal(observed.latencyMs, 4);
  assert.equal(adapter.machine.connectorInitialized, false);
  assert.equal(typeof adapter.loadBundle, 'undefined');
  assert.equal(
    commands.some((args) => /cdp|listClients|openPage|createDefaultConnector/i.test(args.join(' '))),
    false,
  );
  assert.equal(adapter.machine.devtoolPreflights[0].valid, true);
  assert.equal(logcatStarts, 1);
  assert.equal(commands.filter((args) => args.join(' ') === 'shell date +%s%3N').length, 1);
  assert.equal(commands.some((args) => args[0] === 'logcat' && args.includes('-d')), false);
  await adapter.dispose();
});

test('capacity log capture exposes deltas while retaining the complete finalized attempt', () => {
  const capture = createCapacityLogBuffer();
  capture.append('1.000 1 1 I Lynx : marker\nSummary:\n');
  let cursor = 0;
  const first = capture.readFrom(cursor);
  cursor = first.cursor;
  assert.equal(first.text, '1.000 1 1 I Lynx : marker\nSummary:\n');
  capture.append('30026 of com.lynx.tasm.behavior.PaintingContext$a (30026 unique instances)\n');
  const second = capture.readFrom(cursor);
  assert.match(second.text, /30026 of com\.lynx/);
  assert.match(capture.snapshot(), /Summary:\n30026 of com\.lynx/);
  capture.reset();
  assert.equal(capture.snapshot(), '');
});

test('without an adapter the harness still explains itself instead of proxying', async () => {
  await assert.rejects(() => runNativeHarness(), /no device adapter is wired/);
  await assert.rejects(() => runNativeHarness({}), /no device adapter is wired/);
});

test('sandbox adapter imports without the device-only connector installed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-connector-receipt-'));
  const priorSerial = process.env.LYNX_SANDBOX_SERIAL;
  const priorLeaseReceipt = process.env.LYNX_SANDBOX_LEASE_RECEIPT;
  delete process.env.LYNX_SANDBOX_SERIAL;
  delete process.env.LYNX_SANDBOX_LEASE_RECEIPT;
  try {
    const {
      assertRuntimeConnectorPackageTrees,
      default: createAdapter,
      findExplorerClient,
    } = await import('../adapters/lynx-sandbox-android.mjs');
    const unavailable = resolveConnectorPackageTrees({
      requireContext: { resolve() { throw new Error('not installed'); } },
    });
    assert.doesNotThrow(() => assertConnectorPackageTrees(
      unavailable, { requireAvailable: false },
    ));
    assert.equal(unavailable.packages.every((receipt) => (
      receipt.available === false
      && receipt.version === null
      && receipt.resolvedPath === null
      && receipt.rootSha256 === null
      && receipt.fileCount === null
      && receipt.byteCount === null
      && typeof receipt.reason === 'string'
    )), true);
    assert.throws(() => assertConnectorPackageTrees(unavailable), /is unavailable/);
    const makeConnectorReceipt = (base) => {
      const packages = CONNECTOR_PACKAGE_NAMES.map((name, index) => {
        const packageRoot = path.join(base, String(index));
        fs.mkdirSync(packageRoot, { recursive: true });
        fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
          name, version: `2.0.${index}`,
        }));
        fs.writeFileSync(path.join(packageRoot, 'index.js'), `module.exports = ${index};`);
        return createPackageTreeReceipt(name, packageRoot);
      });
      const payload = { protocol: CONNECTOR_PACKAGE_TREES_PROTOCOL, packages };
      return { ...payload, sha256: connectorPackageTreesSha256(payload) };
    };
    const expected = makeConnectorReceipt(path.join(dir, 'connector-expected'));
    const runtime = makeConnectorReceipt(path.join(dir, 'connector-runtime'));
    assert.throws(
      () => assertRuntimeConnectorPackageTrees(expected, runtime),
      /does not match campaign receipt/,
    );
    const encodedSerial = encodeURIComponent('sandbox.example:1234');
    assert.equal(findExplorerClient([
      {
        id: `${encodedSerial}:8901`,
        info: { AppProcessName: 'com.ss.android.cardi' },
      },
      {
        id: `${encodedSerial}:8903`,
        info: { AppProcessName: 'com.lynx.explorer', debugRouterId: 'new-router' },
      },
    ], encodedSerial)?.id, `${encodedSerial}:8903`);
    await assert.rejects(() => createAdapter(), /requires LYNX_SANDBOX_SERIAL/);
    process.env.LYNX_SANDBOX_SERIAL = 'reused-device:1234';
    await assert.rejects(() => createAdapter(), /Native lease receipt/);
  } finally {
    if (priorSerial === undefined) delete process.env.LYNX_SANDBOX_SERIAL;
    else process.env.LYNX_SANDBOX_SERIAL = priorSerial;
    if (priorLeaseReceipt === undefined) delete process.env.LYNX_SANDBOX_LEASE_RECEIPT;
    else process.env.LYNX_SANDBOX_LEASE_RECEIPT = priorLeaseReceipt;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
