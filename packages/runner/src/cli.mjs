#!/usr/bin/env node
// lynx-bench CLI.
//
//   lynx-bench run [--entry a,b] [--case create,select] [--scale 1000,10000]
//                  [--suite table,startup] [--reps N] [--quick] [--label x]
//                  [--harness web|native]
//   lynx-bench preflight
//   lynx-bench collect
//   lynx-bench list
import fs from 'node:fs';
import path from 'node:path';

import { TABLE_CASES } from '@lynx-bench/shared/workloads';
import { SCHEMA_VERSION } from '@lynx-bench/shared/schema';

import { discoverEntries, repoRoot } from './entries.mjs';
import { runWebHarness } from './harness-web.mjs';
import { runNativeHarness } from './harness-native.mjs';
import { bundleRecords } from './bundles.mjs';
import { collectRuns } from './collect.mjs';
import { machineFingerprint } from './machine.mjs';
import { runPreflight } from './preflight.mjs';
import { launchBrowser } from './browser.mjs';
import { runReceipt } from './provenance.mjs';
import { stringifyResult } from './result-json.mjs';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) args[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) args[a.slice(2)] = argv[++i];
      else args[a.slice(2)] = true;
    } else {
      args._.push(a);
    }
  }
  return args;
}

const list = (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()) : null);
const numList = (v) => list(v)?.map(Number);

async function cmdRun(args) {
  const harness = args.harness ?? 'web';
  if (harness !== 'web' && harness !== 'native') throw new Error(`unknown harness: ${harness}`);

  const entries = discoverEntries({ only: list(args.entry) });
  if (entries.length === 0) throw new Error('no entries matched');
  const caseNames = list(args.case);
  const cases = caseNames
    ? TABLE_CASES.filter((c) => caseNames.includes(c.name))
    : TABLE_CASES;
  const suites = list(args.suite) ?? ['table', 'startup'];

  if (harness === 'native') {
    const reps = args.reps ? Number(args.reps) : 5;
    const startupReps = args['startup-reps'] ? Number(args['startup-reps']) : 3;
    const scales = numList(args.scale) ?? [1000, 10000];
    const startupScales = numList(args['startup-scale']) ?? [0, 1000, 10000, 30000];
    const receipt = runReceipt({
      entries,
      reps,
      stormReps: reps,
      startupReps,
      execution: {
        harness: 'native',
        adapter: args.adapter ? path.resolve(args.adapter) : null,
      },
    });
    console.log(`[run:native] entries: ${entries.map((e) => e.id).join(', ')}`);
    const now = new Date();
    const label = args.label ? `-${args.label}` : '';
    let outPath = null;
    const persist = ({ records, machine: adapterMachine }) => {
      const machine = adapterMachine ?? machineFingerprint();
      if (outPath === null) {
        const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
        outPath = path.join(repoRoot(), 'results/runs', `${stamp}-${machine.id}-native${label}.json`);
      }
      const run = {
        schemaVersion: SCHEMA_VERSION,
        meta: {
          generatedAt: now.toISOString(),
          machine,
          calibration: null,
          harness: 'native',
          adapter: path.resolve(args.adapter),
          argv: process.argv.slice(2),
          checkpoint: true,
          entryCommits: Object.fromEntries(
            entries.map((e) => [e.id, e.provenance?.commit ?? null]),
          ),
          receipt,
        },
        records,
      };
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      const temporary = `${outPath}.tmp`;
      fs.writeFileSync(temporary, stringifyResult(run));
      fs.renameSync(temporary, outPath);
    };
    const native = await runNativeHarness({
      adapterPath: args.adapter,
      entries, cases, suites, scales, startupScales, reps, startupReps,
      log: (line) => console.log(line),
      onProgress: persist,
    });
    const records = native.records;
    persist({ records, machine: native.machine });
    console.log(`[run:native] ${records.length} records → ${path.relative(repoRoot(), outPath)}`);
    if (!args['no-collect']) collectRuns();
    return;
  }
  const quick = Boolean(args.quick);
  const scales = numList(args.scale)
    ?? (quick ? [1000] : [1000, 10000]);
  const reps = args.reps ? Number(args.reps) : quick ? 3 : 7;
  const stormReps = args['storm-reps'] ? Number(args['storm-reps']) : quick ? 1 : 3;
  const startupReps = args['startup-reps'] ? Number(args['startup-reps']) : quick ? 2 : 5;

  console.log(`[run] entries: ${entries.map((e) => e.id).join(', ')}`);
  console.log(`[run] suites: ${suites.join(', ')}; cases: ${cases.map((c) => c.name).join(', ')}; scales: ${scales.join(', ')}; reps=${reps}`);

  // Preflight in the same browser configuration that will measure.
  const preflight = await (async () => {
    const { browser, executablePath, browserVersion } = await launchBrowser();
    try {
      return {
        probe: await runPreflight(browser),
        browser: { name: 'chromium', version: browserVersion, executablePath },
      };
    } finally {
      await browser.close();
    }
  })();
  const { probe } = preflight;
  console.log(`[preflight] score=${probe.score} (probe v${probe.probeVersion})`);
  const receipt = runReceipt({
    entries, reps, stormReps, startupReps,
    execution: { harness: 'web', browser: preflight.browser },
  });

  const { records, executablePath, browserVersion } = await runWebHarness({
    entries, cases, suites, scales, reps, stormReps, startupReps,
  });
  if (browserVersion !== preflight.browser.version
    || executablePath !== preflight.browser.executablePath) {
    throw new Error('browser identity changed between preflight and benchmark execution');
  }
  for (const entry of entries) records.push(...bundleRecords(entry));

  const machine = machineFingerprint();
  const now = new Date();
  const label = args.label ? `-${args.label}` : '';
  const run = {
    schemaVersion: SCHEMA_VERSION,
    meta: {
      generatedAt: now.toISOString(),
      machine,
      calibration: probe,
      chromium: executablePath,
      browser: { name: 'chromium', version: browserVersion, executablePath },
      argv: process.argv.slice(2),
      entryCommits: Object.fromEntries(
        entries.map((e) => [e.id, e.provenance?.commit ?? null]),
      ),
      receipt,
    },
    records,
  };
  const root = repoRoot();
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = path.join(root, 'results/runs', `${stamp}-${machine.id}${label}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, stringifyResult(run));
  console.log(`[run] ${records.length} records → ${path.relative(root, outPath)}`);
  // The run file is the source; latest.json is only a materialized view. Keep
  // it synchronized immediately so no consumer can observe the previous run's
  // derived cohort/statistics between `run` and a later build.
  collectRuns();
}

async function cmdPreflight() {
  const { browser } = await launchBrowser();
  try {
    const probe = await runPreflight(browser);
    const machine = machineFingerprint();
    console.log(JSON.stringify({ machine, calibration: probe }, null, 2));
  } finally {
    await browser.close();
  }
}

function cmdList() {
  const entries = discoverEntries();
  for (const e of entries) {
    const scales = fs.existsSync(e.distDir)
      ? fs.readdirSync(e.distDir).filter((d) => d.startsWith('rows-')).map((d) => d.slice(5)).join(',')
      : 'no dist';
    console.log(`${e.id.padEnd(18)} ${e.label.padEnd(28)} [${e.tags?.join(',') ?? ''}] rows: ${scales}`);
  }
  console.log('\ncases: ' + TABLE_CASES.map((c) => c.name).join(', ') + ', startup');
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0] ?? 'run';
try {
  if (cmd === 'run') await cmdRun(args);
  else if (cmd === 'preflight') await cmdPreflight();
  else if (cmd === 'collect') collectRuns();
  else if (cmd === 'list') cmdList();
  else {
    console.error(`unknown command: ${cmd}`);
    process.exit(2);
  }
} catch (e) {
  console.error(String(e?.stack ?? e));
  process.exit(1);
}
