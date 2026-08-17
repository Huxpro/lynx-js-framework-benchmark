#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  verifyVueVaporLabEntry,
  verifyVueVaporLabRoot,
} from '../../packages/runner/src/lab-artifacts.mjs';
import {
  assertContainedPath,
  assertLabEntryId,
} from '../../packages/runner/src/path-safety.mjs';

const benchmarkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export { verifyVueVaporLabEntry, verifyVueVaporLabRoot };

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--lab-root' || arg === '--entry') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      args[arg.slice(2).replace('lab-root', 'labRoot')] = value;
    } else if (arg.startsWith('--lab-root=') || arg.startsWith('--entry=')) {
      const equals = arg.indexOf('=');
      const value = arg.slice(equals + 1);
      if (value.length === 0) throw new Error(`${arg.slice(0, equals)} requires a value`);
      const key = arg.slice(2, equals).replace('lab-root', 'labRoot');
      args[key] = value;
    }
    else if (arg === '--help') args.help = true;
    else throw new Error(`unexpected argument: ${arg}`);
  }
  return args;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log(
        'usage: node scripts/lab/verify-vue-vapor-lab.mjs '
        + '[--lab-root .tmp/vue-vapor-lab] [--entry <id>]',
      );
    } else {
      const labRoot = path.resolve(args.labRoot ?? path.join(benchmarkRoot, '.tmp/vue-vapor-lab'));
      assertContainedPath(benchmarkRoot, labRoot, {
        requiredTopLevel: '.tmp',
        label: '--lab-root',
      });
      assertContainedPath(benchmarkRoot, path.join(labRoot, 'entries'), {
        requiredTopLevel: '.tmp',
        label: '--lab-root entries',
      });
      if (args.entry !== undefined) assertLabEntryId(args.entry, '--entry');
      const results = args.entry
        ? [verifyVueVaporLabEntry(path.join(labRoot, 'entries', args.entry))]
        : verifyVueVaporLabRoot(labRoot);
      for (const result of results) {
        console.log(
          `[verify-vue-vapor-lab] ${result.entryId}: ${result.bundleCount} bundles, `
          + `receipt ${result.receiptSha256}`,
        );
      }
    }
  } catch (error) {
    console.error(String(error?.stack ?? error));
    process.exitCode = 1;
  }
}
