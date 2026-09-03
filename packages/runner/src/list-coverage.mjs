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
  NATIVE_LIST_FIXTURE_PROTOCOL,
  NATIVE_LIST_OBSERVER_METRIC_CONTRACTS,
  listCaseKey,
} from '../../shared/src/list-workloads.mjs';
import { NATIVE_DIAGNOSTIC_ENTRY_ID } from '../../shared/src/native-diagnostic-contract.mjs';

export const LIST_HARNESSES = Object.freeze(['native', 'web']);
export const NATIVE_LIST_DIAGNOSTIC_ENTRY_ID = NATIVE_DIAGNOSTIC_ENTRY_ID;
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
    const cohort = entry.id === NATIVE_LIST_DIAGNOSTIC_ENTRY_ID ? 'diagnostic' : 'featured';
    const key = `${record.harness}|${cohort}|${record.runFile ?? 'unattributed'}`;
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  const selected = new Map();
  for (const group of groups.values()) {
    const harness = group[0].harness;
    const cohort = group[0].entry === NATIVE_LIST_DIAGNOSTIC_ENTRY_ID
      ? 'diagnostic'
      : 'featured';
    const score = [
      new Set(group.map((record) => record.entry)).size,
      new Set(group.map((record) => listCaseKey(record))).size,
      group.length,
      group[0].runGeneratedAt ?? group[0].runFile ?? '',
      group[0].runFile ?? '',
    ];
    const selectionKey = `${harness}|${cohort}`;
    const prior = selected.get(selectionKey);
    const better = prior == null || score.some((value, index) =>
      score.slice(0, index).every((prefix, prefixIndex) => prefix === prior.score[prefixIndex])
      && value > prior.score[index]);
    if (better) selected.set(selectionKey, { score, records: group });
  }
  return [...selected.values()].flatMap((candidate) => candidate.records);
}

function fixtureStatus(entry, harness, scale, diagnostic) {
  if (diagnostic && (entry.id !== NATIVE_LIST_DIAGNOSTIC_ENTRY_ID
    || entry.tier !== 'lab'
    || harness !== 'native'
    || !Array.isArray(entry.harnesses)
    || entry.harnesses.length !== 1
    || entry.harnesses[0] !== 'native')) {
    return {
      supported: false,
      reason: 'native-list-diagnostic-entry-contract-mismatch',
      source: {
        kind: 'entry-manifest',
        declared: entry.listFixture != null,
        tier: entry.tier ?? null,
        harnesses: entry.harnesses ?? null,
      },
    };
  }
  const fixture = entry.listFixture;
  if (fixture == null) {
    return {
      supported: false,
      reason: 'list-fixture-not-declared',
      source: { kind: 'entry-manifest', declared: false },
    };
  }
  const expectedProtocol = diagnostic ? NATIVE_LIST_FIXTURE_PROTOCOL : LIST_FIXTURE_PROTOCOL;
  if (fixture.protocol !== expectedProtocol
    || (diagnostic && fixture.workloadProtocol !== LIST_FIXTURE_PROTOCOL)) {
    return {
      supported: false,
      status: 'invalid-incomparable',
      reason: 'list-fixture-protocol-mismatch',
      source: {
        kind: 'entry-manifest', declared: true, protocol: fixture.protocol ?? null,
        workloadProtocol: fixture.workloadProtocol ?? null,
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
  const scaleArtifact = diagnostic ? fixture.scales?.[String(scale)] : null;
  const relativeBundle = diagnostic ? scaleArtifact?.bundle : fixture.bundles?.[harness];
  if (typeof relativeBundle !== 'string' || relativeBundle.length === 0) {
    return {
      supported: false,
      reason: `list-${harness}-bundle-not-declared`,
      source: { kind: 'entry-manifest', declared: true, protocol: fixture.protocol },
    };
  }
  if (diagnostic && relativeBundle !== `dist/list/rows-${scale}/main.lynx.bundle`) {
    return {
      supported: false,
      reason: 'list-native-scale-bundle-path-mismatch',
      source: {
        kind: 'entry-manifest', declared: true, protocol: fixture.protocol,
        bundle: relativeBundle, scale,
      },
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
  const expectedSha256 = diagnostic ? scaleArtifact?.sha256 : fixture.sha256?.[harness];
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
      ...(diagnostic ? { workloadProtocol: fixture.workloadProtocol, scale } : {}),
    },
  };
}

function recordStatus(records, kase, harness) {
  if (records.length === 0) return { status: 'unscheduled', reason: null, recordCount: 0 };
  const metricContracts = {
    ...Object.fromEntries(kase.sourceMetrics.map((metric) => [
      metric, LIST_SOURCE_METRIC_CONTRACTS[metric],
    ])),
    ...(harness === 'native' ? NATIVE_LIST_OBSERVER_METRIC_CONTRACTS : {}),
  };
  const expectedMetrics = Object.keys(metricContracts);
  const byMetric = new Map();
  for (const record of records) {
    byMetric.set(record.metric, [...(byMetric.get(record.metric) ?? []), record]);
  }
  const unexpected = [...byMetric.keys()].filter((metric) => !expectedMetrics.includes(metric));
  const missing = expectedMetrics.filter((metric) => !byMetric.has(metric));
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
    const metric = metricContracts[record.metric];
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
  const statuses = records.map((record) => {
    if (record.measurementStatus != null) return record.measurementStatus;
    if ((record.dnfCount ?? 0) > 0 && (record.n ?? 0) === 0) return 'dnf';
    if ((record.n ?? 0) > 0 && (record.dnfCount ?? 0) === 0) return 'measured';
    if ((record.n ?? 0) > 0 && (record.dnfCount ?? 0) > 0) return 'measured-with-dnf';
    return 'invalid';
  });
  const invalidStatus = records.some((record, index) => {
    const status = statuses[index];
    if (status === 'not-measured') {
      return (record.n ?? 0) !== 0
        || (record.dnfCount ?? 0) !== 0
        || !(record.notMeasuredCount > 0)
        || typeof record.notMeasuredReason?.category !== 'string';
    }
    if (status === 'dnf') return (record.n ?? 0) !== 0 || !(record.dnfCount > 0);
    if (status === 'measured') return !(record.n > 0) || (record.dnfCount ?? 0) !== 0;
    if (status === 'measured-with-dnf') return !(record.n > 0) || !(record.dnfCount > 0);
    return true;
  });
  if (invalidStatus) {
    return {
      status: 'invalid-incomparable',
      reason: 'list source metrics contain an invalid measurement status or count shape',
      recordCount: records.length,
    };
  }
  const observerRecords = records.filter((record) => Object.hasOwn(
    NATIVE_LIST_OBSERVER_METRIC_CONTRACTS, record.metric,
  ));
  if (harness === 'native'
    && observerRecords.length > 0
    && observerRecords.every((record) => record.measurementStatus === 'not-measured')) {
    const reasons = new Set(observerRecords.map((record) => record.notMeasuredReason.category));
    if (reasons.size !== 1) {
      return {
        status: 'invalid-incomparable',
        reason: 'Native list observer metrics disagree on why measurement is unavailable',
        recordCount: records.length,
      };
    }
    const [reason] = reasons;
    return { status: 'not-measured', reason, recordCount: records.length };
  }
  const uniqueStatuses = new Set(statuses);
  if (uniqueStatuses.size === 1) {
    const [status] = uniqueStatuses;
    const reason = status === 'not-measured'
      ? records[0].notMeasuredReason?.category ?? null
      : null;
    return { status, reason, recordCount: records.length };
  }
  return {
    status: 'invalid-incomparable',
    reason: 'list source metrics mix incompatible measurement states',
    recordCount: records.length,
  };
}

export function buildListCoverage({ entries, sourceRecords = [] }) {
  const featured = entries
    .filter((entry) => entry.id !== NATIVE_LIST_DIAGNOSTIC_ENTRY_ID
      && (entry.tier ?? 'featured') === 'featured')
    .sort((left, right) => left.id.localeCompare(right.id));
  const diagnostic = entries
    .filter((entry) => entry.id === NATIVE_LIST_DIAGNOSTIC_ENTRY_ID)
    .sort((left, right) => left.id.localeCompare(right.id));
  const recordsByCase = new Map();
  for (const record of sourceRecords.filter((candidate) => candidate.suite === 'list')) {
    const key = listCaseKey(record);
    recordsByCase.set(key, [...(recordsByCase.get(key) ?? []), record]);
  }
  const targets = [
    ...featured.flatMap((entry) => LIST_HARNESSES.map((harness) => ({
      entry, harness, diagnostic: false, rankingEligible: true,
    }))),
    ...diagnostic.map((entry) => ({
      entry, harness: 'native', diagnostic: true, rankingEligible: false,
    })),
  ];
  const cells = targets.flatMap(({ entry, harness, diagnostic: isDiagnostic, rankingEligible }) => {
    return LIST_CASES.flatMap((kase) => kase.scales.map((scale) => {
      const fixture = fixtureStatus(entry, harness, scale, isDiagnostic);
      const expected = {
        entry: entry.id,
        harness,
        workload: kase.name,
        scale,
      };
      const key = listCaseKey(expected);
      const measured = fixture.supported
        ? recordStatus(recordsByCase.get(key) ?? [], kase, harness)
        : { status: fixture.status ?? 'unsupported', reason: fixture.reason, recordCount: 0 };
      return {
        ...expected,
        key,
        diagnostic: isDiagnostic,
        rankingEligible,
        status: measured.status,
        reason: measured.reason,
        recordCount: measured.recordCount,
        fixture: fixture.source,
        sourceMetrics: [...kase.sourceMetrics],
        derivedMetrics: [...kase.derivedMetrics],
      };
    }));
  });
  const statuses = [...new Set(cells.map((cell) => cell.status))].sort();
  return {
    version: LIST_WORKLOAD_CONTRACT_VERSION,
    contractSha256: LIST_WORKLOAD_CONTRACT_SHA256,
    fixtureProtocol: LIST_FIXTURE_PROTOCOL,
    nativeFixtureProtocol: NATIVE_LIST_FIXTURE_PROTOCOL,
    config: LIST_CONFIG,
    // Preserve the historical meaning of entryIds: public featured coverage.
    // Diagnostic rows remain explicit without becoming ranking participants.
    entryIds: featured.map((entry) => entry.id),
    featuredEntryIds: featured.map((entry) => entry.id),
    diagnosticEntryIds: diagnostic.map((entry) => entry.id),
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
  const contradictory = coverage.cells.filter((cell) =>
    cell.entry === NATIVE_LIST_DIAGNOSTIC_ENTRY_ID
      ? cell.harness !== 'native' || cell.diagnostic !== true || cell.rankingEligible !== false
      : cell.diagnostic !== false || cell.rankingEligible !== true);
  if (contradictory.length > 0) {
    throw new Error('list coverage contradicts diagnostic or ranking identity');
  }
  const invalid = coverage.cells.filter((cell) => cell.status === 'invalid-incomparable');
  if (invalid.length > 0) throw new Error(`list coverage contains ${invalid.length} invalid cells`);
  return coverage;
}
