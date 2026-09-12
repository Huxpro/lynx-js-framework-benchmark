import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { LIST_CASES } from '../../shared/src/list-workloads.mjs';
import {
  assertConnectorPackageTrees,
  assertConnectorPackageTreesMatch,
  refreshConnectorPackageTrees,
} from './connector-receipt.mjs';
import { repoRoot } from './entries.mjs';
import { listFixtureStatus } from './list-coverage.mjs';

export const NATIVE_LIST_INPUT_RECEIPT_VERSION = 'native-list-input-receipt-v1';

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function relativeOrAbsolute(root, file) {
  const relative = path.relative(root, file);
  return relative.startsWith('..') ? path.resolve(file) : relative;
}

export function snapshotNativeListInputs({
  entries,
  adapterPath,
  connectorPackageTrees,
  root = repoRoot(),
}) {
  assertConnectorPackageTrees(connectorPackageTrees, {
    requireAvailable: false,
  });
  const immutableFiles = new Map();
  const snapshots = new Map();
  const pinFile = (file, role) => {
    const resolved = path.resolve(file);
    const prior = immutableFiles.get(resolved);
    if (prior != null) {
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
  const scales = [...new Set(LIST_CASES.flatMap((kase) => kase.scales))].sort((a, b) => a - b);
  const entryArtifacts = {};
  for (const entry of entries) {
    const manifestPath = path.join(entry.dir, 'entry.json');
    const manifest = pinFile(manifestPath, `${entry.id}:manifest`);
    const bundles = {};
    for (const scale of scales) {
      const fixture = listFixtureStatus(entry, 'native', scale);
      if (!fixture.supported) {
        throw new Error(
          `${entry.id}: Native list fixture @${scale} is unavailable: ${fixture.reason}.`,
        );
      }
      const bundlePath = path.resolve(entry.dir, fixture.bundle);
      const bundle = pinFile(bundlePath, `${entry.id}:list:${scale}:native-bundle`);
      snapshots.set(`${entry.id}:${scale}`, {
        entryId: entry.id,
        scale,
        bundlePath,
        bundleBytes: bundle.snapshotBytes,
        sha256: bundle.sha256,
      });
      bundles[String(scale)] = {
        path: relativeOrAbsolute(root, bundlePath),
        bytes: bundle.bytes,
        sha256: bundle.sha256,
      };
    }
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
      },
      bundles,
    };
  }
  const resolvedAdapter = path.resolve(adapterPath);
  const sourceFiles = [
    resolvedAdapter,
    path.join(root, 'packages/runner/src/cli.mjs'),
    path.join(root, 'packages/runner/src/connector-receipt.mjs'),
    path.join(root, 'packages/runner/src/entries.mjs'),
    path.join(root, 'packages/runner/src/harness-native-list.mjs'),
    path.join(root, 'packages/runner/src/harness-native.mjs'),
    path.join(root, 'packages/runner/src/list-coverage.mjs'),
    path.join(root, 'packages/runner/src/list-native-inputs.mjs'),
    path.join(root, 'packages/runner/src/list-observation.mjs'),
    path.join(root, 'packages/runner/src/machine.mjs'),
    path.join(root, 'packages/runner/src/native-coverage.mjs'),
    path.join(root, 'packages/runner/src/native-protocol.mjs'),
    path.join(root, 'packages/runner/src/native-resume.mjs'),
    path.join(root, 'packages/runner/src/result-json.mjs'),
    path.join(root, 'packages/shared/src/list-workloads.mjs'),
    path.join(root, 'packages/shared/src/schema.mjs'),
    path.join(root, 'packages/shared/src/stats.mjs'),
  ];
  const sources = Object.fromEntries(
    sourceFiles.map((file) => {
      const pinned = pinFile(file, 'runner-source');
      return [relativeOrAbsolute(root, file), { bytes: pinned.bytes, sha256: pinned.sha256 }];
    }),
  );
  for (const entry of entries) {
    const patchFile = entry.provenance?.patchFile
      ? path.resolve(root, entry.provenance.patchFile)
      : null;
    if (patchFile == null) continue;
    if (!fs.existsSync(patchFile)) {
      throw new Error(`${entry.id}: provenance patch is missing: ${patchFile}.`);
    }
    const patch = pinFile(patchFile, `${entry.id}:provenance-patch`);
    entryArtifacts[entry.id].provenance.patchSha256 = patch.sha256;
  }
  const payload = {
    version: NATIVE_LIST_INPUT_RECEIPT_VERSION,
    adapter: relativeOrAbsolute(root, resolvedAdapter),
    connectorPackageTrees,
    sources,
    entryArtifacts,
  };
  return {
    snapshots,
    immutableFiles,
    connectorPackageTrees,
    receipt: {
      ...payload,
      sha256: sha256(Buffer.from(JSON.stringify(payload))),
    },
  };
}

export function nativeListBundleSnapshot(snapshots, entryId, scale) {
  const snapshot = snapshots?.get(`${entryId}:${scale}`);
  if (snapshot == null)
    throw new Error(`missing immutable Native list bundle for ${entryId}@${scale}.`);
  return snapshot;
}

export function assertNativeListInputsUnchanged(inputs) {
  assertConnectorPackageTreesMatch(
    inputs.connectorPackageTrees,
    refreshConnectorPackageTrees(inputs.connectorPackageTrees),
    { requireAvailable: false },
  );
  for (const pinned of inputs.immutableFiles.values()) {
    const roles = [...pinned.roles].sort().join(', ');
    if (!fs.existsSync(pinned.file) || sha256(fs.readFileSync(pinned.file)) !== pinned.sha256) {
      throw new Error(`Native list input changed after snapshot: ${pinned.file} (${roles}).`);
    }
    if (sha256(pinned.snapshotBytes) !== pinned.sha256) {
      throw new Error(`Native list input mutated in memory: ${pinned.file} (${roles}).`);
    }
  }
  return inputs;
}
