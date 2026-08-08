// Merge run files into results/latest.json. Newest record wins per
// (machine × harness × environment × entry × workload × scale × metric);
// records from different machines coexist, each tagged with its machine and
// calibration so the site can separate or (opt-in) relate them.
import fs from 'node:fs';
import path from 'node:path';

import { SCHEMA_VERSION } from '@lynx-bench/shared/schema';

import { repoRoot } from './entries.mjs';

const recordKey = (machineId, r) =>
  [machineId, r.harness, r.environment, r.entry, r.workload, r.scale, r.metric].join('|');

export function collectRuns({ log = console.log } = {}) {
  const root = repoRoot();
  const runsDir = path.join(root, 'results/runs');
  const outPath = path.join(root, 'results/latest.json');
  if (!fs.existsSync(runsDir)) throw new Error(`no runs directory at ${runsDir}`);

  const runFiles = fs.readdirSync(runsDir).filter((f) => f.endsWith('.json')).sort();
  const machines = {};
  const merged = new Map();
  let runsSeen = 0;

  for (const file of runFiles) {
    const run = JSON.parse(fs.readFileSync(path.join(runsDir, file), 'utf-8'));
    if (run.schemaVersion !== SCHEMA_VERSION) {
      log(`[collect] skip ${file}: schemaVersion ${run.schemaVersion} != ${SCHEMA_VERSION}`);
      continue;
    }
    runsSeen += 1;
    const m = run.meta.machine;
    machines[m.id] = { ...m, calibration: run.meta.calibration };
    for (const r of run.records) {
      // Sort order of runFiles (ISO-timestamped names) makes later files win.
      merged.set(recordKey(m.id, r), { ...r, machineId: m.id, runFile: file });
    }
  }

  const out = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    machines,
    records: [...merged.values()],
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 1));
  log(`[collect] ${runsSeen} runs → ${out.records.length} records → ${path.relative(root, outPath)}`);
  return out;
}
