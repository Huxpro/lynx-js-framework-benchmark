import crypto from 'node:crypto';

import { STARTUP_CASES, TABLE_CASES } from '@lynx-bench/shared/workloads';

export const NATIVE_MATRIX_CONTRACT_VERSION = 'native-featured-matrix-v1';
export const NATIVE_MATRIX_CELL_COUNT_PER_ENTRY = 35;
export const NATIVE_FEATURED_MATRIX_CELL_COUNT = 210;

const STARTUP_SCALES = [...STARTUP_CASES[0].scales];

export function nativeStartupMetricContracts(entry) {
  return entry.framework === 'octane' || entry.id === 'octane'
    ? [
        {
          metric: 'octaneCommitAck',
          unit: 'ms',
          boundary: 'native-open-request-to-octane-transport-ack',
        },
        {
          metric: 'octaneSecondFrame',
          unit: 'ms',
          boundary: 'native-open-request-to-second-frame-after-octane-transport-ack',
        },
      ]
    : [
        { metric: 'fcp', unit: 'ms', boundary: 'native-open-to-fcp' },
        { metric: 'settled', unit: 'ms', boundary: 'native-open-to-pipeline-end' },
      ];
}

export function nativeCellKey(cell) {
  return [cell.entry, cell.suite, cell.workload, cell.scale, cell.metric].join('|');
}

export function buildNativeMatrixContract(entries) {
  const ranked = entries
    .filter((entry) => (entry.tier ?? 'featured') !== 'lab'
      || entry.ranking?.enabled === true)
    .sort((a, b) => a.id.localeCompare(b.id));
  const cells = [];
  for (const entry of ranked) {
    for (const kase of TABLE_CASES) {
      for (const scale of kase.scales) {
        cells.push({
          entry: entry.id,
          suite: 'table',
          workload: kase.name,
          scale,
          metric: 'latency',
          unit: 'ms',
          boundary: 'native-input-handler-to-second-native-frame',
        });
      }
    }
    for (const scale of STARTUP_SCALES) {
      for (const metric of nativeStartupMetricContracts(entry)) {
        cells.push({
          entry: entry.id,
          suite: 'startup',
          workload: 'startup',
          scale,
          ...metric,
        });
      }
    }
  }
  const payload = {
    version: NATIVE_MATRIX_CONTRACT_VERSION,
    entryIds: ranked.map((entry) => entry.id),
    cells,
  };
  const expectedCount = ranked.length * NATIVE_MATRIX_CELL_COUNT_PER_ENTRY;
  if (cells.length !== expectedCount) {
    throw new Error(
      `Native matrix definition drifted to ${cells.length} cells; expected ${expectedCount}.`,
    );
  }
  return {
    ...payload,
    sha256: crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
    expectedCellCount: cells.length,
  };
}

function recordsByCell(records) {
  const index = new Map();
  for (const record of records ?? []) {
    if (record.harness !== 'native') continue;
    const key = nativeCellKey(record);
    const values = index.get(key) ?? [];
    values.push(record);
    index.set(key, values);
  }
  return index;
}

function isProvenUnsupported(record) {
  if (!(record?.dnfCount > 0) || !Array.isArray(record.failures) || record.failures.length === 0) {
    return false;
  }
  return record.failures.every((failure) => {
    const category = String(failure.category ?? '');
    return category.startsWith('unsupported-')
      || category === 'producer-protocol-unavailable'
      || (category === 'performance-pipeline-unavailable'
        && failure.capabilityScope === 'entry'
        && failure.evidence?.capabilityProven === true);
  });
}

function validateRecordCounts(record) {
  if (!Number.isSafeInteger(record?.n) || record.n < 0) return 'n is not a non-negative integer';
  if (!Number.isSafeInteger(record?.dnfCount) || record.dnfCount < 0) {
    return 'dnfCount is not a non-negative integer';
  }
  if (Array.isArray(record.samples) && record.samples.length !== record.n) {
    return 'sample count does not match n';
  }
  if (Array.isArray(record.failures) && record.failures.length > record.dnfCount) {
    return 'failure evidence exceeds dnfCount';
  }
  return null;
}

function compactRecord(record) {
  if (!record) return null;
  return {
    n: record.n ?? 0,
    dnfCount: record.dnfCount ?? 0,
    median: record.median ?? null,
    boundary: record.boundary,
    unit: record.unit,
    runFile: record.runFile ?? null,
    machineId: record.machineId ?? null,
    failureCategories: [...new Set((record.failures ?? []).map(
      (failure) => failure.category ?? 'unknown',
    ))],
  };
}

export function classifyNativeCoverage({
  entries,
  contract = null,
  sourceRecords = [],
  publishedRecords = sourceRecords,
  archiveRecords = [],
}) {
  const resolvedContract = contract ?? buildNativeMatrixContract(entries);
  const source = recordsByCell(sourceRecords);
  const published = recordsByCell(publishedRecords);
  const archive = recordsByCell(archiveRecords);
  const cells = resolvedContract.cells.map((expected) => {
    const key = nativeCellKey(expected);
    const matches = source.get(key) ?? [];
    const publishedMatches = published.get(key) ?? [];
    const archivedMatches = archive.get(key) ?? [];
    let status;
    let reason = null;
    const record = matches[0];
    if (matches.length > 1) {
      status = 'invalid-incomparable';
      reason = 'duplicate records inside the selected cohort';
    } else if (record) {
      const countError = validateRecordCounts(record);
      if (countError != null) {
        status = 'invalid-incomparable';
        reason = countError;
      } else if (record.boundary !== expected.boundary || record.unit !== expected.unit) {
        status = 'invalid-incomparable';
        reason = 'metric boundary or unit does not match the contract';
      } else if (publishedMatches.length !== 1) {
        status = 'display-derivation-bug';
        reason = publishedMatches.length === 0
          ? 'selected source record is absent from derived comparison data'
          : 'derived comparison data contains duplicate records';
      } else if (Number.isFinite(record.median) && (record.n ?? 0) > 0) {
        status = (record.dnfCount ?? 0) > 0 ? 'measured-with-dnf' : 'measured';
      } else if (isProvenUnsupported(record)) {
        status = 'unsupported';
      } else if ((record.dnfCount ?? 0) > 0) {
        status = 'dnf';
      } else {
        status = 'invalid-incomparable';
        reason = 'record has neither observations nor DNF evidence';
      }
    } else if (archivedMatches.length > 0) {
      status = 'invalid-incomparable';
      reason = 'record exists only outside the selected machine/lease/method cohort';
    } else {
      status = 'unscheduled';
    }
    return { ...expected, key, status, reason, record: compactRecord(record) };
  });
  const summary = Object.fromEntries(
    [...new Set(cells.map((cell) => cell.status))]
      .sort()
      .map((status) => [status, cells.filter((cell) => cell.status === status).length]),
  );
  return {
    version: resolvedContract.version,
    contractSha256: resolvedContract.sha256,
    expectedCellCount: resolvedContract.expectedCellCount,
    entryIds: resolvedContract.entryIds,
    summary,
    cells,
  };
}

export function assertNativeCoverage(coverage, { allowUnscheduled = false } = {}) {
  if (coverage.cells.length !== coverage.expectedCellCount) {
    throw new Error(
      `Native coverage contains ${coverage.cells.length} cells; expected ${coverage.expectedCellCount}.`,
    );
  }
  const keys = new Set(coverage.cells.map((cell) => cell.key));
  if (keys.size !== coverage.cells.length) throw new Error('Native coverage contains duplicate cells.');
  const forbidden = new Set(['invalid-incomparable', 'display-derivation-bug']);
  if (!allowUnscheduled) forbidden.add('unscheduled');
  const failures = coverage.cells.filter((cell) => forbidden.has(cell.status));
  if (failures.length > 0) {
    const counts = Object.fromEntries([...forbidden].map((status) => [
      status, failures.filter((cell) => cell.status === status).length,
    ]).filter(([, count]) => count > 0));
    throw new Error(`Native coverage is incomplete or invalid: ${JSON.stringify(counts)}.`);
  }
  return coverage;
}
