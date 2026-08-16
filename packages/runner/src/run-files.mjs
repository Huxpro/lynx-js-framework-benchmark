import fs from 'node:fs';
import path from 'node:path';

import { assertContainedPath, assertRunLabel } from './path-safety.mjs';
import { validateCampaignMetadata } from './campaign.mjs';
import { deriveRecord } from '@lynx-bench/shared/schema';

export function validateFormalRun(run, label = 'run') {
  const formal = validateCampaignMetadata(run?.meta, label);
  if (!formal) return run;
  if (!Array.isArray(run.records) || run.records.length === 0) {
    throw new Error(`${label} formal records must be non-empty`);
  }
  const expected = new Map();
  for (const cell of [
    ...formal.resolvedMatrix.table,
    ...formal.resolvedMatrix.startup,
  ]) {
    expected.set(`${cell.workload}\0${cell.scale}`, cell.reps);
  }
  for (const [index, record] of run.records.entries()) {
    if (record.suite === 'bundle' || record.workload === 'memory') continue;
    const reps = expected.get(`${record.workload}\0${record.scale}`);
    if (reps == null) {
      throw new Error(`${label} record ${index} is outside resolvedMatrix`);
    }
    if (!Array.isArray(record.attempts) || record.attempts.length !== reps) {
      throw new Error(`${label} record ${index} attempts length must be ${reps}`);
    }
    deriveRecord(record);
  }
  return run;
}

export function runTimestamp(date) {
  return date.toISOString().replace(/[:.]/g, '-');
}

export function runFileName({
  date,
  machineId,
  label = null,
  native = false,
}) {
  const safeLabel = assertRunLabel(label);
  return [
    runTimestamp(date),
    machineId,
    ...(native ? ['native'] : []),
    ...(safeLabel ? [safeLabel] : []),
  ].join('-') + '.json';
}

export function writeRunFile({
  root,
  run,
  machineId,
  label = null,
  native = false,
}) {
  validateFormalRun(run);
  const resultsDir = path.join(root, 'results');
  const runsDir = path.join(resultsDir, 'runs');
  const file = runFileName({
    date: new Date(run.meta.generatedAt),
    machineId,
    label,
    native,
  });
  const outPath = path.join(runsDir, file);
  for (const [target, targetLabel] of [
    [resultsDir, 'results directory'],
    [runsDir, 'results/runs directory'],
    [outPath, 'run file'],
  ]) {
    assertContainedPath(root, target, { label: targetLabel });
  }
  fs.mkdirSync(runsDir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(run, null, 1), { flag: 'wx' });
  return outPath;
}
