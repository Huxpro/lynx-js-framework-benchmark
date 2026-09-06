import assert from 'node:assert/strict';
import test from 'node:test';

import { ROADMAP_SCORECARD } from '@lynx-bench/shared/scorecard';
import { makeRecord, SCHEMA_VERSION } from '@lynx-bench/shared/schema';

import { qualifyRawRuns } from './qualification-runs.mjs';

const candidate = 'candidate';
const comparator = 'comparator';

function rawRun(index, ratio = 0.9) {
  const order = index % 2 === 0 ? [candidate, comparator] : [comparator, candidate];
  const records = [];
  for (const entry of order) {
    const factor = entry === candidate ? ratio : 1;
    for (const cell of ROADMAP_SCORECARD.suites.interaction.cells) {
      records.push(makeRecord({
        suite: 'table',
        entry,
        workload: cell.workload,
        scale: cell.scale,
        metric: 'latency',
        boundary: 'pointerdown-to-dom-predicate',
        unit: 'ms',
        samples: Array.from({ length: 7 }, (_, sample) => (100 + index + sample) * factor),
        attemptedCount: 7,
        acceptedCount: 7,
      }));
    }
    for (const cell of ROADMAP_SCORECARD.suites.startup.cells) {
      records.push(makeRecord({
        suite: 'startup',
        entry,
        workload: cell.workload,
        scale: cell.scale,
        metric: cell.metric,
        boundary: 'view-attach-to-first-content',
        unit: 'ms',
        samples: Array.from({ length: 5 }, (_, sample) => (200 + index + sample) * factor),
        attemptedCount: 5,
        acceptedCount: 5,
      }));
    }
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    meta: {
      machine: { id: 'machine-a', cpu: 'fixed' },
      sessionId: `session-${index}`,
      entryOrder: order,
      entryCommits: { [candidate]: 'candidate-sha', [comparator]: 'comparator-sha' },
      receipt: {
        repository: { commit: 'runner-sha', dirty: false },
        execution: { harness: 'web', sessionId: `session-${index}`, entryOrder: [...order] },
        sampling: { repetitions: { table: 7, startup: 5 } },
        comparabilityCohort: 'sha256:one-cohort',
      },
    },
    records,
  };
}

test('qualifies complete raw AB/BA sessions for interaction and startup', () => {
  const result = qualifyRawRuns({
    runs: Array.from({ length: 10 }, (_, index) => rawRun(index)),
    candidate,
    comparator,
  });
  assert.deepEqual(result.sessions.map(({ order }) => order), [
    'AB', 'BA', 'AB', 'BA', 'AB', 'BA', 'AB', 'BA', 'AB', 'BA',
  ]);
  assert.equal(result.suites.interaction.pairCount, 10);
  assert.equal(result.suites.startup.pairCount, 10);
  assert.ok(Math.abs(result.suites.interaction.aggregate.point - 0.9) < 1e-12);
  assert.equal(result.pass, true);
});

test('rejects dirty, cross-machine, cross-cohort, reordered, incomplete, and DNF evidence', () => {
  const cases = [
    ['clean benchmark checkout', (runs) => { runs[0].meta.receipt.repository.dirty = true; }],
    ['one machine', (runs) => { runs[0].meta.machine.id = 'machine-b'; }],
    ['one cohort', (runs) => { runs[0].meta.receipt.comparabilityCohort = 'sha256:other'; }],
    ['two-arm entry order', (runs) => { runs[0].meta.receipt.execution.entryOrder.reverse(); }],
    ['exactly one source record', (runs) => { runs[0].records.pop(); }],
    ['DNF evidence', (runs) => {
      const record = runs[0].records.find((item) => item.entry === candidate);
      record.dnfCount = 1;
      record.failures = [{ reason: 'timeout' }];
    }],
  ];
  for (const [message, mutate] of cases) {
    const runs = Array.from({ length: 10 }, (_, index) => rawRun(index));
    mutate(runs);
    assert.throws(() => qualifyRawRuns({ runs, candidate, comparator }), new RegExp(message));
  }
});

test('re-derives medians instead of trusting stored aggregate fields', () => {
  const runs = Array.from({ length: 10 }, (_, index) => rawRun(index));
  for (const record of runs[0].records) record.median = 0.000001;
  const result = qualifyRawRuns({ runs, candidate, comparator });
  assert.ok(Math.abs(result.suites.interaction.aggregate.point - 0.9) < 1e-12);
});
