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
