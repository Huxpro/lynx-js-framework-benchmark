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
  nativeDescribedText,
  isNativeTransientTransportFailure,
  nativeDescendantWithClass,
  nativeInnerText,
  nativeNodeHasClass,
  nativeStartupPayloadIsComplete,
  nativeTransportFailureDnf,
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
  NativeLeaseExpiryStop,
  loadNativeAdapter,
  runNativeHarness,
  runNativeMatrix,
} from './harness-native.mjs';
import {
  NATIVE_TABLE_BOUNDARY,
  NATIVE_TABLE_SETTLEMENT_CONTRACT,
} from './native-inputs.mjs';

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

async function captureRejection(action, predicate) {
  try {
    await action();
  } catch (error) {
    assert.equal(predicate(error), true);
    return error;
  }
  assert.fail('Missing expected rejection.');
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
  assert.equal(create1k.boundary, NATIVE_TABLE_BOUNDARY);
  assert.equal(create1k.settlementContract, NATIVE_TABLE_SETTLEMENT_CONTRACT);
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

test('known exhausted transport failures persist the exact DNF cell then checkpoint', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-transport-dnf-'));
  const { entry, snapshots } = fakeEntry(dir);
  const adapter = mockAdapter({ calls: [], collect: [], startup: [] });
  adapter.driveCase = async () => {
    throw new Error('No response found for clientId: device');
  };
  adapter.classifyFailure = async (error, context) => ({
    dnf: true,
    checkpointAfterCell: true,
    failure: {
      category: 'transport-retries-exhausted',
      workload: context.kase.name,
      message: String(error),
    },
  });
  const checkpoints = [];
  const stopped = await captureRejection(() => runNativeMatrix({
      adapter,
      entries: [entry],
      cases: [{ name: 'create', scales: [1000] }],
      suites: ['table'],
      scales: [1000],
      reps: 2,
      bundleSnapshots: snapshots,
      onProgress: async (partial) => checkpoints.push(structuredClone(partial)),
    }), (error) => error instanceof NativeLeaseExpiryStop
      && error.reason === 'transport-failure');
  const records = stopped.records;
  assert.equal(records.length, 1);
  assert.equal(records[0].n, 0);
  assert.equal(records[0].dnfCount, 2);
  assert.deepEqual(records[0].failures.map((failure) => failure.category), [
    'transport-retries-exhausted', 'transport-retries-exhausted',
  ]);
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0][0].dnfCount, 2);
});

test('table loadBundle transport exhaustion maps to the first pending cell and checkpoints', async () => {
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
  const stopped = await captureRejection(() => runNativeMatrix({
      adapter,
      entries: [entry],
      cases: [{ name: 'create', scales: [1000, 3000, 5000] }],
      suites: ['table'],
      scales: [1000, 3000, 5000],
      reps: 1,
      bundleSnapshots: snapshots,
      existingCellKeys: new Set(['fake|table|create|1000|latency']),
    }), (error) => error instanceof NativeLeaseExpiryStop
      && error.reason === 'transport-failure');
  const records = stopped.records;

  assert.deepEqual(records.map((record) => record.scale), [3000]);
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
  assert.deepEqual(
    calls.filter(([method]) => method === 'driveCase'),
    [],
  );
});

test('startup loadBundle transport exhaustion checkpoints an atomic DNF pair', async () => {
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
  const stopped = await captureRejection(() => runNativeMatrix({
      adapter,
      entries: [entry],
      cases: [],
      suites: ['startup'],
      startupScales: [0, 1000],
      startupReps: 1,
      bundleSnapshots: snapshots,
      onProgress: async (partial) => checkpoints.push(structuredClone(partial)),
    }), (error) => error instanceof NativeLeaseExpiryStop
      && error.reason === 'transport-failure');
  const records = stopped.records;

  assert.deepEqual(checkpoints.map((checkpoint) => checkpoint.length), [2]);
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
    calls.filter(([method]) => method === 'loadBundle').map(([, rows]) => rows),
    [0, 0, 0],
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
    isNativeTransientTransportFailure(new Error('timeout waiting for Native timing create.')),
    true,
  );
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

test('Native DOM text prefers populated raw values over an empty compatibility field', () => {
  assert.equal(nativeInnerText({
    innerText: '',
    rawTextValues: [{ text: '1001' }],
  }), '1001');
  assert.equal(nativeInnerText({
    innerText: '',
    rawTextValues: [{ text: '1' }, { text: 'selected row' }],
  }), '1 selected row');
  assert.equal(nativeInnerText({
    result: { innerText: '', rawTextValues: [{ text: '1001' }] },
  }), '1001');
  assert.equal(nativeInnerText({ innerText: 'fallback' }), 'fallback');
});

test('Native selected-row inspection resolves the id text inside the external row subtree', () => {
  const described = {
    compress: false,
    node: {
      nodeId: 117,
      attributes: ['class', 'row danger'],
      children: [{
        nodeId: 118,
        attributes: ['class', 'col-id'],
        children: [{ nodeId: 119, attributes: ['text', '6'] }],
      }, {
        nodeId: 120,
        attributes: ['class', 'col-label'],
      }],
    },
  };
  assert.equal(nativeDescendantWithClass(described, 'col-id'), 118);
  assert.equal(nativeDescendantWithClass(described, 'missing'), null);
  assert.equal(nativeNodeHasClass(described.node, 'row'), true);
  assert.equal(nativeNodeHasClass(described.node, 'danger'), true);
  assert.equal(nativeNodeHasClass(described.node, 'rows'), false);
});

test('Native text inspection reads the rendered text attribute exposed by describeNode', () => {
  assert.equal(nativeDescribedText({
    node: {
      nodeId: 8038,
      nodeName: 'TEXT',
      localName: 'text',
      attributes: ['vue-ref-14090', '1', 'text', '1001', 'class', 'col-id'],
      children: [],
    },
  }), '1001');
  assert.equal(nativeDescribedText({
    node: { children: [{ nodeValue: 'nested text' }] },
  }), 'nested text');
});

test('startup polling ignores an in-flight producer receipt until its second frame', () => {
  assert.equal(nativeStartupPayloadIsComplete(null), false);
  assert.equal(nativeStartupPayloadIsComplete({
    protocol: 'lynx-native-startup-v1',
    moduleStartMs: 1,
  }), false);
  assert.equal(nativeStartupPayloadIsComplete({
    protocol: 'lynx-native-startup-v1',
    moduleStartMs: 1,
    firstFrameMs: 2,
    secondFrameMs: 3,
  }), true);
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

test('startup producers use the entry-specific published metric contract', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-startup-contract-'));
  const { entry, snapshots } = fakeEntry(dir, { id: 'octane', framework: 'octane' });
  const adapter = mockAdapter({
    calls: [],
    collect: [],
    startup: [{
      metrics: {
        octaneCommitAck: {
          value: 1,
          unit: 'ms',
          boundary: 'native-open-request-to-octane-transport-ack',
        },
        octaneSecondFrame: {
          value: 2,
          unit: 'ms',
          boundary: 'native-open-request-to-second-frame-after-octane-transport-ack',
        },
      },
    }],
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
  assert.deepEqual(records.map(({ metric }) => metric), ['octaneCommitAck', 'octaneSecondFrame']);
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
