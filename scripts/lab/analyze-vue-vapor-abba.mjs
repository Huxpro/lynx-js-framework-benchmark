#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readAndAnalyzeAbbaManifest } from '../../packages/runner/src/abba-analysis.mjs';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

export function canonicalAnalysisBytes(value) {
  return Buffer.from(`${JSON.stringify(canonical(value), null, 2)}\n`);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--help') {
      args.help = true;
      continue;
    }
    if (argument !== '--manifest' && argument !== '--out') {
      throw new Error(`unknown argument: ${argument}`);
    }
    if (Object.hasOwn(args, argument.slice(2))) {
      throw new Error(`duplicate argument: ${argument}`);
    }
    const value = argv[++index];
    if (!value || value.startsWith('--')) {
      throw new Error(`${argument} requires a value`);
    }
    args[argument.slice(2)] = value;
  }
  return args;
}

function usage() {
  return [
    'usage: node scripts/lab/analyze-vue-vapor-abba.mjs',
    '  --manifest <complete-manifest.json> --out <analysis.json>',
    '',
    'Reads only the explicit hash-pinned manifest and its listed raw files.',
  ].join('\n');
}

export function writeAnalysis({ manifest, out }) {
  const analysis = readAndAnalyzeAbbaManifest(manifest);
  const output = path.resolve(out);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, canonicalAnalysisBytes(analysis), { flag: 'wx' });
  return { analysis, output };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log(usage());
    } else {
      if (!args.manifest || !args.out) throw new Error('--manifest and --out are required');
      const result = writeAnalysis({ manifest: args.manifest, out: args.out });
      console.log(
        `[abba-analysis] ${result.analysis.coverage.actual}/`
        + `${result.analysis.coverage.expected} keys → ${result.output}`,
      );
    }
  } catch (error) {
    console.error(String(error?.stack ?? error));
    console.error(`\n${usage()}`);
    process.exitCode = 1;
  }
}
