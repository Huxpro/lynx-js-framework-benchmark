import crypto from 'node:crypto';
import path from 'node:path';

import {
  assertNativeDiagnosticManifest,
  DEFAULT_MIN_ACCEPTED_SAMPLES,
  NATIVE_CAPACITY_CONTRACT_VERSION,
  NATIVE_CAPACITY_DEFAULT_SCALES,
  NATIVE_CAPACITY_FIXTURE_PROTOCOL,
  NATIVE_CAPACITY_FIXTURE_ROLE,
  NATIVE_CAPACITY_OUTCOME_PROTOCOL,
  NATIVE_CAPACITY_SUITE,
  NATIVE_CAPACITY_THRESHOLD_SCALES,
  NATIVE_DIAGNOSTIC_ENTRY_ID,
  REPORTABILITY_PROTOCOL,
} from '@lynx-bench/shared/native-diagnostic-contract';
import { makeRecord } from '@lynx-bench/shared/schema';

export const NATIVE_CAPACITY_ENTRY_ID = NATIVE_DIAGNOSTIC_ENTRY_ID;
export const NATIVE_CAPACITY_CAMPAIGN_VERSION = 'native-capacity-campaign-v2';
export {
  assertNativeDiagnosticManifest as assertNativeCapacityDiagnosticEntry,
  NATIVE_CAPACITY_DEFAULT_SCALES,
  NATIVE_CAPACITY_CONTRACT_VERSION,
  NATIVE_CAPACITY_FIXTURE_PROTOCOL,
  NATIVE_CAPACITY_SUITE,
  NATIVE_CAPACITY_THRESHOLD_SCALES,
};

const sha256Json = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sha256Bytes = (value) => crypto.createHash('sha256').update(value).digest('hex');

function positiveInteger(value, label, fallback) {
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return parsed;
}

export function assertNativeCapacityContract(contract) {
  const expectedDefault = JSON.stringify(NATIVE_CAPACITY_DEFAULT_SCALES);
  const expectedThresholds = JSON.stringify([
    ...NATIVE_CAPACITY_DEFAULT_SCALES,
    ...NATIVE_CAPACITY_THRESHOLD_SCALES,
  ].sort((a, b) => a - b));
  const actualScales = JSON.stringify(contract?.scales);
  if (contract?.protocol !== NATIVE_CAPACITY_CONTRACT_VERSION
    || contract.suite !== NATIVE_CAPACITY_SUITE
    || contract.entryId !== NATIVE_CAPACITY_ENTRY_ID
    || contract.fixtureRole !== NATIVE_CAPACITY_FIXTURE_ROLE
    || contract.diagnostic !== true
    || contract.rankingEligible !== false
    || !Number.isSafeInteger(contract.reps)
    || contract.reps <= 0
    || (actualScales !== expectedDefault && actualScales !== expectedThresholds)) {
    throw new Error('invalid Native capacity suite contract.');
  }
  const { sha256, ...payload } = contract;
  if (!/^[a-f0-9]{64}$/.test(sha256 ?? '') || sha256Json(payload) !== sha256) {
    throw new Error('Native capacity suite contract checksum does not match its payload.');
  }
  return contract;
}

/** Resolve the diagnostic-only matrix without touching the publishable Native matrix. */
export function resolveNativeCapacitySuite({
  requested = false,
  includeThresholds = false,
  entries = [],
  reps = null,
  suite = null,
  cases = null,
  scale = null,
  startupScale = null,
  startupReps = null,
  stormReps = null,
  commit = null,
  quick = null,
  resume = null,
} = {}) {
  if (!requested) {
    if (includeThresholds) {
      throw new Error('--capacity-thresholds requires --native-capacity.');
    }
    return null;
  }
  const conflicts = [
    ['--suite', suite],
    ['--case', cases],
    ['--scale', scale],
    ['--startup-scale', startupScale],
    ['--startup-reps', startupReps],
    ['--storm-reps', stormReps],
    ['--commit', commit],
    ['--quick', quick],
    ['--resume', resume],
  ].filter(([, value]) => value != null);
  if (conflicts.length > 0) {
    throw new Error(
      `--native-capacity cannot be combined with ${conflicts.map(([flag]) => flag).join(', ')}.`,
    );
  }
  if (entries.length !== 1) {
    throw new Error(`--native-capacity requires exactly the ${NATIVE_CAPACITY_ENTRY_ID} entry.`);
  }
  const entry = assertNativeDiagnosticManifest(entries[0]);
  const scales = [
    ...NATIVE_CAPACITY_DEFAULT_SCALES,
    ...(includeThresholds ? NATIVE_CAPACITY_THRESHOLD_SCALES : []),
  ].sort((a, b) => a - b);
  const repetitions = positiveInteger(reps, '--reps', 5);
  const cells = scales.map((probeScale) => Object.freeze({
    suite: NATIVE_CAPACITY_SUITE,
    entry: NATIVE_CAPACITY_ENTRY_ID,
    fixtureRole: NATIVE_CAPACITY_FIXTURE_ROLE,
    workload: 'create',
    scale: probeScale,
    artifact: Object.freeze({ ...entry.capacityFixture.scales[String(probeScale)] }),
    thresholdProbe: NATIVE_CAPACITY_THRESHOLD_SCALES.includes(probeScale),
    diagnostic: true,
    rankingEligible: false,
  }));
  const payload = {
    protocol: NATIVE_CAPACITY_CONTRACT_VERSION,
    suite: NATIVE_CAPACITY_SUITE,
    entryId: NATIVE_CAPACITY_ENTRY_ID,
    fixtureRole: NATIVE_CAPACITY_FIXTURE_ROLE,
    scales,
    reps: repetitions,
    diagnostic: true,
    rankingEligible: false,
  };
  const contract = Object.freeze({ ...payload, sha256: sha256Json(payload) });
  assertNativeCapacityContract(contract);
  return Object.freeze({ entry, scales: Object.freeze(scales), cells: Object.freeze(cells), contract });
}

/**
 * Run one outcome-oriented eager capacity cell per declared scale. The adapter
 * owns launch/death classification; this layer never converts a missing hook
 * or thrown harness error into a successful or timed observation.
 */
export async function runNativeCapacitySuite({
  adapter,
  entry,
  contract,
  bundles,
  log = () => {},
  onProgress = async () => {},
}) {
  assertNativeDiagnosticManifest(entry);
  assertNativeCapacityContract(contract);
  if (typeof adapter?.runCapacityProbe !== 'function') {
    throw new Error('native adapter is missing required runCapacityProbe().');
  }
  if (typeof adapter.environment !== 'string' || adapter.environment.length === 0) {
    throw new Error('native capacity adapter must declare an environment.');
  }
  for (const scale of contract.scales) {
    const bundle = bundles?.[String(scale)];
    const declared = entry.capacityFixture.scales[String(scale)];
    if (!Buffer.isBuffer(bundle?.bundleBytes)
      || typeof bundle.bundlePath !== 'string'
      || typeof entry.dir !== 'string'
      || bundle.relativePath !== declared.bundle
      || path.resolve(bundle.bundlePath) !== path.resolve(entry.dir, declared.bundle)
      || bundle.sha256 !== declared.sha256
      || sha256Bytes(bundle.bundleBytes) !== bundle.sha256) {
      throw new Error(`Native capacity suite requires an immutable ${scale}-row bundle snapshot.`);
    }
  }

  const records = [];
  for (const scale of contract.scales) {
    const bundle = bundles[String(scale)];
    const thresholdProbe = NATIVE_CAPACITY_THRESHOLD_SCALES.includes(scale);
    const samples = [];
    const detailSamples = [];
    const failures = [];
    const diagnosticOutcomes = [];
    let dnfCount = 0;
    for (let rep = 0; rep < contract.reps; rep++) {
      const observed = await adapter.runCapacityProbe(entry, {
        suite: NATIVE_CAPACITY_SUITE,
        fixtureRole: contract.fixtureRole,
        scale,
        rep,
        bundlePath: bundle.bundlePath,
        bundleBytes: bundle.bundleBytes,
        bundleSha256: bundle.sha256,
        contractSha256: contract.sha256,
      });
      if (observed?.dnf === true) {
        if (observed.failure == null || typeof observed.failure.category !== 'string') {
          throw new Error(`Native capacity adapter returned DNF without a failure category at ${scale}.`);
        }
        dnfCount++;
        failures.push({ rep, ...observed.failure });
        diagnosticOutcomes.push({
          rep,
          outcome: 'dnf',
          failure: { category: observed.failure.category },
        });
        continue;
      }
      if (!Number.isFinite(observed?.latencyMs)) {
        throw new Error(`Native capacity adapter returned no completion latency at ${scale}.`);
      }
      diagnosticOutcomes.push({
        rep,
        outcome: 'completed',
        latencyMs: observed.latencyMs,
      });
      // Threshold bisection is outcome evidence only. It can locate a device-
      // specific boundary, but it never becomes a performance timing sample.
      if (!thresholdProbe) {
        samples.push(observed.latencyMs);
        detailSamples.push(observed.detail ?? null);
      }
    }
    const record = {
      ...makeRecord({
        suite: NATIVE_CAPACITY_SUITE,
        harness: 'native',
        environment: adapter.environment,
        entry: entry.id,
        workload: 'create',
        scale,
        metric: 'loadToSemanticCompletion',
        boundary: 'native-launch-to-valid-completion-receipt',
        unit: 'ms',
        samples,
        detailSamples,
        dnfCount,
        failures,
        attemptedCount: contract.reps,
        acceptedCount: samples.length,
        contractVersion: contract.protocol,
      }),
      fixtureRole: contract.fixtureRole,
      capacityContractSha256: contract.sha256,
      thresholdProbe,
      diagnostic: true,
      rankingEligible: false,
      timingEligible: !thresholdProbe,
      outcomeProtocol: NATIVE_CAPACITY_OUTCOME_PROTOCOL,
      reportability: {
        protocol: REPORTABILITY_PROTOCOL,
        minAcceptedSamples: DEFAULT_MIN_ACCEPTED_SAMPLES,
      },
      diagnosticOutcomes,
    };
    records.push(record);
    log(
      `[native:${adapter.environment}:capacity] ${entry.id} create@${scale}: `
      + `${samples.length} samples, ${dnfCount} DNF`
      + (thresholdProbe ? ' (threshold outcome only)' : ''),
    );
    await onProgress(records);
  }
  return records;
}
