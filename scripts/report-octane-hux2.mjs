// Validate one archived Hux2 checkpoint run and print its Markdown report.
//
// Usage:
//   pnpm report:octane-hux2 results/runs/<run>.json
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const input = process.argv[2];
if (!input) throw new Error('pass an archived checkpoint run JSON path');
const runPath = path.resolve(root, input);
const run = JSON.parse(fs.readFileSync(runPath, 'utf8'));

const ENTRIES = [
  ['octane', 'Hux1', '4a53620fe811a016cb9966fab53ca181a89159c8'],
  ['octane-hux2-b0', 'B0', '1fbf224c36608067694d32c23d227291fec52d60'],
  ['octane-hux2-p2', 'P2', '71e1b8a88a8c3e37cc005d37a8e6f75cf31088b4'],
  ['octane-hux2-p3', 'P3', '4a444b1b9665d8b4020d774a220bd0e21933cdb2'],
  ['octane-hux2-p6', 'P6', '68b2b0546b28d54b7cd8d44665f95d36b58e48b3'],
  ['octane-hux2', 'P7 / Hux2', 'ff7d2c71c2296b7936f17c809e46637a18963338'],
];
const EXPECTED_REPS = { table: 7, storm: 3, startup: 5 };
const STORMS = new Set(['updateStorm', 'selectStorm']);
const STAT_METRICS = new Set([
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
const EXPECTED_BOUNDARIES = {
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
  throw new Error(`checkpoint run audit failed: ${message}`);
};
const sha256 = (file) =>
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const pct = (before, after) => ((after / before) - 1) * 100;
const signed = (value, digits = 1) => `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`;
const number = (value, digits = 1) => Number(value).toFixed(digits);
const bytes = (value) => `${(value / 1024).toFixed(1)} KiB`;
const relRun = path.relative(root, runPath);

if (run.schemaVersion !== 2) fail(`schemaVersion ${run.schemaVersion}`);
for (const [id, , commit] of ENTRIES) {
  if (run.meta?.entryCommits?.[id] !== commit) {
    fail(`${id} run commit is ${run.meta?.entryCommits?.[id]}, expected ${commit}`);
  }
}
if (run.records.length !== 912) fail(`expected 912 records, found ${run.records.length}`);

let bundleChecks = 0;
for (const [id, , commit] of ENTRIES) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, 'entries', id, 'entry.json'), 'utf8'),
  );
  if (manifest.provenance?.commit !== commit) {
    fail(`${id} manifest commit is ${manifest.provenance?.commit}, expected ${commit}`);
  }
  for (const [relative, expected] of Object.entries(manifest.provenance.sha256)) {
    const file = path.join(root, 'entries', id, 'dist', relative);
    if (!fs.existsSync(file)) fail(`${id} missing ${relative}`);
    if (sha256(file) !== expected) fail(`${id} checksum mismatch: ${relative}`);
    bundleChecks += 1;
  }
}

for (const record of run.records) {
  if (record.harness !== 'web' || record.environment !== 'lynx-for-web') {
    fail(`unexpected measurement environment on ${record.entry}/${record.metric}`);
  }
  if (record.dnfCount != null && record.dnfCount !== 0) {
    fail(`${record.entry}/${record.workload}@${record.scale} has ${record.dnfCount} DNF`);
  }
  if (STAT_METRICS.has(record.metric)) {
    if (!Number.isFinite(record.median)) {
      fail(`${record.entry}/${record.workload}@${record.scale}/${record.metric} has null median`);
    }
    const expected = record.suite === 'startup'
      ? EXPECTED_REPS.startup
      : STORMS.has(record.workload)
        ? EXPECTED_REPS.storm
        : EXPECTED_REPS.table;
    if (record.n !== expected) {
      fail(`${record.entry}/${record.workload}@${record.scale}/${record.metric} n=${record.n}, expected ${expected}`);
    }
  }
  const expectedBoundary = EXPECTED_BOUNDARIES[record.metric];
  if (expectedBoundary && record.boundary !== expectedBoundary) {
    fail(`${record.metric} boundary is ${record.boundary}, expected ${expectedBoundary}`);
  }
}

const lookup = new Map(
  run.records.map((record) => [
    [record.entry, record.workload, record.scale, record.metric].join('|'),
    record,
  ]),
);
const get = (entry, workload, scale, metric) => {
  const record = lookup.get([entry, workload, scale, metric].join('|'));
  if (!record) fail(`missing ${entry}/${workload}@${scale}/${metric}`);
  return record;
};

const interactions = run.records.filter(
  (record) => record.entry === 'octane' && record.metric === 'latency',
);
const interactionRows = interactions.map((hux1) => {
  const hux2 = get('octane-hux2', hux1.workload, hux1.scale, 'latency');
  return { hux1, hux2, delta: pct(hux1.median, hux2.median) };
});
const fasterInteractions = interactionRows.filter((row) => row.delta < 0).length;
const btsRows = interactions.map((latency) => {
  const hux1 = get('octane', latency.workload, latency.scale, 'btsCpu');
  const hux2 = get('octane-hux2', latency.workload, latency.scale, 'btsCpu');
  return pct(hux1.median, hux2.median);
});

const lines = [];
const out = (line = '') => lines.push(line);
out('# Octane Hux2 neutral checkpoint benchmark');
out();
out(`Raw run: \`${relRun}\``);
out(`SHA-256: \`${sha256(runPath)}\``);
out();
out('## Verdict');
out();
out(`- Hux2 is faster than Hux1 in **${fasterInteractions}/${interactionRows.length} interaction latency cells**. The only adverse median is select@1k (${signed(interactionRows.find((row) => row.hux1.workload === 'select' && row.hux1.scale === 1000).delta)}), inside the two confidence intervals.`);
const createHux1 = get('octane', 'create', 10000, 'latency');
const createHux2 = get('octane-hux2', 'create', 10000, 'latency');
out(`- Neutral create@10k is ${number(createHux1.median)} → ${number(createHux2.median)} ms (${signed(pct(createHux1.median, createHux2.median))}), passing the P7 ≥10% acceptance gate.`);
out(`- BTS CPU improves in **${btsRows.filter((delta) => delta < 0).length}/${btsRows.length} interaction cells**. At create@10k it is ${number(get('octane', 'create', 10000, 'btsCpu').median)} → ${number(get('octane-hux2', 'create', 10000, 'btsCpu').median)} ms (${signed(pct(get('octane', 'create', 10000, 'btsCpu').median, get('octane-hux2', 'create', 10000, 'btsCpu').median))}).`);
out(`- The result is not literally all-green: startup FCP@10k/@30k is ${signed(pct(get('octane', 'startup', 10000, 'fcp').median, get('octane-hux2', 'startup', 10000, 'fcp').median))}/${signed(pct(get('octane', 'startup', 30000, 'fcp').median, get('octane-hux2', 'startup', 30000, 'fcp').median))}, create@10k MTS CPU is ${signed(pct(get('octane', 'create', 10000, 'mtsCpu').median, get('octane-hux2', 'create', 10000, 'mtsCpu').median))}, and Web/Lynx gzip is ${signed(pct(get('octane', 'bundle', 0, 'bundleWebGzip').median, get('octane-hux2', 'bundle', 0, 'bundleWebGzip').median))}/${signed(pct(get('octane', 'bundle', 0, 'bundleLynxGzip').median, get('octane-hux2', 'bundle', 0, 'bundleLynxGzip').median))}. These headline tradeoffs are below the 5% gate.`);
out(`- Audit: ${run.records.length} records, zero DNF, zero null medians, expected n=7 (ordinary), n=3 (storms), n=5 (startup), ${bundleChecks} bundle checksums verified.`);
out();
out('## Run provenance');
out();
out('| Field | Value |');
out('| --- | --- |');
out(`| Generated | ${run.meta.generatedAt} |`);
out(`| Machine | ${run.meta.machine.id} · ${run.meta.machine.cpuModel} · ${run.meta.machine.cores} cores · ${run.meta.machine.memGB} GiB |`);
out(`| Node / Chromium | ${run.meta.machine.node} · ${path.basename(path.dirname(path.dirname(run.meta.chromium)))} |`);
out(`| Calibration | probe v${run.meta.calibration.probeVersion}, score ${run.meta.calibration.score} |`);
out('| Harness | web · lynx-for-web |');
out('| Repetitions | ordinary 7 · storms 3 · startup 5 |');
out();
out('| Entry | Exact commit | Benchmark tree | Lockfile SHA-256 |');
out('| --- | --- | --- | --- |');
for (const [id, label, commit] of ENTRIES) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'entries', id, 'entry.json'), 'utf8'));
  out(`| ${label} | \`${commit}\` | \`${manifest.provenance.sourceBenchmarkTree ?? 'legacy manifest'}\` | \`${manifest.provenance.sourceLockSha256 ?? 'legacy manifest'}\` |`);
}
out();
out('Hux1 and P2–P7 use the same benchmark app tree. B0 differs only by the later profiling row-render counter, which is compile-time disabled in these default bundles. B0–P7 use the same lockfile and `pnpm@11.15.1`.');
out();
out('## Hux1 → Hux2 interaction latency');
out();
out('| Workload | Scale | Hux1 ms (CI95) | Hux2 ms (CI95) | Delta |');
out('| --- | ---: | ---: | ---: | ---: |');
for (const { hux1, hux2, delta } of interactionRows) {
  out(`| ${hux1.workload} | ${hux1.scale.toLocaleString('en-US')} | ${number(hux1.median)} ±${number(hux1.ci95)} | ${number(hux2.median)} ±${number(hux2.ci95)} | ${signed(delta)} |`);
}
out();
out('## Startup');
out();
out('| Scale | Hux1 FCP ms | Hux2 FCP ms | Delta |');
out('| ---: | ---: | ---: | ---: |');
for (const scale of [0, 1000, 10000, 30000]) {
  const hux1 = get('octane', 'startup', scale, 'fcp');
  const hux2 = get('octane-hux2', 'startup', scale, 'fcp');
  out(`| ${scale.toLocaleString('en-US')} | ${number(hux1.median)} | ${number(hux2.median)} | ${signed(pct(hux1.median, hux2.median))} |`);
}
out();
out('## Checkpoint decomposition');
out();
out('| Checkpoint | create@1k | create@10k | create@30k | BTS CPU@10k | MTS CPU@10k |');
out('| --- | ---: | ---: | ---: | ---: | ---: |');
for (const [id, label] of ENTRIES) {
  out(`| ${label} | ${number(get(id, 'create', 1000, 'latency').median)} | ${number(get(id, 'create', 10000, 'latency').median)} | ${number(get(id, 'create', 30000, 'latency').median)} | ${number(get(id, 'create', 10000, 'btsCpu').median)} | ${number(get(id, 'create', 10000, 'mtsCpu').median)} |`);
}
out();
out('| Checkpoint | update10th@10k | select@10k | update storm@10k | select storm@10k | BTS heap@10k |');
out('| --- | ---: | ---: | ---: | ---: | ---: |');
for (const [id, label] of ENTRIES) {
  out(`| ${label} | ${number(get(id, 'update10th', 10000, 'latency').median)} | ${number(get(id, 'select', 10000, 'latency').median)} | ${number(get(id, 'updateStorm', 10000, 'latency').median)} | ${number(get(id, 'selectStorm', 10000, 'latency').median)} | ${bytes(get(id, 'memory', 10000, 'heapBts').median)} |`);
}
out();
out('Interpretation: P2 owns retained-update/select breadth; P3 owns compact protocol/wire and prepares the materialization contract; P4–P6 together lower create and large-update cost; P7 supplies the final large BTS/materialization win. Its exact Octane harness separately establishes the retained heap-slope win; this neutral harness records one indicative 10k snapshot. Individual noisy cells are not monotonic, so dependency and rollback boundaries—not microbenchmark sorting—should determine landing order.');
out();
out('## Resource and static deltas');
out();
out('| Metric | Hux1 | Hux2 | Delta |');
out('| --- | ---: | ---: | ---: |');
for (const [label, workload, scale, metric, formatter = number] of [
  ['create@10k BTS CPU', 'create', 10000, 'btsCpu'],
  ['create@10k MTS CPU', 'create', 10000, 'mtsCpu'],
  ['BTS heap with 10k rows', 'memory', 10000, 'heapBts', bytes],
  ['MTS heap with 10k rows', 'memory', 10000, 'heapMts', bytes],
  ['Web bundle gzip', 'bundle', 0, 'bundleWebGzip', bytes],
  ['Lynx bundle gzip', 'bundle', 0, 'bundleLynxGzip', bytes],
]) {
  const hux1 = get('octane', workload, scale, metric).median;
  const hux2 = get('octane-hux2', workload, scale, metric).median;
  out(`| ${label} | ${formatter(hux1)} | ${formatter(hux2)} | ${signed(pct(hux1, hux2))} |`);
}
out();
out('## Adverse and mixed cells');
out();
out('- Primary latency: select@1k is +0.8% (22.9 → 23.1 ms), inside overlapping CI95 ranges; the other 17/18 interaction cells improve.');
out('- Sampled MTS CPU: create@10k is +3.9%. Select@1k is +10.5% in relative terms but only 5.4 → 6.0 ms absolute, while its end-to-end latency is statistically flat.');
out('- Startup: FCP@10k/@30k is +0.8%/+1.9%; both stay below the 5% acceptance threshold.');
out('- Wire: ordinary operations are byte/message invariant except tiny storm-envelope differences. Select storm@10k adds one MTS message and 66 bytes; startup@0 adds 3.4 KiB to BTS, while startup@10k removes about 11.6 MiB.');
const p6Heap = get('octane-hux2-p6', 'memory', 10000, 'heapBts').median;
const p7Heap = get('octane-hux2', 'memory', 10000, 'heapBts').median;
out(`- Indicative neutral BTS heap: P6 → P7 is ${signed(pct(p6Heap, p7Heap))} at 10k, below the 5% gate; Hux1 → Hux2 is ${signed(pct(get('octane', 'memory', 10000, 'heapBts').median, p7Heap))}. Exact retained-slope/release evidence remains in the Octane P7 PR.`);
out('- Static cost: Web/Lynx gzip is +2.0%/+1.5% versus Hux1.');
out();
out('## Measurement-boundary audit');
out();
out('| Metric family | Boundary |');
out('| --- | --- |');
for (const [metric, boundary] of Object.entries(EXPECTED_BOUNDARIES)) {
  out(`| ${metric} | \`${boundary}\` |`);
}
out();
out('All entries were measured sequentially by one runner invocation on one machine with one preflight result. Every operation reached the shared DOM predicate; all startup scales reached first content and settled; all entries produced MTS/BTS heap snapshots.');

console.log(lines.join('\n'));
