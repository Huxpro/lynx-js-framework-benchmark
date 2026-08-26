import crypto from 'node:crypto';

import { BOUNDARIES } from '@lynx-bench/shared/schema';
import { PAPI_SEGMENTS } from '@lynx-bench/shared/pipeline';
import { TABLE_CASES } from '@lynx-bench/shared/workloads';

import { entrySupportsHarness } from './entries.mjs';

export const PIPELINE_MATRIX_CONTRACT_VERSION = 'web-element-papi-matrix-v1';
export const PIPELINE_MATRIX_CELL_COUNT_PER_ENTRY = 12;
export const PIPELINE_FEATURED_MATRIX_CELL_COUNT = 84;

const segmentMetric = (segment, suffix) =>
  `papi${segment[0].toUpperCase()}${segment.slice(1)}${suffix}`;

export const PIPELINE_METRICS = [
  'operationTime',
  ...PAPI_SEGMENTS.flatMap((segment) => [
    segmentMetric(segment, 'Time'),
    segmentMetric(segment, 'Calls'),
  ]),
  'outsidePapiTime',
];

export function pipelineCellKey(cell) {
  return [cell.entry, cell.workload, cell.scale].join('|');
}

export function buildPipelineMatrixContract(entries) {
  const featured = entries
    .filter((entry) => (entry.tier ?? 'featured') === 'featured'
      && entrySupportsHarness(entry, 'web'))
    .sort((left, right) => left.id.localeCompare(right.id));
  const cells = featured.flatMap((entry) => TABLE_CASES.flatMap((kase) =>
    kase.defaultScales.map((scale) => ({
      entry: entry.id,
      suite: 'pipeline',
      harness: 'web',
      workload: kase.name,
      scale,
      metric: 'operationTime',
      unit: 'ms',
      boundary: BOUNDARIES.pipelineOperation,
    }))));
  const expectedCount = featured.length * PIPELINE_MATRIX_CELL_COUNT_PER_ENTRY;
  if (cells.length !== expectedCount) {
    throw new Error(
      `Pipeline matrix definition drifted to ${cells.length} cells; expected ${expectedCount}.`,
    );
  }
  const payload = {
    version: PIPELINE_MATRIX_CONTRACT_VERSION,
    entryIds: featured.map((entry) => entry.id),
    cells,
  };
  return {
    ...payload,
    sha256: crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
    expectedCellCount: cells.length,
  };
}

function indexByCell(records) {
  const index = new Map();
  for (const record of records ?? []) {
    if (record.suite !== 'pipeline' || record.harness !== 'web') continue;
    const key = pipelineCellKey(record);
    const cell = index.get(key) ?? [];
    cell.push(record);
    index.set(key, cell);
  }
  return index;
}

function compactRecord(record) {
  if (!record) return null;
  return {
    n: record.n ?? 0,
    dnfCount: record.dnfCount ?? 0,
    attemptedCount: record.attemptedCount ?? null,
    acceptedCount: record.acceptedCount ?? null,
    median: record.median ?? null,
    runFile: record.runFile ?? null,
    machineId: record.machineId ?? null,
    failureCategories: [...new Set((record.failures ?? []).map(
      (failure) => failure.category ?? 'unknown',
    ))],
  };
}

function recordIntegrity(operation, records) {
  if (!Number.isSafeInteger(operation.n) || operation.n < 0) {
    return 'n is not a non-negative integer';
  }
  if (!Number.isSafeInteger(operation.dnfCount) || operation.dnfCount < 0) {
    return 'dnfCount is not a non-negative integer';
  }
  if (!Number.isSafeInteger(operation.attemptedCount) || operation.attemptedCount < 1) {
    return 'attemptedCount is not a positive integer';
  }
  if (operation.n + operation.dnfCount !== operation.attemptedCount) {
    return 'accepted observations and DNF do not account for every attempt';
  }
  if (operation.acceptedCount !== operation.n) {
    return 'acceptedCount does not match n';
  }
  const metrics = records.map((record) => record.metric).sort();
  const expected = [...PIPELINE_METRICS].sort();
  if (JSON.stringify(metrics) !== JSON.stringify(expected)) {
    return 'pipeline cell does not contain the complete metric family';
  }
  const siblings = new Map(records.map((record) => [record.metric, record]));
  for (const metric of PIPELINE_METRICS) {
    const record = siblings.get(metric);
    if (record.attemptedCount !== operation.attemptedCount
      || record.acceptedCount !== operation.acceptedCount
      || record.dnfCount !== operation.dnfCount) {
      return `pipeline metric ${metric} does not share attempt accounting`;
    }
  }
  return null;
}

export function classifyPipelineCoverage({
  entries,
  sourceRecords = [],
  publishedRecords = sourceRecords,
}) {
  const contract = buildPipelineMatrixContract(entries);
  const source = indexByCell(sourceRecords);
  const published = indexByCell(publishedRecords);
  const cells = contract.cells.map((expected) => {
    const key = pipelineCellKey(expected);
    const records = source.get(key) ?? [];
    const operationRecords = records.filter((record) => record.metric === 'operationTime');
    const publishedOperations = (published.get(key) ?? [])
      .filter((record) => record.metric === 'operationTime');
    const operation = operationRecords[0];
    let status;
    let reason = null;
    if (operationRecords.length > 1) {
      status = 'invalid-incomparable';
      reason = 'duplicate operation records inside the selected campaign';
    } else if (!operation) {
      status = 'unscheduled';
    } else {
      const integrity = recordIntegrity(operation, records);
      if (integrity != null) {
        status = 'invalid-incomparable';
        reason = integrity;
      } else if (operation.boundary !== expected.boundary || operation.unit !== expected.unit) {
        status = 'invalid-incomparable';
        reason = 'operation boundary or unit does not match the contract';
      } else if (publishedOperations.length !== 1) {
        status = 'display-derivation-bug';
        reason = publishedOperations.length === 0
          ? 'selected source operation is absent from derived comparison data'
          : 'derived comparison data contains duplicate operations';
      } else if (operation.pipelineControl?.status === 'invalid') {
        status = 'invalid-incomparable';
        reason = operation.pipelineControl.reason ?? 'pipeline controls are invalid';
      } else if (operation.n > 0) {
        status = operation.dnfCount > 0 ? 'measured-with-dnf' : 'measured';
      } else if (operation.dnfCount > 0) {
        status = 'dnf';
      } else {
        status = 'invalid-incomparable';
        reason = 'operation has neither observations nor DNF evidence';
      }
    }
    return { ...expected, key, status, reason, record: compactRecord(operation) };
  });
  const summary = Object.fromEntries(
    [...new Set(cells.map((cell) => cell.status))]
      .sort()
      .map((status) => [status, cells.filter((cell) => cell.status === status).length]),
  );
  return {
    version: contract.version,
    contractSha256: contract.sha256,
    expectedCellCount: contract.expectedCellCount,
    entryIds: contract.entryIds,
    summary,
    cells,
  };
}

export function assertPipelineCoverage(coverage) {
  if (coverage.cells.length !== coverage.expectedCellCount) {
    throw new Error(
      `Pipeline coverage contains ${coverage.cells.length} cells; expected ${coverage.expectedCellCount}.`,
    );
  }
  if (new Set(coverage.cells.map((cell) => cell.key)).size !== coverage.cells.length) {
    throw new Error('Pipeline coverage contains duplicate cells.');
  }
  const forbidden = new Set(['unscheduled', 'invalid-incomparable', 'display-derivation-bug']);
  const failures = coverage.cells.filter((cell) => forbidden.has(cell.status));
  if (failures.length > 0) {
    const counts = Object.fromEntries([...forbidden].map((status) => [
      status, failures.filter((cell) => cell.status === status).length,
    ]).filter(([, count]) => count > 0));
    throw new Error(`Pipeline coverage is incomplete or invalid: ${JSON.stringify(counts)}.`);
  }
  return coverage;
}
