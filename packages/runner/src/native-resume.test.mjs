import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { makeRecord } from '@lynx-bench/shared/schema';

import {
  NATIVE_PRODUCER_PROTOCOL_ERROR,
  nativeTransportFailureDnf,
  nativeProducerProtocolDnf,
  validateNativeStartupPayload,
  validateNativeTablePayload,
} from '../adapters/lynx-sandbox-android.mjs';
import { runNativeHarness, runNativeMatrix } from './harness-native.mjs';
import { buildNativeMatrixContract, nativeCellKey } from './native-coverage.mjs';
import {
  NATIVE_SANDBOX_CAMPAIGN_VERSION,
  appendNativeMethodRevision,
  appendNativeLeaseReceipt,
  assertNativeLeaseChain,
  assertNativeMethodRevisionChain,
  buildNativeDeviceCohort,
  createNativeMethodRevisionChain,
  parseNativeLeaseReceipt,
  shouldStopBeforeLeaseExpiry,
} from './native-protocol.mjs';
import {
  assertNativeResumeDeviceCohort,
  mergeNativeRecords,
  validateNativeResumeCheckpoint,
} from './native-resume.mjs';

const serial = 'sandbox.example:41315';
const lease = (issueId, expiredAt, serialValue = serial) => parseNativeLeaseReceipt({
  serial: serialValue, issueId, expiredAt,
}, { serial: serialValue, now: 1_000 });

const deviceCohort = (serialSha256, cores = 8) => buildNativeDeviceCohort({
  serialSha256,
  environment: 'lynx-native-android-aries-10',
  hardware: { cpuModel: 'aries', cores, osVersion: '10' },
  campaignId: 'campaign-a',
  matrixContractSha256: 'matrix-a',
  inputReceiptSha256: 'input-a',
  connectorPackageTreesSha256: 'connector-a',
  harnessConfigId: 'method-a',
});

const sha256Json = (value) => crypto.createHash('sha256')
  .update(JSON.stringify(value))
  .digest('hex');

function methodInputReceipt(sources, invariant = {}) {
  const payload = {
    version: 'native-input-receipt-v2',
    adapter: 'adapter.mjs',
    connectorPackageTrees: { sha256: 'connector-a' },
    sources,
    entryArtifacts: {},
    ...invariant,
  };
  return { ...payload, sha256: sha256Json(payload) };
}

test('structured lease receipts reject malformed, expired, duplicate, and cross-serial chains', () => {
  const first = lease('issue-a', 2_000);
  const second = lease('issue-b', 3_000);
  assert.notEqual(first.deviceLeaseId, second.deviceLeaseId);
  assert.throws(
    () => parseNativeLeaseReceipt({ serial, issueId: 'expired', expiredAt: 999 }, { serial, now: 1_000 }),
    /expired/,
  );
  assert.throws(
    () => parseNativeLeaseReceipt({ serial: 'other', issueId: 'x', expiredAt: 2_000 }, { serial, now: 1_000 }),
    /does not match/,
  );
  const chain = appendNativeLeaseReceipt(appendNativeLeaseReceipt(null, first), second);
  assert.equal(assertNativeLeaseChain(chain).receipts.length, 2);
  assert.throws(() => appendNativeLeaseReceipt(chain, second), /already present/);
  assert.throws(
    () => appendNativeLeaseReceipt(chain, lease('other-serial', 4_000, 'sandbox.other:1')),
    /physical serial/,
  );
});

test('stable device cohorts ignore lease IDs but reject hardware or serial changes', () => {
  const first = lease('issue-a', 2_000);
  const cohort = deviceCohort(first.serialSha256);
  assert.deepEqual(assertNativeResumeDeviceCohort(cohort, deviceCohort(first.serialSha256)), cohort);
  assert.throws(
    () => assertNativeResumeDeviceCohort(cohort, deviceCohort(lease('other', 2_000, 'other:2').serialSha256)),
    /device cohort identity mismatch/,
  );
  assert.throws(
    () => assertNativeResumeDeviceCohort(cohort, deviceCohort(first.serialSha256, 4)),
    /device cohort identity mismatch/,
  );
});

function fixture() {
  const entries = [{ id: 'react', framework: 'reactlynx', provenance: { commit: 'react-new' } }];
  const matrixContract = buildNativeMatrixContract(entries);
  const connectorPackageTrees = { sha256: 'connector-a' };
  const inputReceipt = { sha256: 'input-a', connectorPackageTrees };
  const campaign = {
    version: NATIVE_SANDBOX_CAMPAIGN_VERSION,
    id: 'campaign-a',
    matrixContractSha256: matrixContract.sha256,
    inputReceiptSha256: inputReceipt.sha256,
    connectorPackageTreesSha256: connectorPackageTrees.sha256,
  };
  const firstLease = lease('issue-a', 2_000);
  const cohort = buildNativeDeviceCohort({
    serialSha256: firstLease.serialSha256,
    environment: 'lynx-native-android-aries-10',
    hardware: { cpuModel: 'aries', cores: 8 },
    campaignId: campaign.id,
    matrixContractSha256: matrixContract.sha256,
    inputReceiptSha256: inputReceipt.sha256,
    connectorPackageTreesSha256: connectorPackageTrees.sha256,
    harnessConfigId: 'method-a',
  });
  const cell = matrixContract.cells.find((candidate) => candidate.suite === 'table');
  const record = makeRecord({
    ...cell, harness: 'native', environment: cohort.environment, samples: [1],
  });
  const run = {
    schemaVersion: 2,
    meta: {
      checkpoint: true, checkpointComplete: false, campaign, matrixContract, inputReceipt,
      deviceCohort: cohort,
      leaseChain: appendNativeLeaseReceipt(null, firstLease),
      cellLeaseIds: { [nativeCellKey(record)]: firstLease.deviceLeaseId },
    },
    records: [record],
  };
  return { entries, matrixContract, connectorPackageTrees, inputReceipt, campaign, firstLease, cohort, record, run };
}

test('resume validation appends same-serial leases and rejects overlap or partial startup cells', () => {
  const value = fixture();
  const secondLease = lease('issue-b', 3_000);
  const resumed = validateNativeResumeCheckpoint(value.run, {
    campaign: value.campaign, matrixContract: value.matrixContract,
    inputReceipt: value.inputReceipt, connectorPackageTrees: value.connectorPackageTrees,
    entries: value.entries, leaseReceipt: secondLease,
  });
  assert.equal(resumed.records.length, 1);
  assert.equal(resumed.leaseChain.receipts.length, 2);
  assert.throws(
    () => mergeNativeRecords(resumed.records, [value.record], value.matrixContract),
    /overlap/,
  );
  const startup = value.matrixContract.cells.find((candidate) => candidate.suite === 'startup');
  const partial = makeRecord({
    ...startup, harness: 'native', environment: value.cohort.environment, samples: [1],
  });
  const partialRun = {
    ...value.run,
    records: [partial],
    meta: {
      ...value.run.meta,
      cellLeaseIds: { [nativeCellKey(partial)]: value.firstLease.deviceLeaseId },
    },
  };
  assert.throws(() => validateNativeResumeCheckpoint(partialRun, {
    campaign: value.campaign, matrixContract: value.matrixContract,
    inputReceipt: value.inputReceipt, connectorPackageTrees: value.connectorPackageTrees,
    entries: value.entries, leaseReceipt: secondLease,
  }), /partially checkpointed/);
  assert.throws(() => validateNativeResumeCheckpoint(value.run, {
    campaign: value.campaign, matrixContract: value.matrixContract,
    inputReceipt: value.inputReceipt, connectorPackageTrees: value.connectorPackageTrees,
    entries: value.entries, leaseReceipt: lease('other', 3_000, 'other:9'),
  }), /physical serial/);
});

test('approved method revision preserves the campaign base and attributes the exact prefix', () => {
  const value = fixture();
  const baseInput = methodInputReceipt({
    adapter: { bytes: 1, sha256: 'a'.repeat(64) },
    cli: { bytes: 1, sha256: 'b'.repeat(64) },
    stable: { bytes: 1, sha256: 'c'.repeat(64) },
  });
  const currentInput = methodInputReceipt({
    adapter: { bytes: 2, sha256: 'd'.repeat(64) },
    cli: { bytes: 2, sha256: 'e'.repeat(64) },
    stable: { bytes: 1, sha256: 'c'.repeat(64) },
  });
  const baseCampaign = {
    ...value.campaign, id: 'campaign-base', inputReceiptSha256: baseInput.sha256,
  };
  const currentCampaign = {
    ...baseCampaign, id: 'campaign-current', inputReceiptSha256: currentInput.sha256,
  };
  const run = {
    ...value.run,
    meta: { ...value.run.meta, campaign: baseCampaign, inputReceipt: baseInput },
  };
  const approval = {
    reason: 'approved-test-revision',
    baseCampaignId: baseCampaign.id,
    baseInputReceiptSha256: baseInput.sha256,
    baseRecordCount: 1,
    baseLeaseCount: 1,
    baseLastLeaseIssueId: value.firstLease.issueId,
    requiredCurrentSources: { adapter: currentInput.sources.adapter.sha256 },
    allowedChangedSources: ['adapter', 'cli'],
  };
  const secondLease = lease('issue-b', 3_000);
  const resumed = validateNativeResumeCheckpoint(run, {
    campaign: currentCampaign, matrixContract: value.matrixContract,
    inputReceipt: currentInput, connectorPackageTrees: currentInput.connectorPackageTrees,
    entries: value.entries, leaseReceipt: secondLease,
    methodRevisionReason: approval.reason,
    methodRevisionInputReceiptSha256: currentInput.sha256,
    methodRevisionApproval: approval,
  });
  const chain = assertNativeMethodRevisionChain(resumed.methodRevisionChain);
  assert.equal(chain.revisions.length, 2);
  assert.equal(chain.revisions[0].inputReceipt.sha256, baseInput.sha256);
  assert.equal(chain.revisions[1].inputReceipt.sha256, currentInput.sha256);
  assert.equal(resumed.campaign.id, baseCampaign.id);
  assert.equal(resumed.campaignInputReceipt.sha256, baseInput.sha256);
  assert.equal(
    resumed.cellMethodRevisionIds[nativeCellKey(value.record)],
    chain.revisions[0].id,
  );
  assert.equal(resumed.activeMethodRevisionId, chain.revisions[1].id);

  assert.throws(() => validateNativeResumeCheckpoint(run, {
    campaign: currentCampaign, matrixContract: value.matrixContract,
    inputReceipt: currentInput, connectorPackageTrees: currentInput.connectorPackageTrees,
    entries: value.entries, leaseReceipt: secondLease,
    methodRevisionReason: approval.reason,
    methodRevisionInputReceiptSha256: '0'.repeat(64),
    methodRevisionApproval: approval,
  }), /not explicitly pinned/);

  const continuedRun = {
    ...run,
    meta: {
      ...run.meta,
      methodRevisionChain: chain,
      cellMethodRevisionIds: resumed.cellMethodRevisionIds,
      leaseChain: resumed.leaseChain,
    },
  };
  const continued = validateNativeResumeCheckpoint(continuedRun, {
    campaign: currentCampaign, matrixContract: value.matrixContract,
    inputReceipt: currentInput, connectorPackageTrees: currentInput.connectorPackageTrees,
    entries: value.entries, leaseReceipt: lease('issue-c', 4_000),
  });
  assert.equal(continued.activeMethodRevisionId, chain.revisions[1].id);
  const driftedInput = methodInputReceipt({
    ...currentInput.sources,
    stable: { bytes: 2, sha256: 'f'.repeat(64) },
  });
  assert.throws(() => validateNativeResumeCheckpoint(continuedRun, {
    campaign: { ...currentCampaign, inputReceiptSha256: driftedInput.sha256 },
    matrixContract: value.matrixContract, inputReceipt: driftedInput,
    connectorPackageTrees: driftedInput.connectorPackageTrees,
    entries: value.entries, leaseReceipt: lease('issue-c', 4_000),
  }), /active method revision/);
});

function snapshots(entryId) {
  const map = new Map();
  for (const rows of [0, 1000, 10000, 30000]) {
    const bytes = Buffer.from(`${entryId}:${rows}`);
    map.set(`${entryId}:${rows}`, {
      entryId, rows, bundlePath: `/unused/${rows}`, bundleBytes: bytes,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    });
  }
  return map;
}

test('harness skips existing cells and stops gracefully before lease expiry', async () => {
  const entry = { id: 'react', framework: 'reactlynx' };
  const calls = [];
  const adapter = {
    environment: 'native-test',
    async loadBundle(_entry, { rows }) { calls.push(['load', rows]); },
    async driveCase(kase, scale) { calls.push(['drive', kase.name, scale]); },
    async collect() { return { latencyMs: 1 }; },
    async collectStartup() { return { fcpMs: 1, settledMs: 2 }; },
  };
  const cases = [{ name: 'create', scales: [1000, 3000] }];
  const existing = new Set(['react|table|create|1000|latency']);
  const records = await runNativeMatrix({
    adapter, entries: [entry], cases, suites: ['table'], scales: [1000, 3000],
    reps: 1, bundleSnapshots: snapshots(entry.id), existingCellKeys: existing,
  });
  assert.deepEqual(records.map((record) => record.scale), [3000]);
  assert.deepEqual(calls.filter(([kind]) => kind === 'drive'), [['drive', 'create', 3000]]);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-expiry-'));
  try {
    const adapterPath = path.join(dir, 'adapter.mjs');
    fs.writeFileSync(adapterPath, `export default async () => ({
      environment: 'native-test', machine: { id: 'test' },
      loadBundle: async () => {}, driveCase: async () => {},
      collect: async () => ({ latencyMs: 1 }), collectStartup: async () => ({}),
      dispose: async () => {},
    });`);
    const stopped = await runNativeHarness({
      adapterPath, entries: [entry], cases, suites: ['table'], scales: [1000],
      reps: 1, bundleSnapshots: snapshots(entry.id), shouldStopBeforeCell: () => true,
    });
    assert.equal(stopped.stoppedForLeaseExpiry, true);
    assert.deepEqual(stopped.records, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const current = lease('expiry', 2_000);
  assert.equal(shouldStopBeforeLeaseExpiry(current, { now: 1_800, safetyMs: 201 }), true);
  assert.equal(shouldStopBeforeLeaseExpiry(current, { now: 1_000, safetyMs: 200 }), false);
});

test('resume skips an atomic startup transport-DNF pair without duplicates or partial records', async () => {
  const entry = { id: 'react', framework: 'reactlynx' };
  const matrixContract = buildNativeMatrixContract([entry]);
  const firstProgress = [];
  const first = await runNativeMatrix({
    adapter: {
      environment: 'native-test',
      async loadBundle() {
        throw new Error(
          'CDP Runtime.enable failed: Error: timeout waiting 30000ms for Runtime.enable',
        );
      },
      async collectStartup() { throw new Error('collectStartup must not run'); },
      async recoverTransient() { return true; },
      async classifyFailure(error, context) {
        return nativeTransportFailureDnf(error, context, { transientRecoveries: [] });
      },
    },
    entries: [entry],
    cases: [],
    suites: ['startup'],
    startupScales: [0],
    startupReps: 1,
    bundleSnapshots: snapshots(entry.id),
    onProgress: async (records) => firstProgress.push(structuredClone(records)),
  });
  assert.deepEqual(firstProgress.map((records) => records.length), [2]);
  assert.deepEqual(first.map((record) => record.metric), ['fcp', 'settled']);

  const calls = [];
  const second = await runNativeMatrix({
    adapter: {
      environment: 'native-test',
      async loadBundle(_entry, { rows }) { calls.push(['load', rows]); },
      async collectStartup() { return { fcpMs: 8, settledMs: 13 }; },
    },
    entries: [entry],
    cases: [],
    suites: ['startup'],
    startupScales: [0, 1000],
    startupReps: 1,
    bundleSnapshots: snapshots(entry.id),
    existingCellKeys: new Set(first.map(nativeCellKey)),
  });
  assert.deepEqual(calls, [['load', 1000]]);

  const merged = mergeNativeRecords(first, second, matrixContract);
  const keys = merged.map(nativeCellKey);
  assert.equal(new Set(keys).size, 4);
  for (const rows of [0, 1000]) {
    assert.deepEqual(
      merged.filter((record) => record.scale === rows).map((record) => record.metric).sort(),
      ['fcp', 'settled'],
    );
  }
  assert.throws(
    () => mergeNativeRecords(first, [second[0], first[0]], matrixContract),
    /overlap/,
  );
});

test('strict producer validation failures become cell-local evidenced DNF', () => {
  for (const [suite, validate, context] of [
    ['startup', () => validateNativeStartupPayload({ protocol: 'bad' }, {
      entryId: 'react', expectedRows: 1000,
    }), { suite: 'startup', entry: { id: 'react' }, rows: 1000 }],
    ['table', () => validateNativeTablePayload({ protocol: 'bad' }, {
      entryId: 'react', expectedName: 'create', expectedSource: 'native-tap',
    }), { suite: 'table', entry: { id: 'react' }, kase: { name: 'create' }, scale: 1000 }],
  ]) {
    let error;
    try { validate(); } catch (caught) { error = caught; }
    assert.equal(error.code, NATIVE_PRODUCER_PROTOCOL_ERROR);
    const dnf = nativeProducerProtocolDnf(error, context);
    assert.equal(dnf.dnf, true);
    assert.equal(dnf.failure.category, 'producer-protocol-invalid');
    assert.equal(dnf.failure.phase, suite);
    assert.deepEqual(
      dnf.failure.evidence.producerProtocolValidation,
      { attempted: true, passed: false },
    );
    assert.equal('producerProtocolValidated' in dnf.failure.evidence, false);
    if (suite === 'startup') assert.deepEqual(dnf.metricContracts.map(({ name }) => name), ['fcp', 'settled']);
    else assert.equal(dnf.metricContracts, undefined);
  }
});

test('dated Octane entries validate their transport acknowledgement as Octane', () => {
  const state = {
    rowCount: 0,
    firstId: null,
    secondId: null,
    thirdId: null,
    row998Id: null,
    firstLabel: null,
    selectedId: null,
  };
  const payload = {
    protocol: 'lynx-native-bench-v2',
    name: 'create',
    source: 'native-tap',
    boundary: 'native-input-handler-to-second-native-frame',
    startMs: 10,
    commitAckMs: 15,
    firstFrameMs: 20,
    endMs: 30,
    latencyMs: 20,
    renderEvidence: { kind: 'native-animation-frame', frames: 2 },
    transportEvidence: {
      kind: 'octane-root.flushTransport',
      acknowledged: true,
      ackMs: 15,
    },
    preState: state,
    postState: state,
  };

  assert.equal(validateNativeTablePayload(payload, {
    entryId: 'octane-new-2026-08-20',
    octane: true,
    expectedName: 'create',
    expectedSource: 'native-tap',
  }), payload);
  assert.throws(() => validateNativeTablePayload(payload, {
    entryId: 'react-lynx',
    octane: false,
    expectedName: 'create',
    expectedSource: 'native-tap',
  }), /Non-Octane payload/);
});
