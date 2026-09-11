#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { qualifyRawSuiteRuns } from '../packages/runner/src/qualification-runs.mjs';

const args = process.argv.slice(2);
const options = {
  candidate: null,
  comparator: null,
  output: null,
  interaction: [],
  startup: [],
};
for (let index = 0; index < args.length; index += 2) {
  const name = args[index];
  const value = args[index + 1];
  if (value == null || value.startsWith('--')) {
    throw new Error(`${name} requires a value.`);
  }
  if (name === '--candidate') options.candidate = value;
  else if (name === '--comparator') options.comparator = value;
  else if (name === '--output') options.output = value;
  else if (name === '--interaction-run') options.interaction.push(value);
  else if (name === '--startup-run') options.startup.push(value);
  else throw new Error(`unknown option: ${name}`);
}
const { candidate, comparator, output } = options;
const filesBySuite = {
  interaction: options.interaction,
  startup: options.startup,
};

if (candidate == null || comparator == null
  || Object.values(filesBySuite).some((files) => files.length === 0)) {
  throw new Error(
    'usage: qualify-m4-runs --candidate <id> --comparator <id> '
      + '--interaction-run <run.json>... --startup-run <run.json>...',
  );
}

const sourcesBySuite = Object.fromEntries(Object.entries(filesBySuite).map(
  ([suite, files]) => [suite, files.map((file) => {
    const contents = fs.readFileSync(path.resolve(file));
    return {
      file,
      sha256: crypto.createHash('sha256').update(contents).digest('hex'),
      run: JSON.parse(contents),
    };
  })],
));
const result = qualifyRawSuiteRuns({
  runsBySuite: Object.fromEntries(Object.entries(sourcesBySuite).map(
    ([suite, sources]) => [suite, sources.map(({ run }) => run)],
  )),
  candidate,
  comparator,
});

const serialized = `${JSON.stringify({
  ...result,
  sourceRuns: Object.fromEntries(Object.entries(sourcesBySuite).map(
    ([suite, sources]) => [
      suite,
      sources.map(({ file, sha256 }) => ({ file, sha256 })),
    ],
  )),
}, null, 2)}\n`;
if (output == null) {
  process.stdout.write(serialized);
} else {
  const outputPath = path.resolve(output);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, serialized);
  process.stderr.write(`[qualify] wrote ${outputPath}\n`);
}
