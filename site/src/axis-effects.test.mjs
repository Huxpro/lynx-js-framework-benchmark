import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('axis Lab view leads with the current answer and explains why evidence is not attributable', () => {
  const source = fs.readFileSync(new URL('./components/AxisEffects.tsx', import.meta.url), 'utf8');
  assert.match(source, /Not yet. Both first experiments change three coordinates at once/);
  assert.match(source, /These measurements describe that combined change/);
  assert.match(source, /Why this verdict/);
  assert.match(source, /no regression or interaction fitting/);
  assert.match(source, /A hand-written ceiling measures implementation gap only/);
  assert.match(source, /#200 instrument is ready, but no single-axis staging experiment/);
});
