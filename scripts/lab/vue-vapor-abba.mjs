#!/usr/bin/env node
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  verifyPinnedVueVaporLabEntry,
  verifyVueVaporLabEntry,
  verifyVueVaporLabBenchmarkState,
} from '../../packages/runner/src/lab-artifacts.mjs';
import {
  assertContainedPath,
  assertLabEntryId,
  assertRegularFile,
} from '../../packages/runner/src/path-safety.mjs';
import { validateFormalRun } from '../../packages/runner/src/run-files.mjs';

const benchmarkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runner = path.join(benchmarkRoot, 'packages/runner/src/cli.mjs');
const FORBIDDEN_RUN_ARGS = new Set([
  '--entry',
  '--lab-root',
  '--label',
  '--harness',
  '--campaign-id',
  '--comparison-id',
  '--phase',
  '--leg',
  '--sequence-index',
]);
const LEGS = ['A1', 'B1', 'B2', 'A2'];
const LEG_INDEX = { A1: 0, B1: 1, B2: 2, A2: 3 };

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function writeAtomic(file, value) {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  fs.renameSync(temporary, file);
}

function readJson(file, label) {
  assertRegularFile(file, label);
  return JSON.parse(fs.readFileSync(file));
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./,:=@+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function assertExtraArgs(args) {
  for (const arg of args) {
    const name = arg.split('=', 1)[0];
    if (FORBIDDEN_RUN_ARGS.has(name)) {
      throw new Error(`${name} is controlled by the ABBA helper`);
    }
  }
}

export function createAbbaPlan({
  a,
  b,
  labRoot,
  runArgs = [],
  labelPrefix = 'vue-vapor-abba',
  comparisonId = labelPrefix,
  campaignId = `${labelPrefix}-campaign`,
  phase,
  sequenceId = `${comparisonId}-${phase}`,
} = {}) {
  assertLabEntryId(a, '--a');
  assertLabEntryId(b, '--b');
  if (a === b) throw new Error('--a and --b must be distinct experiment entry IDs');
  if (!labRoot) throw new Error('--lab-root is required');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(labelPrefix)) {
    throw new Error('--label-prefix must contain only lowercase letters, digits, and hyphens');
  }
  assertExtraArgs(runArgs);
  if (!['table', 'startup', 'heap'].includes(phase)) {
    throw new Error('phase must be table, startup, or heap');
  }
  const resolvedLabRoot = path.resolve(labRoot);
  assertContainedPath(benchmarkRoot, resolvedLabRoot, {
    requiredTopLevel: '.tmp',
    label: '--lab-root',
  });
  for (const child of ['entries', 'results']) {
    assertContainedPath(benchmarkRoot, path.join(resolvedLabRoot, child), {
      requiredTopLevel: '.tmp',
      label: `--lab-root ${child}`,
    });
  }
  const sequence = [
    { arm: 'A', ordinal: 1, entry: a },
    { arm: 'B', ordinal: 1, entry: b },
    { arm: 'B', ordinal: 2, entry: b },
    { arm: 'A', ordinal: 2, entry: a },
  ];
  return sequence.map(({ arm, ordinal, entry }) => {
    const leg = `${arm}${ordinal}`;
    const runLabel = `${labelPrefix}-${leg.toLowerCase()}`;
    return {
    arm,
    ordinal,
    leg,
    sequenceIndex: LEG_INDEX[leg],
    entry,
    runLabel,
    campaignId: `${campaignId}-${leg.toLowerCase()}`,
    comparisonId,
    sequenceId,
    phase,
    argv: [
      runner,
      'run',
      '--lab-root',
      resolvedLabRoot,
      '--entry',
      entry,
      '--harness',
      'web',
      '--label',
      runLabel,
      '--campaign-id',
      `${campaignId}-${leg.toLowerCase()}`,
      '--comparison-id',
      comparisonId,
      '--phase',
      phase,
      '--leg',
      leg,
      '--sequence-index',
      String(LEG_INDEX[leg]),
      '--no-collect',
      ...runArgs,
    ],
    };
  });
}

export function findRawFile(labRoot, step) {
  const runsDir = path.join(labRoot, 'results/runs');
  const matches = [];
  for (const name of fs.readdirSync(runsDir)) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(runsDir, name);
    let run;
    try {
      run = readJson(file, 'raw run');
    } catch {
      continue;
    }
    if (run.meta?.campaign?.id === step.campaignId
      && run.meta.campaign.leg === step.leg
      && run.meta.runLabel === step.runLabel) {
      validateFormalRun(run, `${step.leg} raw run`);
      matches.push({ file, run });
    }
  }
  if (matches.length !== 1) {
    throw new Error(
      `${step.leg} requires exactly one raw campaign match; found ${matches.length}`,
    );
  }
  return matches[0];
}

function manifestPlan(plan, verified) {
  const variants = new Set(plan.map((step) =>
    verified.get(step.entry)?.receipt?.variant));
  if (variants.size !== 1 || !['vapor', 'ifr'].includes([...variants][0])) {
    throw new Error('A and B receipts must have one matching Vapor variant');
  }
  return {
    schemaVersion: 1,
    comparisonId: plan[0].comparisonId,
    id: plan[0].sequenceId,
    variant: [...variants][0],
    harness: 'web',
    phase: plan[0].phase,
    legs: Object.fromEntries(plan.map((step) => [step.leg, {
      entry: step.entry,
      campaignId: step.campaignId,
      runLabel: step.runLabel,
      sequenceIndex: step.sequenceIndex,
      argv: step.argv,
    }])),
  };
}

function validateRecordedLeg(labRoot, step, recorded) {
  const file = path.resolve(labRoot, recorded.path);
  assertContainedPath(labRoot, file, { label: `${step.leg} raw file` });
  assertRegularFile(file, `${step.leg} raw file`);
  const bytes = fs.readFileSync(file);
  if (sha256(bytes) !== recorded.sha256) {
    throw new Error(`${step.leg} recorded raw hash mismatch`);
  }
  const run = JSON.parse(bytes);
  validateFormalRun(run, `${step.leg} resumed raw run`);
  if (run.meta.campaign.id !== step.campaignId
    || run.meta.campaign.leg !== step.leg
    || run.meta.runLabel !== step.runLabel) {
    throw new Error(`${step.leg} resumed raw metadata mismatch`);
  }
}

export function executeAbbaPlan({
  plan,
  labRoot,
  pinned,
  verified = null,
  manifestPath = path.join(labRoot, 'manifests', `${plan[0].comparisonId}-${plan[0].phase}.json`),
  resume = false,
  spawn = spawnSync,
  verifyEntry = verifyPinnedVueVaporLabEntry,
  verifyBenchmark = () => {},
  findRaw = findRawFile,
  log = console.log,
}) {
  const currentVerified = verified ?? new Map([...pinned].map(([entry]) => [
    entry,
    verifyEntry(path.join(labRoot, 'entries', entry), pinned.get(entry)),
  ]));
  const planSnapshot = manifestPlan(plan, currentVerified);
  let manifest;
  if (resume) {
    manifest = readJson(manifestPath, 'incomplete ABBA manifest');
    if (manifest.status !== 'incomplete') {
      throw new Error('resume requires an incomplete manifest');
    }
    if (JSON.stringify(manifest.plan) !== JSON.stringify(planSnapshot)) {
      throw new Error('resume plan does not match the incomplete manifest');
    }
    let missingSeen = false;
    for (const leg of LEGS) {
      if (!manifest.legs[leg]) missingSeen = true;
      else if (missingSeen) {
        throw new Error('resume manifest legs must form a contiguous completed prefix');
      }
    }
  } else {
    if (fs.existsSync(manifestPath)) throw new Error(`manifest already exists: ${manifestPath}`);
    manifest = {
      schemaVersion: 1,
      status: 'incomplete',
      comparisonId: planSnapshot.comparisonId,
      plan: planSnapshot,
      legs: {},
    };
    writeAtomic(manifestPath, manifest);
  }
  for (const step of plan) {
    const entryDir = path.join(labRoot, 'entries', step.entry);
    const fingerprint = pinned.get(step.entry);
    verifyEntry(entryDir, fingerprint);
    verifyBenchmark();
    if (manifest.legs[step.leg]) {
      validateRecordedLeg(labRoot, step, manifest.legs[step.leg]);
      verifyEntry(entryDir, fingerprint);
      verifyBenchmark();
      log(`[abba] resume skip ${step.leg}`);
      continue;
    }
    log(`[abba] execute ${step.arm}${step.ordinal}: ${step.entry}`);
    const result = spawn(process.execPath, step.argv, {
      cwd: benchmarkRoot,
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`${step.arm}${step.ordinal} exited with status ${result.status}`);
    }
    verifyEntry(entryDir, fingerprint);
    verifyBenchmark();
    const { file, run } = findRaw(labRoot, step);
    const bytes = fs.readFileSync(file);
    manifest.legs[step.leg] = {
      path: path.relative(labRoot, file).split(path.sep).join('/'),
      sha256: sha256(bytes),
      runLabel: run.meta.runLabel,
      campaignId: step.campaignId,
    };
    writeAtomic(manifestPath, manifest);
  }
  manifest.status = 'complete';
  manifest.sequences = [{
    id: planSnapshot.id,
    variant: planSnapshot.variant,
    harness: 'web',
    phase: planSnapshot.phase,
    legs: Object.fromEntries(LEGS.map((leg) => [leg, manifest.legs[leg]])),
  }];
  writeAtomic(manifestPath, manifest);
  return { manifest, manifestPath };
}

function parseArgs(argv) {
  const separator = argv.indexOf('--');
  const options = separator < 0 ? argv : argv.slice(0, separator);
  const runArgs = separator < 0 ? [] : argv.slice(separator + 1);
  const args = { runArgs };
  const valued = new Set([
    'a', 'b', 'lab-root', 'label-prefix', 'comparison-id', 'campaign-id',
    'phase', 'manifest', 'sequence-id',
  ]);
  for (let index = 0; index < options.length; index++) {
    const arg = options[index];
    if (arg === '--execute') args.execute = true;
    else if (arg === '--resume') args.resume = true;
    else if (arg === '--help') args.help = true;
    else if (arg.startsWith('--') && arg.includes('=')) {
      const equals = arg.indexOf('=');
      const key = arg.slice(2, equals);
      if (!valued.has(key)) throw new Error(`unknown argument: --${key}`);
      const value = arg.slice(equals + 1);
      if (value.length === 0) throw new Error(`--${key} requires a value`);
      args[key] = value;
    } else if (arg.startsWith('--') && options[index + 1] && !options[index + 1].startsWith('--')) {
      const key = arg.slice(2);
      if (!valued.has(key)) throw new Error(`unknown argument: --${key}`);
      args[key] = options[++index];
    } else {
      throw new Error(`${arg} requires a value`);
    }
  }
  return args;
}

function usage() {
  return [
    'usage: node scripts/lab/vue-vapor-abba.mjs',
    '  --a <entry-id> --b <entry-id> [--lab-root .tmp/vue-vapor-lab]',
    '  --phase table|startup|heap',
    '  [--label-prefix vue-vapor-abba] [--comparison-id <id>]',
    '  [--campaign-id <id>] [--manifest <path>] [--execute|--resume]',
    '  [-- <lynx-bench run arguments>]',
    '',
    'Default: verify both entries and print four single-entry A/B/B/A commands.',
    'Execution writes only below --lab-root and does not compute a statistical conclusion.',
  ].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log(usage());
    } else {
      const labRoot = path.resolve(args['lab-root'] ?? path.join(benchmarkRoot, '.tmp/vue-vapor-lab'));
      assertContainedPath(benchmarkRoot, labRoot, {
        requiredTopLevel: '.tmp',
        label: '--lab-root',
      });
      assertLabEntryId(args.a, '--a');
      assertLabEntryId(args.b, '--b');
      const pinned = new Map();
      const verified = new Map();
      for (const entry of [args.a, args.b]) {
        const result = verifyVueVaporLabEntry(path.join(labRoot, 'entries', entry));
        pinned.set(entry, result.fingerprint);
        verified.set(entry, result);
        console.log(
          `[abba] verified ${result.entryId} @ ${result.sourceHead} `
          + `(receipt ${result.receiptSha256})`,
        );
      }
      const plan = createAbbaPlan({
        a: args.a,
        b: args.b,
        labRoot,
        labelPrefix: args['label-prefix'] ?? 'vue-vapor-abba',
        comparisonId: args['comparison-id'] ?? args['label-prefix'] ?? 'vue-vapor-abba',
        campaignId: args['campaign-id'] ?? args['label-prefix'] ?? 'vue-vapor-abba',
        phase: args.phase,
        sequenceId: args['sequence-id']
          ?? `${args['comparison-id'] ?? args['label-prefix'] ?? 'vue-vapor-abba'}-${args.phase}`,
        runArgs: args.runArgs,
      });
      for (const [index, step] of plan.entries()) {
        console.log(
          `${index + 1}. ${step.arm}${step.ordinal}: `
          + [process.execPath, ...step.argv].map(shellQuote).join(' '),
        );
      }
      if (args.execute || args.resume) {
        const benchmarkState = verifyVueVaporLabBenchmarkState(
          benchmarkRoot,
          [...verified.values()],
        );
        executeAbbaPlan({
          plan,
          labRoot,
          pinned,
          verified,
          verifyBenchmark: () => verifyVueVaporLabBenchmarkState(
            benchmarkRoot,
            [...verified.values()],
            benchmarkState,
          ),
          resume: Boolean(args.resume),
          ...(args.manifest ? { manifestPath: path.resolve(args.manifest) } : {}),
        });
        console.log('[abba] sequence complete; no statistical conclusion was computed');
      } else {
        console.log('[abba] plan only; pass --execute to run it');
      }
    }
  } catch (error) {
    console.error(String(error?.stack ?? error));
    console.error(`\n${usage()}`);
    process.exitCode = 1;
  }
}
