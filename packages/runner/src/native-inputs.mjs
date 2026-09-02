import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  assertConnectorPackageTrees,
  assertConnectorPackageTreesMatch,
  refreshConnectorPackageTrees,
} from './connector-receipt.mjs';
import { repoRoot } from './entries.mjs';
import {
  assertNativeCapacityContract,
  NATIVE_CAPACITY_DEFAULT_SCALES,
  NATIVE_CAPACITY_FIXTURE_PROTOCOL,
  NATIVE_CAPACITY_THRESHOLD_SCALES,
} from './native-capacity-suite.mjs';

export const NATIVE_INPUT_RECEIPT_VERSION = 'native-input-receipt-v2';
export const NATIVE_CAPACITY_INPUT_RECEIPT_VERSION = 'native-capacity-input-receipt-v2';
export const NATIVE_TABLE_PROTOCOL = 'lynx-native-bench-v2';
export const NATIVE_STARTUP_PROTOCOL = 'lynx-native-startup-v1';

const NATIVE_CAPACITY_ENTRY_ID = 'octane-native-diagnostic';
const NATIVE_CAPACITY_BUILD_PROTOCOL = 'octane-native-diagnostic-build-v2';
const NATIVE_CAPACITY_BUILD_ARTIFACT = 'benchmarks/lynx-table/app/dist/main.lynx.bundle';
const NATIVE_CAPACITY_BUILD_LIST_ARTIFACT = 'benchmarks/lynx-list/app/dist/main.lynx.bundle';
const NATIVE_CAPACITY_BUNDLE_REL = 'dist/table/main.lynx.bundle';
const NATIVE_CAPACITY_SCALES = [
  ...NATIVE_CAPACITY_DEFAULT_SCALES,
  ...NATIVE_CAPACITY_THRESHOLD_SCALES,
].sort((a, b) => a - b);
const NATIVE_CAPACITY_TOPOLOGY = { elementsPerRow: 7, chromeElements: 42 };
const nativeCapacityBundleRel = (scale) =>
  `dist/capacity/rows-${scale}/main.lynx.bundle`;
const nativeCapacityProvenanceRel = (scale) =>
  `capacity/rows-${scale}/main.lynx.bundle`;
const nativeCapacityBuildArtifact = (scale) =>
  `benchmarks/lynx-table/app/dist-rows${scale}/main.lynx.bundle`;

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

function assertCapacitySourceRevision(provenance, label) {
  const { commit, ref, buildReceipt } = provenance ?? {};
  if (buildReceipt === null || typeof buildReceipt !== 'object' || Array.isArray(buildReceipt)
    || !/^[a-f0-9]{40}$/.test(commit ?? '')
    || ref !== commit
    || buildReceipt?.sourceCommit !== commit) {
    throw new Error(`${label} has an inconsistent Native capacity source revision.`);
  }
  if (buildReceipt.protocol !== NATIVE_CAPACITY_BUILD_PROTOCOL) {
    throw new Error(`${label} has an invalid Native capacity build protocol.`);
  }
  if (JSON.stringify(Object.keys(buildReceipt.artifacts ?? {}))
    !== JSON.stringify(['table', 'capacity', 'list'])
    || buildReceipt.artifacts?.table?.path !== NATIVE_CAPACITY_BUILD_ARTIFACT
    || !/^[a-f0-9]{64}$/.test(buildReceipt.artifacts?.table?.sha256 ?? '')
    || provenance.sha256?.['table/main.lynx.bundle'] !== buildReceipt.artifacts.table.sha256
    || buildReceipt.artifacts?.list?.path !== NATIVE_CAPACITY_BUILD_LIST_ARTIFACT
    || !/^[a-f0-9]{64}$/.test(buildReceipt.artifacts?.list?.sha256 ?? '')
    || provenance.sha256?.['list/main.lynx.bundle'] !== buildReceipt.artifacts.list.sha256) {
    throw new Error(`${label} has an invalid Native diagnostic build artifact map.`);
  }
  if (JSON.stringify(Object.keys(buildReceipt.artifacts?.capacity ?? {}))
    !== JSON.stringify(NATIVE_CAPACITY_SCALES.map(String))) {
    throw new Error(`${label} has an invalid Native capacity build artifact map.`);
  }
  for (const scale of NATIVE_CAPACITY_SCALES) {
    const artifact = buildReceipt.artifacts.capacity[String(scale)];
    if (artifact?.path !== nativeCapacityBuildArtifact(scale)
      || !/^[a-f0-9]{64}$/.test(artifact?.sha256 ?? '')) {
      throw new Error(`${label} has an invalid ${scale}-row Native capacity build artifact.`);
    }
  }
  const { sha256: receiptSha256, ...receiptPayload } = buildReceipt;
  if (receiptSha256 !== sha256(Buffer.from(JSON.stringify(receiptPayload)))) {
    throw new Error(`${label} has an invalid Native capacity build receipt checksum.`);
  }
  return commit;
}

function assertCapacityManifestShape(manifest, label) {
  if (manifest?.id !== NATIVE_CAPACITY_ENTRY_ID
    || manifest.tier !== 'lab'
    || !Array.isArray(manifest.harnesses)
    || manifest.harnesses.length !== 1
    || manifest.harnesses[0] !== 'native'
    || manifest.bundles?.lynx !== NATIVE_CAPACITY_BUNDLE_REL) {
    throw new Error(`${label} is not the exact Native capacity diagnostic manifest.`);
  }
  const fixture = manifest.capacityFixture;
  if (fixture?.protocol !== NATIVE_CAPACITY_FIXTURE_PROTOCOL
    || fixture.fixtureRole !== 'eager-capacity-probe'
    || fixture.topology?.elementsPerRow !== NATIVE_CAPACITY_TOPOLOGY.elementsPerRow
    || fixture.topology?.chromeElements !== NATIVE_CAPACITY_TOPOLOGY.chromeElements
    || Object.keys(fixture.topology ?? {}).length !== Object.keys(NATIVE_CAPACITY_TOPOLOGY).length
    || JSON.stringify(Object.keys(fixture.scales ?? {}))
      !== JSON.stringify(NATIVE_CAPACITY_SCALES.map(String))) {
    throw new Error(`${label} has an invalid Native capacity fixture contract.`);
  }
  for (const scale of NATIVE_CAPACITY_SCALES) {
    const artifact = fixture.scales[String(scale)];
    if (artifact?.bundle !== nativeCapacityBundleRel(scale)
      || !/^[a-f0-9]{64}$/.test(artifact?.sha256 ?? '')) {
      throw new Error(`${label} has an invalid ${scale}-row Native capacity fixture artifact.`);
    }
  }
  return manifest;
}

/** Snapshot the separate, unranked eager-capacity input contract. */
export function snapshotNativeCapacityInputs({
  entry,
  contract,
  runtimePolicy,
  adapterPath,
  connectorPackageTrees = null,
  root = repoRoot(),
}) {
  assertCapacityManifestShape(entry, entry?.id ?? 'capacity entry');
  assertNativeCapacityContract(contract);
  if (runtimePolicy === null || typeof runtimePolicy !== 'object' || Array.isArray(runtimePolicy)) {
    throw new Error('Native capacity runtime policy must be an object.');
  }
  if (connectorPackageTrees != null) assertConnectorPackageTrees(connectorPackageTrees);

  const immutableFiles = new Map();
  const pinFile = (file, role) => {
    const resolved = path.resolve(file);
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

  const manifestPath = path.join(entry.dir, 'entry.json');
  const manifestPin = pinFile(manifestPath, `${NATIVE_CAPACITY_ENTRY_ID}:manifest`);
  const manifest = assertCapacityManifestShape(
    JSON.parse(manifestPin.snapshotBytes.toString('utf8')),
    `${NATIVE_CAPACITY_ENTRY_ID} manifest`,
  );
  const sourceCommit = assertCapacitySourceRevision(entry.provenance, entry.id);
  if (assertCapacitySourceRevision(manifest.provenance, `${entry.id} manifest`) !== sourceCommit) {
    throw new Error(`${entry.id} manifest source revision differs from discovered entry.`);
  }
  if (JSON.stringify(entry.capacityFixture) !== JSON.stringify(manifest.capacityFixture)) {
    throw new Error(`${entry.id} discovered capacityFixture differs from its pinned manifest.`);
  }

  const bundles = Object.fromEntries(contract.scales.map((scale) => {
    const key = String(scale);
    const artifact = manifest.capacityFixture.scales[key];
    const bundlePath = path.join(entry.dir, artifact.bundle);
    const bundlePin = pinFile(bundlePath, `${entry.id}:capacity-${scale}-bundle`);
    const provenanceRelative = nativeCapacityProvenanceRel(scale);
    const expectedChecksums = [
      entry.capacityFixture.scales[key].sha256,
      entry.provenance?.sha256?.[provenanceRelative],
      entry.provenance?.buildReceipt?.artifacts?.capacity?.[key]?.sha256,
      manifest.capacityFixture.scales[key].sha256,
      manifest.provenance?.sha256?.[provenanceRelative],
      manifest.provenance?.buildReceipt?.artifacts?.capacity?.[key]?.sha256,
    ];
    if (expectedChecksums.some((expected) => expected !== bundlePin.sha256)) {
      throw new Error(
        `${entry.id} ${scale}-row Native capacity bundle checksum does not match manifest provenance.`,
      );
    }
    if (!bundlePin.snapshotBytes.includes(Buffer.from(NATIVE_STARTUP_PROTOCOL))) {
      throw new Error(
        `${entry.id} ${scale}-row Native capacity bundle lacks ${NATIVE_STARTUP_PROTOCOL}.`,
      );
    }
    return [key, {
      bundlePath,
      bundleBytes: bundlePin.snapshotBytes,
      relativePath: artifact.bundle,
      sha256: bundlePin.sha256,
    }];
  }));

  const resolvedAdapter = path.resolve(adapterPath);
  const sourceFiles = [
    resolvedAdapter,
    path.join(root, 'packages/runner/src/cli.mjs'),
    path.join(root, 'packages/runner/src/connector-receipt.mjs'),
    path.join(root, 'packages/runner/src/harness-native.mjs'),
    path.join(root, 'packages/runner/src/native-capacity-suite.mjs'),
    path.join(root, 'packages/runner/src/native-inputs.mjs'),
    path.join(root, 'packages/runner/src/native-protocol.mjs'),
    path.join(root, 'packages/runner/src/run-matrix.mjs'),
    path.join(root, 'packages/shared/src/schema.mjs'),
    path.join(root, 'packages/shared/src/stats.mjs'),
  ];
  const sources = Object.fromEntries(sourceFiles.map((file) => {
    const pinned = pinFile(file, 'capacity-runner-source');
    return [relativeOrAbsolute(root, file), { bytes: pinned.bytes, sha256: pinned.sha256 }];
  }));
  const receiptPayload = {
    version: NATIVE_CAPACITY_INPUT_RECEIPT_VERSION,
    suite: contract.suite,
    fixtureRole: contract.fixtureRole,
    contract: JSON.parse(JSON.stringify(contract)),
    runtimePolicy: JSON.parse(JSON.stringify(runtimePolicy)),
    sourceCommit,
    adapter: relativeOrAbsolute(root, resolvedAdapter),
    connectorPackageTrees,
    sources,
    manifest: {
      path: relativeOrAbsolute(root, manifestPath),
      bytes: manifestPin.bytes,
      sha256: manifestPin.sha256,
    },
    capacityFixture: {
      protocol: manifest.capacityFixture.protocol,
      fixtureRole: manifest.capacityFixture.fixtureRole,
      topology: { ...manifest.capacityFixture.topology },
      scales: Object.fromEntries(contract.scales.map((scale) => {
        const artifact = bundles[String(scale)];
        return [String(scale), {
          bundle: artifact.relativePath,
          bytes: artifact.bundleBytes.length,
          sha256: artifact.sha256,
          startupProtocol: NATIVE_STARTUP_PROTOCOL,
        }];
      })),
    },
  };
  return {
    bundles,
    immutableFiles,
    connectorPackageTrees,
    receipt: {
      ...receiptPayload,
      sha256: sha256(Buffer.from(JSON.stringify(receiptPayload))),
    },
  };
}

export function assertNativeCapacityInputsUnchanged(inputs) {
  const { sha256: receiptSha256, ...receiptPayload } = inputs?.receipt ?? {};
  if (sha256(Buffer.from(JSON.stringify(receiptPayload))) !== receiptSha256) {
    throw new Error('immutable Native capacity input receipt mutated in memory.');
  }
  if (inputs?.connectorPackageTrees != null) {
    assertConnectorPackageTreesMatch(
      inputs.connectorPackageTrees,
      refreshConnectorPackageTrees(inputs.connectorPackageTrees),
    );
  }
  const receiptScales = inputs?.receipt?.capacityFixture?.scales ?? {};
  if (JSON.stringify(Object.keys(inputs?.bundles ?? {}))
    !== JSON.stringify(Object.keys(receiptScales))) {
    throw new Error('immutable Native capacity bundle selection mutated in memory.');
  }
  for (const [scale, bundle] of Object.entries(inputs.bundles)) {
    const receiptArtifact = receiptScales[scale];
    const pinnedBundle = inputs.immutableFiles?.get(path.resolve(bundle?.bundlePath ?? ''));
    if (!Buffer.isBuffer(bundle?.bundleBytes)
      || sha256(bundle.bundleBytes) !== bundle.sha256
      || pinnedBundle?.sha256 !== bundle.sha256
      || bundle.relativePath !== receiptArtifact?.bundle
      || bundle.bundleBytes.length !== receiptArtifact?.bytes
      || bundle.sha256 !== receiptArtifact?.sha256
      || receiptArtifact?.startupProtocol !== NATIVE_STARTUP_PROTOCOL) {
      throw new Error(`immutable ${scale}-row Native capacity bundle mutated in memory.`);
    }
  }
  for (const pinned of inputs.immutableFiles?.values() ?? []) {
    const roles = [...pinned.roles].sort().join(', ');
    if (sha256(pinned.snapshotBytes) !== pinned.sha256) {
      throw new Error(`immutable Native capacity input mutated in memory: ${pinned.file} (${roles}).`);
    }
    if (!fs.existsSync(pinned.file) || sha256(fs.readFileSync(pinned.file)) !== pinned.sha256) {
      throw new Error(`Native capacity input changed on disk: ${pinned.file} (${roles}).`);
    }
  }
  return inputs;
}
