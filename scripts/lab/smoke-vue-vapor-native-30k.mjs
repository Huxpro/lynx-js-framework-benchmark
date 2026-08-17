#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { discoverEntries } from '../../packages/runner/src/entries.mjs';
import {
  assertVueVaporLabSelectedRows,
  verifyPinnedVueVaporLabEntry,
  verifyVueVaporLabBenchmarkState,
  verifyVueVaporLabRoot,
} from '../../packages/runner/src/lab-artifacts.mjs';
import {
  materializeNativeBundleSnapshots,
  nativeBundleSnapshotFor,
  pinNativeAdapterGraph,
} from '../../packages/runner/src/native-inputs.mjs';
import {
  assertContainedPath,
  assertLabEntryId,
} from '../../packages/runner/src/path-safety.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (!['--lab-root', '--entry', '--adapter'].includes(key)) {
      throw new Error(`unknown argument: ${key}`);
    }
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${key} requires a value`);
    args[key.slice(2)] = value;
  }
  for (const key of ['lab-root', 'entry', 'adapter']) {
    if (!args[key]) throw new Error(`--${key} is required`);
  }
  return args;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const labRoot = path.resolve(args['lab-root']);
    assertContainedPath(root, labRoot, {
      requiredTopLevel: '.tmp',
      label: '--lab-root',
    });
    assertLabEntryId(args.entry, '--entry');
    const verified = new Map(
      verifyVueVaporLabRoot(labRoot).map((entry) => [entry.entryId, entry]),
    );
    const entries = discoverEntries({ only: [args.entry], root: labRoot });
    if (entries.length !== 1) throw new Error('smoke requires exactly one lab entry');
    const entry = entries[0];
    assertVueVaporLabSelectedRows(
      entries,
      verified,
      ['startup'],
      [30000],
      'lynx',
      [30000],
    );
    const benchmarkState = verifyVueVaporLabBenchmarkState(
      root,
      [verified.get(entry.id)],
    );
    const bundles = materializeNativeBundleSnapshots({
      entries,
      suites: ['startup'],
      startupScales: [30000],
    });
    const adapterGraph = pinNativeAdapterGraph(path.resolve(args.adapter));
    let adapter;
    let primaryError = null;
    try {
      adapter = await adapterGraph.factory({ log: console.log });
      if (typeof adapter.assertRenderedRows !== 'function') {
        throw new Error('Native adapter lacks assertRenderedRows() count-only oracle');
      }
      const snapshot = nativeBundleSnapshotFor(bundles.snapshots, entry.id, 30000);
      await adapter.loadBundle(entry, {
        rows: 30000,
        bundlePath: snapshot.bundlePath,
        bundleBytes: snapshot.bundleBytes,
        suite: 'count-only',
      });
      await adapter.assertRenderedRows(30000);
      verifyPinnedVueVaporLabEntry(entry.dir, verified.get(entry.id).fingerprint);
      verifyVueVaporLabBenchmarkState(root, [verified.get(entry.id)], benchmarkState);
    } catch (error) {
      primaryError = error;
    }
    const cleanupErrors = [];
    for (const dispose of [
      adapter?.dispose?.bind(adapter),
      adapterGraph.dispose.bind(adapterGraph),
      bundles.dispose.bind(bundles),
    ]) {
      if (!dispose) continue;
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
          'Native 30k smoke failed and cleanup also failed',
          { cause: primaryError },
        );
      }
      throw primaryError;
    }
    if (cleanupErrors.length) {
      throw new AggregateError(cleanupErrors, 'Native 30k smoke cleanup failed');
    }
    console.log('[native-smoke] rows-30000 rendered row count validated');
  } catch (error) {
    console.error(String(error?.stack ?? error));
    process.exitCode = 1;
  }
}
