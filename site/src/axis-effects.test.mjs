import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('axis Lab view leads with an interactive six-axis matrix and keeps audit detail secondary', () => {
  const source = fs.readFileSync(new URL('./components/AxisEffects.tsx', import.meta.url), 'utf8');
  assert.match(source, /Six-axis experiment ledger/);
  assert.match(source, /Six coordinates, six questions/);
  assert.match(source, /What change makes old output stale/);
  assert.match(source, /How much work is recomputed/);
  assert.match(source, /Which work or results can be shared/);
  assert.match(source, /In what form is the work executed/);
  assert.match(source, /Which thread performs the work/);
  assert.match(source, /What crosses the thread boundary/);
  assert.match(source, /className="axis-matrix"/);
  assert.match(source, /setRequestedId\(comparison\.id\)/);
  assert.match(source, /Architecture comparisons/);
  assert.match(source, /Same-coordinate controls/);
  assert.match(source, /Observed movement/);
  assert.match(source, /Coordinate delta/);
  assert.match(source, /Axis instruments/);
  assert.match(source, /Single-axis attribution requires the same codebase/);
  assert.doesNotMatch(source, /\bINV\b|\bREC\b|\bSHR\b|\bSTG\b|\bRES\b|\bHND\b/);
  assert.doesNotMatch(source, /axis-card-grid|axis-story-lede|single-axis causal effects/);
});

test('Storm observations stay neutral unless the run is DNF', () => {
  const source = fs.readFileSync(new URL('./components/StormCoalescing.tsx', import.meta.url), 'utf8');
  const theme = fs.readFileSync(new URL('./theme.css', import.meta.url), 'utf8');

  assert.match(source, /Coalescing is neutral; only DNF is an error/);
  assert.match(source, /coalesced to \$\{row\.frames\}\/\$\{row\.ticks\} frames/);
  assert.match(source, /data-outcome=\{row\.dnf \? 'dnf' : 'observed'\}/);
  assert.doesNotMatch(source, /contract fail|contract 失败|data-outcome=.*'fail'/);
  assert.match(theme, /tr\[data-outcome='dnf'\] strong \{ color: var\(--bad\)/);
  assert.doesNotMatch(theme, /tr\[data-outcome='(?:observed|fail)'\] strong \{ color: var\(--bad\)/);
});
