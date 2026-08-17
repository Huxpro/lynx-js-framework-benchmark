import path from 'node:path';

import { SCHEMA_VERSION } from '@lynx-bench/shared/schema';

import { collectRuns } from './collect.mjs';
import { bundleFor } from './entries.mjs';
import {
  assertVueVaporLabSelectedRows,
  verifyPinnedVueVaporLabEntry,
  verifyVueVaporLabBenchmarkState,
} from './lab-artifacts.mjs';
import { machineFingerprint } from './machine.mjs';
import { validateRunMatrix } from './run-matrix.mjs';
import { writeRunFile } from './run-files.mjs';
import { runNativeHarness } from './harness-native.mjs';

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
  now = () => new Date(),
  runHarness = runNativeHarness,
  collect = collectRuns,
  fingerprintMachine = machineFingerprint,
  verifyPinnedEntry = verifyPinnedVueVaporLabEntry,
  verifyBenchmarkState = verifyVueVaporLabBenchmarkState,
  writeRun = writeRunFile,
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
  const native = await runHarness({
    adapterPath,
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

  const machine = native.machine ?? fingerprintMachine();
  const generatedAt = now().toISOString();
  const run = {
    schemaVersion: SCHEMA_VERSION,
    meta: {
      generatedAt,
      machine,
      calibration: null,
      harness: 'native',
      adapter: path.resolve(adapterPath),
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
    records: native.records,
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
  return { run, outPath };
}
