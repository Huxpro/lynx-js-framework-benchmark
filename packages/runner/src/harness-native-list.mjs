import crypto from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { makeRecord } from '@lynx-bench/shared/schema';
import {
  LIST_CASES,
  LIST_CONFIG,
  LIST_FIXTURE_PROTOCOL,
  LIST_SOURCE_METRIC_CONTRACTS,
  LIST_WORKLOAD_CONTRACT_VERSION,
  NATIVE_LIST_CAPABILITY_PROTOCOL,
  NATIVE_LIST_DEVICE_CLAIM_CONTRACT,
  NATIVE_LIST_FIXTURE_PROTOCOL,
  NATIVE_LIST_MAX_LIVE_LIST_ITEM_BOUND,
  NATIVE_LIST_OBSERVER_METRIC_CONTRACTS,
  NATIVE_LIST_OBSERVER_PROTOCOL,
} from '@lynx-bench/shared/list-workloads';
import {
  DEFAULT_MIN_ACCEPTED_SAMPLES,
  NATIVE_DIAGNOSTIC_ENTRY_ID,
  NATIVE_LIST_FIXTURE_ID,
  NATIVE_LIST_FIXTURE_ROLE,
  NATIVE_LIST_SCALES,
  REPORTABILITY_PROTOCOL,
  nativeListBundlePath,
} from '@lynx-bench/shared/native-diagnostic-contract';

import { LIST_WORKLOAD_CONTRACT_SHA256 } from './list-coverage.mjs';
import { deriveOutcomeCounts } from './result-json.mjs';

export {
  NATIVE_LIST_CAPABILITY_PROTOCOL,
  NATIVE_LIST_MAX_LIVE_LIST_ITEM_BOUND,
  NATIVE_LIST_OBSERVER_METRIC_CONTRACTS,
  NATIVE_LIST_OBSERVER_PROTOCOL,
  NATIVE_LIST_FIXTURE_ID,
  NATIVE_LIST_FIXTURE_ROLE,
};

export const NATIVE_LIST_RUN_CONTRACT_VERSION = 'lynx-native-list-run-v1';
export const NATIVE_LIST_INPUT_CONTRACT_VERSION = 'lynx-native-list-input-v1';
export const NATIVE_LIST_ATTEMPT_PROTOCOL = 'lynx-native-list-attempt-v1';
export const NATIVE_LIST_CHECKPOINT_PROTOCOL = 'lynx-native-list-checkpoint-v1';
export const NATIVE_LIST_CELL_EVIDENCE_PROTOCOL = 'lynx-native-list-cell-evidence-v1';
export const NATIVE_LIST_TEARDOWN_PROTOCOL = 'lynx-native-list-teardown-v1';

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const sha256Json = (value) => sha256(JSON.stringify(value));
const CASE_NAMES = Object.freeze(LIST_CASES.map(({ name }) => name));

function observerDeclaration(observer) {
  if (observer == null) return null;
  return {
    protocol: observer.protocol ?? null,
    methodRevision: observer.methodRevision ?? null,
    measurementOverhead: observer.measurementOverhead == null
      ? null
      : {
        boundary: observer.measurementOverhead.boundary ?? null,
        unit: observer.measurementOverhead.unit ?? null,
        value: observer.measurementOverhead.value ?? null,
      },
  };
}

function manifestArtifact(entry, scale) {
  const artifact = entry?.listFixture?.scales?.[String(scale)];
  return typeof artifact?.bundle === 'string' && typeof artifact?.sha256 === 'string'
    ? { relativePath: artifact.bundle, sha256: artifact.sha256 }
    : null;
}

/**
 * Pure input identity for `native-inputs.mjs`. The caller owns the immutable
 * byte snapshots; this object makes runner, fixture, per-scale artifact, and
 * observer mutations visible in the enclosing campaign receipt.
 */
export function buildNativeListInputContract({ entry, bundles = {}, observer = null }) {
  const artifacts = Object.fromEntries(NATIVE_LIST_SCALES.map((scale) => {
    const declared = manifestArtifact(entry, scale);
    const snapshot = bundles[String(scale)] ?? null;
    return [String(scale), {
      declaredRelativePath: declared?.relativePath ?? null,
      declaredSha256: declared?.sha256 ?? null,
      snapshotRelativePath: snapshot?.relativePath ?? null,
      snapshotBytes: Buffer.isBuffer(snapshot?.bundleBytes) ? snapshot.bundleBytes.length : null,
      snapshotSha256: Buffer.isBuffer(snapshot?.bundleBytes)
        ? sha256(snapshot.bundleBytes)
        : snapshot?.sha256 ?? null,
    }];
  }));
  const payload = {
    protocol: NATIVE_LIST_INPUT_CONTRACT_VERSION,
    runnerContract: NATIVE_LIST_RUN_CONTRACT_VERSION,
    entryId: entry?.id ?? null,
    fixture: {
      protocol: entry?.listFixture?.protocol ?? null,
      workloadProtocol: entry?.listFixture?.workloadProtocol ?? null,
      contractSha256: entry?.listFixture?.contractSha256 ?? null,
    },
    workload: {
      version: LIST_WORKLOAD_CONTRACT_VERSION,
      sha256: LIST_WORKLOAD_CONTRACT_SHA256,
    },
    deviceClaim: NATIVE_LIST_DEVICE_CLAIM_CONTRACT,
    artifacts,
    observer: observerDeclaration(observer),
  };
  return Object.freeze({ ...payload, sha256: sha256Json(payload) });
}

function preflightEntry(entry) {
  if (entry?.tier !== 'lab'
    || !Array.isArray(entry.harnesses)
    || entry.harnesses.length !== 1
    || entry.harnesses[0] !== 'native'
    || entry.listFixture?.protocol !== NATIVE_LIST_FIXTURE_PROTOCOL
    || entry.listFixture?.workloadProtocol !== LIST_FIXTURE_PROTOCOL
    || entry.listFixture?.contractSha256 !== LIST_WORKLOAD_CONTRACT_SHA256
    || entry.id !== NATIVE_DIAGNOSTIC_ENTRY_ID) {
    return {
      category: 'native-list-fixture-contract-unavailable',
      message: 'entry does not declare the exact diagnostic bounded-list contract',
    };
  }
  return null;
}

function preflightBundle(entry, bundles, scale) {
  const declared = manifestArtifact(entry, scale);
  const snapshot = bundles?.[String(scale)];
  if (declared == null || snapshot == null) {
    return {
      reason: {
        category: 'native-list-scale-artifact-unavailable',
        scale,
        message: `no exact immutable Native list artifact is available for scale ${scale}`,
      },
      bundle: null,
    };
  }
  const actualSha256 = Buffer.isBuffer(snapshot.bundleBytes)
    ? sha256(snapshot.bundleBytes)
    : null;
  const requiredRelativePath = nativeListBundlePath(scale);
  const expectedPath = path.resolve(entry.dir, declared.relativePath);
  if (!Buffer.isBuffer(snapshot.bundleBytes)
    || declared.relativePath !== requiredRelativePath
    || typeof snapshot.bundlePath !== 'string'
    || snapshot.relativePath !== declared.relativePath
    || path.resolve(snapshot.bundlePath) !== expectedPath
    || !/^[a-f0-9]{64}$/.test(snapshot.sha256 ?? '')
    || snapshot.sha256 !== declared.sha256
    || actualSha256 !== snapshot.sha256) {
    return {
      reason: {
        category: 'native-list-scale-artifact-invalid',
        scale,
        message: `Native list artifact for scale ${scale} does not match its immutable manifest identity`,
      },
      bundle: null,
    };
  }
  return { reason: null, bundle: snapshot };
}

function preflightCapability(adapter) {
  const capability = adapter?.listCapability;
  if (typeof adapter?.runListCase !== 'function'
    || capability?.protocol !== NATIVE_LIST_CAPABILITY_PROTOCOL
    || capability.available !== true
    || capability.fixtureProtocol !== NATIVE_LIST_FIXTURE_PROTOCOL
    || capability.observation !== LIST_CONFIG.observation.native) {
    return {
      category: 'native-list-capability-unavailable',
      message: 'adapter did not declare the exact real-Native list capability',
    };
  }
  return null;
}

function preflightObserver(adapter, observer) {
  if (observer == null) {
    return {
      category: 'native-list-allocation-observer-unavailable',
      message: 'campaign did not declare a real Native allocation observer',
    };
  }
  const overhead = observer.measurementOverhead;
  if (observer.protocol !== NATIVE_LIST_OBSERVER_PROTOCOL
    || typeof observer.methodRevision !== 'string'
    || observer.methodRevision.length === 0
    || overhead?.boundary !== 'observer-enable-through-disable-per-attempt'
    || overhead.unit !== 'ms'
    || !Number.isFinite(overhead.value)
    || overhead.value < 0
    || !adapter.listCapability?.observerProtocols?.includes(observer.protocol)) {
    return {
      category: 'native-list-allocation-observer-unavailable',
      message: 'campaign observer declaration or adapter observer capability is incompatible',
    };
  }
  return null;
}

function expectedStimulus(kase) {
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

function exactJson(actual, expected, label) {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`${label} does not match the Native list contract`);
  }
}

function assertEvidenceIdentity(evidence, expected, label) {
  if (evidence == null || typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw new Error(`${label} is missing or malformed`);
  }
  for (const [field, value] of Object.entries(expected)) {
    if (evidence[field] !== value) throw new Error(`${label} has the wrong ${field}`);
  }
}

function assertEvidenceTime(evidence, openedAtMs, closedAtMs, label) {
  if (!Number.isFinite(evidence.observedAtMs)
    || evidence.observedAtMs < openedAtMs
    || evidence.observedAtMs > closedAtMs) {
    throw new Error(`${label} is outside the closed attempt evidence window`);
  }
}

function validateCheckpoint(checkpoint, { kase, scale }) {
  if (checkpoint.protocol !== NATIVE_LIST_CHECKPOINT_PROTOCOL
    || checkpoint.fixtureRole !== NATIVE_LIST_FIXTURE_ROLE
    || checkpoint.fixtureId !== NATIVE_LIST_FIXTURE_ID
    || checkpoint.caseId !== kase.name
    || checkpoint.logicalRowCount !== scale) {
    throw new Error('semantic checkpoint has the wrong fixture, case, or logical scale');
  }
  exactJson(checkpoint.viewport, {
    widthPx: LIST_CONFIG.viewport.widthPx,
    heightPx: LIST_CONFIG.viewport.heightPx,
    estimatedRowHeightPx: LIST_CONFIG.row.estimatedHeightPx,
    leadingBufferRows: LIST_CONFIG.buffer.leadingRows,
    trailingBufferRows: LIST_CONFIG.buffer.trailingRows,
  }, 'semantic checkpoint viewport');
  exactJson(checkpoint.declaredCases, CASE_NAMES, 'semantic checkpoint case declaration');
  if (!Number.isFinite(checkpoint.scrollTop) || checkpoint.scrollTop < 0
    || !Array.isArray(checkpoint.attachedRows)
    || checkpoint.attachedRows.length === 0
    || checkpoint.attachedRows.length > NATIVE_LIST_MAX_LIVE_LIST_ITEM_BOUND) {
    throw new Error('semantic checkpoint has an invalid visible-cell window');
  }
  const indices = checkpoint.attachedRows.map(({ index }) => index);
  const keysMatch = checkpoint.attachedRows.every((row) =>
    Number.isSafeInteger(row.index)
    && row.index >= 0
    && row.index < scale
    && row.itemKey === `row-${row.index}`
    && row.expectedItemKey === row.itemKey
    && row.label === `Row ${row.index}`);
  const indicesUnique = new Set(indices).size === indices.length;
  const contiguous = indices.every((value, index) =>
    index === 0 || value === indices[index - 1] + 1);
  const startupAnchorPresent = kase.name !== 'list-startup' || indices.includes(0);
  const expectedSemantics = {
    valid: keysMatch && indicesUnique && contiguous && startupAnchorPresent,
    keysMatch,
    indicesUnique,
    contiguous,
    startupAnchorPresent,
  };
  exactJson(checkpoint.semantics, expectedSemantics, 'semantic checkpoint outcome');
  if (!expectedSemantics.valid) throw new Error('semantic checkpoint is not valid');
  if (kase.name === 'list-startup' && checkpoint.scrollTop !== 0) {
    throw new Error('startup checkpoint is not anchored at the start of the list');
  }
  if (kase.name === 'list-recycle'
    && checkpoint.scrollTop < LIST_CONFIG.recycle.distancePx * LIST_CONFIG.recycle.repetitions) {
    throw new Error('recycle checkpoint did not traverse the declared viewport repetitions');
  }
  if (kase.name === 'list-fling' && checkpoint.scrollTop <= 0) {
    throw new Error('fling checkpoint did not traverse the logical list');
  }
}

function validateSourceMetrics(sourceMetrics, kase) {
  if (sourceMetrics == null || typeof sourceMetrics !== 'object' || Array.isArray(sourceMetrics)) {
    throw new Error('Native list source metrics are missing or malformed');
  }
  exactJson(Object.keys(sourceMetrics).sort(), [...kase.sourceMetrics].sort(),
    'Native list source metric names');
  for (const [metric, value] of Object.entries(sourceMetrics)) {
    const values = metric === 'materializationTimesMs' ? value : [value];
    if (!Array.isArray(values) || values.length === 0
      || values.some((item) => !Number.isFinite(item) || item < 0)) {
      throw new Error(`Native list source metric ${metric} is invalid`);
    }
  }
}

function validateObserverReceipt(receipt, observer, kase) {
  if (receipt.protocol !== observer.protocol
    || receipt.methodRevision !== observer.methodRevision) {
    throw new Error('Native list observer protocol or method revision drifted');
  }
  exactJson(receipt.measurementOverhead, observer.measurementOverhead,
    'Native list observer overhead');
  for (const metric of Object.keys(NATIVE_LIST_OBSERVER_METRIC_CONTRACTS)) {
    if (!Number.isSafeInteger(receipt[metric]) || receipt[metric] < 0) {
      throw new Error(`Native list observer metric ${metric} is invalid`);
    }
  }
  if (receipt.peakLiveNativeListItems === 0
    || receipt.peakLiveNativeListItems > NATIVE_LIST_MAX_LIVE_LIST_ITEM_BOUND) {
    throw new Error('Native list peak live list items exceed the viewport-plus-buffer bound');
  }
  if (receipt.cumulativeNativeListItemCreations < receipt.peakLiveNativeListItems) {
    throw new Error('Native list cumulative creations cannot be below peak live list items');
  }
  if (kase.name !== 'list-startup' && receipt.reusedNativeListItems === 0) {
    throw new Error('Native list recycle and fling cases require observed list-item reuse');
  }
  if (receipt.remainingLiveNativeListItemsAfterTeardown !== 0) {
    throw new Error('Native list teardown left live list items behind');
  }
}

function validateAttemptEnvelope(result, context) {
  if (result == null || typeof result !== 'object' || Array.isArray(result)
    || result.protocol !== NATIVE_LIST_ATTEMPT_PROTOCOL
    || !Number.isFinite(result.openedAtMs)
    || !Number.isFinite(result.closedAtMs)
    || result.openedAtMs !== context.attempt.openedAtMs
    || result.closedAtMs < result.openedAtMs
    || result.closedAtMs > context.receivedAtMs) {
    throw new Error('Native list attempt envelope is malformed or late');
  }
  const expectedIdentity = {
    campaignId: context.campaignId,
    attemptId: context.attempt.id,
    entryId: context.entryId,
    fixtureRole: NATIVE_LIST_FIXTURE_ROLE,
    fixtureId: NATIVE_LIST_FIXTURE_ID,
    caseId: context.kase.name,
    scale: context.scale,
    bundleSha256: context.bundleSha256,
    contractSha256: LIST_WORKLOAD_CONTRACT_SHA256,
  };
  assertEvidenceIdentity(result, expectedIdentity, 'Native list attempt');
  return expectedIdentity;
}

function validateDnfAttempt(result, context) {
  validateAttemptEnvelope(result, context);
  if (result.dnf !== true
    || result.failure == null
    || typeof result.failure !== 'object'
    || Array.isArray(result.failure)
    || typeof result.failure.category !== 'string'
    || result.failure.category.length === 0) {
    throw new Error('Native list DNF lacks a typed failure');
  }
  return result;
}

function validateMeasuredAttempt(result, context, receiptIds, observer) {
  const expectedIdentity = validateAttemptEnvelope(result, context);
  exactJson(result.stimulus, expectedStimulus(context.kase), 'Native list stimulus receipt');
  const evidence = [
    ['semantic checkpoint', result.checkpoint],
    ['teardown receipt', result.teardown],
    ...(observer == null ? [] : [['observer receipt', result.observer]]),
  ];
  for (const [label, receipt] of evidence) {
    assertEvidenceIdentity(receipt, expectedIdentity, label);
    assertEvidenceTime(receipt, result.openedAtMs, result.closedAtMs, label);
    if (typeof receipt.evidenceId !== 'string' || receipt.evidenceId.length === 0
      || receiptIds.has(receipt.evidenceId)) {
      throw new Error(`${label} is duplicate or lacks an evidence identity`);
    }
    receiptIds.add(receipt.evidenceId);
  }
  if (result.checkpoint.observedAtMs > result.teardown.observedAtMs
    || (observer != null && result.observer.observedAtMs < result.teardown.observedAtMs)) {
    throw new Error('Native list checkpoint, teardown, and observer receipts are out of order');
  }
  validateCheckpoint(result.checkpoint, context);
  validateSourceMetrics(result.sourceMetrics, context.kase);
  if (result.teardown.protocol !== NATIVE_LIST_TEARDOWN_PROTOCOL
    || result.teardown.complete !== true
    || result.teardown.fixtureRole !== NATIVE_LIST_FIXTURE_ROLE
    || result.teardown.fixtureId !== NATIVE_LIST_FIXTURE_ID) {
    throw new Error('Native list teardown receipt is incomplete');
  }
  if (observer == null) {
    if (result.observer != null) {
      throw new Error('Native list attempt returned an undeclared allocation observer');
    }
  } else {
    validateObserverReceipt(result.observer, observer, context.kase);
  }
  return result;
}

function recordBase(adapter, entry, kase, scale, metric, contract, observer) {
  return {
    suite: 'list',
    harness: 'native',
    environment: adapter.environment,
    entry: entry.id,
    workload: kase.name,
    scale,
    metric,
    boundary: contract.boundary,
    unit: contract.unit,
    contractVersion: LIST_WORKLOAD_CONTRACT_VERSION,
    fixtureRole: NATIVE_LIST_FIXTURE_ROLE,
    fixtureId: NATIVE_LIST_FIXTURE_ID,
    listContractSha256: LIST_WORKLOAD_CONTRACT_SHA256,
    nativeListObserver: observerDeclaration(observer),
    diagnostic: true,
    rankingEligible: false,
    ...(['ms', 'ms/cell'].includes(contract.unit) ? {
      reportability: {
        protocol: REPORTABILITY_PROTOCOL,
        minAcceptedSamples: DEFAULT_MIN_ACCEPTED_SAMPLES,
      },
    } : {}),
  };
}

function notMeasuredRecord(base, reason) {
  const outcome = {
    ...makeRecord({ ...base, samples: [], dnfCount: 0, failures: [] }),
    ...base,
    measurementStatus: 'not-measured',
    attemptedCount: 0,
    acceptedCount: 0,
    notMeasuredCount: 1,
    notMeasuredReason: reason,
  };
  return {
    ...outcome,
    outcomeCounts: deriveOutcomeCounts(outcome),
    observationCount: 0,
    observationCardinality: base.metric === 'materializationTimesMs'
      ? 'many-observations-per-accepted-attempt'
      : 'one-observation-per-accepted-attempt',
  };
}

function detailObservations(details, metric, isObserverMetric) {
  return details.flatMap((detail) => {
    const value = isObserverMetric ? detail.observer?.[metric] : detail.sourceMetrics[metric];
    const values = Array.isArray(value) ? value : [value];
    return values.map((sample, observationIndex) => ({
      sample,
      reference: {
        attemptId: detail.attemptId,
        observationIndex,
      },
    }));
  });
}

function failureReferences(failures, ownerMetric) {
  return failures.map(({ rep, attemptId, category }) => ({
    rep,
    attemptId,
    category,
    evidenceRef: {
      protocol: NATIVE_LIST_CELL_EVIDENCE_PROTOCOL,
      ownerMetric,
      attemptId,
    },
  }));
}

function cellEvidenceOwnerMetric(kase) {
  return [...kase.sourceMetrics].reverse().find((metric) => {
    const unit = LIST_SOURCE_METRIC_CONTRACTS[metric].unit;
    return unit !== 'ms' && unit !== 'bytes';
  }) ?? kase.sourceMetrics[0];
}

function makeCaseRecords({
  adapter,
  entry,
  kase,
  scale,
  details,
  dnfCount,
  failures,
  attemptedCount,
  observer,
  observerUnavailable,
  cellUnavailable,
}) {
  const records = [];
  // Prefer a terminal semantic metric so collector-derived timing and ratio
  // records do not copy the cell's full receipt payload.
  const ownerMetric = cellEvidenceOwnerMetric(kase);
  const acceptedAttemptsById = Object.fromEntries(details.map((detail) => [
    detail.attemptId,
    detail,
  ]));
  const metricContracts = {
    ...Object.fromEntries(kase.sourceMetrics.map((metric) => [
      metric, LIST_SOURCE_METRIC_CONTRACTS[metric],
    ])),
    ...NATIVE_LIST_OBSERVER_METRIC_CONTRACTS,
  };
  for (const [metric, contract] of Object.entries(metricContracts)) {
    const base = recordBase(adapter, entry, kase, scale, metric, contract, observer);
    const isObserverMetric = Object.hasOwn(NATIVE_LIST_OBSERVER_METRIC_CONTRACTS, metric);
    const unavailable = cellUnavailable ?? (isObserverMetric ? observerUnavailable : null);
    if (unavailable != null) {
      records.push(notMeasuredRecord(base, unavailable));
      continue;
    }
    const observations = detailObservations(details, metric, isObserverMetric);
    const samples = observations.map(({ sample }) => sample);
    const detailSamples = observations.map(({ reference }) => reference);
    const ownsEvidence = metric === ownerMetric;
    const recordFailures = ownsEvidence
      ? failures
      : failureReferences(failures, ownerMetric);
    const record = makeRecord({
      ...base,
      samples,
      detailSamples,
      dnfCount,
      failures: recordFailures,
      attemptedCount,
      acceptedCount: details.length,
    });
    records.push({
      ...record,
      ...base,
      measurementStatus: samples.length > 0
        ? dnfCount > 0 ? 'measured-with-dnf' : 'measured'
        : 'dnf',
      notMeasuredCount: 0,
      outcomeCounts: deriveOutcomeCounts(record),
      observationCount: samples.length,
      observationCardinality: metric === 'materializationTimesMs'
        ? 'many-observations-per-accepted-attempt'
        : 'one-observation-per-accepted-attempt',
      ...(ownsEvidence ? {
        nativeListCellEvidence: {
          protocol: NATIVE_LIST_CELL_EVIDENCE_PROTOCOL,
          ownerMetric,
          acceptedAttemptsById,
        },
      } : {
        nativeListCellEvidenceRef: {
          protocol: NATIVE_LIST_CELL_EVIDENCE_PROTOCOL,
          ownerMetric,
        },
      }),
    });
  }
  return records;
}

/**
 * Run the four shared list cells against exact per-scale Native list artifacts.
 * The adapter owns device interaction; this layer validates all returned
 * semantic/allocation evidence and emits source records only from valid attempts.
 */
export async function runNativeListMatrix({
  adapter,
  entry,
  bundles,
  campaignId,
  observer = null,
  reps = 5,
  now = Date.now,
  log = () => {},
  onProgress = async () => {},
}) {
  if (typeof campaignId !== 'string' || campaignId.length === 0) {
    throw new Error('Native list run requires a campaignId.');
  }
  if (!Number.isSafeInteger(reps) || reps <= 0) {
    throw new Error('Native list reps must be a positive safe integer.');
  }
  if (typeof adapter?.environment !== 'string' || adapter.environment.length === 0
    || adapter.environment === 'lynx-for-web') {
    throw new Error('Native list adapter must declare a real Native environment.');
  }
  const entryUnavailable = preflightEntry(entry);
  const capabilityUnavailable = preflightCapability(adapter);
  const observerUnavailable = capabilityUnavailable == null
    ? preflightObserver(adapter, observer)
    : null;
  const declaredObserver = observerUnavailable == null ? observer : null;
  const receiptIds = new Set();
  const records = [];

  for (const kase of LIST_CASES) {
    for (const scale of kase.scales) {
      const artifact = preflightBundle(entry, bundles, scale);
      const cellUnavailable = entryUnavailable ?? capabilityUnavailable ?? artifact.reason;
      if (cellUnavailable != null) {
        records.push(...makeCaseRecords({
          adapter, entry, kase, scale,
          details: [],
          dnfCount: 0, failures: [], attemptedCount: 0,
          observer: declaredObserver,
          observerUnavailable: null,
          cellUnavailable,
        }));
        await onProgress(records);
        continue;
      }
      const details = [];
      const failures = [];
      let dnfCount = 0;
      for (let rep = 0; rep < reps; rep++) {
        const openedAtMs = now();
        const attemptPayload = {
          protocol: NATIVE_LIST_ATTEMPT_PROTOCOL,
          campaignId,
          entryId: entry.id,
          caseId: kase.name,
          scale,
          rep,
          bundleSha256: artifact.bundle.sha256,
          contractSha256: LIST_WORKLOAD_CONTRACT_SHA256,
          openedAtMs,
        };
        const attempt = Object.freeze({
          ...attemptPayload,
          id: sha256Json(attemptPayload).slice(0, 20),
        });
        const context = Object.freeze({
          campaignId,
          entryId: entry.id,
          kase,
          scale,
          rep,
          config: LIST_CONFIG,
          bundlePath: artifact.bundle.bundlePath,
          bundleBytes: artifact.bundle.bundleBytes,
          bundleRelativePath: artifact.bundle.relativePath,
          bundleSha256: artifact.bundle.sha256,
          contractSha256: LIST_WORKLOAD_CONTRACT_SHA256,
          fixtureProtocol: NATIVE_LIST_FIXTURE_PROTOCOL,
          workloadProtocol: LIST_FIXTURE_PROTOCOL,
          fixtureRole: NATIVE_LIST_FIXTURE_ROLE,
          fixtureId: NATIVE_LIST_FIXTURE_ID,
          observer: declaredObserver,
          attempt,
        });
        let result;
        try {
          result = await adapter.runListCase(entry, context);
          const receivedAtMs = now();
          const receivedContext = { ...context, receivedAtMs };
          if (result?.dnf === true) {
            validateDnfAttempt(result, receivedContext);
            dnfCount++;
            failures.push({ rep, attemptId: attempt.id, ...result.failure });
            continue;
          }
          validateMeasuredAttempt(result, receivedContext, receiptIds, declaredObserver);
        } catch (error) {
          dnfCount++;
          failures.push({
            rep,
            attemptId: attempt.id,
            category: result == null
              ? 'native-list-adapter-failure'
              : 'invalid-native-list-evidence',
            message: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        details.push({
          campaignId,
          attemptId: attempt.id,
          fixtureRole: NATIVE_LIST_FIXTURE_ROLE,
          fixtureId: NATIVE_LIST_FIXTURE_ID,
          caseId: kase.name,
          scale,
          bundleSha256: artifact.bundle.sha256,
          contractSha256: LIST_WORKLOAD_CONTRACT_SHA256,
          sourceMetrics: result.sourceMetrics,
          checkpoint: result.checkpoint,
          observer: result.observer,
          teardown: result.teardown,
        });
      }
      records.push(...makeCaseRecords({
        adapter, entry, kase, scale,
        details,
        dnfCount, failures, attemptedCount: reps,
        observer: declaredObserver,
        observerUnavailable,
        cellUnavailable: null,
      }));
      log(`[native-list:${adapter.environment}] ${entry.id} ${kase.name}@${scale}: `
        + `${details.length}/${reps} valid attempts`
        + (observerUnavailable == null ? '' : ' (allocation not measured)'));
      await onProgress(records);
    }
  }
  return records;
}
