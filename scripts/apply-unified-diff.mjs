#!/usr/bin/env node
// Apply the zero-context unified diffs emitted by scripts/vendor-entries.mjs
// to an isolated source checkout. This is intentionally not a general patcher.
import fs from 'node:fs';
import path from 'node:path';

const [checkoutArg, patchArg] = process.argv.slice(2);
if (!checkoutArg || !patchArg) {
  throw new Error('usage: node scripts/apply-unified-diff.mjs <checkout> <patch>');
}
const checkout = path.resolve(checkoutArg);
const patch = fs.readFileSync(path.resolve(patchArg), 'utf8');
const sections = patch.split(/(?=^diff --git )/m).filter(Boolean);

for (const section of sections) {
  const header = /^diff --git a\/(\S+) b\/(\S+)$/m.exec(section);
  if (!header || header[1] !== header[2]) throw new Error('unsupported diff header');
  const file = path.join(checkout, header[1]);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const headerPattern = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@[^\n]*$/gm;
  const headers = [...section.matchAll(headerPattern)];
  let offset = 0;
  for (const [hunkIndex, match] of headers.entries()) {
    const oldStart = Number(match[1]);
    const oldCount = match[2] == null ? 1 : Number(match[2]);
    const bodyStart = match.index + match[0].length + 1;
    const bodyEnd = headers[hunkIndex + 1]?.index ?? section.length;
    const body = section.slice(bodyStart, bodyEnd).split('\n');
    while (body.at(-1) === '' || body.at(-1)?.startsWith('diff --git ')) body.pop();
    if (body.at(-1) === '') body.pop();
    const before = body.filter((line) => line.startsWith('-') || line.startsWith(' '))
      .map((line) => line.slice(1));
    const after = body.filter((line) => line.startsWith('+') || line.startsWith(' '))
      .map((line) => line.slice(1));
    if (before.length !== oldCount) {
      throw new Error(header[1] + ':' + oldStart + ': malformed hunk old count');
    }
    // Unified diff encodes a pure insertion as -N,0 meaning after source line
    // N, while a replacing/deleting hunk starts at source line N.
    const index = oldStart - (oldCount === 0 ? 0 : 1) + offset;
    const actual = lines.slice(index, index + before.length);
    if (JSON.stringify(actual) !== JSON.stringify(before)) {
      throw new Error(header[1] + ':' + oldStart + ': source does not match patch');
    }
    lines.splice(index, before.length, ...after);
    offset += after.length - before.length;
  }
  if (headers.length === 0) throw new Error(header[1] + ': patch contains no hunks');
  fs.writeFileSync(file, lines.join('\n'));
}
