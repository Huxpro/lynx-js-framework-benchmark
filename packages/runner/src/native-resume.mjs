import { SCHEMA_VERSION } from '@lynx-bench/shared/schema';

import { nativeCellKey, nativeStartupMetricContracts } from './native-coverage.mjs';
import {
  assertNativeDeviceCohort,
  assertNativeLeaseChain,
  appendNativeLeaseReceipt,
} from './native-protocol.mjs';

const jsonEqual = (left, right) => JSON.stringify(left) === JSON.stringify(right);

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
}) {
  if (run?.schemaVersion !== SCHEMA_VERSION || run.meta?.checkpoint !== true) {
    throw new Error('Native resume source is not a schema-v2 checkpoint.');
  }
  if (run.meta.checkpointComplete === true) throw new Error('Native resume source is already complete.');
  if (!jsonEqual(run.meta.campaign, campaign)) throw new Error('Native resume campaign identity mismatch.');
  if (!jsonEqual(run.meta.matrixContract, matrixContract)) {
    throw new Error('Native resume matrix contract mismatch.');
  }
  if (!jsonEqual(run.meta.inputReceipt, inputReceipt)) {
    throw new Error('Native resume immutable input receipt mismatch.');
  }
  if (!jsonEqual(inputReceipt.connectorPackageTrees, connectorPackageTrees)) {
    throw new Error('Native resume connector receipt mismatch.');
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
