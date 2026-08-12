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
      { fcpMs: 50 },
    ],
  };
  const records = await runNativeMatrix({
    adapter: mockAdapter(script),
    entries: [entry],
    cases: CASES,
    scales: [1000, 10000],
    reps: 3,
    startupReps: 1,
  });

  const create1k = records.find(
    (r) => r.workload === 'create' && r.scale === 1000 && r.metric === 'latency',
  );
  assert.equal(create1k.harness, 'native');
  assert.equal(create1k.environment, 'lynx-native-mock-sim');
  assert.equal(create1k.boundary, 'tap-to-timing-pipeline');
  assert.equal(create1k.n, 2);
  assert.equal(create1k.dnfCount, 1);
  for (const key of COMPARABILITY_KEYS) assert.ok(key in create1k, key);

  const wire = records.find((r) => r.metric === 'nativeWireBytes');
  assert.equal(wire.boundary, 'engine-wire');
  assert.equal(wire.unit, 'B');
  assert.equal(wire.median, 640);

  const startupFcp = records.find((r) => r.workload === 'startup' && r.scale === 0);
  assert.equal(startupFcp.metric, 'fcp');
  assert.equal(startupFcp.boundary, 'load-to-first-timing-pipeline');
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
