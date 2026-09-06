#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { qualifyRawRuns } from '../packages/runner/src/qualification-runs.mjs';

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
};
const candidate = option('--candidate');
const comparator = option('--comparator');
const consumed = new Set();
for (const name of ['--candidate', '--comparator']) {
  const index = args.indexOf(name);
  if (index !== -1) {
    consumed.add(index);
    consumed.add(index + 1);
  }
}
const files = args.filter((_, index) => !consumed.has(index));
if (files.length === 0) {
  throw new Error(
    'usage: qualify-m0-runs --candidate <id> --comparator <id> <run.json>...',
  );
}
const sources = files.map((file) => {
  const contents = fs.readFileSync(path.resolve(file));
  return {
    file,
    sha256: crypto.createHash('sha256').update(contents).digest('hex'),
    run: JSON.parse(contents),
  };
});
const runs = sources.map(({ run }) => run);
const result = qualifyRawRuns({ runs, candidate, comparator });
process.stdout.write(`${JSON.stringify({
  ...result,
  sourceRuns: sources.map(({ file, sha256 }) => ({ file, sha256 })),
}, null, 2)}\n`);
