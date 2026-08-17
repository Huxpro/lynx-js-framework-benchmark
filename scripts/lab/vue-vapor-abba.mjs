#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  verifyPinnedVueVaporLabEntry,
  verifyVueVaporLabEntry,
} from '../../packages/runner/src/lab-artifacts.mjs';
import {
  assertContainedPath,
  assertLabEntryId,
} from '../../packages/runner/src/path-safety.mjs';

const benchmarkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runner = path.join(benchmarkRoot, 'packages/runner/src/cli.mjs');
const FORBIDDEN_RUN_ARGS = new Set(['--entry', '--lab-root', '--label', '--harness']);

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
} = {}) {
  assertLabEntryId(a, '--a');
  assertLabEntryId(b, '--b');
  if (a === b) throw new Error('--a and --b must be distinct experiment entry IDs');
  if (!labRoot) throw new Error('--lab-root is required');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(labelPrefix)) {
    throw new Error('--label-prefix must contain only lowercase letters, digits, and hyphens');
  }
  assertExtraArgs(runArgs);
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
  return sequence.map(({ arm, ordinal, entry }) => ({
    arm,
    ordinal,
    entry,
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
      `${labelPrefix}-${arm.toLowerCase()}${ordinal}`,
      ...runArgs,
    ],
  }));
}

export function executeAbbaPlan({
  plan,
  labRoot,
  pinned,
  spawn = spawnSync,
  verifyEntry = verifyPinnedVueVaporLabEntry,
  log = console.log,
}) {
  for (const step of plan) {
    const entryDir = path.join(labRoot, 'entries', step.entry);
    const fingerprint = pinned.get(step.entry);
    verifyEntry(entryDir, fingerprint);
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
  }
}

function parseArgs(argv) {
  const separator = argv.indexOf('--');
  const options = separator < 0 ? argv : argv.slice(0, separator);
  const runArgs = separator < 0 ? [] : argv.slice(separator + 1);
  const args = { runArgs };
  const valued = new Set(['a', 'b', 'lab-root', 'label-prefix']);
  for (let index = 0; index < options.length; index++) {
    const arg = options[index];
    if (arg === '--execute') args.execute = true;
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
    '  [--label-prefix vue-vapor-abba] [--execute]',
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
      for (const entry of [args.a, args.b]) {
        const result = verifyVueVaporLabEntry(path.join(labRoot, 'entries', entry));
        pinned.set(entry, result.fingerprint);
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
        runArgs: args.runArgs,
      });
      for (const [index, step] of plan.entries()) {
        console.log(
          `${index + 1}. ${step.arm}${step.ordinal}: `
          + [process.execPath, ...step.argv].map(shellQuote).join(' '),
        );
      }
      if (args.execute) {
        executeAbbaPlan({ plan, labRoot, pinned });
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
