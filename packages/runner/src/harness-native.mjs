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
//                               `{ latencyMs, dnf?, metrics? }` where metrics
//                               is an optional `{ name: { value, unit,
//                               boundary } }` map (native wire stats, engine
//                               counters) recorded verbatim.
//   async collectStartup()      startup observations for the last loadBundle:
//                               `{ fcpMs, settledMs?, dnf? }`.
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

import { bundleFor } from './entries.mjs';

export const NATIVE_BOUNDARIES = {
  latency: 'native-input-handler-to-second-native-frame',
  fcp: 'native-open-to-fcp',
  settled: 'native-open-to-pipeline-end',
};

const STARTUP_ROWS = [0, 1000, 10000, 30000];

async function withTransientRetry(adapter, action, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await action();
    } catch (error) {
      if (attempt >= attempts || !(await adapter.recoverTransient?.(error))) throw error;
    }
  }
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
  scales = [1000, 10000],
  startupRows = STARTUP_ROWS,
  reps = 5,
  startupReps = 3,
  log = () => {},
}) {
  const records = [];
  const uniqueStartupRows = [...new Set(startupRows)];
  for (const entry of entries) {
    log(`[native:${adapter.environment}] ${entry.id}`);
    if (suites.includes('table')) {
      for (const kase of cases) {
        for (const scale of kase.scales.filter((s) => scales.includes(s))) {
          const bundle = bundleFor(entry, { rows: 0, flavor: 'lynx' });
          if (!bundle) {
            log(`  [skip] ${entry.id}: no rows-0 lynx bundle`);
            continue;
          }
          const samples = [];
          const extras = new Map();
          let dnfCount = 0;
          for (let rep = 0; rep < reps; rep++) {
            if (adapter.isTableUnsupported?.(entry, kase, scale)) {
              dnfCount++;
              continue;
            }
            const observed = await withTransientRetry(adapter, async () => {
              await adapter.loadBundle(entry, { rows: 0, bundlePath: bundle.abs });
              await adapter.driveCase(kase, scale);
              return adapter.collect();
            });
            if (observed?.dnf) {
              dnfCount++;
              continue;
            }
            if (typeof observed?.latencyMs !== 'number') {
              throw new Error(`native adapter returned no latency for ${kase.name}@${scale}.`);
            }
            samples.push(observed.latencyMs);
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
            boundary: NATIVE_BOUNDARIES.latency,
            unit: 'ms',
            stat,
            samples,
            dnfCount,
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
            }));
          }
          log(`  ${entry.id} ${kase.name}@${scale}: ${stat ? `${stat.median.toFixed(1)}ms (n=${stat.n})` : 'no samples'}${dnfCount ? ` dnf=${dnfCount}` : ''}`);
        }
      }
    }
    if (suites.includes('startup')) {
      for (const rows of uniqueStartupRows) {
        const bundle = bundleFor(entry, { rows, flavor: 'lynx' });
        if (!bundle) continue;
        const samples = { fcp: [], settled: [] };
        let dnfCount = 0;
        for (let rep = 0; rep < startupReps; rep++) {
          if (adapter.isStartupUnsupported?.(entry, rows)) {
            dnfCount++;
            continue;
          }
          const observed = await withTransientRetry(adapter, async () => {
            await adapter.loadBundle(entry, { rows, bundlePath: bundle.abs });
            return adapter.collectStartup();
          });
          if (observed?.dnf) {
            dnfCount++;
            continue;
          }
          if (typeof observed?.fcpMs !== 'number') {
            throw new Error(`native adapter returned no fcp for startup@${rows}.`);
          }
          samples.fcp.push(observed.fcpMs);
          if (typeof observed.settledMs === 'number') samples.settled.push(observed.settledMs);
        }
        for (const [key, metric, boundary] of [
          ['fcp', 'fcp', NATIVE_BOUNDARIES.fcp],
          ['settled', 'settled', NATIVE_BOUNDARIES.settled],
        ]) {
          const stat = summarize(samples[key]);
          if (!stat && metric !== 'fcp') continue;
          records.push(makeRecord({
            suite: 'startup',
            harness: 'native',
            environment: adapter.environment,
            entry: entry.id,
            workload: 'startup',
            scale: rows,
            metric,
            boundary,
            unit: 'ms',
            stat,
            samples: samples[key],
            dnfCount: metric === 'fcp' ? dnfCount : 0,
          }));
        }
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
  const adapter = await loadNativeAdapter(options.adapterPath, { log: options.log });
  try {
    return {
      records: await runNativeMatrix({ ...options, adapter }),
      environment: adapter.environment,
      machine: adapter.machine ?? null,
    };
  } finally {
    await adapter.dispose();
  }
}
