import assert from 'node:assert/strict';
import test from 'node:test';

import { completeEntryScores } from './derive.mjs';
import { HEATMAP_SCORE_KEYS, SCORE_PROFILES, scoreCellKey } from './score-policy.mjs';

test('score profiles pin the published cells and keep suites separate', () => {
  assert.equal(SCORE_PROFILES.interactive.cells.length, 11);
  assert.equal(SCORE_PROFILES.interactive1k.cells.length, 7);
  assert.equal(SCORE_PROFILES.interactive10k.cells.length, 4);
  assert.equal(SCORE_PROFILES.storms.cells.length, 4);
  assert.equal(SCORE_PROFILES.startup.cells.length, 4);

  for (const profile of Object.values(SCORE_PROFILES)) {
    const keys = profile.cells.map(scoreCellKey);
    assert.equal(new Set(keys).size, keys.length, `${profile.key} contains duplicate cells`);
  }

  const heatmapCells = HEATMAP_SCORE_KEYS.flatMap((key) => SCORE_PROFILES[key].cells.map(scoreCellKey));
  assert.equal(new Set(heatmapCells).size, heatmapCells.length);
});

test('clear is one eleventh of interactive overall but one fourth of the 10k diagnostic', () => {
  const clearKey = scoreCellKey({ suite: 'table', workload: 'clear', scale: 10000, metric: 'latency' });
  const score = (profile) => completeEntryScores(['octane', 'control'], profile.cells.map((cell) => ({
    key: scoreCellKey(cell),
    values: {
      octane: scoreCellKey(cell) === clearKey ? 11 : 1,
      control: 1,
    },
  }))).scores.find(({ id }) => id === 'octane').value;

  assert.ok(Math.abs(score(SCORE_PROFILES.interactive) - 11 ** (1 / 11)) < 1e-12);
  assert.ok(Math.abs(score(SCORE_PROFILES.interactive10k) - 11 ** (1 / 4)) < 1e-12);
});

