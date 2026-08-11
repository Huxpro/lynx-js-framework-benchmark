// Audit the live-upstream residual experiments and emit the final landing report.
//
// Usage:
//   node scripts/report-octane-upstream-residual.mjs [--write]
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const specs = {
  p6: ['results/runs/2026-08-11T07-07-07-65160668d8d9-upstream-p6.json', 262],
  p6Reverse: ['results/runs/2026-08-11T07-12-07-65160668d8d9-upstream-p6-adverse-reverse.json', 96],
  p1: ['results/runs/2026-08-11T07-49-53-65160668d8d9-upstream-p1.json', 304],
  p1Reverse: ['results/runs/2026-08-11T08-02-23-65160668d8d9-upstream-p1-adverse-reverse.json', 166],
  combined: ['results/runs/2026-08-11T08-23-27-65160668d8d9-upstream-p1-p6.json', 304],
  combinedReverse: ['results/runs/2026-08-11T08-37-59-65160668d8d9-upstream-p1-p6-adverse-reverse.json', 166],
  fusion: ['results/runs/2026-08-11T09-43-38-65160668d8d9-upstream-fusion-vs-main.json', 304],
  fusionReverse: ['results/runs/2026-08-11T09-57-48-65160668d8d9-upstream-fusion-main-adverse-reverse.json', 166],
  fusionV2: ['results/runs/2026-08-11T10-14-57-65160668d8d9-upstream-fusion-v2-vs-main.json', 304],
  fusionV2Reverse: ['results/runs/2026-08-11T10-41-20-65160668d8d9-upstream-fusion-v2-main-adverse-reverse.json', 222],
  pacingOnly: ['results/runs/2026-08-11T10-59-00-65160668d8d9-upstream-pacing-only-main.json', 166],
  pacingOnlyReverse: ['results/runs/2026-08-11T11-13-25-65160668d8d9-upstream-pacing-only-main-reverse.json', 166],
};
const commits = {
  'octane-main': '9b147781c9b4ec4df053a059633978ddc0ed922a',
  'octane-upstream-p6': '57d1a8fdc63daf7e0db0ce35b469d736d8faacb9',
  'octane-upstream-p1': 'aa3ebe22e327a0509bb40937592771e5eeab4529',
  'octane-upstream-p1-p6': 'f9c60a22eff16cbdd4d0c9f77e44e46a8320d26d',
  'octane-upstream-fusion': '7ff554ea51e43d0177ac4a72ac46f2fdc189a718',
  'octane-upstream-fusion-v2': '7f16f8bc19c9eeb1297ea3e42c2cf004e21e6aa8',
  'octane-upstream-pacing-only': '6303f760f7cee36b79eae5d66a9e1d0e585d03bd',
};
const statMetrics = new Set([
  'latency', 'btsCpu', 'mtsCpu', 'wireToBtsBytes', 'wireToBtsMsgs',
  'wireToMtsBytes', 'wireToMtsMsgs', 'fcp', 'settled',
]);
const fail = (message) => {
  throw new Error(`upstream residual audit failed: ${message}`);
};
const sha256 = (file) =>
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const pct = (before, after) => ((after / before) - 1) * 100;
const signed = (value) => `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
const value = (record) => `${record.median.toFixed(1)} ±${record.ci95.toFixed(1)}`;

const runs = {};
let records = 0;
for (const [name, [relative, expected]] of Object.entries(specs)) {
  const file = path.join(root, relative);
  const run = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (run.schemaVersion !== 2) fail(`${name}: schema ${run.schemaVersion}`);
  if (run.records.length !== expected) fail(`${name}: ${run.records.length} records, expected ${expected}`);
  for (const [entry, commit] of Object.entries(run.meta.entryCommits)) {
    if (commits[entry] !== commit) fail(`${name}: unexpected ${entry} commit ${commit}`);
  }
  for (const record of run.records) {
    if (record.dnfCount != null && record.dnfCount !== 0) fail(`${name}: DNF in ${record.entry}/${record.workload}`);
    if (statMetrics.has(record.metric) && !Number.isFinite(record.median)) {
      fail(`${name}: null median in ${record.entry}/${record.workload}/${record.metric}`);
    }
  }
  run.index = new Map(run.records.map((record) => [
    [record.entry, record.workload, record.scale, record.metric].join('|'), record,
  ]));
  runs[name] = { run, relative, sha: sha256(file) };
  records += run.records.length;
}

let bundleChecks = 0;
for (const [entry, commit] of Object.entries(commits)) {
  const manifestFile = path.join(root, 'entries', entry, 'entry.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (manifest.provenance.commit !== commit || manifest.provenance.patched !== false) {
    fail(`${entry}: provenance mismatch`);
  }
  for (const [relative, expected] of Object.entries(manifest.provenance.sha256)) {
    const file = path.join(root, 'entries', entry, 'dist', relative);
    if (sha256(file) !== expected) fail(`${entry}: checksum mismatch for ${relative}`);
    bundleChecks++;
  }
}

const get = (runName, entry, workload, scale, metric = 'latency') => {
  const record = runs[runName].run.index.get([entry, workload, scale, metric].join('|'));
  if (!record) fail(`${runName}: missing ${entry}/${workload}@${scale}/${metric}`);
  return record;
};
const comparison = (runName, baseline, candidate, workload, scale, metric = 'latency') => {
  const before = get(runName, baseline, workload, scale, metric);
  const after = get(runName, candidate, workload, scale, metric);
  return { before, after, delta: pct(before.median, after.median) };
};

const rows = [
  ['P6 alone', 'p6Reverse', 'octane-main', 'octane-upstream-p6', 'selectStorm', 10000,
    'Blocked: deterministic select-storm regression despite static bundle savings.'],
  ['P1 alone', 'p1Reverse', 'octane-main', 'octane-upstream-p1', 'updateStorm', 30000,
    'Owner appeared, but ordinary commits paid an unconditional pulse.'],
  ['P1 → P6', 'combinedReverse', 'octane-upstream-p1', 'octane-upstream-p1-p6', 'clear', 10000,
    'Blocked: P6 added a repeatable clear-path MTS cost.'],
  ['Fusion v1', 'fusionReverse', 'octane-main', 'octane-upstream-fusion', 'selectStorm', 1000,
    'Blocked: demand pacing raised the small-storm latency by one request round trip.'],
  ['Fusion v2', 'fusionV2Reverse', 'octane-main', 'octane-upstream-fusion-v2', 'updateStorm', 30000,
    'Safe small-root path, but the 30k owner became a wash.'],
  ['Pacing only', 'pacingOnlyReverse', 'octane-main', 'octane-upstream-pacing-only', 'updateStorm', 30000,
    'Final isolation: the forward win did not survive reverse order.'],
];

const lines = [];
const out = (line = '') => lines.push(line);
out('# Octane live-upstream residual performance audit');
out();
out('## Verdict');
out();
out('- Live upstream `main` already contains the structural ceiling raisers from #693/#696/#700. The old Hux2 P3/P4/P5/P7 layers must not be replayed.');
out('- P6 alone, P1+P6, both #693-inspired fusion variants, and the final P1-only isolation each failed at least one required performance gate.');
out('- Therefore there is **no honest mergeable upstream product PR** left in this stack. Opening one would turn entry-order/JIT sensitivity into a performance claim.');
out('- The correct delivery is the neutral benchmark/report PR plus this negative-result ledger; a future product attempt needs a new owner signal, preferably real-device frame data or an explicitly opt-in pacing policy.');
out(`- Audit: ${records} raw records, zero DNF/null medians, ${bundleChecks} exact bundle checksums, one machine, and exact clean source SHAs.`);
out();
out('## Residual decision matrix');
out();
out('| Candidate | Expanded cell | Baseline | Candidate | Delta | Decision |');
out('| --- | --- | ---: | ---: | ---: | --- |');
for (const [label, runName, baseline, candidate, workload, scale, decision] of rows) {
  const result = comparison(runName, baseline, candidate, workload, scale);
  out(`| ${label} | ${workload}@${scale.toLocaleString('en-US')} | ${value(result.before)} ms | ${value(result.after)} ms | ${signed(result.delta)} | ${decision} |`);
}
out();
const fusionLarge = comparison('fusionReverse', 'octane-main', 'octane-upstream-fusion', 'updateStorm', 30000);
const fusionSmall = comparison('fusionReverse', 'octane-main', 'octane-upstream-fusion', 'selectStorm', 1000);
const pacingForward = comparison('pacingOnly', 'octane-main', 'octane-upstream-pacing-only', 'updateStorm', 30000);
const pacingReverse = comparison('pacingOnlyReverse', 'octane-main', 'octane-upstream-pacing-only', 'updateStorm', 30000);
out('The strongest attempted fusion made large update storms faster in one expanded order ' +
  `(${signed(fusionLarge.delta)}) but made the 1k select storm ${signed(fusionSmall.delta)} slower. ` +
  'Adding the host-count gate removed that small-root regression, but also removed the owner win. ' +
  `Removing P6 produced ${signed(pacingForward.delta)} forward and ${signed(pacingReverse.delta)} reverse at updateStorm@30k: an order-sensitive wash, not a shippable improvement.`);
out();
out('## What #693 and Hux2 teach each other');
out();
out('- [Upstream #693](https://github.com/octanejs/octane/pull/693) wins structurally: shared compiled host programs, compact acknowledgements, lazy public handles/selectors, and capability negotiation remove work rather than reschedule it. Its own report makes 10k mount/update faster than ReactLynx, while disclosing about 39% gzip growth.');
out('- Hux2 P6 contributes the opposite lever: lazy-load the worklet bridge and recover roughly 1–3% compressed main-bundle cost, but the neutral runtime gate shows that static shrink alone is not enough to justify the current implementation.');
out('- P1 contributes a scheduling lever for burst folding. Applying #693\'s “pay only on demand” principle removed ordinary frame-pulse messages; applying negotiated host count removed the small-root storm regression. The remaining large-root win was not stable under entry reversal.');
out('- The combined ceiling is therefore not another transplant of the old stack. It is a future design that keeps #693\'s structural fast path, makes optional bridges genuinely cold, and derives pacing from a real frame/backpressure signal rather than a benchmark-scale heuristic.');
out();
out('## Upstream reorganization');
out();
out('| Old layer | Live-upstream treatment |');
out('| --- | --- |');
out('| P0 | Keep as Huxpro diagnostic provenance; no product runtime PR. |');
out('| P1 | Reimplemented three ways and isolated without P6; blocked because the owner is order-sensitive or paid by another cell. |');
out('| P2 | Already landed independently as upstream #696. |');
out('| P3/P4/P5/P7 | Superseded by #693/#700; do not cherry-pick or restack. |');
out('| P6 | Static bundle owner is real, but its standalone and combined runtime gates fail; do not submit in the current form. |');
out();
out('If work resumes, start from live `main`, not any old Hux branch. Keep one product PR with small rollback commits only after one final tree passes forward and reverse neutral gates; until then, no PR ordering or squashing strategy can make the current residuals mergeable.');
out();
out('## Reproducibility');
out();
for (const [name, { relative, sha }] of Object.entries(runs)) {
  out(`- ${name}: \`${relative}\` · SHA-256 \`${sha}\``);
}

const report = `${lines.join('\n')}\n`;
if (process.argv.includes('--write')) {
  const output = path.join(root, 'results/reports/2026-08-11-octane-upstream-residual-audit.md');
  fs.writeFileSync(output, report);
  console.log(path.relative(root, output));
} else {
  process.stdout.write(report);
}
