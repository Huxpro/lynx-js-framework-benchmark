import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('axis Lab view leads with a plain-language answer and keeps audit detail secondary', () => {
  const source = fs.readFileSync(new URL('./components/AxisEffects.tsx', import.meta.url), 'utf8');
  assert.match(source, /Lab overview · architecture evidence/);
  assert.match(source, /What do these experiments actually prove/);
  assert.match(source, /do not give one axis credit for a combined change/);
  assert.match(source, /only a same-codebase experiment that changes exactly one axis/);
  assert.match(source, /Same coordinates: implementation alone still moves the result/);
  assert.match(source, /Why this verdict/);
  assert.match(source, /no regression or interaction fitting/);
  assert.match(source, /Ceiling axis effects and implementation residue stay separate/);
  assert.match(source, /Instruments observe physical work/);
});

test('Storm observations stay neutral unless the run is DNF', () => {
  const source = fs.readFileSync(new URL('./components/StormCoalescing.tsx', import.meta.url), 'utf8');
  const theme = fs.readFileSync(new URL('./theme.css', import.meta.url), 'utf8');

  assert.match(source, /Coalescing under every-tick is an expected strategy observation, not an error/);
  assert.match(source, /coalesced to \$\{row\.frames\}\/\$\{row\.ticks\} frames/);
  assert.match(source, /data-outcome=\{row\.dnf \? 'dnf' : 'observed'\}/);
  assert.doesNotMatch(source, /contract fail|contract 失败|data-outcome=.*'fail'/);
  assert.match(theme, /tr\[data-outcome='dnf'\] strong \{ color: var\(--bad\)/);
  assert.doesNotMatch(theme, /tr\[data-outcome='(?:observed|fail)'\] strong \{ color: var\(--bad\)/);
});
