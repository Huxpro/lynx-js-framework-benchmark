import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildNativeListCampaign,
  loadNativeListAdapter,
  runNativeListHarness,
} from './harness-native.mjs';
import {
  assertNativeListInputsUnchanged,
  NATIVE_LIST_INPUT_RECEIPT_VERSION,
  snapshotNativeListInputs,
} from './native-inputs.mjs';
import { stringifyResult } from './result-json.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ENTRY_ID = 'octane-native-diagnostic';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-list-integration-'));
  const realEntryDir = path.join(ROOT, 'entries', ENTRY_ID);
  const entryDir = path.join(root, 'entries', ENTRY_ID);
  const distDir = path.join(entryDir, 'dist');
  fs.mkdirSync(entryDir, { recursive: true });
  fs.copyFileSync(path.join(realEntryDir, 'entry.json'), path.join(entryDir, 'entry.json'));
  for (const scale of [1_000, 10_000]) {
    const relative = `list/rows-${scale}/main.lynx.bundle`;
    const destination = path.join(distDir, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(realEntryDir, 'dist', relative), destination);
  }
  const entry = {
    ...JSON.parse(fs.readFileSync(path.join(entryDir, 'entry.json'), 'utf8')),
    dir: entryDir,
    distDir,
  };
  const runnerDir = path.join(root, 'packages/runner/src');
  fs.mkdirSync(runnerDir, { recursive: true });
  for (const relative of [
    'cli.mjs',
    'entries.mjs',
    'harness-native.mjs',
    'harness-native-list.mjs',
    'list-coverage.mjs',
    'native-inputs.mjs',
    'result-json.mjs',
  ]) {
    fs.writeFileSync(path.join(runnerDir, relative), `source:${relative}`);
  }
  const sharedDir = path.join(root, 'packages/shared/src');
  fs.mkdirSync(sharedDir, { recursive: true });
  for (const relative of [
    'list-workloads.mjs',
    'native-diagnostic-contract.mjs',
    'schema.mjs',
    'stats.mjs',
  ]) {
    fs.writeFileSync(path.join(sharedDir, relative), `source:${relative}`);
  }
  const adapterPath = path.join(root, 'adapter.mjs');
  fs.writeFileSync(adapterPath, 'export default () => ({})');
  return { root, runnerDir, entry, entryDir, adapterPath };
}

test('Native list inputs pin the exact 1k/10k artifacts, manifest, workload, and runner sources', () => {
  const current = fixture();
  try {
    const inputs = snapshotNativeListInputs({
      entry: current.entry,
      adapterPath: current.adapterPath,
      root: current.root,
    });
    assert.equal(inputs.receipt.version, NATIVE_LIST_INPUT_RECEIPT_VERSION);
    assert.deepEqual(Object.keys(inputs.bundles), ['1000', '10000']);
    assert.equal(inputs.receipt.entryId, ENTRY_ID);
    assert.equal(inputs.receipt.fixtureRole, 'bounded-native-list');
    assert.equal(inputs.receipt.fixtureId, 'octane-lynx-bounded-list-v1');
    assert.equal(inputs.receipt.diagnostic, true);
    assert.equal(inputs.receipt.rankingEligible, false);
    assert.deepEqual(
      Object.fromEntries(Object.entries(inputs.receipt.listFixture.scales)
        .map(([scale, artifact]) => [scale, artifact.bundle])),
      {
        1000: 'dist/list/rows-1000/main.lynx.bundle',
        10000: 'dist/list/rows-10000/main.lynx.bundle',
      },
    );
    assert.equal(
      inputs.receipt.sources['packages/shared/src/list-workloads.mjs'].sha256.length,
      64,
    );
    assert.equal(
      inputs.receipt.sources['packages/runner/src/harness-native-list.mjs'].sha256.length,
      64,
    );
    assert.doesNotThrow(() => assertNativeListInputsUnchanged(inputs));
  } finally {
    fs.rmSync(current.root, { recursive: true, force: true });
  }
});

test('Native list input receipt detects bundle, manifest, and runner-source drift', () => {
  const current = fixture();
  try {
    const initial = snapshotNativeListInputs({
      entry: current.entry,
      adapterPath: current.adapterPath,
      root: current.root,
    });
    initial.bundles['1000'].bundleBytes = Buffer.from('mutated');
    assert.throws(
      () => assertNativeListInputsUnchanged(initial),
      /1000-row Native list bundle mutated in memory/,
    );

    const diskBound = snapshotNativeListInputs({
      entry: current.entry,
      adapterPath: current.adapterPath,
      root: current.root,
    });
    fs.appendFileSync(path.join(current.entryDir, 'entry.json'), '\n');
    assert.throws(
      () => assertNativeListInputsUnchanged(diskBound),
      /Native list input changed on disk/,
    );
    fs.copyFileSync(
      path.join(ROOT, 'entries', ENTRY_ID, 'entry.json'),
      path.join(current.entryDir, 'entry.json'),
    );

    const sourceBound = snapshotNativeListInputs({
      entry: current.entry,
      adapterPath: current.adapterPath,
      root: current.root,
    });
    fs.appendFileSync(path.join(current.runnerDir, 'harness-native-list.mjs'), '\nchanged');
    const changed = snapshotNativeListInputs({
      entry: current.entry,
      adapterPath: current.adapterPath,
      root: current.root,
    });
    assert.notEqual(changed.receipt.sha256, sourceBound.receipt.sha256);
    assert.throws(
      () => assertNativeListInputsUnchanged(sourceBound),
      /Native list input changed on disk/,
    );
  } finally {
    fs.rmSync(current.root, { recursive: true, force: true });
  }
});

test('Native list campaign binds observer, receipt, reportability, and non-ranking identity', () => {
  const current = fixture();
  try {
    const observer = {
      protocol: 'lynx-native-list-allocation-observer-v1',
      methodRevision: 'android-list-items-v1',
      measurementOverhead: {
        boundary: 'observer-enable-through-disable-per-attempt',
        unit: 'ms',
        value: 0.75,
      },
    };
    const inputs = snapshotNativeListInputs({
      entry: current.entry,
      observer,
      adapterPath: current.adapterPath,
      root: current.root,
    });
    const campaign = buildNativeListCampaign({
      inputReceipt: inputs.receipt,
      label: 'aries-10',
    });
    assert.equal(campaign.inputReceiptSha256, inputs.receipt.sha256);
    assert.equal(campaign.fixtureRole, 'bounded-native-list');
    assert.equal(campaign.fixtureId, 'octane-lynx-bounded-list-v1');
    assert.deepEqual(campaign.observer, observer);
    assert.deepEqual(campaign.reportability, {
      protocol: 'accepted-sample-minimum-v1',
      minAcceptedSamples: 5,
    });
    assert.equal(campaign.diagnostic, true);
    assert.equal(campaign.rankingEligible, false);
    assert.equal(campaign.id.length, 16);

    const withoutObserver = snapshotNativeListInputs({
      entry: current.entry,
      adapterPath: current.adapterPath,
      root: current.root,
    });
    const unobserved = buildNativeListCampaign({ inputReceipt: withoutObserver.receipt });
    assert.equal(unobserved.observer, null);
    assert.notEqual(unobserved.inputReceiptSha256, campaign.inputReceiptSha256);
  } finally {
    fs.rmSync(current.root, { recursive: true, force: true });
  }
});

test('Native list adapter modules use a dedicated mode and exact capability contract', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-list-adapter-'));
  try {
    const goodPath = path.join(dir, 'good.mjs');
    fs.writeFileSync(goodPath, `export default async (context) => {
      if (context.mode !== 'list') throw new Error('wrong mode');
      return {
        environment: 'lynx-native-list-device',
        listCapability: {
          protocol: 'lynx-native-list-capability-v1',
          available: true,
          fixtureProtocol: 'lynx-list-fixture-v2',
          observation: 'native-visible-list-cell-tree-v1',
          observerProtocols: [],
        },
        runListCase: async () => ({}),
        dispose: async () => {},
      };
    };`);
    const adapter = await loadNativeListAdapter(goodPath);
    assert.equal(adapter.environment, 'lynx-native-list-device');

    const missingCapability = path.join(dir, 'missing-capability.mjs');
    fs.writeFileSync(missingCapability, `export default async () => ({
      environment: 'lynx-native-list-device',
      runListCase: async () => ({}),
      dispose: async () => {},
    });`);
    assert.equal(
      (await loadNativeListAdapter(missingCapability)).listCapability,
      undefined,
    );

    const missingRunner = path.join(dir, 'missing-runner.mjs');
    fs.writeFileSync(missingRunner, `export default async () => ({
      environment: 'lynx-native-list-device',
      listCapability: {
        protocol: 'lynx-native-list-capability-v1',
        available: true,
        fixtureProtocol: 'lynx-list-fixture-v2',
        observation: 'native-visible-list-cell-tree-v1',
        observerProtocols: [],
      },
      dispose: async () => {},
    });`);
    assert.equal((await loadNativeListAdapter(missingRunner)).runListCase, undefined);

    const unknownCapability = path.join(dir, 'unknown-capability.mjs');
    fs.writeFileSync(unknownCapability, `export default async () => ({
      environment: 'lynx-native-list-device',
      listCapability: { protocol: 'future-native-list-capability-v2' },
      dispose: async () => {},
    });`);
    await assert.rejects(
      () => loadNativeListAdapter(unknownCapability),
      /unknown or malformed listCapability/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('missing Native list capability materializes every cell as not measured without launch', async () => {
  const current = fixture();
  try {
    fs.writeFileSync(current.adapterPath, `export default async (context) => {
      if (context.mode !== 'list') throw new Error('wrong mode');
      return {
        environment: 'lynx-native-list-device',
        dispose: async () => {},
      };
    };`);
    const inputs = snapshotNativeListInputs({
      entry: current.entry,
      adapterPath: current.adapterPath,
      root: current.root,
    });
    const campaign = buildNativeListCampaign({ inputReceipt: inputs.receipt });
    const native = await runNativeListHarness({
      adapterPath: current.adapterPath,
      entry: current.entry,
      bundles: inputs.bundles,
      observer: null,
      reps: 5,
      campaignId: campaign.id,
      listInputs: { receipt: inputs.receipt },
      campaignIdentity: { campaignId: campaign.id },
    });
    assert.equal(native.records.length, 26);
    assert.equal(
      native.records.every((record) =>
        record.measurementStatus === 'not-measured'
        && record.attemptedCount === 0
        && record.acceptedCount === 0
        && record.notMeasuredReason.category === 'native-list-capability-unavailable'),
      true,
    );
    assert.doesNotThrow(() => stringifyResult({ records: native.records }));
  } finally {
    fs.rmSync(current.root, { recursive: true, force: true });
  }
});

test('Native list harness completes semantic cases but refuses observer metrics when none is declared', async () => {
  const current = fixture();
  try {
    fs.writeFileSync(current.adapterPath, `export default async (context) => {
      if (context.mode !== 'list') throw new Error('wrong mode');
      return {
        environment: 'lynx-native-list-device',
        listCapability: {
          protocol: 'lynx-native-list-capability-v1',
          available: true,
          fixtureProtocol: 'lynx-list-fixture-v2',
          observation: 'native-visible-list-cell-tree-v1',
          observerProtocols: [],
        },
        async runListCase(_entry, context) {
          const identity = {
            campaignId: context.campaignId,
            attemptId: context.attempt.id,
            entryId: context.entryId,
            fixtureRole: context.fixtureRole,
            fixtureId: context.fixtureId,
            caseId: context.kase.name,
            scale: context.scale,
            bundleSha256: context.bundleSha256,
            contractSha256: context.contractSha256,
          };
          const attachedRows = Array.from({ length: 4 }, (_, index) => ({
            index,
            itemKey: \`row-\${index}\`,
            expectedItemKey: \`row-\${index}\`,
            label: \`Row \${index}\`,
          }));
          const startup = context.kase.name === 'list-startup';
          const recycle = context.kase.name === 'list-recycle';
          const scrollTop = startup ? 0 : recycle ? 12_800 : 640;
          const sourceMetrics = startup
            ? { firstVisibleContentMs: 1 }
            : recycle
              ? { operationTimeMs: 2, recycledCells: 16, wireToMtsBytes: 32, wireToBtsBytes: 16 }
              : { elapsedMs: 3, materializedCells: 32, blankFrames: 0, materializationTimesMs: [1, 2] };
          const stimulus = startup
            ? { kind: 'attach-prepopulated-list' }
            : recycle
              ? { kind: 'shared-touch-drag-one-viewport-v1', distancePx: 640, repetitions: 20 }
              : { kind: 'shared-native-touch-fling-velocity-v1', velocityPxPerSecond: 4800, durationMs: 1500 };
          const evidence = (protocol, evidenceId) => ({
            protocol,
            ...identity,
            evidenceId,
            observedAtMs: context.attempt.openedAtMs,
          });
          return {
            protocol: 'lynx-native-list-attempt-v1',
            ...identity,
            openedAtMs: context.attempt.openedAtMs,
            closedAtMs: context.attempt.openedAtMs,
            stimulus,
            sourceMetrics,
            checkpoint: {
              ...evidence('lynx-native-list-checkpoint-v1', \`checkpoint-\${context.attempt.id}\`),
              logicalRowCount: context.scale,
              viewport: {
                widthPx: 390,
                heightPx: 640,
                estimatedRowHeightPx: 40,
                leadingBufferRows: 2,
                trailingBufferRows: 2,
              },
              declaredCases: ['list-startup', 'list-recycle', 'list-fling'],
              scrollTop,
              attachedRows,
              semantics: {
                valid: true,
                keysMatch: true,
                indicesUnique: true,
                contiguous: true,
                startupAnchorPresent: true,
              },
            },
            teardown: {
              ...evidence('lynx-native-list-teardown-v1', \`teardown-\${context.attempt.id}\`),
              complete: true,
            },
          };
        },
        dispose: async () => {},
      };
    };`);
    const inputs = snapshotNativeListInputs({
      entry: current.entry,
      adapterPath: current.adapterPath,
      root: current.root,
    });
    const campaign = buildNativeListCampaign({ inputReceipt: inputs.receipt });
    const native = await runNativeListHarness({
      adapterPath: current.adapterPath,
      entry: current.entry,
      bundles: inputs.bundles,
      observer: inputs.observer,
      reps: 1,
      campaignId: campaign.id,
      listInputs: { receipt: inputs.receipt },
      campaignIdentity: { campaignId: campaign.id },
    });
    const sourceRecords = native.records.filter((record) =>
      !record.metric.includes('NativeListItem'));
    const observerRecords = native.records.filter((record) =>
      record.metric.includes('NativeListItem'));
    assert.equal(sourceRecords.length > 0, true);
    assert.equal(sourceRecords.every((record) => record.acceptedCount === 1), true);
    assert.equal(observerRecords.length, 16);
    assert.equal(
      observerRecords.every((record) =>
        record.measurementStatus === 'not-measured'
        && record.notMeasuredReason.category
          === 'native-list-allocation-observer-unavailable'),
      true,
    );
    assert.doesNotThrow(() => stringifyResult({ records: native.records }));
  } finally {
    fs.rmSync(current.root, { recursive: true, force: true });
  }
});

test('CLI isolates the opt-in Native list lane from capacity and ranked matrix controls', () => {
  const cli = path.join(ROOT, 'packages/runner/src/cli.mjs');
  const run = (...args) => spawnSync(process.execPath, [cli, 'run', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  for (const [args, expected] of [
    [['--harness', 'native', '--native-list'], /requires --entry octane-native-diagnostic/],
    [[
      '--harness', 'native', '--native-list', '--native-capacity',
      '--entry', ENTRY_ID,
    ], /cannot be combined/],
    [['--harness', 'web', '--native-list', '--entry', ENTRY_ID], /requires --harness native/],
    [[
      '--harness', 'native', '--native-list', '--entry', ENTRY_ID, '--scale', '1000',
    ], /cannot be combined with --scale/],
    [[
      '--harness', 'native', '--native-list=false', '--entry', ENTRY_ID,
    ], /boolean flag/],
    [[
      '--harness', 'native', '--native-list-observer', '{}', '--entry', ENTRY_ID,
    ], /requires --native-list/],
    [[
      '--harness', 'native', '--native-list', '--entry', ENTRY_ID,
    ], /requires --adapter/],
  ]) {
    const result = run(...args);
    assert.equal(result.status, 1, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, expected);
  }
});
