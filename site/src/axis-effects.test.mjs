import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('axis Lab view leads with a plain-language answer and keeps audit detail secondary', () => {
  const source = fs.readFileSync(new URL('./components/AxisEffects.tsx', import.meta.url), 'utf8');
  assert.match(source, /What do these experiments actually prove/);
  assert.match(source, /do not give one axis credit for a combined change/);
  assert.match(source, /only a same-codebase experiment that changes exactly one axis/);
  assert.match(source, /Same coordinates: implementation alone still moves the result/);
  assert.match(source, /Why this verdict/);
  assert.match(source, /no regression or interaction fitting/);
  assert.match(source, /Ceiling axis effects and implementation residue stay separate/);
  assert.match(source, /Instruments observe physical work/);
});
