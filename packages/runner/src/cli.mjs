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
import {
  verifyPinnedVueVaporLabEntry,
  verifyVueVaporLabBenchmarkState,
  verifyVueVaporLabRoot,
} from './lab-artifacts.mjs';
import {
  assertContainedPath,
  assertLabEntryId,
  assertRunLabel,
} from './path-safety.mjs';
import { writeRunFile } from './run-files.mjs';

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

const LAB_ARGS = {
  run: new Set([
    'lab-root', 'entry', 'case', 'scale', 'suite', 'reps', 'quick', 'label',
    'harness', 'storm-reps', 'startup-reps', 'no-collect',
  ]),
  collect: new Set(['lab-root']),
  list: new Set(['lab-root']),
};

function validateLabArgs(args, cmd) {
  if (!Object.hasOwn(args, 'lab-root')) return;
  if (typeof args['lab-root'] !== 'string' || args['lab-root'].length === 0) {
    throw new Error('--lab-root requires a non-empty path');
  }
  const allowed = LAB_ARGS[cmd];
  if (!allowed) throw new Error(`--lab-root is not supported by ${cmd}`);
  for (const key of Object.keys(args)) {
    if (key !== '_' && !allowed.has(key)) throw new Error(`unknown ${cmd} lab argument: --${key}`);
  }
  if (args._.length !== 1) throw new Error(`unexpected ${cmd} lab positional arguments`);
  if (cmd === 'run') {
    if (typeof args.entry !== 'string' || args.entry.length === 0) {
      throw new Error('lab run requires --entry <id[,id]>');
    }
    for (const id of list(args.entry)) assertLabEntryId(id, '--entry');
    for (const key of ['case', 'scale', 'suite', 'reps', 'label', 'harness', 'storm-reps', 'startup-reps']) {
      if (Object.hasOwn(args, key) && typeof args[key] !== 'string') {
        throw new Error(`--${key} requires a value`);
      }
    }
  }
}

function labRoot(args, cmd) {
  validateLabArgs(args, cmd);
  if (!args['lab-root']) return null;
  const root = repoRoot();
  const resolved = path.resolve(args['lab-root']);
  assertContainedPath(root, resolved, { requiredTopLevel: '.tmp', label: '--lab-root' });
  for (const child of ['entries', 'results']) {
    assertContainedPath(root, path.join(resolved, child), {
      requiredTopLevel: '.tmp',
      label: `--lab-root ${child}`,
    });
  }
  return resolved;
}

async function cmdRun(args) {
  assertRunLabel(args.label);
  const harness = args.harness ?? 'web';
  if (harness !== 'web' && harness !== 'native') throw new Error(`unknown harness: ${harness}`);

  const isolatedRoot = labRoot(args, 'run');
  const verifiedLabEntries = isolatedRoot
    ? new Map(verifyVueVaporLabRoot(isolatedRoot).map((result) => [result.entryId, result]))
    : null;
  const entries = discoverEntries({ only: list(args.entry), ...(isolatedRoot ? { root: isolatedRoot } : {}) });
  if (entries.length === 0) throw new Error('no entries matched');
  if (verifiedLabEntries) {
    for (const entry of entries) {
      if (!verifiedLabEntries.has(entry.id)) throw new Error(`unverified lab entry: ${entry.id}`);
    }
  }
  const verifiedLabBenchmark = verifiedLabEntries
    ? verifyVueVaporLabBenchmarkState(
      repoRoot(),
      entries.map((entry) => verifiedLabEntries.get(entry.id)),
    )
    : null;
  const caseNames = list(args.case);
  const cases = caseNames
    ? TABLE_CASES.filter((c) => caseNames.includes(c.name))
    : TABLE_CASES;
  const suites = list(args.suite) ?? ['table', 'startup'];

  if (harness === 'native') {
    if (isolatedRoot) throw new Error('--lab-root currently supports only the web harness');
    const reps = args.reps ? Number(args.reps) : 5;
    const startupReps = args['startup-reps'] ? Number(args['startup-reps']) : 3;
    const scales = numList(args.scale) ?? [1000, 10000];
    console.log(`[run:native] entries: ${entries.map((e) => e.id).join(', ')}`);
    const native = await runNativeHarness({
      adapterPath: args.adapter,
      entries, cases, suites, scales, reps, startupReps,
      log: (line) => console.log(line),
    });
    const records = native.records;
    const machine = native.machine ?? machineFingerprint();
    const now = new Date();
    const run = {
      schemaVersion: SCHEMA_VERSION,
      meta: {
        generatedAt: now.toISOString(),
        machine,
        calibration: null,
        harness: 'native',
        adapter: path.resolve(args.adapter),
        argv: process.argv.slice(2),
        entryCommits: Object.fromEntries(
          entries.map((e) => [e.id, e.provenance?.commit ?? null]),
        ),
      },
      records,
    };
    const root = repoRoot();
    const outPath = writeRunFile({
      root,
      run,
      machineId: machine.id,
      label: args.label ?? null,
      native: true,
    });
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
  const probe = await (async () => {
    const { browser } = await launchBrowser();
    try {
      return await runPreflight(browser);
    } finally {
      await browser.close();
    }
  })();
  console.log(`[preflight] score=${probe.score} (probe v${probe.probeVersion})`);

  const { records, executablePath } = await runWebHarness({
    entries, cases, suites, scales,
    ...(isolatedRoot ? { startupScales: scales } : {}),
    reps, stormReps, startupReps,
  });
  for (const entry of entries) records.push(...bundleRecords(entry));
  if (verifiedLabEntries) {
    for (const entry of entries) {
      const pinned = verifiedLabEntries.get(entry.id);
      verifyPinnedVueVaporLabEntry(entry.dir, pinned.fingerprint);
    }
    verifyVueVaporLabBenchmarkState(
      repoRoot(),
      entries.map((entry) => verifiedLabEntries.get(entry.id)),
      verifiedLabBenchmark,
    );
  }

  const machine = machineFingerprint();
  const now = new Date();
  const run = {
    schemaVersion: SCHEMA_VERSION,
    meta: {
      generatedAt: now.toISOString(),
      machine,
      calibration: probe,
      chromium: executablePath,
      argv: process.argv.slice(2),
      entryCommits: Object.fromEntries(
        entries.map((e) => [e.id, e.provenance?.commit ?? null]),
      ),
      ...(verifiedLabEntries ? {
        benchmarkWorktree: {
          head: verifiedLabBenchmark.head,
          patchSha256: verifiedLabBenchmark.patchSha256,
        },
        entryArtifacts: Object.fromEntries(entries.map((entry) => {
          const verified = verifiedLabEntries.get(entry.id);
          return [entry.id, {
            fingerprint: verified.fingerprint,
            ...verified.cohort,
          }];
        })),
      } : {}),
    },
    records,
  };
  const root = isolatedRoot ?? repoRoot();
  const outPath = writeRunFile({
    root,
    run,
    machineId: machine.id,
    label: args.label ?? null,
  });
  console.log(`[run] ${records.length} records → ${path.relative(root, outPath)}`);
  // The run file is the source; latest.json is only a materialized view. Keep
  // it synchronized immediately so no consumer can observe the previous run's
  // derived cohort/statistics between `run` and a later build.
  collectRuns({
    root,
    ...(isolatedRoot ? { labMode: true } : {}),
  });
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
  const isolatedRoot = labRoot(args, 'list');
  if (isolatedRoot) verifyVueVaporLabRoot(isolatedRoot);
  const entries = discoverEntries(isolatedRoot ? { root: isolatedRoot } : {});
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
  else if (cmd === 'collect') {
    const isolatedRoot = labRoot(args, 'collect');
    collectRuns({
      ...(isolatedRoot ? { root: isolatedRoot, labMode: true } : {}),
    });
  }
  else if (cmd === 'list') cmdList();
  else {
    console.error(`unknown command: ${cmd}`);
    process.exit(2);
  }
} catch (e) {
  console.error(String(e?.stack ?? e));
  process.exit(1);
}
