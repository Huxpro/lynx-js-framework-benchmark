import crypto from 'node:crypto';

import { BOUNDARIES } from '@lynx-bench/shared/schema';
import { STARTUP_CASES, TABLE_CASES } from '@lynx-bench/shared/workloads';

export const LAB_WEB_CONTRACT_VERSION = 'web-lab-entry-v1';
export const LAB_WEB_REQUIRED_CELL_COUNT = 35;

const cellKey = (cell) =>
  [cell.entry, cell.suite, cell.workload, cell.scale, cell.metric].join('|');

export function buildLabWebContract(entry) {
  if (entry.tier !== 'lab' || entry.webLab?.enabled !== true) {
    throw new Error(`${entry.id}: Lab Web requires tier=lab and webLab.enabled=true.`);
  }
  if (entry.webLab.contract !== LAB_WEB_CONTRACT_VERSION) {
    throw new Error(`${entry.id}: webLab.contract must be ${LAB_WEB_CONTRACT_VERSION}.`);
  }
  const cells = [];
  for (const kase of TABLE_CASES) {
    for (const scale of kase.scales) {
      cells.push({
        entry: entry.id, suite: 'table', workload: kase.name, scale, metric: 'latency',
        boundary: BOUNDARIES.latency, unit: 'ms',
        expectedReps: kase.freshPage ? 3 : 7,
      });
    }
  }
  for (const scale of STARTUP_CASES[0].scales) {
    cells.push({
      entry: entry.id, suite: 'startup', workload: 'startup', scale, metric: 'fcp',
      boundary: BOUNDARIES.fcp, unit: 'ms',
      expectedReps: 5,
    });
    cells.push({
      entry: entry.id, suite: 'startup', workload: 'startup', scale, metric: 'settled',
      boundary: BOUNDARIES.settled, unit: 'ms',
      expectedReps: 5,
    });
  }
  if (cells.length !== LAB_WEB_REQUIRED_CELL_COUNT) {
    throw new Error(`${entry.id}: Lab Web contract contains ${cells.length} required cells.`);
  }
  const payload = {
    version: LAB_WEB_CONTRACT_VERSION,
    entryId: entry.id,
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

export function labWebMatrixOptions(contract) {
  return {
    scales: [...new Set(contract.cells
      .filter((cell) => cell.suite === 'table')
      .map((cell) => cell.scale))],
    reps: 7,
    stormReps: 3,
    startupReps: 5,
  };
}

export function resolveLabWebEntry(allEntries, requestedEntryIds, enabled) {
  if (!enabled) return null;
  if (requestedEntryIds == null || requestedEntryIds.length !== 1) {
    throw new Error('--lab-web requires exactly one explicit --entry.');
  }
  const entry = allEntries.find((candidate) => candidate.id === requestedEntryIds[0]);
  if (!entry) throw new Error(`unknown entry: ${requestedEntryIds[0]}`);
  return { entry, contract: buildLabWebContract(entry) };
}

export function assertCompleteLabWebRun(run, entry) {
  const contract = buildLabWebContract(entry);
  if (run.meta?.completed !== true || !run.meta?.completedAt) return null;
  if (run.meta?.comparisonScope !== 'lab-entry-web') return null;
  const meta = run.meta?.labWeb;
  if (meta?.entryId !== entry.id || meta?.entryCommit !== contract.entryCommit) return null;
  if (meta?.contractVersion !== contract.version || meta?.contractSha256 !== contract.sha256) return null;
  if (meta?.expectedCellCount !== contract.expectedCellCount) return null;
  if (run.meta?.entryCommits?.[entry.id] !== contract.entryCommit) return null;
  if (run.records.some((record) => record.entry !== entry.id || record.harness !== 'web')) return null;
  const records = new Map();
  for (const record of run.records) {
    const key = cellKey(record);
    if (records.has(key)) return null;
    records.set(key, record);
  }
  for (const cell of contract.cells) {
    const record = records.get(cellKey(cell));
    if (!record || record.boundary !== cell.boundary || record.unit !== cell.unit) return null;
    const sourceCount = (Array.isArray(record.samples) ? record.samples.length : 0)
      + (record.dnfCount ?? 0);
    if (sourceCount !== cell.expectedReps) return null;
    if ((record.failures?.length ?? 0) !== (record.dnfCount ?? 0)) return null;
  }
  return { contract, records: run.records };
}
