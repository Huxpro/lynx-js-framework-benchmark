import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { TABLE_CASES } from '@lynx-bench/shared/workloads';

import {
  CONNECTOR_PACKAGE_NAMES,
  CONNECTOR_PACKAGE_TREES_PROTOCOL,
  assertConnectorPackageTreesMatch,
  connectorPackageTreesSha256,
  createPackageTreeReceipt,
} from './connector-receipt.mjs';
import {
  assertNativeCoverage,
  buildNativeMatrixContract,
  classifyNativeCoverage,
  NATIVE_FEATURED_MATRIX_CELL_COUNT,
  NATIVE_MATRIX_CELL_COUNT_PER_ENTRY,
} from './native-coverage.mjs';
import { assertNativeInputsUnchanged, snapshotNativeInputs } from './native-inputs.mjs';
import { deriveNativeLeaseExpirySafety, resolveNativeSandboxPolicy } from './native-protocol.mjs';
import { NATIVE_STARTUP_SCALES, NATIVE_TABLE_SCALES, resolveNativeRunMatrix } from './run-matrix.mjs';
import { buildLabNativeContract } from './lab-native.mjs';

const ENTRIES = [
  { id: 'octane', framework: 'octane' },
  { id: 'react', framework: 'reactlynx' },
  { id: 'vue-vapor', framework: 'vue-lynx' },
  { id: 'vue-vapor-ifr', framework: 'vue-lynx' },
  { id: 'vue-vdom', framework: 'vue-lynx' },
  { id: 'vue-vdom-ifr-et', framework: 'vue-lynx' },
];

function recordFor(cell, { dnf = false, unsupported = false } = {}) {
  const failure = unsupported
    ? {
        category: 'performance-pipeline-unavailable',
        capabilityScope: 'entry',
        evidence: { capabilityProven: true },
      }
    : { category: 'timeout', capabilityScope: 'cell', evidence: { capabilityProven: false } };
  return {
    harness: 'native',
    environment: 'test',
    ...cell,
    samples: dnf ? [] : [1],
    n: dnf ? 0 : 1,
    median: dnf ? null : 1,
    dnfCount: dnf ? 1 : 0,
    failures: dnf ? [failure] : [],
  };
}

test('featured Native contract is exactly six entries by 35 cells and covers every suite scale', () => {
  const contract = buildNativeMatrixContract([...ENTRIES].reverse());
  assert.equal(contract.expectedCellCount, NATIVE_FEATURED_MATRIX_CELL_COUNT);
  assert.equal(contract.cells.length, 210);
  assert.equal(new Set(contract.cells.map((cell) => cell.entry)).size, 6);
  for (const entry of ENTRIES) {
    const cells = contract.cells.filter((cell) => cell.entry === entry.id);
    assert.equal(cells.length, NATIVE_MATRIX_CELL_COUNT_PER_ENTRY);
    assert.equal(cells.filter((cell) => cell.suite === 'table').length, 27);
    assert.equal(cells.filter((cell) => cell.suite === 'startup').length, 8);
  }
  assert.equal(new Set(contract.cells.map((cell) => cell.entry)).size, contract.entryIds.length);
});

test('Native coverage distinguishes unscheduled, per-cell DNF, proven unsupported, and derivation bugs', () => {
  const contract = buildNativeMatrixContract(ENTRIES);
  const measured = recordFor(contract.cells[0]);
  const dnf = recordFor(contract.cells[1], { dnf: true });
  const unsupported = recordFor(contract.cells[2], { dnf: true, unsupported: true });
  const sourceRecords = [measured, dnf, unsupported];
  const coverage = classifyNativeCoverage({
    entries: ENTRIES,
    sourceRecords,
    publishedRecords: [dnf, unsupported],
  });
  assert.equal(coverage.cells[0].status, 'display-derivation-bug');
  assert.equal(coverage.cells[1].status, 'dnf');
  assert.equal(coverage.cells[2].status, 'unsupported');
  assert.equal(coverage.summary.unscheduled, 207);
  assert.throws(() => assertNativeCoverage(coverage), /incomplete or invalid/);

  const complete = classifyNativeCoverage({
    entries: ENTRIES,
    sourceRecords: contract.cells.map((cell) => recordFor(cell)),
  });
  assert.deepEqual(complete.summary, { measured: 210 });
  assert.doesNotThrow(() => assertNativeCoverage(complete));
});

test('Native coverage accepts an explicit single-entry Lab contract without filtering it out', () => {
  const entry = {
    id: 'octane-new1', framework: 'octane', tier: 'lab',
    nativeLab: { enabled: true, contract: 'native-lab-entry-v1' },
    provenance: { commit: '1'.repeat(40) },
  };
  const contract = buildLabNativeContract(entry);
  const records = contract.cells.map((cell) => recordFor(cell));
  const coverage = classifyNativeCoverage({ entries: [entry], contract, sourceRecords: records });
  assert.equal(coverage.expectedCellCount, 35);
  assert.deepEqual(coverage.entryIds, ['octane-new1']);
  assert.deepEqual(coverage.summary, { measured: 35 });
  assert.doesNotThrow(() => assertNativeCoverage(coverage));
});

test('Native defaults schedule the full table/startup matrix and reject silent scale loss', () => {
  const matrix = resolveNativeRunMatrix();
  assert.deepEqual(matrix.suites, ['table', 'startup']);
  assert.deepEqual(matrix.cases.map(({ name }) => name), TABLE_CASES.map(({ name }) => name));
  assert.deepEqual(matrix.scales, [1000, 3000, 5000, 10000, 20000, 30000]);
  assert.deepEqual(matrix.scales, NATIVE_TABLE_SCALES);
  assert.deepEqual(matrix.startupScales, [0, 1000, 10000, 30000]);
  assert.deepEqual(matrix.startupScales, NATIVE_STARTUP_SCALES);
  assert.equal(matrix.reps, 5);
  assert.equal(matrix.startupReps, 3);
  assert.throws(
    () => resolveNativeRunMatrix({ scale: '3000', case: 'create,replace' }),
    /drops case replace/,
  );
  assert.throws(() => resolveNativeRunMatrix({ quick: true }), /not supported/);
});

test('campaign policy includes every timeout, lifecycle, thermal, and retry input', () => {
  const policy = resolveNativeSandboxPolicy({
    LYNX_SANDBOX_TIMEOUT_MS: '11',
    LYNX_SANDBOX_LONG_TIMEOUT_MS: '22',
    LYNX_SANDBOX_ROUTER_SETTLE_MS: '3',
    LYNX_SANDBOX_RECYCLE_EVERY_PAGES: '4',
    LYNX_SANDBOX_EXPLORER_LAUNCH_SETTLE_MS: '5',
    LYNX_SANDBOX_RECONNECT_TIMEOUT_MS: '66',
    LYNX_SANDBOX_STARTUP_POLL_MS: '7',
    LYNX_SANDBOX_TAP_SETTLE_MS: '8',
    LYNX_SANDBOX_MAX_BATTERY_TEMP_C: '39',
    LYNX_SANDBOX_THERMAL_GATE_TIMEOUT_MS: '99',
    LYNX_SANDBOX_THERMAL_POLL_MS: '10',
    LYNX_SANDBOX_TRANSIENT_ATTEMPTS: '2',
    LYNX_SANDBOX_LEASE_CLEANUP_MARGIN_MS: '13',
    LYNX_SANDBOX_OCTANE_TRIGGER: 'tap',
    LYNX_SANDBOX_DEVTOOL_TRANSPORT: 'direct',
  });
  assert.equal(policy.defaultTimeoutMs, 11);
  assert.equal(policy.longWorkloadTimeoutMs, 22);
  assert.equal(policy.thermalGateScope, 'before-every-bundle-load');
  assert.equal(policy.explorerReconnectTimeoutMs, 66);
  assert.equal(policy.transientAttempts, 2);
  assert.equal(policy.leaseCleanupMarginMs, 13);
  assert.equal(policy.leaseStopSafetyOverrideMs, null);
  assert.equal(policy.semanticDnfRetries, 0);
  assert.equal(policy.retryScope, 'transport-only-within-repetition');
  const safety = deriveNativeLeaseExpirySafety(policy, { reps: 5, startupReps: 3 });
  assert.deepEqual(safety, {
    protocol: 'native-lease-expiry-safety-v1',
    repetitions: 5,
    attemptCount: 2,
    thermalGateTimeoutMs: 99,
    pageSessionTimeoutMs: 11,
    longWorkloadTimeoutMs: 22,
    reconnectAttempts: 1,
    explorerReconnectTimeoutMs: 66,
    cleanupMarginMs: 13,
    minimumSafetyMs: 1663,
    overrideMs: null,
    effectiveSafetyMs: 1663,
  });
  const slower = resolveNativeSandboxPolicy({
    LYNX_SANDBOX_TIMEOUT_MS: '11',
    LYNX_SANDBOX_LONG_TIMEOUT_MS: '122',
    LYNX_SANDBOX_RECONNECT_TIMEOUT_MS: '166',
    LYNX_SANDBOX_THERMAL_GATE_TIMEOUT_MS: '199',
    LYNX_SANDBOX_TRANSIENT_ATTEMPTS: '2',
    LYNX_SANDBOX_LEASE_CLEANUP_MARGIN_MS: '13',
  });
  const slowerSafety = deriveNativeLeaseExpirySafety(slower, { reps: 5, startupReps: 3 });
  assert.equal(slowerSafety.minimumSafetyMs, 4163);
  assert.ok(slowerSafety.minimumSafetyMs > safety.minimumSafetyMs);
  assert.throws(
    () => deriveNativeLeaseExpirySafety(resolveNativeSandboxPolicy({
      LYNX_SANDBOX_TIMEOUT_MS: '11',
      LYNX_SANDBOX_LONG_TIMEOUT_MS: '22',
      LYNX_SANDBOX_RECONNECT_TIMEOUT_MS: '66',
      LYNX_SANDBOX_THERMAL_GATE_TIMEOUT_MS: '99',
      LYNX_SANDBOX_TRANSIENT_ATTEMPTS: '2',
      LYNX_SANDBOX_LEASE_CLEANUP_MARGIN_MS: '13',
      LYNX_SANDBOX_LEASE_STOP_SAFETY_MS: '1662',
    }), { reps: 5, startupReps: 3 }),
    /below the derived minimum 1663ms/,
  );
  assert.equal(deriveNativeLeaseExpirySafety(resolveNativeSandboxPolicy({
    LYNX_SANDBOX_TIMEOUT_MS: '11',
    LYNX_SANDBOX_LONG_TIMEOUT_MS: '22',
    LYNX_SANDBOX_RECONNECT_TIMEOUT_MS: '66',
    LYNX_SANDBOX_THERMAL_GATE_TIMEOUT_MS: '99',
    LYNX_SANDBOX_TRANSIENT_ATTEMPTS: '2',
    LYNX_SANDBOX_LEASE_CLEANUP_MARGIN_MS: '13',
    LYNX_SANDBOX_LEASE_STOP_SAFETY_MS: '2000',
  }), { reps: 5, startupReps: 3 }).effectiveSafetyMs, 2000);
  assert.throws(
    () => resolveNativeSandboxPolicy({ LYNX_SANDBOX_RENDER_GRACE_FRAMES: '1' }),
    /must be 2/,
  );
});

test('immutable input receipt detects source, manifest, patch, bundle, and memory mutation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-input-receipt-'));
  try {
    const runner = path.join(root, 'packages/runner/src');
    const shared = path.join(root, 'packages/shared/src');
    fs.mkdirSync(runner, { recursive: true });
    fs.mkdirSync(shared, { recursive: true });
    for (const relative of [
      'cli.mjs', 'connector-receipt.mjs', 'harness-native.mjs', 'native-coverage.mjs',
      'native-inputs.mjs', 'native-protocol.mjs', 'native-resume.mjs', 'run-matrix.mjs',
    ]) fs.writeFileSync(path.join(runner, relative), `source:${relative}`);
    fs.writeFileSync(path.join(shared, 'workloads.mjs'), 'workloads');
    fs.writeFileSync(path.join(shared, 'schema.mjs'), 'schema');
    const adapterPath = path.join(root, 'adapter.mjs');
    fs.writeFileSync(adapterPath, 'adapter');
    const patchPath = path.join(root, 'entry.patch');
    fs.writeFileSync(patchPath, 'patch');
    const entryDir = path.join(root, 'entries/react');
    const distDir = path.join(entryDir, 'dist');
    fs.mkdirSync(path.join(distDir, 'rows-0'), { recursive: true });
    const bundle = Buffer.from('lynx-native-bench-v2 lynx-native-startup-v1');
    const bundlePath = path.join(distDir, 'rows-0/main.lynx.bundle');
    fs.writeFileSync(bundlePath, bundle);
    const bundleSha = crypto.createHash('sha256').update(bundle).digest('hex');
    const manifest = {
      id: 'react',
      provenance: {
        source: 'test', ref: 'test', commit: 'test', patchFile: 'entry.patch',
        sha256: { 'rows-0/main.lynx.bundle': bundleSha },
      },
    };
    fs.writeFileSync(path.join(entryDir, 'entry.json'), JSON.stringify(manifest));
    const makeConnectorReceipt = (base) => {
      const packages = CONNECTOR_PACKAGE_NAMES.map((name, index) => {
        const packageRoot = path.join(base, String(index));
        fs.mkdirSync(path.join(packageRoot, 'lib'), { recursive: true });
        fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
          name, version: `1.0.${index}`,
        }));
        fs.writeFileSync(path.join(packageRoot, 'lib/index.js'), `export default ${index};`);
        return createPackageTreeReceipt(name, packageRoot);
      });
      const payload = { protocol: CONNECTOR_PACKAGE_TREES_PROTOCOL, packages };
      return { ...payload, sha256: connectorPackageTreesSha256(payload) };
    };
    const connectorPackageTrees = makeConnectorReceipt(path.join(root, 'connector-a'));
    const relocatedConnectorPackageTrees = makeConnectorReceipt(path.join(root, 'connector-b'));
    assert.deepEqual(
      connectorPackageTrees.packages.map(({ rootSha256 }) => rootSha256),
      relocatedConnectorPackageTrees.packages.map(({ rootSha256 }) => rootSha256),
    );
    assert.notEqual(connectorPackageTrees.sha256, relocatedConnectorPackageTrees.sha256);
    assert.throws(
      () => assertConnectorPackageTreesMatch(
        connectorPackageTrees, relocatedConnectorPackageTrees,
      ),
      /runtime connector package-tree receipt/,
    );
    const inputs = snapshotNativeInputs({
      entries: [{ ...manifest, dir: entryDir, distDir }],
      suites: ['table', 'startup'],
      startupScales: [0],
      adapterPath,
      connectorPackageTrees,
      root,
    });
    assert.deepEqual(inputs.receipt.connectorPackageTrees, connectorPackageTrees);
    assert.doesNotThrow(() => assertNativeInputsUnchanged(inputs));
    const connectorFile = path.join(root, 'connector-a/0/lib/index.js');
    fs.appendFileSync(connectorFile, '\nmutation');
    assert.throws(
      () => assertNativeInputsUnchanged(inputs),
      /runtime connector package-tree receipt/,
    );
    fs.writeFileSync(connectorFile, 'export default 0;');
    assert.doesNotThrow(() => assertNativeInputsUnchanged(inputs));
    fs.appendFileSync(path.join(entryDir, 'entry.json'), ' ');
    assert.throws(() => assertNativeInputsUnchanged(inputs), /source changed on disk/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
