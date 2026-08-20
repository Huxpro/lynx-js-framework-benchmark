import crypto from 'node:crypto';

import { STARTUP_CASES, TABLE_CASES } from '@lynx-bench/shared/workloads';

export const LAB_NATIVE_CONTRACT_VERSION = 'native-lab-entry-v1';
export const LAB_NATIVE_CELL_COUNT = 35;

export const nativeCellKey = (cell) =>
  [cell.entry, cell.suite, cell.workload, cell.scale, cell.metric].join('|');

export function labNativeStartupMetrics(entry) {
  if (entry.framework === 'octane') {
    return [
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
    ];
  }
  return [
    { metric: 'fcp', unit: 'ms', boundary: 'native-open-to-fcp' },
    { metric: 'settled', unit: 'ms', boundary: 'native-open-to-pipeline-end' },
  ];
}

export function buildLabNativeContract(entry) {
  if (entry.tier !== 'lab' || entry.nativeLab?.enabled !== true) {
    throw new Error(`${entry.id}: Lab Native requires tier=lab and nativeLab.enabled=true.`);
  }
  if (entry.nativeLab.contract !== LAB_NATIVE_CONTRACT_VERSION) {
    throw new Error(
      `${entry.id}: nativeLab.contract must be ${LAB_NATIVE_CONTRACT_VERSION}.`,
    );
  }
  const cells = [];
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
        expectedReps: 5,
      });
    }
  }
  for (const scale of STARTUP_CASES[0].scales) {
    for (const metric of labNativeStartupMetrics(entry)) {
      cells.push({
        entry: entry.id,
        suite: 'startup',
        workload: 'startup',
        scale,
        ...metric,
        expectedReps: 3,
      });
    }
  }
  if (cells.length !== LAB_NATIVE_CELL_COUNT) {
    throw new Error(
      `${entry.id}: Lab Native contract contains ${cells.length} cells; `
      + `expected ${LAB_NATIVE_CELL_COUNT}.`,
    );
  }
  const payload = {
    version: LAB_NATIVE_CONTRACT_VERSION,
    entryId: entry.id,
    entryIds: [entry.id],
    entryCommit: entry.provenance?.commit ?? null,
    entryBuild: {
      patched: entry.provenance?.patched === true,
      patchFile: entry.provenance?.patchFile ?? null,
      sha256: entry.provenance?.sha256 ?? null,
    },
    cells,
  };
  return {
    ...payload,
    expectedCellCount: cells.length,
    sha256: crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
  };
}

export function labNativeMatrixOptions(contract) {
  return {
    scales: [...new Set(contract.cells
      .filter((cell) => cell.suite === 'table')
      .map((cell) => cell.scale))],
    startupScales: [...new Set(contract.cells
      .filter((cell) => cell.suite === 'startup')
      .map((cell) => cell.scale))],
    reps: 5,
    startupReps: 3,
  };
}

export function resolveNativeEntrySelection(allEntries, {
  requestedEntryIds = null,
  labNative = false,
} = {}) {
  const byId = new Map(allEntries.map((entry) => [entry.id, entry]));
  const requested = requestedEntryIds == null
    ? null
    : requestedEntryIds.map((id) => {
        const entry = byId.get(id);
        if (!entry) throw new Error(`unknown entry: ${id}`);
        return entry;
      });

  if (!labNative) {
    const selected = requested ?? allEntries.filter((entry) => entry.tier !== 'lab');
    const labs = selected.filter((entry) => entry.tier === 'lab');
    if (labs.length > 0) {
      throw new Error(
        `Native Lab entries (${labs.map((entry) => entry.id).join(', ')}) require `
        + `--lab-native and an explicit single --entry.`,
      );
    }
    return { entries: selected, comparisonScope: 'featured-cohort', contract: null };
  }

  if (requested == null || requested.length !== 1) {
    throw new Error('--lab-native requires exactly one explicit --entry.');
  }
  const [entry] = requested;
  const contract = buildLabNativeContract(entry);
  return { entries: [entry], comparisonScope: 'lab-entry', contract };
}

export function assertCompleteLabNativeRun(run, entry) {
  const contract = buildLabNativeContract(entry);
  if (run.meta?.checkpoint !== true || run.meta?.checkpointComplete !== true) return null;
  if (run.meta?.comparisonScope !== 'lab-entry') return null;
  if (run.meta?.labNative?.entryId !== entry.id) return null;
  if (run.meta?.labNative?.entryCommit !== contract.entryCommit) return null;
  if (run.meta?.labNative?.contractVersion !== contract.version) return null;
  if (run.meta?.labNative?.contractSha256 !== contract.sha256) return null;
  if (run.meta?.labNative?.expectedCellCount !== contract.expectedCellCount) return null;
  if (run.meta?.entryCommits?.[entry.id] !== entry.provenance?.commit) return null;
  if (JSON.stringify(run.meta?.matrixContract) !== JSON.stringify(contract)) return null;
  if (run.nativeCoverage?.contractSha256 !== contract.sha256) return null;
  if (run.nativeCoverage?.expectedCellCount !== contract.expectedCellCount) return null;
  if (run.nativeCoverage?.cells?.some((cell) => [
    'unscheduled', 'invalid-incomparable', 'display-derivation-bug',
  ].includes(cell.status))) return null;
  if (run.records.length !== contract.expectedCellCount) return null;
  if (run.records.some((record) =>
    record.harness !== 'native' || record.entry !== entry.id)) return null;
  const records = run.records.filter((record) => record.harness === 'native');
  const expected = new Map(contract.cells.map((cell) => [nativeCellKey(cell), cell]));
  const actual = new Map();
  for (const record of records) {
    const key = nativeCellKey(record);
    const cell = expected.get(key);
    if (!cell || actual.has(key)) return null;
    if (record.unit !== cell.unit || record.boundary !== cell.boundary) return null;
    const sourceCount = (Array.isArray(record.samples) ? record.samples.length : 0)
      + (record.dnfCount ?? 0);
    if (sourceCount !== cell.expectedReps) return null;
    if ((record.failures?.length ?? 0) !== (record.dnfCount ?? 0)) return null;
    actual.set(key, record);
  }
  if (actual.size !== contract.expectedCellCount) return null;
  return { contract, records };
}
