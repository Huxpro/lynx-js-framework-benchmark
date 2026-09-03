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
  assertNativeDiagnosticManifest,
  NATIVE_CAPACITY_BUILD_PROTOCOL,
  NATIVE_DIAGNOSTIC_ENTRY_ID,
  NATIVE_LIST_FIXTURE_ID,
  NATIVE_LIST_FIXTURE_ROLE,
  NATIVE_LIST_SCALES,
  NATIVE_STARTUP_PROTOCOL,
  nativeCapacityProvenancePath,
  nativeListBundlePath,
  nativeListProvenancePath,
} from '@lynx-bench/shared/native-diagnostic-contract';
import {
  LIST_FIXTURE_PROTOCOL,
  NATIVE_LIST_FIXTURE_PROTOCOL,
} from '@lynx-bench/shared/list-workloads';
import {
  assertNativeCapacityDiagnosticEntry,
  assertNativeCapacityContract,
  NATIVE_CAPACITY_ENTRY_ID,
} from './native-capacity-suite.mjs';
import { buildNativeListInputContract } from './harness-native-list.mjs';
import { NATIVE_CAPACITY_POLICY } from './native-protocol.mjs';

export const NATIVE_INPUT_RECEIPT_VERSION = 'native-input-receipt-v2';
export const NATIVE_CAPACITY_INPUT_RECEIPT_VERSION = 'native-capacity-input-receipt-v3';
export const NATIVE_LIST_INPUT_RECEIPT_VERSION = 'native-list-input-receipt-v1';
export const NATIVE_TABLE_PROTOCOL = 'lynx-native-bench-v2';
export { NATIVE_STARTUP_PROTOCOL };

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function createImmutablePinRegistry(immutableFiles = new Map()) {
  const files = immutableFiles ?? new Map();
  return {
    immutableFiles: files,
    pin(file, role) {
      const resolved = path.resolve(file);
      const prior = files.get(resolved);
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
      files.set(resolved, pinned);
      return pinned;
    },
    assertUnchanged({ memoryLabel, missingLabel, diskLabel = missingLabel }) {
      for (const pinned of files.values()) {
        const roles = [...pinned.roles].sort().join(', ');
        if (sha256(pinned.snapshotBytes) !== pinned.sha256) {
          throw new Error(`${memoryLabel}: ${pinned.file} (${roles}).`);
        }
        if (!fs.existsSync(pinned.file)) {
          throw new Error(`${missingLabel}: ${pinned.file} (${roles}).`);
        }
        if (sha256(fs.readFileSync(pinned.file)) !== pinned.sha256) {
          throw new Error(`${diskLabel}: ${pinned.file} (${roles}).`);
        }
      }
    },
  };
}

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
  const pins = createImmutablePinRegistry();
  const { immutableFiles } = pins;
  const entryArtifacts = {};
  for (const entry of entries) {
    const manifestPath = path.join(entry.dir, 'entry.json');
    const manifest = pins.pin(manifestPath, `${entry.id}:manifest`);
    const bundles = {};
    for (const rows of requiredRows({ suites, startupScales })) {
      const rel = `rows-${rows}/main.lynx.bundle`;
      const bundlePath = path.join(entry.distDir, rel);
      if (!fs.existsSync(bundlePath)) {
        throw new Error(`${entry.id}: missing Native input ${rel}.`);
      }
      const pinnedBundle = pins.pin(bundlePath, `${entry.id}:rows-${rows}:lynx-bundle`);
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
      ? pins.pin(patchFile, `${entry.id}:provenance-patch`)
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
    path.join(root, 'packages/shared/src/list-workloads.mjs'),
    path.join(root, 'packages/shared/src/native-diagnostic-contract.mjs'),
    path.join(root, 'packages/shared/src/workloads.mjs'),
    path.join(root, 'packages/shared/src/schema.mjs'),
  ];
  const sources = Object.fromEntries(sourceFiles.map((file) => {
    const pinned = pins.pin(file, 'runner-source');
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
  createImmutablePinRegistry(inputs.immutableFiles).assertUnchanged({
    memoryLabel: 'immutable Native source mutated in memory',
    missingLabel: 'Native source disappeared after snapshot',
    diskLabel: 'Native source changed on disk after snapshot',
  });
  return inputs;
}

function assertNativeListFixture(entry, manifest) {
  assertNativeDiagnosticManifest(entry);
  assertNativeDiagnosticManifest(manifest);
  if (entry.id !== NATIVE_DIAGNOSTIC_ENTRY_ID
    || entry.listFixture?.protocol !== NATIVE_LIST_FIXTURE_PROTOCOL
    || entry.listFixture?.workloadProtocol !== LIST_FIXTURE_PROTOCOL
    || JSON.stringify(Object.keys(entry.listFixture?.scales ?? {}))
      !== JSON.stringify(NATIVE_LIST_SCALES.map(String))
    || JSON.stringify(entry.listFixture) !== JSON.stringify(manifest.listFixture)) {
    throw new Error('Native list inputs require the exact diagnostic bounded-list manifest.');
  }
}

/** Snapshot the separate, non-ranking real-Native list campaign inputs. */
export function snapshotNativeListInputs({
  entry,
  adapterPath,
  observer = null,
  root = repoRoot(),
}) {
  const pins = createImmutablePinRegistry();
  const { immutableFiles } = pins;

  const manifestPath = path.join(entry.dir, 'entry.json');
  const manifestPin = pins.pin(manifestPath, `${NATIVE_DIAGNOSTIC_ENTRY_ID}:manifest`);
  const manifest = JSON.parse(manifestPin.snapshotBytes.toString('utf8'));
  assertNativeListFixture(entry, manifest);
  const sourceCommit = assertCapacitySourceRevision(entry.provenance, entry.id);
  if (assertCapacitySourceRevision(manifest.provenance, `${entry.id} manifest`) !== sourceCommit) {
    throw new Error(`${entry.id} manifest source revision differs from discovered entry.`);
  }

  const bundles = Object.fromEntries(NATIVE_LIST_SCALES.map((scale) => {
    const key = String(scale);
    const artifact = manifest.listFixture.scales[key];
    if (artifact.bundle !== nativeListBundlePath(scale)) {
      throw new Error(`${entry.id} ${scale}-row Native list bundle path is not scale-exact.`);
    }
    const bundlePath = path.join(entry.dir, artifact.bundle);
    const bundlePin = pins.pin(bundlePath, `${entry.id}:list-${scale}-bundle`);
    const provenanceRelative = nativeListProvenancePath(scale);
    const expectedChecksums = [
      entry.listFixture.scales[key].sha256,
      entry.provenance?.sha256?.[provenanceRelative],
      entry.provenance?.buildReceipt?.artifacts?.list?.[key]?.sha256,
      manifest.listFixture.scales[key].sha256,
      manifest.provenance?.sha256?.[provenanceRelative],
      manifest.provenance?.buildReceipt?.artifacts?.list?.[key]?.sha256,
    ];
    if (expectedChecksums.some((expected) => expected !== bundlePin.sha256)) {
      throw new Error(
        `${entry.id} ${scale}-row Native list bundle checksum does not match manifest provenance.`,
      );
    }
    return [key, {
      bundlePath,
      bundleBytes: bundlePin.snapshotBytes,
      relativePath: artifact.bundle,
      sha256: bundlePin.sha256,
    }];
  }));

  const listInput = buildNativeListInputContract({ entry, bundles, observer });
  const resolvedAdapter = path.resolve(adapterPath);
  const sourceFiles = [
    resolvedAdapter,
    path.join(root, 'packages/runner/src/cli.mjs'),
    path.join(root, 'packages/runner/src/entries.mjs'),
    path.join(root, 'packages/runner/src/harness-native.mjs'),
    path.join(root, 'packages/runner/src/harness-native-list.mjs'),
    path.join(root, 'packages/runner/src/list-coverage.mjs'),
    path.join(root, 'packages/runner/src/native-inputs.mjs'),
    path.join(root, 'packages/runner/src/result-json.mjs'),
    path.join(root, 'packages/shared/src/list-workloads.mjs'),
    path.join(root, 'packages/shared/src/native-diagnostic-contract.mjs'),
    path.join(root, 'packages/shared/src/schema.mjs'),
    path.join(root, 'packages/shared/src/stats.mjs'),
  ];
  const sources = Object.fromEntries(sourceFiles.map((file) => {
    const pinned = pins.pin(file, 'native-list-runner-source');
    return [relativeOrAbsolute(root, file), { bytes: pinned.bytes, sha256: pinned.sha256 }];
  }));
  const receiptPayload = {
    version: NATIVE_LIST_INPUT_RECEIPT_VERSION,
    suite: 'list',
    entryId: entry.id,
    fixtureRole: NATIVE_LIST_FIXTURE_ROLE,
    fixtureId: NATIVE_LIST_FIXTURE_ID,
    diagnostic: true,
    rankingEligible: false,
    sourceCommit,
    adapter: relativeOrAbsolute(root, resolvedAdapter),
    observer: listInput.observer,
    sources,
    manifest: {
      path: relativeOrAbsolute(root, manifestPath),
      bytes: manifestPin.bytes,
      sha256: manifestPin.sha256,
    },
    listInput: JSON.parse(JSON.stringify(listInput)),
    listFixture: {
      protocol: manifest.listFixture.protocol,
      workloadProtocol: manifest.listFixture.workloadProtocol,
      contractSha256: manifest.listFixture.contractSha256,
      scales: Object.fromEntries(NATIVE_LIST_SCALES.map((scale) => {
        const artifact = bundles[String(scale)];
        return [String(scale), {
          bundle: artifact.relativePath,
          bytes: artifact.bundleBytes.length,
          sha256: artifact.sha256,
        }];
      })),
    },
  };
  return {
    bundles,
    observer: listInput.observer,
    immutableFiles,
    receipt: {
      ...receiptPayload,
      sha256: sha256(Buffer.from(JSON.stringify(receiptPayload))),
    },
  };
}

export function assertNativeListInputsUnchanged(inputs) {
  const { sha256: receiptSha256, ...receiptPayload } = inputs?.receipt ?? {};
  if (sha256(Buffer.from(JSON.stringify(receiptPayload))) !== receiptSha256) {
    throw new Error('immutable Native list input receipt mutated in memory.');
  }
  if (inputs?.receipt?.version !== NATIVE_LIST_INPUT_RECEIPT_VERSION
    || inputs.receipt.suite !== 'list'
    || inputs.receipt.entryId !== NATIVE_DIAGNOSTIC_ENTRY_ID
    || inputs.receipt.fixtureRole !== NATIVE_LIST_FIXTURE_ROLE
    || inputs.receipt.fixtureId !== NATIVE_LIST_FIXTURE_ID
    || inputs.receipt.diagnostic !== true
    || inputs.receipt.rankingEligible !== false) {
    throw new Error('immutable Native list input receipt has the wrong diagnostic identity.');
  }
  const receiptScales = inputs.receipt.listFixture?.scales ?? {};
  if (JSON.stringify(Object.keys(inputs?.bundles ?? {}))
    !== JSON.stringify(NATIVE_LIST_SCALES.map(String))
    || JSON.stringify(Object.keys(receiptScales))
      !== JSON.stringify(NATIVE_LIST_SCALES.map(String))) {
    throw new Error('immutable Native list bundle selection mutated in memory.');
  }
  for (const scale of NATIVE_LIST_SCALES) {
    const key = String(scale);
    const bundle = inputs.bundles[key];
    const receiptArtifact = receiptScales[key];
    const contractArtifact = inputs.receipt.listInput?.artifacts?.[key];
    const pinnedBundle = inputs.immutableFiles?.get(path.resolve(bundle?.bundlePath ?? ''));
    if (!Buffer.isBuffer(bundle?.bundleBytes)
      || sha256(bundle.bundleBytes) !== bundle.sha256
      || pinnedBundle?.sha256 !== bundle.sha256
      || bundle.relativePath !== receiptArtifact?.bundle
      || bundle.bundleBytes.length !== receiptArtifact?.bytes
      || bundle.sha256 !== receiptArtifact?.sha256
      || bundle.relativePath !== contractArtifact?.snapshotRelativePath
      || bundle.bundleBytes.length !== contractArtifact?.snapshotBytes
      || bundle.sha256 !== contractArtifact?.snapshotSha256) {
      throw new Error(`immutable ${scale}-row Native list bundle mutated in memory.`);
    }
  }
  createImmutablePinRegistry(inputs.immutableFiles).assertUnchanged({
    memoryLabel: 'immutable Native list input mutated in memory',
    missingLabel: 'Native list input changed on disk',
  });
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
  const { sha256: receiptSha256, ...receiptPayload } = buildReceipt;
  if (receiptSha256 !== sha256(Buffer.from(JSON.stringify(receiptPayload)))) {
    throw new Error(`${label} has an invalid Native capacity build receipt checksum.`);
  }
  return commit;
}

/** Snapshot the separate, unranked eager-capacity input contract. */
export function snapshotNativeCapacityInputs({
  entry,
  contract,
  runtimePolicy,
  adapterPath,
  preflightPath,
  connectorPackageTrees = null,
  root = repoRoot(),
}) {
  assertNativeCapacityDiagnosticEntry(entry);
  assertNativeCapacityContract(contract);
  if (runtimePolicy === null || typeof runtimePolicy !== 'object' || Array.isArray(runtimePolicy)) {
    throw new Error('Native capacity runtime policy must be an object.');
  }
  if (JSON.stringify(runtimePolicy) !== JSON.stringify(NATIVE_CAPACITY_POLICY)) {
    throw new Error('Native capacity runtime policy must match the dedicated no-CDP policy.');
  }
  if (connectorPackageTrees != null) {
    throw new Error('Native capacity inputs must not include a DevTool connector package tree.');
  }

  const pins = createImmutablePinRegistry();
  const { immutableFiles } = pins;

  const manifestPath = path.join(entry.dir, 'entry.json');
  const manifestPin = pins.pin(manifestPath, `${NATIVE_CAPACITY_ENTRY_ID}:manifest`);
  const manifest = assertNativeCapacityDiagnosticEntry(
    JSON.parse(manifestPin.snapshotBytes.toString('utf8')),
  );
  const sourceCommit = assertCapacitySourceRevision(entry.provenance, entry.id);
  if (assertCapacitySourceRevision(manifest.provenance, `${entry.id} manifest`) !== sourceCommit) {
    throw new Error(`${entry.id} manifest source revision differs from discovered entry.`);
  }
  if (JSON.stringify(entry.capacityFixture) !== JSON.stringify(manifest.capacityFixture)) {
    throw new Error(`${entry.id} discovered capacityFixture differs from its pinned manifest.`);
  }

  if (typeof preflightPath !== 'string' || preflightPath.length === 0) {
    throw new Error(
      'Native capacity inputs require --capacity-disable-file with a local DevTool-disable bundle.',
    );
  }
  const preflightBundlePath = path.resolve(preflightPath);
  const preflightPin = pins.pin(
    preflightBundlePath,
    `${entry.id}:devtool-disabled-preflight`,
  );
  if (!preflightPin.snapshotBytes.includes(Buffer.from('__OCTANE_DEVTOOL_DISABLED__=true'))) {
    throw new Error(
      'Native capacity DevTool-disable preflight bundle lacks __OCTANE_DEVTOOL_DISABLED__=true.',
    );
  }

  const bundles = Object.fromEntries(contract.scales.map((scale) => {
    const key = String(scale);
    const artifact = manifest.capacityFixture.scales[key];
    const bundlePath = path.join(entry.dir, artifact.bundle);
    const bundlePin = pins.pin(bundlePath, `${entry.id}:capacity-${scale}-bundle`);
    const provenanceRelative = nativeCapacityProvenancePath(scale);
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
    path.join(root, 'packages/runner/src/android-art-capacity.mjs'),
    path.join(root, 'packages/runner/src/harness-native.mjs'),
    path.join(root, 'packages/runner/src/native-capacity-suite.mjs'),
    path.join(root, 'packages/runner/src/native-inputs.mjs'),
    path.join(root, 'packages/runner/src/native-protocol.mjs'),
    path.join(root, 'packages/runner/src/run-matrix.mjs'),
    path.join(root, 'packages/shared/src/list-workloads.mjs'),
    path.join(root, 'packages/shared/src/native-diagnostic-contract.mjs'),
    path.join(root, 'packages/shared/src/schema.mjs'),
    path.join(root, 'packages/shared/src/stats.mjs'),
  ];
  const sources = Object.fromEntries(sourceFiles.map((file) => {
    const pinned = pins.pin(file, 'capacity-runner-source');
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
    connectorPackageTrees: null,
    sources,
    manifest: {
      path: relativeOrAbsolute(root, manifestPath),
      bytes: manifestPin.bytes,
      sha256: manifestPin.sha256,
    },
    preflight: {
      protocol: runtimePolicy.preflightProtocol,
      bundle: relativeOrAbsolute(root, preflightBundlePath),
      bytes: preflightPin.bytes,
      sha256: preflightPin.sha256,
      serving: 'immutable-local-http',
      launch: 'explicit-lynx-initial-url',
      source: 'operator-supplied-local-bundle',
      requiredEvidence: [
        'DevTool disabled. Transitioning to ATTACHED.',
        '__OCTANE_DEVTOOL_DISABLED__=true',
      ],
      forbiddenEvidence: ['DevTool enabled. Transitioning to ENABLED.'],
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
    preflight: {
      bundlePath: preflightBundlePath,
      bundleBytes: preflightPin.snapshotBytes,
      relativePath: relativeOrAbsolute(root, preflightBundlePath),
      sha256: preflightPin.sha256,
    },
    immutableFiles,
    connectorPackageTrees: null,
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
  if (inputs?.connectorPackageTrees != null || inputs?.receipt?.connectorPackageTrees != null) {
    throw new Error('immutable Native capacity inputs unexpectedly contain a DevTool connector.');
  }
  const receiptPreflight = inputs?.receipt?.preflight;
  const preflight = inputs?.preflight;
  const pinnedPreflight = inputs.immutableFiles?.get(path.resolve(preflight?.bundlePath ?? ''));
  if (!Buffer.isBuffer(preflight?.bundleBytes)
    || sha256(preflight.bundleBytes) !== preflight.sha256
    || pinnedPreflight?.sha256 !== preflight.sha256
    || preflight.relativePath !== receiptPreflight?.bundle
    || preflight.bundleBytes.length !== receiptPreflight?.bytes
    || preflight.sha256 !== receiptPreflight?.sha256
    || receiptPreflight?.serving !== 'immutable-local-http') {
    throw new Error('immutable Native capacity DevTool-disable preflight mutated in memory.');
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
  createImmutablePinRegistry(inputs.immutableFiles).assertUnchanged({
    memoryLabel: 'immutable Native capacity input mutated in memory',
    missingLabel: 'Native capacity input changed on disk',
  });
  return inputs;
}
