import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');

test('rank over time is the final content section', () => {
  const history = source.indexOf('<HistoryRanking');
  const pageContentEnd = source.lastIndexOf("      )}\n", history);
  const historyEnd = source.indexOf('/>', history);
  const footer = source.indexOf('<footer', history);

  assert.notEqual(history, -1);
  assert.ok(pageContentEnd < history, 'history ranking must follow the selected page content');
  assert.ok(historyEnd < footer, 'history ranking must remain before the footer');
  assert.equal(source.slice(historyEnd + 2, footer).trim(), '');
});

test('Native overview leads with the at-a-glance table and ends with coverage appendix', () => {
  const overview = source.slice(
    source.indexOf("page === 'overview'"),
    source.indexOf("page === 'scale'"),
  );
  const glance = overview.indexOf('<HeatGrid');
  const coverage = overview.indexOf('<NativeCoverage');

  assert.notEqual(glance, -1);
  assert.notEqual(coverage, -1);
  assert.ok(glance < coverage, 'at-a-glance table must precede the Native coverage appendix');
});

test('Native empty snapshots lead with at-a-glance and end with the coverage appendix', () => {
  const emptyState = source.slice(
    source.indexOf("harness === 'native' && !nativeHasData"),
    source.indexOf(") : page === 'overview'"),
  );
  const glance = emptyState.indexOf('<HeatGrid');
  const observations = emptyState.indexOf('<NativeObservations');
  const coverage = emptyState.indexOf('<NativeCoverage');

  assert.notEqual(glance, -1);
  assert.notEqual(observations, -1);
  assert.notEqual(coverage, -1);
  assert.ok(glance < observations, 'at-a-glance table must lead the Native empty state');
  assert.ok(observations < coverage, 'coverage contract must remain the final Native appendix');
});

test('Threads and method are inlined instead of competing page tabs', () => {
  assert.match(source, /type Page = 'overview' \| 'scale'/);
  assert.doesNotMatch(source, /page === 'threads'/);
  assert.doesNotMatch(source, /page === 'method'/);
  assert.match(source, /<ThreadsPage harness=\{harness\}/);
  assert.match(source, /<MeasurementReceipt harness=\{harness\}/);
});

test('Native empty checkpoints preserve the selected Scale view', () => {
  const emptyState = source.slice(
    source.indexOf("harness === 'native' && !nativeHasData"),
    source.indexOf(") : page === 'overview'"),
  );
  assert.match(emptyState, /How does Native cost grow with scale/);
});
