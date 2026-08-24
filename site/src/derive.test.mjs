import assert from 'node:assert/strict';
import test from 'node:test';

import {
  completeEntryScores,
  completeHistoryAggregateCells,
  rankHistoryAggregate,
  rankHistoryCell,
  rebaseEntryScores,
  slopeFit,
  weightedGeomean,
} from './derive.mjs';

test('interactive scores exclude entries with stale/incomplete matrices', () => {
  const result = completeEntryScores(['a', 'b', 'partial'], [
    { key: 'create', values: { a: 10, b: 20, partial: 5 } },
    { key: 'select', values: { a: 4, b: 2, partial: null } },
  ]);
  assert.deepEqual(result.missing, ['partial']);
  assert.equal(result.cellCount, 2);
  assert.deepEqual(result.scores.map(({ id }) => id), ['a', 'b']);
  assert.ok(Math.abs(result.scores[0].value - Math.sqrt(2)) < 1e-12);
  assert.ok(Math.abs(result.scores[1].value - Math.sqrt(2)) < 1e-12);
});

test('weighted scores use one strict complete matrix and the supplied formula weights', () => {
  assert.ok(Math.abs(weightedGeomean([2, 8], [3, 1]) - Math.pow(64, 0.25)) < 1e-12);
  const result = completeEntryScores(['a', 'b', 'partial'], [
    { key: 'heavy', values: { a: 10, b: 20, partial: 5 } },
    { key: 'light', values: { a: 40, b: 10, partial: null } },
  ], [3, 1]);
  assert.deepEqual(result.missing, ['partial']);
  assert.ok(Math.abs(result.scores[0].value - Math.pow(4, 0.25)) < 1e-12);
  assert.ok(Math.abs(result.scores[1].value - Math.pow(8, 0.25)) < 1e-12);
  assert.throws(() => completeEntryScores(['a'], [], [1]), /one positive weight per cell/);
});

test('conclusion scores follow the selected display baseline without changing their matrix', () => {
  const scores = new Map([['a', 1.25], ['b', 2.5]]);
  assert.deepEqual([...rebaseEntryScores(['a', 'b', 'partial'], scores, 'fastest')], [
    ['a', 1.25],
    ['b', 2.5],
  ]);
  assert.deepEqual([...rebaseEntryScores(['a', 'b', 'partial'], scores, 'a')], [
    ['a', 1],
    ['b', 2],
    ['partial', null],
  ]);
  assert.deepEqual([...rebaseEntryScores(['a', 'b'], scores, 'partial')], [
    ['a', null],
    ['b', null],
  ]);
});

test('trend slope is recalculated from current points', () => {
  assert.ok(Math.abs(slopeFit([[10, 100], [100, 1000], [1000, 10000]]) - 1) < 1e-12);
  assert.equal(slopeFit([[10, 1]]), null);
});

test('history ranks only exact eligible cohort values and preserves every missing state', () => {
  const records = [
    { entry: 'fast', median: 10, dnfCount: 0, rankEligible: true },
    { entry: 'tied', median: 10, dnfCount: 0, rankEligible: true },
    { entry: 'incomparable', median: 1, dnfCount: 0, rankEligible: false },
    { entry: 'dnf', median: null, dnfCount: 5, rankEligible: true },
  ];
  assert.deepEqual(
    rankHistoryCell(['fast', 'tied', 'incomparable', 'dnf', 'absent'], records),
    [
      { entry: 'fast', record: records[0], rank: 1, status: 'ranked' },
      { entry: 'tied', record: records[1], rank: 1, status: 'ranked' },
      { entry: 'incomparable', record: records[2], rank: null, status: 'incomparable' },
      { entry: 'dnf', record: records[3], rank: null, status: 'dnf' },
      { entry: 'absent', record: null, rank: null, status: 'missing' },
    ],
  );
  assert.equal(rankHistoryCell(['fast'], records, false)[0].status, 'observation');
  assert.equal(rankHistoryCell(['fast', 'absent'], records)[0].status, 'observation');
});

test('history interactive rank uses one complete unweighted operation matrix', () => {
  const create = [
    { entry: 'a', median: 10, dnfCount: 0, rankEligible: true },
    { entry: 'b', median: 20, dnfCount: 0, rankEligible: true },
    { entry: 'partial', median: 5, dnfCount: 0, rankEligible: true },
  ];
  const select = [
    { entry: 'a', median: 4, dnfCount: 0, rankEligible: true },
    { entry: 'b', median: 2, dnfCount: 0, rankEligible: true },
  ];
  const result = rankHistoryAggregate(['a', 'b', 'partial'], [
    { key: 'create@1000', records: create },
    { key: 'select@1000', records: select },
  ]);

  assert.equal(result[0].rank, 1);
  assert.equal(result[1].rank, 1);
  assert.ok(Math.abs(result[0].value - Math.sqrt(2)) < 1e-12);
  assert.ok(Math.abs(result[1].value - Math.sqrt(2)) < 1e-12);
  assert.equal(result[2].status, 'missing');
  assert.equal(result[2].rank, null);
  assert.equal(result[0].cellCount, 2);
});

test('history composite rank applies the supplied js-framework weights', () => {
  const result = rankHistoryAggregate(['a', 'b'], [
    {
      key: 'heavy',
      records: [
        { entry: 'a', median: 10, dnfCount: 0, rankEligible: true },
        { entry: 'b', median: 20, dnfCount: 0, rankEligible: true },
      ],
    },
    {
      key: 'light',
      records: [
        { entry: 'a', median: 40, dnfCount: 0, rankEligible: true },
        { entry: 'b', median: 10, dnfCount: 0, rankEligible: true },
      ],
    },
  ], true, [3, 1]);

  assert.equal(result[0].rank, 1);
  assert.equal(result[1].rank, 2);
  assert.ok(result[0].value < result[1].value);
});

test('historical formulas omit a missing cell for every entry together', () => {
  const complete = {
    key: 'create@1000',
    records: [
      { entry: 'a', median: 10, rankEligible: true },
      { entry: 'b', median: 20, rankEligible: true },
    ],
  };
  const partial = {
    key: 'clear@1000',
    records: [{ entry: 'a', median: 5, rankEligible: true }],
  };
  const incomparable = {
    key: 'select@1000',
    records: [
      { entry: 'a', median: 2, rankEligible: true },
      { entry: 'b', median: 3, rankEligible: false },
    ],
  };

  assert.deepEqual(
    completeHistoryAggregateCells(['a', 'b'], [complete, partial, incomparable]),
    [complete],
  );
});

test('historical weighted formulas renormalize the weights of available cells', () => {
  const cells = [
    {
      key: 'heavy',
      records: [
        { entry: 'a', median: 10, dnfCount: 0, rankEligible: true },
        { entry: 'b', median: 20, dnfCount: 0, rankEligible: true },
      ],
    },
    {
      key: 'light',
      records: [
        { entry: 'a', median: 40, dnfCount: 0, rankEligible: true },
        { entry: 'b', median: 10, dnfCount: 0, rankEligible: true },
      ],
    },
    {
      key: 'missing',
      records: [{ entry: 'a', median: 1, dnfCount: 0, rankEligible: true }],
    },
  ];
  const weights = new Map([['heavy', 3], ['light', 1], ['missing', 10]]);
  const available = completeHistoryAggregateCells(['a', 'b'], cells);
  const result = rankHistoryAggregate(
    ['a', 'b'],
    available,
    true,
    available.map((cell) => weights.get(cell.key)),
  );

  assert.deepEqual(available.map((cell) => cell.key), ['heavy', 'light']);
  assert.equal(result[0].cellCount, 2);
  assert.ok(Math.abs(result[0].value - Math.pow(4, 0.25)) < 1e-12);
  assert.ok(Math.abs(result[1].value - Math.pow(8, 0.25)) < 1e-12);
});
