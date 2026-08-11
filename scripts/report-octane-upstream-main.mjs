// Audit the exact Hux2-versus-live-upstream runs and emit a reproducible report.
//
// Usage:
//   node scripts/report-octane-upstream-main.mjs [--write]
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const paths = {
  full: 'results/runs/2026-08-11T06-27-46-65160668d8d9-octane-hux2-vs-upstream-main.json',
  adverse: 'results/runs/2026-08-11T06-39-01-65160668d8d9-octane-upstream-adverse-reverse.json',
  startup: 'results/runs/2026-08-11T06-48-07-65160668d8d9-octane-upstream-startup0-reverse.json',
};
const commits = {
  'octane-hux2': 'ff7d2c71c2296b7936f17c809e46637a18963338',
  'octane-main': '9b147781c9b4ec4df053a059633978ddc0ed922a',
};
const labels = {
  'octane-hux2': 'Hux2 / P7',
  'octane-main': 'Live upstream main',
};
const expectedRecords = { full: 304, adverse: 96, startup: 38 };
const statMetrics = new Set([
  'latency',
  'btsCpu',
  'mtsCpu',
  'wireToBtsBytes',
  'wireToBtsMsgs',
  'wireToMtsBytes',
  'wireToMtsMsgs',
  'fcp',
  'settled',
]);
const boundaries = {
  latency: 'pointerdown-to-dom-predicate',
  btsCpu: 'sampled-js-cpu-background-realm',
  mtsCpu: 'sampled-js-cpu-ui-thread',
  wireToBtsBytes: 'web-core-rpc-channel',
  wireToBtsMsgs: 'web-core-rpc-channel',
  wireToMtsBytes: 'web-core-rpc-channel',
  wireToMtsMsgs: 'web-core-rpc-channel',
  fcp: 'view-attach-to-first-content',
  settled: 'view-attach-to-dom-settled',
  heapBts: 'gc-heap-with-10k-rows',
  heapMts: 'gc-heap-with-10k-rows',
  bundleWebGzip: 'static',
  bundleLynxGzip: 'static',
};

const fail = (message) => {
  throw new Error(`upstream comparison audit failed: ${message}`);
};
const sha256 = (file) =>
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const pct = (before, after) => ((after / before) - 1) * 100;
const signed = (value) => `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
const number = (value) => Number(value).toFixed(1);
const bytes = (value) => `${(value / 1024).toFixed(1)} KiB`;
const absolute = Object.fromEntries(
  Object.entries(paths).map(([key, relative]) => [key, path.join(root, relative)]),
);
const runs = Object.fromEntries(
  Object.entries(absolute).map(([key, file]) => [key, JSON.parse(fs.readFileSync(file, 'utf8'))]),
);

for (const [name, run] of Object.entries(runs)) {
  if (run.schemaVersion !== 2) fail(`${name}: schemaVersion ${run.schemaVersion}`);
  if (run.records.length !== expectedRecords[name]) {
    fail(`${name}: expected ${expectedRecords[name]} records, found ${run.records.length}`);
  }
  for (const [id, commit] of Object.entries(commits)) {
    if (run.meta?.entryCommits?.[id] !== commit) {
      fail(`${name}: ${id} commit is ${run.meta?.entryCommits?.[id]}, expected ${commit}`);
    }
  }
  for (const record of run.records) {
    if (record.harness !== 'web' || record.environment !== 'lynx-for-web') {
      fail(`${name}: unexpected environment on ${record.entry}/${record.metric}`);
    }
    if (record.dnfCount != null && record.dnfCount !== 0) {
      fail(`${name}: ${record.entry}/${record.workload}@${record.scale} has DNF`);
    }
    if (statMetrics.has(record.metric) && !Number.isFinite(record.median)) {
      fail(`${name}: ${record.entry}/${record.workload}@${record.scale}/${record.metric} is null`);
    }
    if (boundaries[record.metric] && record.boundary !== boundaries[record.metric]) {
      fail(`${name}: ${record.metric} boundary is ${record.boundary}`);
    }
  }
}

let bundleChecks = 0;
const manifests = {};
for (const [id, commit] of Object.entries(commits)) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, 'entries', id, 'entry.json'), 'utf8'),
  );
  manifests[id] = manifest;
  if (manifest.provenance.commit !== commit) fail(`${id}: manifest commit mismatch`);
  if (id === 'octane-main' && manifest.provenance.patched !== false) {
    fail('octane-main must be a clean, unpatched checkout');
  }
  for (const [relative, expected] of Object.entries(manifest.provenance.sha256)) {
    const file = path.join(root, 'entries', id, 'dist', relative);
    if (!fs.existsSync(file) || sha256(file) !== expected) {
      fail(`${id}: checksum mismatch for ${relative}`);
    }
    bundleChecks += 1;
  }
}

const index = (run) => new Map(
  run.records.map((record) => [
    [record.entry, record.workload, record.scale, record.metric].join('|'),
    record,
  ]),
);
const indexes = Object.fromEntries(Object.entries(runs).map(([key, run]) => [key, index(run)]));
const get = (run, entry, workload, scale, metric) => {
  const record = indexes[run].get([entry, workload, scale, metric].join('|'));
  if (!record) fail(`${run}: missing ${entry}/${workload}@${scale}/${metric}`);
  return record;
};

for (const record of runs.full.records) {
  if (statMetrics.has(record.metric)) {
    const expected = record.suite === 'startup'
      ? 5
      : record.workload === 'updateStorm' || record.workload === 'selectStorm'
        ? 3
        : 7;
    if (record.n !== expected) fail(`full: ${record.entry}/${record.workload} n=${record.n}`);
  }
}
for (const record of runs.adverse.records) {
  if (record.metric !== 'latency') continue;
  const expected = record.workload === 'updateStorm' ? 9 : 15;
  if (record.n !== expected) fail(`adverse: ${record.entry}/${record.workload} n=${record.n}`);
}
for (const record of runs.startup.records) {
  if (record.metric === 'fcp' && record.n !== 15) {
    fail(`startup: ${record.entry}/${record.scale} n=${record.n}`);
  }
}

const interactionRows = runs.full.records
  .filter((record) => record.entry === 'octane-hux2' && record.metric === 'latency')
  .map((hux2) => {
    const main = get('full', 'octane-main', hux2.workload, hux2.scale, 'latency');
    return { hux2, main, delta: pct(hux2.median, main.median) };
  });
const btsRows = interactionRows.map(({ hux2 }) => {
  const before = get('full', 'octane-hux2', hux2.workload, hux2.scale, 'btsCpu');
  const after = get('full', 'octane-main', hux2.workload, hux2.scale, 'btsCpu');
  return pct(before.median, after.median);
});
const mtsRows = interactionRows.map(({ hux2 }) => {
  const before = get('full', 'octane-hux2', hux2.workload, hux2.scale, 'mtsCpu');
  const after = get('full', 'octane-main', hux2.workload, hux2.scale, 'mtsCpu');
  return pct(before.median, after.median);
});

const lines = [];
const out = (line = '') => lines.push(line);
out('# Octane Hux2 vs live upstream main');
out();
out('> Historical baseline comparison. Its preliminary P6→P1 landing order is superseded by `2026-08-11-octane-upstream-residual-audit.md`, which reruns every live-upstream residual and concludes that no current product candidate passes the final gate.');
out();
out(`Primary run: \`${paths.full}\` · SHA-256 \`${sha256(absolute.full)}\``);
out(`Reverse adverse rerun: \`${paths.adverse}\` · SHA-256 \`${sha256(absolute.adverse)}\``);
out(`Reverse startup rerun: \`${paths.startup}\` · SHA-256 \`${sha256(absolute.startup)}\``);
out();
out('## Verdict');
out();
out(`- Live upstream main is faster in **${interactionRows.filter(({ delta }) => delta < 0).length}/${interactionRows.length} interaction latency cells**, ${btsRows.filter((delta) => delta < 0).length}/${btsRows.length} BTS CPU cells, and ${mtsRows.filter((delta) => delta < 0).length}/${mtsRows.length} MTS CPU cells.`);
for (const scale of [1000, 10000, 30000]) {
  const before = get('full', 'octane-hux2', 'create', scale, 'latency');
  const after = get('full', 'octane-main', 'create', scale, 'latency');
  out(`- create@${scale / 1000}k: ${number(before.median)} → ${number(after.median)} ms (${signed(pct(before.median, after.median))}).`);
}
out('- Therefore the old P3/P4/P5/P7 implementation should not be replayed upstream: #693/#700 already replace that architecture and outperform the final Hux2 tip on its primary large-materialization cells.');
out('- The comparison is not all-green. Expanded reverse-order runs confirm clear@10k, update storm@30k, startup@0, and bundle gzip as remaining upstream costs; select@1k is a small overlapping-CI adverse cell.');
out(`- Audit: ${Object.values(runs).reduce((sum, run) => sum + run.records.length, 0)} records across three same-machine runs, zero DNF/null medians, ${bundleChecks} bundle checksums, exact clean source SHAs.`);
out();
out('## Provenance');
out();
out('| Entry | Exact commit | App tree | Lockfile SHA-256 | Patched |');
out('| --- | --- | --- | --- | --- |');
for (const id of Object.keys(commits)) {
  const manifest = manifests[id];
  out(`| ${labels[id]} | \`${commits[id]}\` | \`${manifest.provenance.sourceBenchmarkTree}\` | \`${manifest.provenance.sourceLockSha256}\` | ${manifest.provenance.patched} |`);
}
out();
out('| Run | Entry order | Samples | Calibration | Machine |');
out('| --- | --- | --- | ---: | --- |');
out(`| Primary | Hux2 → upstream | ordinary 7, storms 3, startup 5 | ${runs.full.meta.calibration.score} | \`${runs.full.meta.machine.id}\` |`);
out(`| Adverse repeat | upstream → Hux2 | ordinary 15, storm 9 | ${runs.adverse.meta.calibration.score} | \`${runs.adverse.meta.machine.id}\` |`);
out(`| Startup repeat | upstream → Hux2 | startup 15 | ${runs.startup.meta.calibration.score} | \`${runs.startup.meta.machine.id}\` |`);
out();
out('The app trees differ because live upstream changed the benchmark together with the renderer. Both entries implement the same neutral workload/DOM contract and were driven by the same runner boundaries; neither source was patched.');
out();
out('## Primary interaction latency');
out();
out('| Workload | Scale | Hux2 ms (CI95) | Upstream ms (CI95) | Delta |');
out('| --- | ---: | ---: | ---: | ---: |');
for (const { hux2, main, delta } of interactionRows) {
  out(`| ${hux2.workload} | ${hux2.scale.toLocaleString('en-US')} | ${number(hux2.median)} ±${number(hux2.ci95)} | ${number(main.median)} ±${number(main.ci95)} | ${signed(delta)} |`);
}
out();
out('## Expanded reverse-order classification');
out();
out('| Cell | Upstream | Hux2 | Upstream delta | Classification |');
out('| --- | ---: | ---: | ---: | --- |');
for (const [workload, scale, classification] of [
  ['select', 1000, 'small absolute delta; CI95 overlaps'],
  ['clear', 10000, 'confirmed adverse; clear/teardown owner'],
  ['updateStorm', 30000, 'confirmed adverse; pacing candidate'],
]) {
  const main = get('adverse', 'octane-main', workload, scale, 'latency');
  const hux2 = get('adverse', 'octane-hux2', workload, scale, 'latency');
  out(`| ${workload}@${scale.toLocaleString('en-US')} | ${number(main.median)} ±${number(main.ci95)} ms | ${number(hux2.median)} ±${number(hux2.ci95)} ms | ${signed(pct(hux2.median, main.median))} | ${classification} |`);
}
for (const scale of [0, 1000, 30000]) {
  const main = get('startup', 'octane-main', 'startup', scale, 'fcp');
  const hux2 = get('startup', 'octane-hux2', 'startup', scale, 'fcp');
  out(`| startup@${scale.toLocaleString('en-US')} | ${number(main.median)} ±${number(main.ci95)} ms | ${number(hux2.median)} ±${number(hux2.ci95)} ms | ${signed(pct(hux2.median, main.median))} | ${scale === 0 ? 'confirmed fixed-cost adverse' : 'upstream materialization win'} |`);
}
out();
out('## CPU, memory, startup, and static cost');
out();
out('| Metric | Hux2 | Upstream | Delta |');
out('| --- | ---: | ---: | ---: |');
for (const [label, workload, scale, metric, formatter = number] of [
  ['create@10k BTS CPU', 'create', 10000, 'btsCpu'],
  ['create@10k MTS CPU', 'create', 10000, 'mtsCpu'],
  ['clear@10k BTS CPU', 'clear', 10000, 'btsCpu'],
  ['clear@10k MTS CPU', 'clear', 10000, 'mtsCpu'],
  ['BTS heap with 10k rows', 'memory', 10000, 'heapBts', bytes],
  ['MTS heap with 10k rows', 'memory', 10000, 'heapMts', bytes],
  ['startup FCP@10k', 'startup', 10000, 'fcp'],
  ['startup FCP@30k', 'startup', 30000, 'fcp'],
  ['Web bundle gzip', 'bundle', 0, 'bundleWebGzip', bytes],
  ['Lynx bundle gzip', 'bundle', 0, 'bundleLynxGzip', bytes],
]) {
  const hux2 = get('full', 'octane-hux2', workload, scale, metric).median;
  const main = get('full', 'octane-main', workload, scale, metric).median;
  out(`| ${label} | ${formatter(hux2)} | ${formatter(main)} | ${signed(pct(hux2, main))} |`);
}
out();
out('## Upstream landing decision');
out();
out('| Old layer | Live upstream treatment |');
out('| --- | --- |');
out('| P0 attribution tooling | Keep as Huxpro diagnostic provenance; current upstream benchmarks and #693/#700 evidence supersede its old target matrix. No product PR. |');
out('| P1 frame pacing | Missing on live main. Reimplement against the new protocol as a narrow, separately benchmarked PR; update storm@30k is the current owner signal. |');
out('| P2 retained adoption | Already landed independently as upstream #696. Do not duplicate. |');
out('| P3 plan wire · P4 validation · P5 protocol v2 · P7 materialization | Superseded by the combined, newer #693/#700 renderer protocol and template-run architecture. Do not replay or cherry-pick. |');
out('| P6 lazy worklet bridge | Still missing. Rebase/reimplement as a narrow bundle-only PR and remeasure against live main; retain the explicit “no startup win” claim boundary. |');
out();
out('P1 and P6 should remain separate rollback units. For the sequential upstream train, land P6 first because it is a low-risk static dependency boundary with deterministic bundle evidence; then rebase and benchmark P1, whose scheduling behavior has higher semantic and responsiveness risk. Do not combine either with the clear@10k follow-up, which has a different owner.');
out();
out('## Measurement boundaries');
out();
for (const [metric, boundary] of Object.entries(boundaries)) {
  out(`- ${metric}: \`${boundary}\``);
}

const report = `${lines.join('\n')}\n`;
if (process.argv.includes('--write')) {
  const output = path.join(root, 'results/reports/2026-08-11-octane-hux2-vs-upstream-main.md');
  fs.writeFileSync(output, report);
  console.log(path.relative(root, output));
} else {
  process.stdout.write(report);
}
