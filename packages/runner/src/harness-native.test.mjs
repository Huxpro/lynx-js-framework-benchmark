// The native harness must be drivable end to end by any adapter that honors
// the documented contract, without this repository ever registering a proxy
// adapter of its own (docs/METHODOLOGY.md "Harness separation").
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TransformStream } from 'node:stream/web';
import test from 'node:test';

import { COMPARABILITY_KEYS } from '@lynx-bench/shared/schema';

import {
  NATIVE_STARTUP_PROTOCOL,
  NATIVE_TABLE_PROTOCOL,
  NATIVE_TABLE_RESULT_MARKER,
  installedPackageSha256,
  parseNativeTimingConsoleArgs,
  physicalDeviceFingerprint,
  validateNativeStartupPayload,
  validateNativeTimingPayload,
} from '../adapters/lynx-sandbox-android.mjs';
import { loadNativeAdapter, runNativeHarness, runNativeMatrix } from './harness-native.mjs';
import { materializeNativeBundleSnapshots } from './native-inputs.mjs';

const CASES = [
  { name: 'create', scales: [1000, 10000] },
  { name: 'clear', scales: [10000] },
];

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const RAW_DID = 'did-one';
const PHYSICAL_DEVICE_ID = sha256(RAW_DID);
const LEASE_ID = sha256('serial');
const APP_APK_SHA256 = sha256('lynx-explorer-apk');

test('Native startup payload requires the exact protocol and ordered real frame timestamps', () => {
  const payload = {
    protocol: NATIVE_STARTUP_PROTOCOL,
    moduleStartMs: 110,
    mountEndMs: 120,
    firstFrameMs: 135,
    secondFrameMs: 150,
  };
  assert.equal(validateNativeStartupPayload(payload, 100), payload);
  assert.throws(
    () => validateNativeStartupPayload({ ...payload, protocol: 'wrong' }, 100),
    /must declare protocol/,
  );
  assert.throws(
    () => validateNativeStartupPayload({ ...payload, firstFrameMs: 119 }, 100),
    /timestamp ordering/,
  );
  assert.throws(
    () => validateNativeStartupPayload({ ...payload, moduleStartMs: 99 }, 100),
    /timestamp ordering/,
  );
  assert.throws(
    () => validateNativeStartupPayload({ ...payload, secondFrameMs: null }, 100),
    /invalid secondFrameMs/,
  );
});

test('physical device identity hashes DID or stable Android serial without persisting raw IDs', () => {
  assert.equal(
    physicalDeviceFingerprint({ did: RAW_DID }, 'lease', () => {
      throw new Error('ADB fallback must not run when DID exists');
    }),
    sha256(RAW_DID),
  );
  const calls = [];
  assert.equal(
    physicalDeviceFingerprint({}, 'lease', (_serial, ...args) => {
      calls.push(args);
      return args.at(-1) === 'ro.serialno' ? 'physical-serial' : '';
    }),
    sha256('android-property:ro.serialno:physical-serial'),
  );
  assert.deepEqual(calls, [['shell', 'getprop', 'ro.serialno']]);
  assert.throws(
    () => physicalDeviceFingerprint({}, 'lease', () => ''),
    /lack a stable physical identity/,
  );
});

test('installed package identity requires one APK and verifies its SHA-256', () => {
  const calls = [];
  assert.equal(
    installedPackageSha256('lease', 'com.lynx.explorer', (_serial, ...args) => {
      calls.push(args);
      if (args.join(' ') === 'shell pm path com.lynx.explorer') {
        return 'package:/data/app/com.lynx.explorer/base.apk';
      }
      if (args.join(' ') === 'shell sha256sum /data/app/com.lynx.explorer/base.apk') {
        return `${APP_APK_SHA256}  /data/app/com.lynx.explorer/base.apk`;
      }
      return '';
    }),
    APP_APK_SHA256,
  );
  assert.deepEqual(calls, [
    ['shell', 'pm', 'path', 'com.lynx.explorer'],
    ['shell', 'sha256sum', '/data/app/com.lynx.explorer/base.apk'],
  ]);
  assert.throws(
    () => installedPackageSha256('lease', 'com.lynx.explorer', () => ''),
    /exactly one installed APK/,
  );
  assert.throws(
    () => installedPackageSha256(
      'lease',
      'com.lynx.explorer',
      (_serial, ...args) => args.includes('path')
        ? 'package:/data/app/com.lynx.explorer/base.apk'
        : 'invalid',
    ),
    /could not verify installed APK SHA-256/,
  );
});

const MACHINE = {
  id: PHYSICAL_DEVICE_ID,
  platform: 'android',
  osVersion: '10',
  cpuModel: 'board',
  cores: 8,
  deviceModel: 'test-device',
  app: 'LynxExplorer',
  appVersion: '1.0',
  sdkVersion: '3.4.0',
  debugRouterVersion: '0.0.1',
  agentLynxVersion: '0.14.4',
  appApkSha256: APP_APK_SHA256,
  physicalDeviceId: PHYSICAL_DEVICE_ID,
  leaseId: LEASE_ID,
};

function fakeEntry(dir) {
  for (const rows of [0, 1000]) {
    const dist = path.join(dir, 'dist', `rows-${rows}`);
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(
      path.join(dist, 'main.lynx.bundle'),
      '__NATIVE_BENCH_RESULT__ vue-lynx-native-bench-v1',
    );
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
    machine: MACHINE,
    calls: script.calls,
    async loadBundle(entry, { rows, bundlePath, bundleBytes }) {
      script.calls.push([
        'loadBundle',
        entry.id,
        rows,
        fs.existsSync(bundlePath),
        bundleBytes.toString(),
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

test('sandbox timing payload validation enforces the versioned producer contract', () => {
  const valid = {
    protocol: NATIVE_TABLE_PROTOCOL,
    name: 'create',
    startMs: 10,
    endMs: 25,
    latencyMs: 15,
  };
  assert.deepEqual(
    parseNativeTimingConsoleArgs([
      { value: NATIVE_TABLE_RESULT_MARKER },
      { value: JSON.stringify(valid) },
    ], {
      currentEntryId: 'react',
      expectedName: 'create',
    }),
    valid,
  );
  assert.equal(
    parseNativeTimingConsoleArgs([
      { value: `prefix-${NATIVE_TABLE_RESULT_MARKER}` },
      { value: JSON.stringify(valid) },
    ], {
      currentEntryId: 'react',
      expectedName: 'create',
    }),
    null,
  );
  assert.equal(
    parseNativeTimingConsoleArgs([
      { value: 'unrelated' },
      { value: NATIVE_TABLE_RESULT_MARKER },
      { value: JSON.stringify(valid) },
    ], {
      currentEntryId: 'react',
      expectedName: 'create',
    }),
    null,
  );
  for (const [label, payload, expected] of [
    [
      'missing protocol',
      { name: 'create', startMs: 10, endMs: 25, latencyMs: 15 },
      /must declare protocol/,
    ],
    [
      'wrong protocol',
      { ...valid, protocol: 'wrong' },
      /must declare protocol/,
    ],
    [
      'wrong name',
      { ...valid, name: 'clear' },
      /does not match expected/,
    ],
    [
      'non-finite start',
      { ...valid, startMs: Number.NaN },
      /invalid startMs/,
    ],
    [
      'negative ordering',
      { ...valid, startMs: 25, endMs: 10, latencyMs: -15 },
      /invalid timestamp ordering/,
    ],
    [
      'inconsistent timestamps',
      { ...valid, latencyMs: 14 },
      /inconsistent timestamps/,
    ],
  ]) {
    assert.throws(
      () => validateNativeTimingPayload(payload, {
        currentEntryId: 'react',
        expectedName: 'create',
      }),
      expected,
      label,
    );
  }
  const octaneLegacy = {
    name: 'create',
    startMs: 10,
    endMs: 25,
    latencyMs: 15,
  };
  assert.deepEqual(
    validateNativeTimingPayload(octaneLegacy, {
      currentEntryId: 'octane',
      expectedName: 'create',
    }),
    octaneLegacy,
  );
  assert.throws(
    () => validateNativeTimingPayload(
      { ...octaneLegacy, protocol: 'wrong' },
      { currentEntryId: 'octane', expectedName: 'create' },
    ),
    /must declare protocol/,
  );
});

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
      { fcpMs: 50 },
    ],
  };
  const materialized = materializeNativeBundleSnapshots({
    entries: [entry],
    suites: ['table', 'startup'],
    startupScales: [0, 1000],
  });
  const records = await runNativeMatrix({
    adapter: mockAdapter(script),
    bundleSnapshots: materialized.snapshots,
    entries: [entry],
    cases: CASES,
    scales: [1000, 10000],
    startupScales: [0, 1000],
    reps: 3,
    startupReps: 1,
  });
  materialized.dispose();

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

  // No record may claim web comparability.
  for (const record of records) {
    assert.equal(record.harness, 'native');
    assert.notEqual(record.environment, 'lynx-for-web');
  }
});

test('adapter modules are validated against the documented contract', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-adapter-'));
  const good = path.join(dir, 'good.mjs');
  fs.writeFileSync(
    good,
    `export default () => ({
      environment: 'lynx-native-mock-sim',
      machine: ${JSON.stringify(MACHINE)},
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
      machine: ${JSON.stringify(MACHINE)},
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

test('adapter contract validation disposes a returned invalid adapter', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-adapter-dispose-'));
  try {
    const disposed = path.join(dir, 'disposed');
    const invalid = path.join(dir, 'invalid.mjs');
    fs.writeFileSync(
      invalid,
      `import fs from 'node:fs';
      export default () => ({
        environment: 'lynx-for-web',
        machine: ${JSON.stringify(MACHINE)},
        loadBundle: async () => {},
        driveCase: async () => {},
        collect: async () => ({}),
        collectStartup: async () => ({}),
        dispose: async () => fs.appendFileSync(${JSON.stringify(disposed)}, 'disposed\\n'),
      });`,
    );
    await assert.rejects(() => loadNativeAdapter(invalid), /never comparable/);
    assert.equal(fs.readFileSync(disposed, 'utf8'), 'disposed\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('invalid adapter.machine is disposed before any device action', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-adapter-machine-'));
  try {
    const actions = path.join(dir, 'actions');
    const invalid = path.join(dir, 'invalid-machine.mjs');
    fs.writeFileSync(
      invalid,
      `import fs from 'node:fs';
      export default () => ({
        environment: 'lynx-native-mock-sim',
        machine: {
          id: ${JSON.stringify(PHYSICAL_DEVICE_ID)},
          physicalDeviceId: ${JSON.stringify(PHYSICAL_DEVICE_ID)},
          leaseId: ${JSON.stringify(LEASE_ID)},
        },
        loadBundle: async () => fs.appendFileSync(${JSON.stringify(actions)}, 'load\\n'),
        driveCase: async () => fs.appendFileSync(${JSON.stringify(actions)}, 'drive\\n'),
        collect: async () => ({}),
        collectStartup: async () => ({}),
        dispose: async () => fs.appendFileSync(${JSON.stringify(actions)}, 'dispose\\n'),
      });`,
    );
    await assert.rejects(
      () => runNativeHarness({
        adapterPath: invalid,
        entries: [],
        cases: [],
        suites: [],
        scales: [],
        startupScales: [],
        bundleSnapshots: new Map(),
      }),
      /machine\.platform/,
    );
    assert.equal(fs.readFileSync(actions, 'utf8'), 'dispose\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('adapter.machine requires every Native comparability field', async (t) => {
  const required = [
    'id',
    'platform',
    'osVersion',
    'cpuModel',
    'cores',
    'deviceModel',
    'app',
    'appVersion',
    'sdkVersion',
    'debugRouterVersion',
    'agentLynxVersion',
    'appApkSha256',
    'physicalDeviceId',
    'leaseId',
  ];
  for (const field of required) {
    await t.test(field, async () => {
      const machine = { ...MACHINE };
      delete machine[field];
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-machine-field-'));
      try {
        const adapterPath = path.join(dir, `${field}.mjs`);
        fs.writeFileSync(
          adapterPath,
          `export default () => ({
            environment: 'lynx-native-mock-sim',
            machine: ${JSON.stringify(machine)},
            loadBundle: async () => {},
            driveCase: async () => {},
            collect: async () => ({}),
            collectStartup: async () => ({}),
            dispose: async () => {},
          });`,
        );
        await assert.rejects(
          () => loadNativeAdapter(adapterPath),
          new RegExp(`machine\\.${field}`),
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

test('without an adapter the harness still explains itself instead of proxying', async () => {
  await assert.rejects(() => runNativeHarness(), /no device adapter is wired/);
  await assert.rejects(() => runNativeHarness({}), /no device adapter is wired/);
});

test('sandbox adapter imports without the device-only connector installed', async () => {
  const priorSerial = process.env.LYNX_SANDBOX_SERIAL;
  delete process.env.LYNX_SANDBOX_SERIAL;
  try {
    const { default: createAdapter } = await import('../adapters/lynx-sandbox-android.mjs');
    await assert.rejects(() => createAdapter(), /requires LYNX_SANDBOX_SERIAL/);
  } finally {
    if (priorSerial === undefined) delete process.env.LYNX_SANDBOX_SERIAL;
    else process.env.LYNX_SANDBOX_SERIAL = priorSerial;
  }
});

test('30k rendered-row grace is explicit, bounded, and leaves smaller rows unchanged', async () => {
  const { nativeRenderGraceMs } =
    await import('../adapters/lynx-sandbox-android.mjs');
  assert.equal(nativeRenderGraceMs(1000, 30_000, {}), 500);
  assert.equal(nativeRenderGraceMs(10000, 30_000, {}), 5_000);
  assert.equal(nativeRenderGraceMs(30000, 30_000, {}), 15_000);
  assert.equal(nativeRenderGraceMs(30000, 1_800_000, {
    LYNX_SANDBOX_RENDER_GRACE_30K_MS: '1200000',
  }), 1_200_000);
  assert.equal(nativeRenderGraceMs(30000, 600_000, {
    LYNX_SANDBOX_RENDER_GRACE_30K_MS: '1200000',
  }), 600_000);
  assert.throws(
    () => nativeRenderGraceMs(30000, 30_000, {
      LYNX_SANDBOX_RENDER_GRACE_30K_MS: '-1',
    }),
    /invalid LYNX_SANDBOX_RENDER_GRACE_30K_MS/,
  );
});

test('sandbox adapter cleans initialized resources on every tested initialization failure', async (t) => {
  const { createLynxSandboxAndroidAdapter } =
    await import('../adapters/lynx-sandbox-android.mjs');
  const failurePoints = [
    'reverse',
    'launch',
    'listClients',
    'clientTimeout',
    'globalSwitch',
    'clock',
    'apk',
    'machine',
  ];

  for (const failurePoint of failurePoints) {
    await t.test(failurePoint, async () => {
      const calls = [];
      let closeCount = 0;
      const runAdb = (_serial, ...args) => {
        calls.push(args);
        const key = args.join(' ');
        if (failurePoint === 'reverse' && key === 'reverse tcp:8765 tcp:8765') {
          throw new Error('reverse failed');
        }
        if (
          failurePoint === 'launch'
          && key === 'shell am start -n com.lynx.explorer/.LynxViewShellActivity'
        ) {
          throw new Error('launch failed');
        }
        if (failurePoint === 'apk' && key === 'shell pm path com.lynx.explorer') {
          throw new Error('apk failed');
        }
        if (failurePoint === 'machine' && key === 'shell getprop ro.product.board') {
          throw new Error('machine failed');
        }
        if (key === 'shell pm path com.lynx.explorer') {
          return 'package:/data/app/com.lynx.explorer/base.apk';
        }
        if (key === 'shell sha256sum /data/app/com.lynx.explorer/base.apk') {
          return `${APP_APK_SHA256}  /data/app/com.lynx.explorer/base.apk`;
        }
        if (key === 'shell getprop ro.product.board') return 'board';
        if (key === 'shell nproc') return '8';
        return '';
      };
      const connector = {
        async listClients() {
          if (failurePoint === 'listClients') throw new Error('list failed');
          if (failurePoint === 'clientTimeout') return [];
          return [{
            id: 'serial:',
            info: {
              AppProcessName: 'com.lynx.explorer',
              App: 'LynxExplorer',
              AppVersion: '1.0',
              sdkVersion: '3.4.0',
              debugRouterVersion: '0.0.1',
              deviceModel: 'test-device',
              osVersion: '10',
              did: RAW_DID,
            },
          }];
        },
        async setGlobalSwitch() {
          if (failurePoint === 'globalSwitch') throw new Error('switch failed');
        },
      };
      let currentTime = 0;
      const expectedError = failurePoint === 'globalSwitch' ? /switch failed/
        : failurePoint === 'listClients' ? /list failed/
          : failurePoint === 'clientTimeout' ? /leased device/
            : new RegExp(`${failurePoint} failed`);
      await assert.rejects(
        () => createLynxSandboxAndroidAdapter({}, {
          env: { LYNX_SANDBOX_SERIAL: 'serial' },
          loadConnector: async () => () => connector,
          runAdb,
          calibrateClock: () => {
            if (failurePoint === 'clock') throw new Error('clock failed');
            return { offsetMs: 0, rttMs: 1 };
          },
          startServer: async () => ({
            close(callback) {
              closeCount++;
              callback();
            },
          }),
          wait: async () => {},
          ...(failurePoint === 'clientTimeout' ? {
            now: () => {
              currentTime += 30_001;
              return currentTime;
            },
          } : {}),
        }),
        expectedError,
      );
      assert.equal(closeCount, 1);
      assert.equal(
        calls.filter((args) => args.join(' ') === 'reverse --remove tcp:8765').length,
        1,
      );
    });
  }
});

test('sandbox adapter dispose is idempotent', async () => {
  const { createLynxSandboxAndroidAdapter } =
    await import('../adapters/lynx-sandbox-android.mjs');
  const calls = [];
  let closeCount = 0;
  const adapter = await createLynxSandboxAndroidAdapter({}, {
    env: { LYNX_SANDBOX_SERIAL: 'serial' },
    loadConnector: async () => () => ({
      async listClients() {
        return [{
          id: 'serial:',
          info: {
            AppProcessName: 'com.lynx.explorer',
            App: 'LynxExplorer',
            AppVersion: '1.0',
            sdkVersion: '3.4.0',
            debugRouterVersion: '0.0.1',
            deviceModel: 'test-device',
            osVersion: '10',
            did: RAW_DID,
          },
        }];
      },
      async setGlobalSwitch() {},
    }),
    runAdb: (_serial, ...args) => {
      calls.push(args);
      if (args.join(' ') === 'shell getprop ro.product.board') return 'board';
      if (args.join(' ') === 'shell nproc') return '8';
      if (args.join(' ') === 'shell pm path com.lynx.explorer') {
        return 'package:/data/app/com.lynx.explorer/base.apk';
      }
      if (args.join(' ') === 'shell sha256sum /data/app/com.lynx.explorer/base.apk') {
        return `${APP_APK_SHA256}  /data/app/com.lynx.explorer/base.apk`;
      }
      return '';
    },
    calibrateClock: () => ({ offsetMs: 0, rttMs: 1 }),
    startServer: async () => ({
      close(callback) {
        closeCount++;
        callback();
      },
    }),
    wait: async () => {},
  });

  await Promise.all([adapter.dispose(), adapter.dispose()]);
  await adapter.dispose();
  assert.equal(closeCount, 1);
  assert.equal(
    calls.filter((args) => args.join(' ') === 'reverse --remove tcp:8765').length,
    1,
  );
  assert.equal(adapter.machine.physicalDeviceId, PHYSICAL_DEVICE_ID);
  assert.equal(adapter.machine.id, PHYSICAL_DEVICE_ID);
  assert.equal(adapter.machine.sdkVersion, '3.4.0');
  assert.equal(adapter.machine.appApkSha256, APP_APK_SHA256);
  assert.equal(adapter.machine.leaseId, LEASE_ID);
  assert.equal(JSON.stringify(adapter.machine).includes(RAW_DID), false);
});

test('sandbox adapter consumes immutable bundle bytes and reverse removal is best effort', async () => {
  const { createLynxSandboxAndroidAdapter } =
    await import('../adapters/lynx-sandbox-android.mjs');
  let currentUrl = null;
  let getBundleBytes = null;
  let closeCount = 0;
  let streamCount = 0;
  const streamMethods = [];
  const adapter = await createLynxSandboxAndroidAdapter({}, {
    env: { LYNX_SANDBOX_SERIAL: 'serial' },
    loadConnector: async () => () => ({
      async listClients() {
        return [{
          id: 'serial:',
          info: {
            AppProcessName: 'com.lynx.explorer',
            App: 'LynxExplorer',
            AppVersion: '1.0',
            sdkVersion: '3.4.0',
            debugRouterVersion: '0.0.1',
            deviceModel: 'test-device',
            osVersion: '10',
            did: RAW_DID,
          },
        }];
      },
      async setGlobalSwitch() {},
      async openPage(_clientId, url) {
        currentUrl = url;
      },
      async sendListSessionMessage() {
        return [{ session_id: 1, type: 'lynx', url: currentUrl }];
      },
      async sendCDPMessage(_clientId, _sessionId, method, params) {
        if (method === 'DOM.setEventDelivery') {
          assert.equal(typeof params.enabled, 'boolean');
          return {};
        }
        throw new Error(`unexpected one-shot CDP method: ${method}`);
      },
      async sendCDPStream(_clientId, _sessionId, input) {
        streamCount++;
        const output = new TransformStream();
        const writer = output.writable.getWriter();
        void (async () => {
          const reader = input.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (Number.isInteger(value.id)) {
                streamMethods.push(value.method);
                const result = value.method === 'DOM.performSearch'
                  ? { searchId: 'rows', resultCount: 30000 }
                  : {};
                if (value.method === 'DOM.performSearch') {
                  assert.equal(value.params.countOnly, true);
                }
                await writer.write({ id: value.id, result });
              }
            }
          } finally {
            reader.releaseLock();
            await writer.close();
            writer.releaseLock();
          }
        })();
        return output.readable;
      },
    }),
    runAdb: (_serial, ...args) => {
      const command = args.join(' ');
      if (
        command.startsWith(
          'shell am start -n com.lynx.explorer/.LynxViewShellActivity --es url ',
        )
      ) {
        currentUrl = args.at(-1);
      }
      if (command === 'shell getprop ro.product.board') return 'board';
      if (command === 'shell nproc') return '8';
      if (command === 'shell pm path com.lynx.explorer') {
        return 'package:/data/app/com.lynx.explorer/base.apk';
      }
      if (command === 'shell sha256sum /data/app/com.lynx.explorer/base.apk') {
        return `${APP_APK_SHA256}  /data/app/com.lynx.explorer/base.apk`;
      }
      if (command === 'reverse --remove tcp:8765') throw new Error('lease gone');
      return '';
    },
    calibrateClock: () => ({ offsetMs: 0, rttMs: 1 }),
    startServer: async (_port, getter) => {
      getBundleBytes = getter;
      return {
        close(callback) {
          closeCount++;
          callback();
        },
      };
    },
    wait: async () => {},
  });
  const bytes = Buffer.from('immutable-snapshot');
  await adapter.loadBundle(
    { id: 'fake' },
    { rows: 30000, bundleBytes: bytes, suite: 'count-only' },
  );
  assert.equal(streamCount, 0);
  bytes.fill(0);
  assert.equal(getBundleBytes().toString(), 'immutable-snapshot');
  assert.equal(await adapter.assertRenderedRows(30000), 30000);
  assert.equal(streamCount, 1);
  assert.deepEqual(streamMethods, [
    'DOM.performSearch',
    'DOM.setEventDelivery',
  ]);
  await assert.doesNotReject(() => adapter.dispose());
  assert.equal(closeCount, 1);
});

test('sandbox adapter performs the Agent Lynx console handshake before table suppression', async () => {
  const { createLynxSandboxAndroidAdapter } =
    await import('../adapters/lynx-sandbox-android.mjs');
  let currentUrl = null;
  const streamMethods = [];
  const adapter = await createLynxSandboxAndroidAdapter({}, {
    env: { LYNX_SANDBOX_SERIAL: 'serial' },
    loadConnector: async () => () => ({
      async listClients() {
        return [{
          id: 'serial:',
          info: {
            AppProcessName: 'com.lynx.explorer',
            App: 'LynxExplorer',
            AppVersion: '1.0',
            sdkVersion: '3.4.0',
            debugRouterVersion: '0.0.1',
            deviceModel: 'test-device',
            osVersion: '10',
            did: RAW_DID,
          },
        }];
      },
      async setGlobalSwitch() {},
      async sendListSessionMessage() {
        return [{ session_id: 1, type: 'lynx', url: currentUrl }];
      },
      async sendCDPStream(_clientId, _sessionId, input) {
        const output = new TransformStream();
        const writer = output.writable.getWriter();
        void (async () => {
          const reader = input.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (!Number.isInteger(value.id)) continue;
              streamMethods.push(value.method);
              const result = value.method === 'Page.getResourceTree'
                ? { frameTree: { frame: {}, resources: [] } }
                : {};
              await writer.write({ id: value.id, result });
            }
          } finally {
            reader.releaseLock();
            await writer.close();
            writer.releaseLock();
          }
        })();
        return output.readable;
      },
    }),
    runAdb: (_serial, ...args) => {
      const command = args.join(' ');
      if (
        command.startsWith(
          'shell am start -n com.lynx.explorer/.LynxViewShellActivity --es url ',
        )
      ) {
        currentUrl = args.at(-1);
      }
      if (command === 'shell getprop ro.product.board') return 'board';
      if (command === 'shell nproc') return '8';
      if (command === 'shell pm path com.lynx.explorer') {
        return 'package:/data/app/com.lynx.explorer/base.apk';
      }
      if (command === 'shell sha256sum /data/app/com.lynx.explorer/base.apk') {
        return `${APP_APK_SHA256}  /data/app/com.lynx.explorer/base.apk`;
      }
      return '';
    },
    calibrateClock: () => ({ offsetMs: 0, rttMs: 1 }),
    startServer: async () => ({
      close(callback) {
        callback();
      },
    }),
    wait: async () => {},
  });

  await adapter.loadBundle(
    { id: 'fake' },
    { rows: 0, bundleBytes: Buffer.from('immutable-snapshot'), suite: 'table' },
  );
  assert.deepEqual(streamMethods, [
    'Page.enable',
    'Page.getResourceTree',
    'Debugger.enable',
    'Runtime.enable',
    'DOM.setEventDelivery',
  ]);
  await adapter.dispose();
});
