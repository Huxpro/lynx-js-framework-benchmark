import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  assertConnectorPackageTrees,
  assertConnectorPackageTreesMatch,
  refreshConnectorPackageTrees,
} from './connector-receipt.mjs';
import { repoRoot } from './entries.mjs';

export const NATIVE_INPUT_RECEIPT_VERSION = 'native-input-receipt-v2';
export const NATIVE_TABLE_PROTOCOL = 'lynx-native-bench-v2';
export const NATIVE_STARTUP_PROTOCOL = 'lynx-native-startup-v1';

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function requiredRows({ suites, startupScales }) {
  return [...new Set([
    ...(suites.includes('table') ? [0] : []),
    ...(suites.includes('startup') ? startupScales : []),
  ])].sort((a, b) => a - b);
}

function relativeOrAbsolute(root, file) {
  const relative = path.relative(root, file);
  return relative.startsWith('..') ? path.resolve(file) : relative;
}

export function snapshotNativeInputs({
  entries,
  suites,
  startupScales,
  adapterPath,
  connectorPackageTrees,
  root = repoRoot(),
  requireProtocols = true,
}) {
  assertConnectorPackageTrees(connectorPackageTrees, { requireAvailable: false });
  const snapshots = new Map();
  const immutableFiles = new Map();
  const pinFile = (file, role) => {
    const resolved = path.resolve(file);
    const prior = immutableFiles.get(resolved);
    if (prior) {
      prior.roles.add(role);
      return prior;
    }
    const snapshotBytes = fs.readFileSync(resolved);
    const pinned = {
      file: resolved,
      snapshotBytes,
      bytes: snapshotBytes.length,
      sha256: sha256(snapshotBytes),
      roles: new Set([role]),
    };
    immutableFiles.set(resolved, pinned);
    return pinned;
  };
  const entryArtifacts = {};
  for (const entry of entries) {
    const manifestPath = path.join(entry.dir, 'entry.json');
    const manifest = pinFile(manifestPath, `${entry.id}:manifest`);
    const bundles = {};
    for (const rows of requiredRows({ suites, startupScales })) {
      const rel = `rows-${rows}/main.lynx.bundle`;
      const bundlePath = path.join(entry.distDir, rel);
      if (!fs.existsSync(bundlePath)) {
        throw new Error(`${entry.id}: missing Native input ${rel}.`);
      }
      const pinnedBundle = pinFile(bundlePath, `${entry.id}:rows-${rows}:lynx-bundle`);
      const bytes = pinnedBundle.snapshotBytes;
      const actual = pinnedBundle.sha256;
      const expected = entry.provenance?.sha256?.[rel];
      if (!expected || actual !== expected) {
        throw new Error(
          `${entry.id}: Native input ${rel} sha256 ${actual} does not match manifest ${expected ?? 'missing'}.`,
        );
      }
      const protocols = {
        table: bytes.includes(Buffer.from(NATIVE_TABLE_PROTOCOL)),
        startup: bytes.includes(Buffer.from(NATIVE_STARTUP_PROTOCOL)),
      };
      if (requireProtocols && suites.includes('table') && rows === 0) {
        if (!protocols.table) {
          throw new Error(`${entry.id}: rows-0 Native bundle lacks ${NATIVE_TABLE_PROTOCOL}.`);
        }
        if (!protocols.startup) {
          throw new Error(`${entry.id}: rows-0 Native bundle lacks ${NATIVE_STARTUP_PROTOCOL}.`);
        }
      }
      if (
        requireProtocols
        && suites.includes('startup')
        && startupScales.includes(rows)
        && !protocols.startup
      ) {
        throw new Error(`${entry.id}: rows-${rows} Native bundle lacks ${NATIVE_STARTUP_PROTOCOL}.`);
      }
      const key = `${entry.id}:${rows}`;
      snapshots.set(key, {
        entryId: entry.id,
        rows,
        bundlePath,
        bundleBytes: bytes,
        sha256: actual,
        protocols,
      });
      bundles[String(rows)] = { rel, bytes: bytes.length, sha256: actual, protocols };
    }
    const patchFile = entry.provenance?.patchFile
      ? path.resolve(root, entry.provenance.patchFile)
      : null;
    const patch = patchFile && fs.existsSync(patchFile)
      ? pinFile(patchFile, `${entry.id}:provenance-patch`)
      : null;
    entryArtifacts[entry.id] = {
      manifest: {
        path: relativeOrAbsolute(root, manifestPath),
        bytes: manifest.bytes,
        sha256: manifest.sha256,
      },
      provenance: {
        source: entry.provenance?.source ?? null,
        ref: entry.provenance?.ref ?? null,
        commit: entry.provenance?.commit ?? null,
        patchFile: entry.provenance?.patchFile ?? null,
        patchSha256: patch?.sha256 ?? null,
      },
      bundles,
    };
  }

  const resolvedAdapter = path.resolve(adapterPath);
  const sourceFiles = [
    resolvedAdapter,
    path.join(root, 'packages/runner/src/cli.mjs'),
    path.join(root, 'packages/runner/src/connector-receipt.mjs'),
    path.join(root, 'packages/runner/src/harness-native.mjs'),
    path.join(root, 'packages/runner/src/native-coverage.mjs'),
    path.join(root, 'packages/runner/src/native-inputs.mjs'),
    path.join(root, 'packages/runner/src/native-protocol.mjs'),
    path.join(root, 'packages/runner/src/native-resume.mjs'),
    path.join(root, 'packages/runner/src/run-matrix.mjs'),
    path.join(root, 'packages/shared/src/workloads.mjs'),
    path.join(root, 'packages/shared/src/schema.mjs'),
  ];
  const sources = Object.fromEntries(sourceFiles.map((file) => {
    const pinned = pinFile(file, 'runner-source');
    return [relativeOrAbsolute(root, file), { bytes: pinned.bytes, sha256: pinned.sha256 }];
  }));
  const receiptPayload = {
    version: NATIVE_INPUT_RECEIPT_VERSION,
    adapter: relativeOrAbsolute(root, resolvedAdapter),
    connectorPackageTrees,
    sources,
    entryArtifacts,
  };
  const receipt = {
    ...receiptPayload,
    sha256: sha256(Buffer.from(JSON.stringify(receiptPayload))),
  };
  return { snapshots, immutableFiles, receipt, connectorPackageTrees };
}

export function nativeBundleSnapshot(snapshots, entryId, rows) {
  const snapshot = snapshots?.get(`${entryId}:${rows}`);
  if (!snapshot) throw new Error(`missing immutable Native bundle snapshot for ${entryId} rows-${rows}.`);
  return snapshot;
}

export function assertNativeInputsUnchanged(inputs) {
  assertConnectorPackageTreesMatch(
    inputs.connectorPackageTrees,
    refreshConnectorPackageTrees(inputs.connectorPackageTrees),
    { requireAvailable: false },
  );
  for (const snapshot of inputs.snapshots.values()) {
    const memorySha256 = sha256(snapshot.bundleBytes);
    if (memorySha256 !== snapshot.sha256) {
      throw new Error(`immutable Native input mutated in memory: ${snapshot.entryId} rows-${snapshot.rows}.`);
    }
    const diskSha256 = sha256(fs.readFileSync(snapshot.bundlePath));
    if (diskSha256 !== snapshot.sha256) {
      throw new Error(
        `Native input changed on disk after snapshot: ${snapshot.entryId} rows-${snapshot.rows}.`,
      );
    }
  }
  for (const pinned of inputs.immutableFiles?.values() ?? []) {
    const roles = [...pinned.roles].sort().join(', ');
    if (sha256(pinned.snapshotBytes) !== pinned.sha256) {
      throw new Error(`immutable Native source mutated in memory: ${pinned.file} (${roles}).`);
    }
    if (!fs.existsSync(pinned.file)) {
      throw new Error(`Native source disappeared after snapshot: ${pinned.file} (${roles}).`);
    }
    const diskSha256 = sha256(fs.readFileSync(pinned.file));
    if (diskSha256 !== pinned.sha256) {
      throw new Error(`Native source changed on disk after snapshot: ${pinned.file} (${roles}).`);
    }
  }
  return inputs;
}
