import fs from 'node:fs';
import path from 'node:path';

import { assertContainedPath, assertRunLabel } from './path-safety.mjs';

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
