// Native-engine harness: the preserved capability, explicitly separated from
// the web harness (docs/DESIGN.md "Harnesses").
//
// Every entry ships `main.lynx.bundle` alongside its web bundle, and the
// result schema carries `harness: "native"` end to end. This module owns the
// executable side of that capability: entry discovery, workload sequencing,
// DNF accounting, and schema-shaped record emission are implemented here. A
// device adapter is passed via `--adapter <module.mjs>`; this repository ships
// an Android Lynx Sandbox adapter and keeps the interface open for other farms.
//
// An adapter module default-exports `createAdapter(context)` returning:
//
//   environment                 REQUIRED string naming the device class
//                               (e.g. "lynx-native-ios-sim"); must not be
//                               "lynx-for-web" — native and web records are
//                               never comparable and COMPARABILITY_KEYS keeps
//                               them apart.
//   async loadBundle(entry, {rows, bundlePath})
//                               install/launch the entry's main.lynx.bundle
//                               variant on the device (fresh app state).
//   async driveCase(kase, scale)
//                               dispatch one operation through the shared
//                               workload contract (taps by label/cell, storms
//                               in-app) — e.g. via lynx-devtool CDP (Input
//                               domain) or agent-device. Resolves when the
//                               operation's predicate holds on-device.
//   async collect()             per-op observations for the last drive:
//                               `{ latencyMs, dnf?, failure?, metrics? }` where metrics
//                               is an optional `{ name: { value, unit,
//                               boundary } }` map (native wire stats, engine
//                               counters) recorded verbatim.
//   async collectStartup()      startup observations for the last loadBundle:
//                               `{ fcpMs?, settledMs?, metrics?, detail?, dnf?,
//                               failure?, metricContracts? }`. Contracts let
//                               a DNF retain metric identity without fabricating
//                               a value (for example Octane's isolated ACK metrics).
//   async dispose()             release the device.
//
// The harness never fabricates native numbers: without an adapter it explains
// itself and exits, and nothing in this repository registers a proxy adapter
// (node --jitless and jsdom PAPI proxies were explicitly rejected — see
// docs/METHODOLOGY.md "Harness separation").
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { summarize } from '@lynx-bench/shared/stats';
import { makeRecord } from '@lynx-bench/shared/schema';

import { nativeBundleSnapshot } from './native-inputs.mjs';
import { NATIVE_SANDBOX_POLICY } from './native-protocol.mjs';
import { NATIVE_STARTUP_SCALES, NATIVE_TABLE_SCALES } from './run-matrix.mjs';
import { nativeStartupMetricContracts } from './native-coverage.mjs';

export const NATIVE_BOUNDARIES = {
  latency: 'native-input-handler-to-second-native-frame',
  fcp: 'native-open-to-fcp',
  settled: 'native-open-to-pipeline-end',
};

export class NativeLeaseExpiryStop extends Error {
  constructor(records) {
    super('Native campaign stopped safely before lease expiry.');
    this.name = 'NativeLeaseExpiryStop';
    this.records = records;
  }
}

async function withTransientRetry(
  adapter,
  action,
  attempts = NATIVE_SANDBOX_POLICY.transientAttempts,
) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await action();
    } catch (error) {
      if (error instanceof NativeLeaseExpiryStop) throw error;
      if (attempt >= attempts || !(await adapter.recoverTransient?.(error))) throw error;
    }
  }
}

async function classifyCellFailure(adapter, error, context) {
  // Lease expiry is campaign control flow, never a failed measurement. Keep it
  // ahead of adapter classification even if an adapter has a broad classifier.
  if (error instanceof NativeLeaseExpiryStop) throw error;
  const observed = await adapter.classifyFailure?.(error, context);
  if (!observed?.dnf) throw error;
  return observed;
}

export async function loadNativeAdapter(adapterPath, context = {}) {
  const resolved = path.resolve(adapterPath);
  const module = await import(pathToFileURL(resolved).href);
  const factory = module.default;
  if (typeof factory !== 'function') {
    throw new Error(`native adapter ${adapterPath} must default-export createAdapter(context).`);
  }
  const adapter = await factory(context);
  for (const method of ['loadBundle', 'driveCase', 'collect', 'collectStartup', 'dispose']) {
    if (typeof adapter?.[method] !== 'function') {
      throw new Error(`native adapter ${adapterPath} is missing ${method}().`);
    }
  }
  if (typeof adapter.environment !== 'string' || adapter.environment.length === 0) {
    throw new Error(`native adapter ${adapterPath} must declare a device-class environment string.`);
  }
  if (adapter.environment === 'lynx-for-web') {
    throw new Error('native adapter environment must not be "lynx-for-web"; native and web records are never comparable.');
  }
  return adapter;
}

/** Load the diagnostic direct-ADB surface without requiring ranked/CDP methods. */
export async function loadNativeCapacityAdapter(adapterPath, context = {}) {
  const resolved = path.resolve(adapterPath);
  const module = await import(pathToFileURL(resolved).href);
  const factory = module.default;
  if (typeof factory !== 'function') {
    throw new Error(`native adapter ${adapterPath} must default-export createAdapter(context).`);
  }
  const adapter = await factory({ ...context, mode: 'capacity' });
  for (const method of ['runCapacityProbe', 'dispose']) {
    if (typeof adapter?.[method] !== 'function') {
      throw new Error(`native capacity adapter ${adapterPath} is missing ${method}().`);
    }
  }
  if (typeof adapter.environment !== 'string' || adapter.environment.length === 0) {
    throw new Error(`native capacity adapter ${adapterPath} must declare a device-class environment string.`);
  }
  if (adapter.environment === 'lynx-for-web') {
    throw new Error('native capacity adapter environment must not be "lynx-for-web".');
  }
  return adapter;
}

/**
 * Drive the full case matrix through one adapter. Timeouts inside the adapter
 * surface as `{dnf: true}` observations and are counted, never dropped; any
 * other adapter error aborts the run (a broken adapter is a harness bug, not
 * data — the same policy the web harness applies to itself).
 */
export async function runNativeMatrix({
  adapter,
  entries,
  cases,
  suites = ['table', 'startup'],
  scales = NATIVE_TABLE_SCALES,
  startupScales = NATIVE_STARTUP_SCALES,
  bundleSnapshots = null,
  reps = 5,
  startupReps = 3,
  log = () => {},
  onProgress = async () => {},
  existingCellKeys = new Set(),
  shouldStopBeforeCell = () => false,
}) {
  if (bundleSnapshots == null) {
    throw new Error(
      'Native device runs require immutable bundle snapshots; mutable bundle paths are not supported.',
    );
  }
  const records = [];
  const stopIfNeeded = () => {
    if (shouldStopBeforeCell()) throw new NativeLeaseExpiryStop(records);
  };
  for (const entry of entries) {
    // There is deliberately no entry-wide page/session setup here. loadBundle
    // runs only after the next missing contract key has been selected, so an
    // exhausted setup transport failure belongs to that exact cell.
    log(`[native:${adapter.environment}] ${entry.id}`);
    if (suites.includes('table')) {
      for (const kase of cases) {
        for (const scale of kase.scales.filter((s) => scales.includes(s))) {
          const expectedKey = [entry.id, 'table', kase.name, scale, 'latency'].join('|');
          if (existingCellKeys.has(expectedKey)) continue;
          stopIfNeeded();
          const bundle = nativeBundleSnapshot(bundleSnapshots, entry.id, 0);
          const samples = [];
          const detailSamples = [];
          const extras = new Map();
          let latencyBoundary = null;
          let dnfCount = 0;
          const failures = [];
          for (let rep = 0; rep < reps; rep++) {
            if (adapter.isTableUnsupported?.(entry, kase, scale)) {
              dnfCount++;
              const failure = adapter.tableUnsupportedReason?.(entry, kase, scale);
              if (failure != null) failures.push({ rep, ...failure });
              continue;
            }
            let observed;
            let failureStage = 'loadBundle';
            try {
              observed = await withTransientRetry(adapter, async () => {
                failureStage = 'loadBundle';
                await adapter.loadBundle(entry, {
                  rows: 0,
                  bundlePath: bundle.bundlePath,
                  bundleBytes: bundle.bundleBytes,
                  bundleSha256: bundle.sha256 ?? bundle.bundleSha256,
                  suite: 'table',
                });
                failureStage = 'driveCase';
                await adapter.driveCase(kase, scale);
                failureStage = 'collect';
                return adapter.collect();
              });
            } catch (error) {
              observed = await classifyCellFailure(adapter, error, {
                suite: 'table', entry, kase, scale, stage: failureStage,
              });
            }
            if (observed?.dnf) {
              dnfCount++;
              if (observed.failure != null) failures.push({ rep, ...observed.failure });
              continue;
            }
            if (typeof observed?.latencyMs !== 'number') {
              throw new Error(`native adapter returned no latency for ${kase.name}@${scale}.`);
            }
            samples.push(observed.latencyMs);
            detailSamples.push(observed.detail ?? null);
            const observedBoundary = observed.boundary ?? NATIVE_BOUNDARIES.latency;
            if (latencyBoundary !== null && latencyBoundary !== observedBoundary) {
              throw new Error(`native adapter changed the latency boundary within ${kase.name}@${scale}.`);
            }
            latencyBoundary = observedBoundary;
            for (const [name, extra] of Object.entries(observed.metrics ?? {})) {
              if (!extras.has(name)) extras.set(name, { unit: extra.unit, boundary: extra.boundary, values: [] });
              extras.get(name).values.push(extra.value);
            }
          }
          const stat = summarize(samples);
          records.push(makeRecord({
            suite: 'table',
            harness: 'native',
            environment: adapter.environment,
            entry: entry.id,
            workload: kase.name,
            scale,
            metric: 'latency',
            boundary: latencyBoundary ?? NATIVE_BOUNDARIES.latency,
            unit: 'ms',
            stat,
            samples,
            detailSamples,
            dnfCount,
            failures,
            attemptedCount: reps,
            acceptedCount: samples.length,
          }));
          for (const [name, extra] of extras) {
            records.push(makeRecord({
              suite: 'table',
              harness: 'native',
              environment: adapter.environment,
              entry: entry.id,
              workload: kase.name,
              scale,
              metric: name,
              boundary: extra.boundary ?? NATIVE_BOUNDARIES.latency,
              unit: extra.unit ?? 'count',
              stat: summarize(extra.values),
              samples: extra.values,
              attemptedCount: reps,
              acceptedCount: extra.values.length,
            }));
          }
          log(`  ${entry.id} ${kase.name}@${scale}: ${stat ? `${stat.median.toFixed(1)}ms (n=${stat.n})` : 'no samples'}${dnfCount ? ` dnf=${dnfCount}` : ''}`);
          await onProgress(records);
        }
      }
    }
    if (suites.includes('startup')) {
      for (const rows of NATIVE_STARTUP_SCALES.filter((rows) => startupScales.includes(rows))) {
        const startupKeys = nativeStartupMetricContracts(entry).map(({ metric }) =>
          [entry.id, 'startup', 'startup', rows, metric].join('|'));
        const existingStartupMetrics = startupKeys.filter((key) => existingCellKeys.has(key)).length;
        if (existingStartupMetrics === startupKeys.length) continue;
        if (existingStartupMetrics !== 0) {
          throw new Error(`${entry.id} startup@${rows} is only partially checkpointed.`);
        }
        stopIfNeeded();
        const bundle = nativeBundleSnapshot(bundleSnapshots, entry.id, rows);
        const observations = new Map();
        const expectedMetrics = nativeStartupMetricContracts(entry);
        const expectedMetricNames = new Set(expectedMetrics.map(({ metric }) => metric));
        let dnfCount = 0;
        const failures = [];
        const addContract = (name, unit, boundary) => {
          if (!observations.has(name)) observations.set(name, { unit, boundary, values: [], details: [] });
        };
        const addObservation = (name, value, unit, boundary, detail) => {
          if (!Number.isFinite(value)) return;
          addContract(name, unit, boundary);
          const current = observations.get(name);
          if (current.unit !== unit || current.boundary !== boundary) {
            throw new Error(`native adapter changed the ${name} startup metric contract within one cell.`);
          }
          current.values.push(value);
          current.details.push(detail ?? null);
        };
        for (const contract of expectedMetrics) {
          addContract(contract.metric, contract.unit, contract.boundary);
        }
        for (let rep = 0; rep < startupReps; rep++) {
          if (adapter.isStartupUnsupported?.(entry, rows)) {
            dnfCount++;
            const failure = adapter.startupUnsupportedReason?.(entry, rows);
            if (failure != null) failures.push({ rep, ...failure });
            for (const contract of adapter.startupUnsupportedContracts?.(entry, rows) ?? []) {
              addContract(contract.name, contract.unit, contract.boundary);
            }
            continue;
          }
          let observed;
          let failureStage = 'loadBundle';
          try {
            observed = await withTransientRetry(adapter, async () => {
              failureStage = 'loadBundle';
              await adapter.loadBundle(entry, {
                rows,
                bundlePath: bundle.bundlePath,
                bundleBytes: bundle.bundleBytes,
                bundleSha256: bundle.sha256 ?? bundle.bundleSha256,
                suite: 'startup',
              });
              failureStage = 'collectStartup';
              return adapter.collectStartup();
            });
          } catch (error) {
            observed = await classifyCellFailure(adapter, error, {
              suite: 'startup', entry, rows, stage: failureStage,
            });
          }
          if (observed?.dnf) {
            dnfCount++;
            if (observed.failure != null) failures.push({ rep, ...observed.failure });
            for (const contract of observed.metricContracts ?? []) {
              addContract(contract.name, contract.unit, contract.boundary);
            }
            continue;
          }
          const returned = new Map();
          if (Number.isFinite(observed?.fcpMs)) {
            returned.set('fcp', {
              value: observed.fcpMs, unit: 'ms', boundary: NATIVE_BOUNDARIES.fcp,
            });
          }
          if (Number.isFinite(observed?.settledMs)) {
            returned.set('settled', {
              value: observed.settledMs, unit: 'ms', boundary: NATIVE_BOUNDARIES.settled,
            });
          }
          for (const [name, metric] of Object.entries(observed?.metrics ?? {})) {
            returned.set(name, {
              value: metric.value,
              unit: metric.unit ?? 'count',
              boundary: metric.boundary ?? `native-${name}`,
            });
          }
          const unexpected = [...returned.keys()].filter((name) => !expectedMetricNames.has(name));
          const absent = [...expectedMetricNames].filter((name) => !returned.has(name));
          if (unexpected.length > 0 || absent.length > 0) {
            throw new Error(
              `${entry.id} startup@${rows} returned an invalid metric set: `
              + `missing=${absent.join(',') || 'none'} unexpected=${unexpected.join(',') || 'none'}.`,
            );
          }
          for (const { metric, unit, boundary } of expectedMetrics) {
            const value = returned.get(metric);
            if (!Number.isFinite(value.value) || value.unit !== unit || value.boundary !== boundary) {
              throw new Error(`${entry.id} startup@${rows} changed the ${metric} metric contract.`);
            }
            addObservation(metric, value.value, unit, boundary, observed?.detail);
          }
        }
        for (const [metric, observation] of observations) {
          const stat = summarize(observation.values);
          records.push(makeRecord({
            suite: 'startup',
            harness: 'native',
            environment: adapter.environment,
            entry: entry.id,
            workload: 'startup',
            scale: rows,
            metric,
            boundary: observation.boundary,
            unit: observation.unit,
            stat,
            samples: observation.values,
            detailSamples: observation.details,
            dnfCount,
            failures,
            attemptedCount: startupReps,
            acceptedCount: observation.values.length,
          }));
        }
        await onProgress(records);
      }
    }
  }
  return records;
}

export async function runNativeHarness(options = undefined) {
  if (!options?.adapterPath) {
    throw new Error(
      'native harness: no device adapter is wired. Pass --adapter <module.mjs> '
      + 'implementing the contract documented in packages/runner/src/harness-native.mjs; '
      + 'entries keep main.lynx.bundle and the schema reserves harness:"native".',
    );
  }
  const adapter = await loadNativeAdapter(options.adapterPath, {
    log: options.log,
    campaignIdentity: options.campaignIdentity ?? null,
  });
  try {
    const onProgress = async (records) => options.onProgress?.({
      records,
      environment: adapter.environment,
      machine: adapter.machine ?? null,
    });
    let records;
    let stoppedForLeaseExpiry = false;
    try {
      records = await runNativeMatrix({ ...options, adapter, onProgress });
    } catch (error) {
      if (!(error instanceof NativeLeaseExpiryStop)) throw error;
      records = error.records;
      stoppedForLeaseExpiry = true;
    }
    return {
      records,
      environment: adapter.environment,
      machine: adapter.machine ?? null,
      stoppedForLeaseExpiry,
    };
  } finally {
    await adapter.dispose();
  }
}
