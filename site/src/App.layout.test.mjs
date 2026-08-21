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

test('Native empty snapshots keep coverage after available observations', () => {
  const emptyState = source.slice(
    source.indexOf("harness === 'native' && !nativeHasData"),
    source.indexOf("page === 'overview'"),
  );

  assert.ok(emptyState.indexOf('<NativeObservations') < emptyState.indexOf('<NativeCoverage'));
});
