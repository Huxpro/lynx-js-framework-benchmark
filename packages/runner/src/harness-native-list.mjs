import crypto from 'node:crypto';

import { makeRecord } from '@lynx-bench/shared/schema';
import { summarize } from '@lynx-bench/shared/stats';
import {
  LIST_CASES,
  LIST_CONFIG,
  LIST_SOURCE_METRIC_CONTRACTS,
  LIST_WORKLOAD_CONTRACT_VERSION,
} from '../../shared/src/list-workloads.mjs';
import { loadNativeAdapter, NativeLeaseExpiryStop } from './harness-native.mjs';
import { nativeListBundleSnapshot } from './list-native-inputs.mjs';

export const NATIVE_LIST_MATRIX_VERSION = 'native-list-matrix-v1';
export const NATIVE_LIST_CAMPAIGN_VERSION = 'native-list-sandbox-campaign-v1';

export const nativeListCellKey = (cell) =>
  [cell.entry, 'list', cell.workload, cell.scale, cell.metric].join('|');

export function buildNativeListMatrixContract(entries) {
  const cells = entries.flatMap((entry) =>
    LIST_CASES.flatMap((kase) =>
      kase.scales.flatMap((scale) =>
        kase.sourceMetrics.map((metric) => ({
          entry: entry.id,
          suite: 'list',
          workload: kase.name,
          scale,
          metric,
          ...LIST_SOURCE_METRIC_CONTRACTS[metric],
          contractVersion: LIST_WORKLOAD_CONTRACT_VERSION,
        })),
      ),
    ),
  );
  const payload = {
    version: NATIVE_LIST_MATRIX_VERSION,
    entryIds: entries.map((entry) => entry.id),
    cells,
  };
  return {
    ...payload,
    expectedCellCount: cells.length,
    sha256: crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
  };
}

function emitNativeListRecord({
  adapter,
  entry,
  kase,
  scale,
  metric,
  samples,
  detailSamples,
  dnfCount,
  failures,
  attemptedCount,
}) {
  const contract = LIST_SOURCE_METRIC_CONTRACTS[metric];
  return makeRecord({
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
    samples,
    detailSamples,
    dnfCount,
    failures,
    attemptedCount: metric === 'materializationTimesMs'
      ? samples.length + dnfCount
      : attemptedCount,
    acceptedCount: samples.length,
  });
}

export async function runNativeListMatrix({
  adapter,
  entries,
  cases = LIST_CASES,
  bundleSnapshots,
  reps = LIST_CONFIG.recycle.repetitions,
  log = () => {},
  onProgress = async () => {},
  existingCellKeys = new Set(),
  shouldStopBeforeRepetition = () => false,
}) {
  const records = [];
  for (const entry of entries) {
    log(`[native-list:${adapter.environment}] ${entry.id}`);
    for (const kase of cases) {
      for (const scale of kase.scales) {
        const keys = kase.sourceMetrics.map((metric) =>
          nativeListCellKey({
            entry: entry.id,
            workload: kase.name,
            scale,
            metric,
          }),
        );
        const existingCount = keys.filter((key) => existingCellKeys.has(key)).length;
        if (existingCount === keys.length) continue;
        if (existingCount !== 0) {
          throw new Error(`${entry.id} ${kase.name}@${scale} is only partially checkpointed.`);
        }
        const bundle = nativeListBundleSnapshot(bundleSnapshots, entry.id, scale);
        const observations = Object.fromEntries(kase.sourceMetrics.map((metric) => [metric, []]));
        const detail = Object.fromEntries(kase.sourceMetrics.map((metric) => [metric, []]));
        const metricDnfs = Object.fromEntries(kase.sourceMetrics.map((metric) => [metric, 0]));
        const metricFailures = Object.fromEntries(kase.sourceMetrics.map((metric) => [metric, []]));
        for (let rep = 0; rep < reps; rep++) {
          if (shouldStopBeforeRepetition()) throw new NativeLeaseExpiryStop(records);
          try {
            await adapter.loadBundle(entry, {
              rows: scale,
              bundlePath: bundle.bundlePath,
              bundleBytes: bundle.bundleBytes,
              bundleSha256: bundle.sha256,
              suite: 'list',
            });
            const startup = await adapter.collectListStartup();
            if (kase.name === 'list-startup') {
              if (!Number.isFinite(startup.firstVisibleContentMs)) {
                throw new Error(`${entry.id} list-startup@${scale} omitted firstVisibleContentMs.`);
              }
              observations.firstVisibleContentMs.push(startup.firstVisibleContentMs);
              detail.firstVisibleContentMs.push(startup);
              continue;
            }
            const measured = await adapter.driveListCase(kase, scale, startup.initial);
            const repetition = {};
            for (const metric of kase.sourceMetrics) {
              const value = measured.metrics?.[metric];
              if (metric === 'materializationTimesMs' && Array.isArray(value)) {
                if (value.length === 0 || value.some((sample) => !Number.isFinite(sample))) {
                  throw new Error(`${entry.id} ${kase.name}@${scale} returned invalid ${metric}.`);
                }
                repetition[metric] = { samples: value, detail: null };
                continue;
              }
              if (Number.isFinite(value)) {
                repetition[metric] = {
                  samples: [value],
                  detail: measured.detail ?? null,
                };
                continue;
              }
              const failure = measured.metricFailures?.[metric];
              if (failure == null) {
                throw new Error(`${entry.id} ${kase.name}@${scale} omitted ${metric}.`);
              }
              repetition[metric] = { failure };
            }
            for (const metric of kase.sourceMetrics) {
              const result = repetition[metric];
              if (result.failure != null) {
                metricDnfs[metric]++;
                metricFailures[metric].push({ rep, ...result.failure });
              } else {
                observations[metric].push(...result.samples);
                if (result.detail != null) detail[metric].push(result.detail);
              }
            }
          } catch (error) {
            for (const metric of kase.sourceMetrics) {
              metricDnfs[metric]++;
              metricFailures[metric].push({
                rep,
                category: 'native-list-capture-failure',
                capabilityScope: 'cell',
                message: String(error),
              });
            }
            log(
              `  [dnf] ${entry.id} ${kase.name}@${scale} rep${rep}: ${String(error).slice(0, 160)}`,
            );
          }
        }
        for (const metric of kase.sourceMetrics) {
          records.push(
            emitNativeListRecord({
              adapter,
              entry,
              kase,
              scale,
              metric,
              samples: observations[metric],
              detailSamples: detail[metric],
              dnfCount: metricDnfs[metric],
              failures: metricFailures[metric],
              attemptedCount: reps,
            }),
          );
        }
        const headline = kase.sourceMetrics[0];
        const stat = summarize(observations[headline]);
        log(
          `  ${entry.id} ${kase.name}@${scale}: ${stat ? stat.median.toFixed(2) : 'DNF'} ${LIST_SOURCE_METRIC_CONTRACTS[headline].unit}`,
        );
        await onProgress(records);
      }
    }
  }
  return records;
}

export async function runNativeListHarness(options) {
  const adapter = await loadNativeAdapter(options.adapterPath, {
    log: options.log,
    campaignIdentity: options.campaignIdentity ?? null,
  });
  for (const method of ['collectListStartup', 'driveListCase']) {
    if (typeof adapter[method] !== 'function') {
      await adapter.dispose();
      throw new Error(`native list adapter ${options.adapterPath} is missing ${method}().`);
    }
  }
  try {
    let records;
    let stoppedForLeaseExpiry = false;
    try {
      records = await runNativeListMatrix({
        ...options,
        adapter,
        onProgress: async (next) =>
          options.onProgress?.({
            records: next,
            environment: adapter.environment,
            machine: adapter.machine ?? null,
          }),
      });
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
