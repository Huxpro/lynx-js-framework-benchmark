#!/usr/bin/env node
import { runWebCorrectnessPreflight } from '../packages/runner/src/correctness-web.mjs';
import { discoverEntries, selectEntriesForHarness } from '../packages/runner/src/entries.mjs';

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
};
const selected = option('--entry')?.split(',').map((value) => value.trim()) ?? null;
const output = option('--output');
const entries = selectEntriesForHarness(discoverEntries({ only: selected }), 'web', {
  explicit: selected != null,
});
const report = await runWebCorrectnessPreflight({ entries, output });
process.stdout.write(`${JSON.stringify({
  pass: report.pass,
  entries: report.entries.map(({ entry }) => entry),
  output,
}, null, 2)}\n`);
