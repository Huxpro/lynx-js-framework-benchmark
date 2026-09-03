import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import test from 'node:test';

import {
  LIST_CASES,
  LIST_CONFIG,
  LIST_FIXTURE_PROTOCOL,
  LIST_WORKLOAD_CONTRACT_VERSION,
  NATIVE_LIST_FIXTURE_PROTOCOL,
} from '../../shared/src/list-workloads.mjs';

import {
  NATIVE_LIST_ATTEMPT_PROTOCOL,
  NATIVE_LIST_CAPABILITY_PROTOCOL,
  NATIVE_LIST_CHECKPOINT_PROTOCOL,
  NATIVE_LIST_FIXTURE_ID,
  NATIVE_LIST_FIXTURE_ROLE,
  NATIVE_LIST_MAX_LIVE_LIST_ITEM_BOUND,
  NATIVE_LIST_OBSERVER_METRIC_CONTRACTS,
  NATIVE_LIST_OBSERVER_PROTOCOL,
  NATIVE_LIST_TEARDOWN_PROTOCOL,
  buildNativeListInputContract,
  runNativeListMatrix,
} from './harness-native-list.mjs';
import { LIST_WORKLOAD_CONTRACT_SHA256 } from './list-coverage.mjs';
import { deriveListRecords } from './list-derivation.mjs';

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const CAMPAIGN_ID = 'native-list-campaign-test';
const OBSERVER = Object.freeze({
  protocol: NATIVE_LIST_OBSERVER_PROTOCOL,
  methodRevision: 'android-list-allocation-observer-test-v1',
  measurementOverhead: Object.freeze({
    boundary: 'observer-enable-through-disable-per-attempt',
    unit: 'ms',
    value: 0.75,
  }),
});

function fixture() {
  const entry = {
    id: 'octane-native-diagnostic',
    tier: 'lab',
    harnesses: ['native'],
    framework: 'octane',
    dir: '/fixture/octane-native-diagnostic',
    provenance: { commit: 'a'.repeat(40) },
    listFixture: {
      protocol: NATIVE_LIST_FIXTURE_PROTOCOL,
      workloadProtocol: LIST_FIXTURE_PROTOCOL,
      contractSha256: LIST_WORKLOAD_CONTRACT_SHA256,
      scales: {},
    },
  };
  const bundles = {};
  for (const scale of [1_000, 10_000]) {
    const bundleBytes = Buffer.from(`native-list-${scale}`);
    const relativePath = `dist/list/rows-${scale}/main.lynx.bundle`;
    const digest = sha256(bundleBytes);
    entry.listFixture.scales[String(scale)] = { bundle: relativePath, sha256: digest };
    bundles[String(scale)] = {
      bundlePath: path.join(entry.dir, relativePath),
      bundleBytes,
      relativePath,
      sha256: digest,
    };
  }
  return { entry, bundles };
}

function attachedRows(scale, first = 0) {
  const count = Math.min(NATIVE_LIST_MAX_LIVE_LIST_ITEM_BOUND, scale - first);
  return Array.from({ length: count }, (_, offset) => {
    const index = first + offset;
    return {
      index,
      itemKey: `row-${index}`,
      expectedItemKey: `row-${index}`,
      label: `Row ${index}`,
    };
  });
}

function semanticCheckpoint(kase, scale, overrides = {}) {
  const first = kase.name === 'list-startup' ? 0 : 16;
  return {
    protocol: NATIVE_LIST_CHECKPOINT_PROTOCOL,
    fixtureRole: NATIVE_LIST_FIXTURE_ROLE,
    fixtureId: NATIVE_LIST_FIXTURE_ID,
    caseId: kase.name,
    logicalRowCount: scale,
    viewport: {
      widthPx: LIST_CONFIG.viewport.widthPx,
      heightPx: LIST_CONFIG.viewport.heightPx,
      estimatedRowHeightPx: LIST_CONFIG.row.estimatedHeightPx,
      leadingBufferRows: LIST_CONFIG.buffer.leadingRows,
      trailingBufferRows: LIST_CONFIG.buffer.trailingRows,
    },
    declaredCases: LIST_CASES.map(({ name }) => name),
    scrollTop: kase.name === 'list-startup'
      ? 0
      : LIST_CONFIG.recycle.distancePx * LIST_CONFIG.recycle.repetitions,
    attachedRows: attachedRows(scale, first),
    semantics: {
      valid: true,
      keysMatch: true,
      indicesUnique: true,
      contiguous: true,
      startupAnchorPresent: true,
    },
    ...overrides,
  };
}

function sourceMetrics(kase) {
  const all = {
    firstVisibleContentMs: 12,
    operationTimeMs: 8,
    recycledCells: 16,
    wireToMtsBytes: 100,
    wireToBtsBytes: 200,
    elapsedMs: 1500,
    materializedCells: 600,
    blankFrames: 0,
    materializationTimesMs: [1, 2, 3],
  };
  return Object.fromEntries(kase.sourceMetrics.map((metric) => [metric, all[metric]]));
}

function stimulusReceipt(kase) {
  if (kase.name === 'list-startup') return { kind: kase.stimulus };
  if (kase.name === 'list-recycle') {
    return {
      kind: LIST_CONFIG.input.native.recycle,
      distancePx: LIST_CONFIG.recycle.distancePx,
      repetitions: LIST_CONFIG.recycle.repetitions,
    };
  }
  return {
    kind: LIST_CONFIG.input.native.fling,
    velocityPxPerSecond: LIST_CONFIG.fling.velocityPxPerSecond,
    durationMs: LIST_CONFIG.fling.durationMs,
  };
}

function measuredAttempt(context, overrides = {}) {
  const { attempt, kase, scale, bundleSha256, observer } = context;
  const baseEvidence = {
    campaignId: CAMPAIGN_ID,
    attemptId: attempt.id,
    entryId: 'octane-native-diagnostic',
    fixtureRole: NATIVE_LIST_FIXTURE_ROLE,
    fixtureId: NATIVE_LIST_FIXTURE_ID,
    caseId: kase.name,
    scale,
    bundleSha256,
    contractSha256: LIST_WORKLOAD_CONTRACT_SHA256,
    observedAtMs: attempt.openedAtMs,
  };
  return {
    protocol: NATIVE_LIST_ATTEMPT_PROTOCOL,
    ...baseEvidence,
    openedAtMs: attempt.openedAtMs,
    closedAtMs: attempt.openedAtMs,
    stimulus: stimulusReceipt(kase),
    checkpoint: {
      evidenceId: `${attempt.id}:checkpoint`,
      ...baseEvidence,
      ...semanticCheckpoint(kase, scale),
    },
    sourceMetrics: sourceMetrics(kase),
    observer: observer == null ? null : {
      evidenceId: `${attempt.id}:observer`,
      ...baseEvidence,
      ...observer,
      peakLiveNativeListItems: NATIVE_LIST_MAX_LIVE_LIST_ITEM_BOUND,
      cumulativeNativeListItemCreations: NATIVE_LIST_MAX_LIVE_LIST_ITEM_BOUND + 8,
      reusedNativeListItems: kase.name === 'list-startup' ? 0 : 8,
      remainingLiveNativeListItemsAfterTeardown: 0,
    },
    teardown: {
      evidenceId: `${attempt.id}:teardown`,
      ...baseEvidence,
      protocol: NATIVE_LIST_TEARDOWN_PROTOCOL,
      complete: true,
    },
    ...overrides,
  };
}

function adapter(runListCase, capability = {}) {
  return {
    environment: 'lynx-native-test-device',
    listCapability: {
      protocol: NATIVE_LIST_CAPABILITY_PROTOCOL,
      available: true,
      fixtureProtocol: NATIVE_LIST_FIXTURE_PROTOCOL,
      observation: LIST_CONFIG.observation.native,
      observerProtocols: [NATIVE_LIST_OBSERVER_PROTOCOL],
      ...capability,
    },
    runListCase,
  };
}

test('Native list schedules the exact shared cases with distinct immutable scale bundles', async () => {
  const { entry, bundles } = fixture();
  const calls = [];
  const records = await runNativeListMatrix({
    adapter: adapter(async (_entry, context) => {
      calls.push({
        case: context.kase.name,
        scale: context.scale,
        bundle: context.bundleRelativePath,
        config: context.config,
      });
      return measuredAttempt(context);
    }),
    entry,
    bundles,
    campaignId: CAMPAIGN_ID,
    observer: OBSERVER,
    reps: 1,
  });

  assert.deepEqual(calls.map(({ case: name, scale }) => [name, scale]), [
    ['list-startup', 1_000],
    ['list-startup', 10_000],
    ['list-recycle', 10_000],
    ['list-fling', 10_000],
  ]);
  assert.deepEqual(calls.map(({ bundle }) => bundle), [
    'dist/list/rows-1000/main.lynx.bundle',
    'dist/list/rows-10000/main.lynx.bundle',
    'dist/list/rows-10000/main.lynx.bundle',
    'dist/list/rows-10000/main.lynx.bundle',
  ]);
  assert.ok(calls.every(({ config }) => config === LIST_CONFIG));
  assert.ok(records.every((record) => record.harness === 'native'
    && record.diagnostic === true
    && record.rankingEligible === false
    && record.contractVersion === LIST_WORKLOAD_CONTRACT_VERSION));
  assert.ok(records.every((record) => record.measurementStatus === 'measured'));
  assert.equal(
    records.find(({ metric }) => metric === 'peakLiveNativeListItems').median,
    NATIVE_LIST_MAX_LIVE_LIST_ITEM_BOUND,
  );
  assert.equal(
    records.find(({ metric }) => metric === 'cumulativeNativeListItemCreations').median,
    NATIVE_LIST_MAX_LIVE_LIST_ITEM_BOUND + 8,
  );
});

test('Native list proves reuse and teardown separately with its declared observer revision and overhead', async () => {
  const { entry, bundles } = fixture();
  const records = await runNativeListMatrix({
    adapter: adapter(async (_entry, context) => measuredAttempt(context)),
    entry,
    bundles,
    campaignId: CAMPAIGN_ID,
    observer: OBSERVER,
    reps: 1,
  });
  const recycle = records.filter(({ workload }) => workload === 'list-recycle');
  assert.equal(recycle.find(({ metric }) => metric === 'reusedNativeListItems').median, 8);
  assert.equal(
    recycle.find(({ metric }) => metric === 'remainingLiveNativeListItemsAfterTeardown').median,
    0,
  );
  assert.ok(recycle.every(({ nativeListObserver }) =>
    nativeListObserver.methodRevision === OBSERVER.methodRevision
    && nativeListObserver.measurementOverhead.value === 0.75));
  assert.ok(recycle.every(({ detailSamples }) => detailSamples.every((detail) =>
    detail.campaignId === CAMPAIGN_ID
    && detail.fixtureId === NATIVE_LIST_FIXTURE_ID)));
});

test('missing capability, observer, or exact scale artifact is not measured without eager fallback', async () => {
  const { entry, bundles } = fixture();
  const missingScale = { ...bundles };
  delete missingScale['1000'];
  const calls = [];
  const missing = await runNativeListMatrix({
    adapter: adapter(async (_entry, context) => {
      calls.push(context.scale);
      return measuredAttempt(context);
    }),
    entry,
    bundles: missingScale,
    campaignId: CAMPAIGN_ID,
    observer: OBSERVER,
    reps: 1,
  });
  assert.equal(calls.includes(1_000), false);
  assert.ok(missing.filter(({ scale }) => scale === 1_000)
    .every(({ measurementStatus, notMeasuredReason }) =>
      measurementStatus === 'not-measured'
      && notMeasuredReason.category === 'native-list-scale-artifact-unavailable'));

  const eagerEntry = structuredClone(entry);
  const eagerBytes = Buffer.from('eager-table-1000');
  const eagerSha256 = sha256(eagerBytes);
  eagerEntry.listFixture.scales['1000'] = {
    bundle: 'dist/table/rows-1000/main.lynx.bundle', sha256: eagerSha256,
  };
  const eagerFallback = await runNativeListMatrix({
    adapter: adapter(async (_entry, context) => {
      if (context.scale === 1_000) assert.fail('must not launch eager table fallback');
      return measuredAttempt(context);
    }),
    entry: eagerEntry,
    bundles: {
      ...bundles,
      1000: {
        bundlePath: path.join(eagerEntry.dir, eagerEntry.listFixture.scales['1000'].bundle),
        bundleBytes: eagerBytes,
        relativePath: eagerEntry.listFixture.scales['1000'].bundle,
        sha256: eagerSha256,
      },
    },
    campaignId: CAMPAIGN_ID,
    observer: OBSERVER,
    reps: 1,
  });
  assert.ok(eagerFallback.filter(({ scale }) => scale === 1_000)
    .every(({ measurementStatus, notMeasuredReason }) =>
      measurementStatus === 'not-measured'
      && notMeasuredReason.category === 'native-list-scale-artifact-invalid'));

  const noCapability = await runNativeListMatrix({
    adapter: adapter(async () => assert.fail('must not launch'), { available: false }),
    entry,
    bundles,
    campaignId: CAMPAIGN_ID,
    observer: OBSERVER,
    reps: 1,
  });
  assert.ok(noCapability.every(({ measurementStatus }) => measurementStatus === 'not-measured'));

  const semanticOnly = await runNativeListMatrix({
    adapter: adapter(async (_entry, context) => measuredAttempt(context)),
    entry,
    bundles,
    campaignId: CAMPAIGN_ID,
    observer: null,
    reps: 1,
  });
  assert.ok(semanticOnly.filter(({ metric }) => Object.hasOwn(
    NATIVE_LIST_OBSERVER_METRIC_CONTRACTS, metric,
  )).every(({ measurementStatus, notMeasuredReason }) =>
    measurementStatus === 'not-measured'
    && notMeasuredReason.category === 'native-list-allocation-observer-unavailable'));
  assert.ok(semanticOnly.filter(({ metric }) => !Object.hasOwn(
    NATIVE_LIST_OBSERVER_METRIC_CONTRACTS, metric,
  )).every(({ measurementStatus }) => measurementStatus === 'measured'));
});

test('input identity changes with the bundle, workload contract, or observer declaration', () => {
  const { entry, bundles } = fixture();
  const original = buildNativeListInputContract({ entry, bundles, observer: OBSERVER });
  const revisedObserver = buildNativeListInputContract({
    entry,
    bundles,
    observer: { ...OBSERVER, methodRevision: 'android-list-allocation-observer-test-v2' },
  });
  const mutatedBytes = Buffer.from('native-list-1000-mutated');
  const mutatedSha = sha256(mutatedBytes);
  const mutatedEntry = structuredClone(entry);
  mutatedEntry.listFixture.scales['1000'].sha256 = mutatedSha;
  const revisedBundle = buildNativeListInputContract({
    entry: mutatedEntry,
    bundles: {
      ...bundles,
      1000: { ...bundles['1000'], bundleBytes: mutatedBytes, sha256: mutatedSha },
    },
    observer: OBSERVER,
  });
  const revisedContract = buildNativeListInputContract({
    entry: {
      ...entry,
      listFixture: { ...entry.listFixture, contractSha256: 'f'.repeat(64) },
    },
    bundles,
    observer: OBSERVER,
  });
  assert.notEqual(original.sha256, revisedObserver.sha256);
  assert.notEqual(original.sha256, revisedBundle.sha256);
  assert.notEqual(original.sha256, revisedContract.sha256);
});

test('wrong, malformed, duplicate, and late attempt evidence becomes typed DNF', async () => {
  for (const [label, mutate] of [
    ['wrong case', (receipt) => { receipt.checkpoint.caseId = 'list-fling'; }],
    ['wrong scale', (receipt) => { receipt.checkpoint.logicalRowCount = 999; }],
    ['wrong bundle', (receipt) => { receipt.bundleSha256 = 'f'.repeat(64); }],
    ['wrong contract', (receipt) => { receipt.checkpoint.contractSha256 = 'f'.repeat(64); }],
    ['malformed semantic', (receipt) => { receipt.checkpoint.semantics.valid = false; }],
    ['duplicate evidence', (receipt) => {
      receipt.observer.evidenceId = receipt.checkpoint.evidenceId;
    }],
    ['late evidence', (receipt) => {
      receipt.checkpoint.observedAtMs = receipt.closedAtMs + 1;
    }],
  ]) {
    const { entry, bundles } = fixture();
    const records = await runNativeListMatrix({
      adapter: adapter(async (_entry, context) => {
        const receipt = structuredClone(measuredAttempt(context));
        mutate(receipt);
        return receipt;
      }),
      entry,
      bundles,
      campaignId: CAMPAIGN_ID,
      observer: OBSERVER,
      reps: 1,
    });
    const first = records.find(({ workload, scale }) =>
      workload === 'list-startup' && scale === 1_000);
    assert.equal(first.measurementStatus, 'dnf', label);
    assert.equal(first.n, 0, label);
    assert.equal(first.dnfCount, 1, label);
    assert.equal(first.failures[0].category, 'invalid-native-list-evidence', label);
  }
});

test('an adapter-declared launched DNF keeps its typed failure and emits no samples', async () => {
  const { entry, bundles } = fixture();
  const records = await runNativeListMatrix({
    adapter: adapter(async (_entry, context) => ({
      protocol: NATIVE_LIST_ATTEMPT_PROTOCOL,
      campaignId: CAMPAIGN_ID,
      attemptId: context.attempt.id,
      entryId: entry.id,
      fixtureRole: NATIVE_LIST_FIXTURE_ROLE,
      fixtureId: NATIVE_LIST_FIXTURE_ID,
      caseId: context.kase.name,
      scale: context.scale,
      bundleSha256: context.bundleSha256,
      contractSha256: LIST_WORKLOAD_CONTRACT_SHA256,
      openedAtMs: context.attempt.openedAtMs,
      closedAtMs: context.attempt.openedAtMs,
      dnf: true,
      failure: { category: 'native-list-capture-timeout', timeoutMs: 180_000 },
    })),
    entry,
    bundles,
    campaignId: CAMPAIGN_ID,
    observer: OBSERVER,
    reps: 1,
  });
  assert.ok(records.every(({ measurementStatus, n, dnfCount, failures }) =>
    measurementStatus === 'dnf'
    && n === 0
    && dnfCount === 1
    && failures[0].category === 'native-list-capture-timeout'));
});

test('materialization distributions preserve observation and attempt cardinality for collection', async () => {
  const { entry, bundles } = fixture();
  const records = await runNativeListMatrix({
    adapter: adapter(async (_entry, context) => measuredAttempt(context)),
    entry,
    bundles,
    campaignId: CAMPAIGN_ID,
    observer: OBSERVER,
    reps: 2,
  });
  const distribution = records.find(({ workload, metric }) =>
    workload === 'list-fling' && metric === 'materializationTimesMs');
  assert.deepEqual(distribution.samples, [1, 2, 3, 1, 2, 3]);
  assert.equal(distribution.observationCount, 6);
  assert.equal(distribution.attemptedCount, 2);
  assert.equal(distribution.acceptedCount, 2);
  assert.equal(distribution.observationCardinality,
    'many-observations-per-accepted-attempt');
  const derived = deriveListRecords(records.filter(({ workload }) => workload === 'list-fling'));
  assert.equal(derived.find(({ metric }) => metric === 'materializationP50Ms').value, 2);
  assert.equal(derived.find(({ metric }) => metric === 'materializationP99Ms').value, 3);
});

test('observer reports must keep peak live distinct and within the viewport-plus-buffer bound', async () => {
  for (const [label, mutate] of [
    ['over bound', (observer) => { observer.peakLiveNativeListItems = 21; }],
    ['cumulative below peak', (observer) => {
      observer.cumulativeNativeListItemCreations = 19;
    }],
    ['missing recycle reuse', (observer) => { observer.reusedNativeListItems = 0; }],
    ['incomplete teardown', (observer) => {
      observer.remainingLiveNativeListItemsAfterTeardown = 1;
    }],
    ['revision drift', (observer) => { observer.methodRevision = 'other'; }],
    ['overhead drift', (observer) => { observer.measurementOverhead.value = 99; }],
  ]) {
    const { entry, bundles } = fixture();
    const records = await runNativeListMatrix({
      adapter: adapter(async (_entry, context) => {
        const receipt = structuredClone(measuredAttempt(context));
        if (context.kase.name === 'list-recycle') mutate(receipt.observer);
        return receipt;
      }),
      entry,
      bundles,
      campaignId: CAMPAIGN_ID,
      observer: OBSERVER,
      reps: 1,
    });
    const recycle = records.find(({ workload }) => workload === 'list-recycle');
    assert.equal(recycle.measurementStatus, 'dnf', label);
    assert.equal(recycle.failures[0].category, 'invalid-native-list-evidence', label);
  }
});
