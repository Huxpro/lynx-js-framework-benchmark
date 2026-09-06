import assert from 'node:assert/strict';
import test from 'node:test';

import { qualifyPairedScorecard } from '@lynx-bench/shared/qualification';
import {
  JS_FRAMEWORK_SCORE_OPS,
  ROADMAP_SCORECARD,
} from '@lynx-bench/shared/scorecard';

function pairs(ratio, count = 10) {
  return Array.from({ length: count }, (_, index) => ({
    session: `session-${index}`,
    order: index % 2 === 0 ? 'AB' : 'BA',
    cells: Object.fromEntries(
      JS_FRAMEWORK_SCORE_OPS.map((cell) => [
        cell.key,
        { comparator: 100 + index, candidate: (100 + index) * ratio },
      ]),
    ),
  }));
}

test('freezes the M4 scorecard before observations exist', () => {
  assert.equal(ROADMAP_SCORECARD.version, 1);
  assert.equal(
    Object.isFrozen(ROADMAP_SCORECARD.suites.interaction.cells[0]),
    true,
  );
  assert.deepEqual(
    ROADMAP_SCORECARD.suites.interaction.cells.map((cell) => cell.key),
    [
      'create@1000',
      'replace@1000',
      'update10th@1000',
      'select@1000',
      'swap@1000',
      'remove@1000',
      'create@10000',
      'append1k@1000',
      'clear@1000',
    ],
  );
  assert.deepEqual(
    ROADMAP_SCORECARD.suites.startup.cells.map((cell) => cell.key),
    ['fcp@0', 'fcp@1000', 'fcp@10000'],
  );
  assert.deepEqual(ROADMAP_SCORECARD.diagnosticScales, {
    startup: [0, 1000, 10000],
    bulk: [1000, 2000, 3000, 5000, 10000],
  });
  assert.equal(ROADMAP_SCORECARD.statistics.minimumPairs, 10);
  assert.deepEqual(ROADMAP_SCORECARD.engagement.requiredPerCell, [
    'wire-operation',
    'load-bundle-pipeline-entry',
  ]);
  assert.deepEqual(ROADMAP_SCORECARD.timeoutsMs, {
    interaction: 240000,
    startup: 240000,
  });
  assert.equal(ROADMAP_SCORECARD.tail.minimumSamples, 100);
  assert.equal(ROADMAP_SCORECARD.memory.minimumCreateClearRecreateCycles, 20);
});

test('qualifies a stable same-window win and retains every core-cell gate', () => {
  const result = qualifyPairedScorecard({
    pairs: pairs(0.9),
    cells: JS_FRAMEWORK_SCORE_OPS,
    resamples: 1000,
  });
  assert.equal(result.pairCount, 10);
  assert.deepEqual(result.orderCounts, { AB: 5, BA: 5 });
  assert.ok(Math.abs(result.aggregate.point - 0.9) < 1e-12);
  assert.ok(result.aggregate.upper < 1);
  assert.equal(result.aggregate.strictWin, true);
  assert.equal(result.aggregate.engineeringTarget, true);
  assert.equal(result.pass, true);
  assert.deepEqual(
    Object.keys(result.cells),
    JS_FRAMEWORK_SCORE_OPS.map((cell) => cell.key),
  );
  assert.ok(Object.values(result.cells).every((cell) => cell.nonInferior));
});

test('refuses incomplete, non-positive, under-sampled, and order-biased matrices', () => {
  assert.throws(
    () =>
      qualifyPairedScorecard({
        pairs: pairs(0.9, 9),
        cells: JS_FRAMEWORK_SCORE_OPS,
        resamples: 1000,
      }),
    /at least 10/,
  );
  const incomplete = pairs(0.9);
  delete incomplete[3].cells['swap@1000'];
  assert.throws(
    () =>
      qualifyPairedScorecard({
        pairs: incomplete,
        cells: JS_FRAMEWORK_SCORE_OPS,
        resamples: 1000,
      }),
    /pair 3 swap@1000 candidate/,
  );
  const biased = pairs(0.9);
  for (const pair of biased) pair.order = 'AB';
  assert.throws(
    () =>
      qualifyPairedScorecard({
        pairs: biased,
        cells: JS_FRAMEWORK_SCORE_OPS,
        resamples: 1000,
      }),
    /order is imbalanced/,
  );
  const duplicated = pairs(0.9);
  duplicated[1].session = duplicated[0].session;
  assert.throws(
    () =>
      qualifyPairedScorecard({
        pairs: duplicated,
        cells: JS_FRAMEWORK_SCORE_OPS,
        resamples: 1000,
      }),
    /session .* duplicated/,
  );
});

test('fails the aggregate and the exact regressed core cell independently', () => {
  const observations = pairs(0.9);
  for (const pair of observations) {
    pair.cells['swap@1000'].candidate =
      pair.cells['swap@1000'].comparator * 1.1;
  }
  const result = qualifyPairedScorecard({
    pairs: observations,
    cells: JS_FRAMEWORK_SCORE_OPS,
    resamples: 1000,
  });
  assert.equal(result.aggregate.strictWin, true);
  assert.equal(result.cells['swap@1000'].nonInferior, false);
  assert.equal(result.pass, false);
});

test('keeps the engineering point target distinct from a statistical strict win', () => {
  const result = qualifyPairedScorecard({
    pairs: pairs(0.98),
    cells: JS_FRAMEWORK_SCORE_OPS,
    resamples: 1000,
  });
  assert.equal(result.aggregate.strictWin, true);
  assert.equal(result.aggregate.engineeringTarget, false);
  assert.equal(result.pass, false);
});
