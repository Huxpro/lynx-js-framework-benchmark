import path from 'node:path';

import { SCHEMA_VERSION } from '@lynx-bench/shared/schema';

import { collectRuns } from './collect.mjs';
import { bundleFor } from './entries.mjs';
import {
  assertVueVaporLabSelectedRows,
  verifyPinnedVueVaporLabEntry,
  verifyVueVaporLabBenchmarkState,
} from './lab-artifacts.mjs';
import { validateRunMatrix } from './run-matrix.mjs';
import { writeRunFile } from './run-files.mjs';
import { runNativeHarness } from './harness-native.mjs';
import {
  materializeNativeBundleSnapshots,
  pinNativeAdapterGraph,
} from './native-inputs.mjs';
import {
  captureNativeBenchmarkFingerprint,
  createNativeCohort,
  validateNativeMachine,
} from './native-cohort.mjs';

function entryArtifacts(entries, verifiedLabEntries) {
  return Object.fromEntries(entries.map((entry) => {
    const verified = verifiedLabEntries.get(entry.id);
    return [entry.id, {
      fingerprint: verified.fingerprint,
      ...verified.cohort,
    }];
  }));
}

export function assertNativeLabBundles(
  entries,
  suites,
  scales,
  startupScales = scales,
) {
  for (const entry of entries) {
    if (suites.includes('table') && !bundleFor(entry, { rows: 0, flavor: 'lynx' })) {
      throw new Error(`${entry.id}: table suite requires a rows-0 Lynx bundle`);
    }
    if (suites.includes('startup')) {
      for (const rows of startupScales) {
        if (!bundleFor(entry, { rows, flavor: 'lynx' })) {
          throw new Error(`${entry.id}: startup@${rows} requires a rows-${rows} Lynx bundle`);
        }
      }
    }
  }
}

async function finishNativeResources(primaryError, disposers) {
  const cleanupErrors = [];
  for (const dispose of disposers) {
    if (typeof dispose !== 'function') continue;
    try {
      await dispose();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (primaryError) {
    if (cleanupErrors.length) {
      throw new AggregateError(
        [primaryError, ...cleanupErrors],
        'Native measurement failed and cleanup also failed',
        { cause: primaryError },
      );
    }
    throw primaryError;
  }
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Native cleanup failed');
}

export async function executeNativeRun({
  adapterPath,
  entries,
  cases,
  suites,
  scales,
  startupScales = null,
  reps,
  startupReps,
  label = null,
  root,
  benchmarkRoot,
  verifiedLabEntries = null,
  verifiedLabBenchmark = null,
  noCollect = false,
  argv = [],
  campaign = null,
  startedAt = null,
  resolvedMatrix = null,
  now = () => new Date(),
  runHarness = runNativeHarness,
  collect = collectRuns,
  verifyPinnedEntry = verifyPinnedVueVaporLabEntry,
  verifyBenchmarkState = verifyVueVaporLabBenchmarkState,
  writeRun = writeRunFile,
  materializeBundles = materializeNativeBundleSnapshots,
  pinAdapter = pinNativeAdapterGraph,
  captureBenchmarkFingerprint = captureNativeBenchmarkFingerprint,
  log = console.log,
}) {
  const matrix = validateRunMatrix({
    cases,
    suites,
    scales,
    startupScales: startupScales ?? scales,
    reps,
    startupReps,
    stormReps: null,
  }, 'native');
  const effectiveStartupScales = matrix.startupScales;
  if (verifiedLabEntries) {
    assertVueVaporLabSelectedRows(
      entries,
      verifiedLabEntries,
      matrix.suites,
      matrix.scales,
      'lynx',
      effectiveStartupScales,
    );
    assertNativeLabBundles(
      entries,
      matrix.suites,
      matrix.scales,
      effectiveStartupScales,
    );
    for (const entry of entries) {
      const pinned = verifiedLabEntries.get(entry.id);
      verifyPinnedEntry(entry.dir, pinned.fingerprint);
    }
    verifyBenchmarkState(
      benchmarkRoot,
      entries.map((entry) => verifiedLabEntries.get(entry.id)),
      verifiedLabBenchmark,
    );
  }
  const benchmarkFingerprint = captureBenchmarkFingerprint(benchmarkRoot);
  const bundleMaterialization = materializeBundles({
    entries,
    suites: matrix.suites,
    startupScales: effectiveStartupScales,
  });
  let pinnedAdapter;
  let result;
  let primaryError = null;
  try {
    pinnedAdapter = pinAdapter(adapterPath);
    const native = await runHarness({
      adapterPath: pinnedAdapter.pinnedPath,
      adapterFactory: pinnedAdapter.factory,
      bundleSnapshots: bundleMaterialization.snapshots,
      entries,
      cases: matrix.cases,
      suites: matrix.suites,
      scales: matrix.scales,
      startupScales: effectiveStartupScales,
      reps: matrix.reps,
      startupReps: matrix.startupReps,
      log,
    });
    if (verifiedLabEntries) {
      for (const entry of entries) {
        const pinned = verifiedLabEntries.get(entry.id);
        verifyPinnedEntry(entry.dir, pinned.fingerprint);
      }
      verifyBenchmarkState(
        benchmarkRoot,
        entries.map((entry) => verifiedLabEntries.get(entry.id)),
        verifiedLabBenchmark,
      );
    }

    const machine = validateNativeMachine(native.machine);
    const nativeCohort = createNativeCohort({
      machine,
      environment: native.environment,
      adapterFingerprint: pinnedAdapter.fingerprint,
      artifactFingerprint: bundleMaterialization.fingerprint,
      benchmarkFingerprint: benchmarkFingerprint.sha256,
    });
    const records = native.records.map((record) => ({
      ...record,
      nativeCohort: nativeCohort.fingerprint,
    }));
    const generatedAt = now().toISOString();
    const run = {
      schemaVersion: SCHEMA_VERSION,
      meta: {
        generatedAt,
        ...(campaign ? {
          runLabel: label,
          startedAt,
          finishedAt: generatedAt,
          campaign,
          resolvedMatrix,
        } : {}),
        machine,
        calibration: null,
        harness: 'native',
        adapter: path.resolve(adapterPath),
        nativeCohort,
        benchmarkFingerprint,
        argv,
        entryCommits: Object.fromEntries(
          entries.map((entry) => [entry.id, entry.provenance?.commit ?? null]),
        ),
        ...(verifiedLabEntries ? {
          benchmarkWorktree: {
            head: verifiedLabBenchmark.head,
            patchSha256: verifiedLabBenchmark.patchSha256,
          },
          entryArtifacts: entryArtifacts(entries, verifiedLabEntries),
        } : {}),
      },
      records,
    };
    const outPath = writeRun({
      root,
      run,
      machineId: machine.id,
      label,
      native: true,
    });
    log(`[run:native] ${native.records.length} records → ${path.relative(root, outPath)}`);
    if (!noCollect) collect({
      root,
      ...(verifiedLabEntries ? { labMode: true } : {}),
    });
    result = { run, outPath };
  } catch (error) {
    primaryError = error;
  }
  await finishNativeResources(primaryError, [
    pinnedAdapter?.dispose?.bind(pinnedAdapter),
    bundleMaterialization.dispose.bind(bundleMaterialization),
  ]);
  return result;
}
