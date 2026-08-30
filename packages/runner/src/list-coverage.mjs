import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  LIST_CASES,
  LIST_CONFIG,
  LIST_FIXTURE_PROTOCOL,
  LIST_SOURCE_METRIC_CONTRACTS,
  LIST_WORKLOAD_CONTRACT,
  LIST_WORKLOAD_CONTRACT_VERSION,
  listCaseKey,
} from '../../shared/src/list-workloads.mjs';

export const LIST_HARNESSES = Object.freeze(['native', 'web']);
export const LIST_WORKLOAD_CONTRACT_SHA256 = crypto.createHash('sha256')
  .update(JSON.stringify(LIST_WORKLOAD_CONTRACT))
  .digest('hex');

export function selectListCampaignRecords(records, entries) {
  const current = new Map(entries.map((entry) => [entry.id, entry]));
  const groups = new Map();
  for (const record of records.filter((candidate) => candidate.suite === 'list')) {
    const entry = current.get(record.entry);
    if (entry == null) continue;
    if (record.entryCommit != null && entry.provenance?.commit != null
      && record.entryCommit !== entry.provenance.commit) continue;
    const key = `${record.harness}|${record.runFile ?? 'unattributed'}`;
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  const selected = new Map();
  for (const group of groups.values()) {
    const harness = group[0].harness;
    const score = [
      new Set(group.map((record) => record.entry)).size,
      new Set(group.map((record) => listCaseKey(record))).size,
      group.length,
      group[0].runGeneratedAt ?? group[0].runFile ?? '',
      group[0].runFile ?? '',
    ];
    const prior = selected.get(harness);
    const better = prior == null || score.some((value, index) =>
      score.slice(0, index).every((prefix, prefixIndex) => prefix === prior.score[prefixIndex])
      && value > prior.score[index]);
    if (better) selected.set(harness, { score, records: group });
  }
  return [...selected.values()].flatMap((candidate) => candidate.records);
}

export function fixtureStatus(entry, harness) {
  const fixture = entry.listFixture;
  if (fixture == null) {
    return {
      supported: false,
      reason: 'list-fixture-not-declared',
      source: { kind: 'entry-manifest', declared: false },
    };
  }
  if (fixture.protocol !== LIST_FIXTURE_PROTOCOL) {
    return {
      supported: false,
      reason: 'list-fixture-protocol-mismatch',
      source: {
        kind: 'entry-manifest', declared: true, protocol: fixture.protocol ?? null,
      },
    };
  }
  if (fixture.contractSha256 !== LIST_WORKLOAD_CONTRACT_SHA256) {
    return {
      supported: false,
      reason: 'list-workload-contract-mismatch',
      source: {
        kind: 'entry-manifest', declared: true, protocol: fixture.protocol,
        contractSha256: fixture.contractSha256 ?? null,
      },
    };
  }
  const relativeBundle = fixture.bundles?.[harness];
  if (typeof relativeBundle !== 'string' || relativeBundle.length === 0) {
    return {
      supported: false,
      reason: `list-${harness}-bundle-not-declared`,
      source: { kind: 'entry-manifest', declared: true, protocol: fixture.protocol },
    };
  }
  const bundle = path.resolve(entry.dir, relativeBundle);
  const bundleWithinEntry = path.relative(entry.dir, bundle);
  if (bundleWithinEntry.startsWith('..') || path.isAbsolute(bundleWithinEntry)) {
    return {
      supported: false,
      reason: `list-${harness}-bundle-outside-entry`,
      source: {
        kind: 'entry-manifest', declared: true, protocol: fixture.protocol,
        bundle: relativeBundle,
      },
    };
  }
  if (!fs.existsSync(bundle)) {
    return {
      supported: false,
      reason: `list-${harness}-bundle-missing`,
      source: {
        kind: 'entry-manifest', declared: true, protocol: fixture.protocol,
        bundle: relativeBundle,
      },
    };
  }
  const expectedSha256 = fixture.sha256?.[harness];
  if (typeof expectedSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(expectedSha256)) {
    return {
      supported: false,
      reason: `list-${harness}-bundle-checksum-not-declared`,
      source: {
        kind: 'entry-manifest', declared: true, protocol: fixture.protocol,
        bundle: relativeBundle,
      },
    };
  }
  const actualSha256 = crypto.createHash('sha256').update(fs.readFileSync(bundle)).digest('hex');
  if (actualSha256 !== expectedSha256) {
    return {
      supported: false,
      reason: `list-${harness}-bundle-checksum-mismatch`,
      source: {
        kind: 'entry-manifest-and-artifact', declared: true, protocol: fixture.protocol,
        bundle: relativeBundle, sha256: expectedSha256, actualSha256,
      },
    };
  }
  return {
    supported: true,
    reason: null,
    bundle: relativeBundle,
    source: {
      kind: 'entry-manifest-and-artifact', declared: true,
      protocol: fixture.protocol, contractSha256: fixture.contractSha256,
      bundle: relativeBundle, sha256: expectedSha256,
    },
  };
}

function recordStatus(records, kase) {
  if (records.length === 0) return { status: 'unscheduled', reason: null, recordCount: 0 };
  const byMetric = new Map();
  for (const record of records) {
    byMetric.set(record.metric, [...(byMetric.get(record.metric) ?? []), record]);
  }
  const unexpected = [...byMetric.keys()].filter((metric) => !kase.sourceMetrics.includes(metric));
  const missing = kase.sourceMetrics.filter((metric) => !byMetric.has(metric));
  const duplicate = [...byMetric].filter(([, values]) => values.length !== 1)
    .map(([metric]) => metric);
  if (unexpected.length > 0 || missing.length > 0 || duplicate.length > 0) {
    return {
      status: 'invalid-incomparable',
      reason: `list source metric mismatch: ${JSON.stringify({ missing, unexpected, duplicate })}`,
      recordCount: records.length,
    };
  }
  const contractMismatch = records.filter((record) => {
    const metric = LIST_SOURCE_METRIC_CONTRACTS[record.metric];
    return record.contractVersion !== LIST_WORKLOAD_CONTRACT_VERSION
      || record.boundary !== metric.boundary
      || record.unit !== metric.unit;
  }).map((record) => record.metric);
  if (contractMismatch.length > 0) {
    return {
      status: 'invalid-incomparable',
      reason: `list source boundary, unit, or contract mismatch: ${contractMismatch.join(', ')}`,
      recordCount: records.length,
    };
  }
  if (records.every((record) => (record.dnfCount ?? 0) > 0 && (record.n ?? 0) === 0)) {
    return { status: 'dnf', reason: null, recordCount: records.length };
  }
  if (records.every((record) => (record.n ?? 0) > 0 && (record.dnfCount ?? 0) === 0)) {
    return { status: 'measured', reason: null, recordCount: records.length };
  }
  return {
    status: 'invalid-incomparable',
    reason: 'list source metrics mix observations, DNF, or empty evidence',
    recordCount: records.length,
  };
}

export function buildListCoverage({ entries, sourceRecords = [] }) {
  const featured = entries
    .filter((entry) => (entry.tier ?? 'featured') === 'featured')
    .sort((left, right) => left.id.localeCompare(right.id));
  const recordsByCase = new Map();
  for (const record of sourceRecords.filter((candidate) => candidate.suite === 'list')) {
    const key = listCaseKey(record);
    recordsByCase.set(key, [...(recordsByCase.get(key) ?? []), record]);
  }
  const cells = featured.flatMap((entry) => LIST_HARNESSES.flatMap((harness) => {
    const fixture = fixtureStatus(entry, harness);
    return LIST_CASES.flatMap((kase) => kase.scales.map((scale) => {
      const expected = {
        entry: entry.id,
        harness,
        workload: kase.name,
        scale,
      };
      const key = listCaseKey(expected);
      const measured = fixture.supported
        ? recordStatus(recordsByCase.get(key) ?? [], kase)
        : { status: 'unsupported', reason: fixture.reason, recordCount: 0 };
      return {
        ...expected,
        key,
        status: measured.status,
        reason: measured.reason,
        recordCount: measured.recordCount,
        fixture: fixture.source,
        sourceMetrics: [...kase.sourceMetrics],
        derivedMetrics: [...kase.derivedMetrics],
      };
    }));
  }));
  const statuses = [...new Set(cells.map((cell) => cell.status))].sort();
  return {
    version: LIST_WORKLOAD_CONTRACT_VERSION,
    contractSha256: LIST_WORKLOAD_CONTRACT_SHA256,
    fixtureProtocol: LIST_FIXTURE_PROTOCOL,
    config: LIST_CONFIG,
    entryIds: featured.map((entry) => entry.id),
    expectedCellCount: cells.length,
    sourceRunFiles: Object.fromEntries(LIST_HARNESSES.map((harness) => [
      harness,
      [...new Set(sourceRecords.filter((record) => record.harness === harness)
        .map((record) => record.runFile).filter(Boolean))].sort(),
    ])),
    summary: Object.fromEntries(statuses.map((status) => [
      status, cells.filter((cell) => cell.status === status).length,
    ])),
    cells,
  };
}

export function assertListCoverage(coverage) {
  if (coverage.cells.length !== coverage.expectedCellCount) {
    throw new Error('list coverage cell count does not match its contract');
  }
  if (new Set(coverage.cells.map((cell) => cell.key)).size !== coverage.cells.length) {
    throw new Error('list coverage contains duplicate cells');
  }
  const invalid = coverage.cells.filter((cell) => cell.status === 'invalid-incomparable');
  if (invalid.length > 0) throw new Error(`list coverage contains ${invalid.length} invalid cells`);
  return coverage;
}
