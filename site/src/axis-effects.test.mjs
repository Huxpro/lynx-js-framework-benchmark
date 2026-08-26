import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('axis Lab view states the causal boundary and separates ceiling residue', () => {
  const source = fs.readFileSync(new URL('./components/AxisEffects.tsx', import.meta.url), 'utf8');
  assert.match(source, /Cross-framework points describe the space but never identify an axis effect/);
  assert.match(source, /no regression or interaction fitting/);
  assert.match(source, /implementation residue/);
  assert.match(source, /entry − its own hand-written ceiling/);
  assert.match(source, /waiting for #200 source records/);
});
