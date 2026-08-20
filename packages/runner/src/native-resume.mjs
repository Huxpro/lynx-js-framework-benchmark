import { SCHEMA_VERSION } from '@lynx-bench/shared/schema';

import { nativeCellKey, nativeStartupMetricContracts } from './native-coverage.mjs';
import {
  appendNativeMethodRevision,
  assertNativeDeviceCohort,
  assertNativeLeaseChain,
  assertNativeMethodRevisionChain,
  appendNativeLeaseReceipt,
  createNativeMethodRevisionChain,
} from './native-protocol.mjs';

const jsonEqual = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export const NATIVE_TRANSPORT_CONTAINMENT_REVISION = Object.freeze({
  reason: 'transport-containment-6630713',
  baseCampaignId: 'a3174f6705a5ac11',
  baseInputReceiptSha256: '1f6de8661cc8f0f103704d91918a8fa8703cf3785f8566c85df112838e8380b9',
  baseRecordCount: 105,
  baseLeaseCount: 4,
  baseLastLeaseIssueId: 'native-matrix-backfill-v2-r1-20260817-lease-04',
  requiredCurrentSources: Object.freeze({
    'packages/runner/adapters/lynx-sandbox-android.mjs':
      'e06517ebba659f9bacf15b521cb23636e51e5c60a7b55d68c875395416c6496f',
    'packages/runner/src/harness-native.mjs':
      '59f8f20a6dbf91e19ef6453a56e41f6df5f9c82348f32b2d5172136afc4031a9',
  }),
  allowedChangedSources: Object.freeze([
    'packages/runner/adapters/lynx-sandbox-android.mjs',
    'packages/runner/src/cli.mjs',
    'packages/runner/src/harness-native.mjs',
    'packages/runner/src/native-protocol.mjs',
    'packages/runner/src/native-resume.mjs',
  ]),
});

const campaignMethodInvariant = (campaign) => {
  const { id: _id, inputReceiptSha256: _inputReceiptSha256, ...invariant } = campaign;
  return invariant;
};

function assertApprovedMethodRevision(
  run,
  currentCampaign,
  currentInputReceipt,
  { reason, inputReceiptSha256 },
  approval,
) {
  if (reason !== approval.reason) {
    throw new Error(
      `Native resume method changed; pass --method-revision ${approval.reason} only for the approved transition.`,
    );
  }
  if (inputReceiptSha256 !== currentInputReceipt.sha256) {
    throw new Error('Native resume method revision target input receipt is not explicitly pinned.');
  }
  if (run.meta.campaign.id !== approval.baseCampaignId
    || run.meta.inputReceipt.sha256 !== approval.baseInputReceiptSha256) {
    throw new Error('Native resume method revision does not start at the approved campaign base.');
  }
  if (run.records.length !== approval.baseRecordCount
    || run.meta.leaseChain?.receipts?.length !== approval.baseLeaseCount
    || run.meta.leaseChain?.receipts?.at(-1)?.issueId !== approval.baseLastLeaseIssueId) {
    throw new Error('Native resume method revision does not match the approved checkpoint prefix.');
  }
  if (!jsonEqual(campaignMethodInvariant(run.meta.campaign), campaignMethodInvariant(currentCampaign))) {
    throw new Error('Native resume method revision changes the campaign matrix or runtime policy.');
  }
  const oldSources = run.meta.inputReceipt.sources;
  const newSources = currentInputReceipt.sources;
  if (oldSources === null || typeof oldSources !== 'object'
    || newSources === null || typeof newSources !== 'object') {
    throw new Error('Native resume method revision requires complete source receipts.');
  }
  if (!jsonEqual(Object.keys(oldSources).sort(), Object.keys(newSources).sort())) {
    throw new Error('Native resume method revision changes the source receipt file set.');
  }
  const allowed = new Set(approval.allowedChangedSources);
  const changed = [];
  for (const path of Object.keys(oldSources)) {
    if (jsonEqual(oldSources[path], newSources[path])) continue;
    changed.push(path);
    if (!allowed.has(path)) {
      throw new Error(`Native resume method revision unexpectedly changes ${path}.`);
    }
  }
  if (!jsonEqual(changed.sort(), [...allowed].sort())) {
    throw new Error('Native resume method revision does not contain the exact approved source delta.');
  }
  for (const [path, expectedSha256] of Object.entries(approval.requiredCurrentSources)) {
    if (newSources[path]?.sha256 !== expectedSha256) {
      throw new Error(`Native resume method revision does not contain the approved ${path}.`);
    }
  }
}

export function nativeRecordIndex(records, contract) {
  const allowed = new Set(contract.cells.map(nativeCellKey));
  const index = new Map();
  for (const record of records ?? []) {
    const key = nativeCellKey(record);
    if (!allowed.has(key)) throw new Error(`Native checkpoint contains non-contract cell ${key}.`);
    if (index.has(key)) throw new Error(`Native checkpoint overlaps cell ${key}.`);
    index.set(key, record);
  }
  return index;
}

export function assertAtomicNativeCells(index, entries) {
  for (const entry of entries) {
    for (const rows of [0, 1000, 10000, 30000]) {
      const keys = nativeStartupMetricContracts(entry).map(({ metric }) => nativeCellKey({
        entry: entry.id, suite: 'startup', workload: 'startup', scale: rows, metric,
      }));
      const present = keys.filter((key) => index.has(key)).length;
      if (present !== 0 && present !== keys.length) {
        throw new Error(`${entry.id} startup@${rows} is only partially checkpointed.`);
      }
    }
  }
  return index;
}

export function mergeNativeRecords(existing, additions, contract) {
  const current = nativeRecordIndex(existing, contract);
  const added = nativeRecordIndex(additions, contract);
  for (const key of added.keys()) {
    if (current.has(key)) throw new Error(`Native resume would overlap existing cell ${key}.`);
  }
  return [...existing, ...additions];
}

export function validateNativeResumeCheckpoint(run, {
  campaign,
  matrixContract,
  inputReceipt,
  connectorPackageTrees,
  entries,
  leaseReceipt,
  methodRevisionReason = null,
  methodRevisionInputReceiptSha256 = null,
  methodRevisionApproval = NATIVE_TRANSPORT_CONTAINMENT_REVISION,
}) {
  if (run?.schemaVersion !== SCHEMA_VERSION || run.meta?.checkpoint !== true) {
    throw new Error('Native resume source is not a schema-v2 checkpoint.');
  }
  if (run.meta.checkpointComplete === true) throw new Error('Native resume source is already complete.');
  if (!jsonEqual(run.meta.matrixContract, matrixContract)) {
    throw new Error('Native resume matrix contract mismatch.');
  }
  if (!jsonEqual(inputReceipt.connectorPackageTrees, connectorPackageTrees)) {
    throw new Error('Native resume connector receipt mismatch.');
  }
  if (!jsonEqual(run.meta.inputReceipt?.connectorPackageTrees, connectorPackageTrees)
    || run.meta.campaign?.inputReceiptSha256 !== run.meta.inputReceipt?.sha256
    || run.meta.campaign?.connectorPackageTreesSha256 !== connectorPackageTrees.sha256) {
    throw new Error('Native resume source has inconsistent immutable input provenance.');
  }
  let methodRevisionChain = run.meta.methodRevisionChain == null
    ? null
    : assertNativeMethodRevisionChain(run.meta.methodRevisionChain);
  let cellMethodRevisionIds = { ...(run.meta.cellMethodRevisionIds ?? {}) };
  const activeInputReceipt = methodRevisionChain?.revisions.at(-1)?.inputReceipt
    ?? run.meta.inputReceipt;
  if (!jsonEqual(activeInputReceipt, inputReceipt)) {
    if (methodRevisionChain != null) {
      throw new Error('Native resume active method revision does not match current runner sources.');
    }
    assertApprovedMethodRevision(run, campaign, inputReceipt, {
      reason: methodRevisionReason,
      inputReceiptSha256: methodRevisionInputReceiptSha256,
    }, methodRevisionApproval);
    methodRevisionChain = createNativeMethodRevisionChain(run.meta.inputReceipt);
    methodRevisionChain = appendNativeMethodRevision(
      methodRevisionChain,
      inputReceipt,
      methodRevisionReason,
    );
  } else if (!jsonEqual(run.meta.campaign, campaign)) {
    if (methodRevisionChain == null) throw new Error('Native resume campaign identity mismatch.');
    if (!jsonEqual(campaignMethodInvariant(run.meta.campaign), campaignMethodInvariant(campaign))) {
      throw new Error('Native resume campaign identity mismatch.');
    }
  }
  if (methodRevisionChain != null) {
    if (!jsonEqual(methodRevisionChain.revisions[0].inputReceipt, run.meta.inputReceipt)) {
      throw new Error('Native method revision chain does not begin at the campaign input receipt.');
    }
    const revisionIds = new Set(methodRevisionChain.revisions.map(({ id }) => id));
    const baseRevisionId = methodRevisionChain.revisions[0].id;
    const recordKeys = new Set(run.records.map(nativeCellKey));
    for (const key of Object.keys(cellMethodRevisionIds)) {
      if (!recordKeys.has(key)) {
        throw new Error(`Native method revision attribution contains non-record cell ${key}.`);
      }
    }
    for (const record of run.records) {
      const key = nativeCellKey(record);
      cellMethodRevisionIds[key] ??= baseRevisionId;
      if (!revisionIds.has(cellMethodRevisionIds[key])) {
        throw new Error(`Native cell ${key} has an unknown method revision.`);
      }
    }
  } else if (Object.keys(cellMethodRevisionIds).length !== 0) {
    throw new Error('Native checkpoint has cell method attribution without a revision chain.');
  }
  const leaseChain = assertNativeLeaseChain(run.meta.leaseChain);
  if (leaseChain.serialSha256 !== leaseReceipt.serialSha256) {
    throw new Error('Native resume crosses physical serial hashes.');
  }
  const index = assertAtomicNativeCells(
    nativeRecordIndex(run.records, matrixContract),
    entries,
  );
  if (run.meta.deviceCohort != null) assertNativeDeviceCohort(run.meta.deviceCohort);
  const priorLease = leaseChain.receipts.find((candidate) =>
    candidate.deviceLeaseId === leaseReceipt.deviceLeaseId);
  if (priorLease != null && !jsonEqual(priorLease, leaseReceipt)) {
    throw new Error('Native resume lease receipt conflicts with its existing lease ID.');
  }
  if (priorLease != null && leaseChain.receipts.at(-1)?.deviceLeaseId !== leaseReceipt.deviceLeaseId) {
    throw new Error('Native resume cannot return to an earlier lease in the chain.');
  }
  return {
    records: [...run.records],
    index,
    leaseChain: priorLease == null
      ? appendNativeLeaseReceipt(leaseChain, leaseReceipt)
      : leaseChain,
    priorDeviceCohort: run.meta.deviceCohort ?? null,
    cellLeaseIds: { ...(run.meta.cellLeaseIds ?? {}) },
    campaign: run.meta.campaign,
    campaignInputReceipt: run.meta.inputReceipt,
    methodRevisionChain,
    cellMethodRevisionIds,
    activeMethodRevisionId: methodRevisionChain?.revisions.at(-1)?.id ?? null,
  };
}

export function assertNativeResumeDeviceCohort(expected, actual) {
  assertNativeDeviceCohort(actual);
  if (expected != null) {
    assertNativeDeviceCohort(expected);
    if (!jsonEqual(expected, actual)) {
      throw new Error('Native resume device cohort identity mismatch.');
    }
  }
  return actual;
}
