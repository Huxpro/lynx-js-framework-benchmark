// CI guard: results/latest.json must equal what `bench collect` produces from
// results/runs/ — the site imports latest.json at build time, so a stale
// collect would publish numbers that don't match the checked-in run files
// (the drift-guard idea from octane's HOME_SUMMARY smoke test).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectRuns } from '../packages/runner/src/collect.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const latestPath = path.join(root, 'results/latest.json');

const before = JSON.parse(fs.readFileSync(latestPath, 'utf-8'));
const regenerated = collectRuns({ log: () => {} });

// generatedAt necessarily differs; everything else must match exactly.
const strip = ({ generatedAt: _generatedAt, ...rest }) => JSON.stringify(rest);
if (strip(before) !== strip(regenerated)) {
  // restore the committed file so a local run doesn't leave noise behind
  fs.writeFileSync(latestPath, JSON.stringify(before, null, 1));
  console.error(
    'results/latest.json is stale: it does not match `lynx-bench collect` over results/runs/.\n'
    + 'Run `pnpm bench collect` and commit the result.',
  );
  process.exit(1);
}
fs.writeFileSync(latestPath, JSON.stringify(before, null, 1));
console.log(`latest.json is in sync (${before.records.length} records)`);
