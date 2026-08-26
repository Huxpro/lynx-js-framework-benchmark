import assert from 'node:assert/strict';
import test from 'node:test';

import { comparisonKey } from '@lynx-bench/shared/schema';
import { STORM_CASES } from '@lynx-bench/shared/workloads';

import {
  deriveStormRecords,
  stormContractClassification,
} from './collect.mjs';
import { makeHarnessHtml } from './server.mjs';
import {
  deriveStormSample,
  emitStormRecords,
  stormContractPass,
} from './storm-contract.mjs';

const everyUpdate = STORM_CASES.find((kase) =>
  kase.name === 'updateStorm' && kase.commitPolicy === 'every-tick');
const finalUpdate = STORM_CASES.find((kase) =>
  kase.name === 'updateStorm' && kase.commitPolicy === 'final-state');

test('prospective contract dimensions keep legacy nulls comparable', () => {
  const legacy = {
    suite: 'table', harness: 'web', environment: 'web/chromium',
    workload: 'create', scale: 1000, metric: 'operationTime', boundary: 'x', unit: 'ms',
  };
  assert.equal(comparisonKey(legacy), comparisonKey({
    ...legacy,
    contractVersion: null,
    commitPolicy: null,
  }));
  assert.notEqual(comparisonKey(legacy), comparisonKey({
    ...legacy,
    contractVersion: 1,
    commitPolicy: 'final-state',
  }));
});

function captureFor(kase, { coalesce = false } = {}) {
  const issueOffsetsMs = Array.from({ length: kase.ticks }, (_, index) => index * 8);
  const states = coalesce
    ? Array.from({ length: kase.ticks / 2 }, (_, index) => (index + 1) * 2)
    : Array.from({ length: kase.ticks }, (_, index) => index + 1);
  return {
    version: 1,
    timedOut: false,
    operationMs: 420,
    ticksIssued: kase.ticks,
    committedFrames: states.length,
    issueOffsetsMs,
    transitions: states.map((state) => ({
      atMs: state * 8 + 4,
      state,
      issuedTicks: state,
    })),
    finalState: kase.ticks,
    expectedFinalState: kase.ticks,
  };
}

const measured = (kase, options) => deriveStormSample({
  kase,
  capture: captureFor(kase, options),
  cpu: { bts: 12, mts: 8 },
  wire: {
    toBts: { messages: 60, bytes: 6000, byName: { call: { messages: 60, bytes: 6000 } } },
    toMts: { messages: 55, bytes: 5500, byName: { commit: { messages: 55, bytes: 5500 } } },
  },
});

test('ordinary and pipeline pages contain no storm observer while /storm does', () => {
  assert.doesNotMatch(makeHarnessHtml(), /x\.armStorm/);
  assert.doesNotMatch(makeHarnessHtml({ pipeline: true }), /x\.armStorm/);
  assert.match(makeHarnessHtml({ storm: true }), /x\.armStorm/);
  assert.doesNotMatch(makeHarnessHtml({ storm: true }), /ElementPAPI capture is already active/);
  assert.throws(() => makeHarnessHtml({ storm: true, pipeline: true }), /mutually exclusive/);
});

test('storm source records retain schedule and transitions but not outcomes or ratios', () => {
  const sample = measured(everyUpdate);
  assert.equal(stormContractPass(sample.control), true);
  const records = emitStormRecords({
    entry: { id: 'react' },
    kase: everyUpdate,
    scale: 1000,
    samples: [sample],
    attemptedCount: 1,
  });
  assert.equal(records.length, 9);
  assert.equal(records.some((record) => record.metric === 'contractPass'), false);
  assert.equal(records.some((record) => record.metric.endsWith('PerTick')), false);
  assert.equal(records.find((record) => record.metric === 'ticksIssued').samples[0], 50);
  assert.equal(records.find((record) => record.metric === 'operationTime').detailSamples.length, 1);
  assert.equal(records.find((record) => record.metric === 'ticksIssued').detailSamples, null);
  assert.deepEqual(Object.keys(records.find((record) =>
    record.metric === 'wireToBtsBytes').detailSamples[0]), ['byName']);

  const derived = deriveStormRecords(records);
  assert.equal(derived.length, 15);
  assert.deepEqual(derived.find((record) => record.metric === 'contractPass').samples, [1]);
  assert.deepEqual(derived.find((record) => record.metric === 'coalescingRatio').samples, [1]);
  assert.deepEqual(derived.find((record) =>
    record.metric === 'wireToBtsBytesPerTick').samples, [120]);
  assert.equal(derived.find((record) => record.metric === 'contractPass').derivedFrom.kind,
    'aligned-sample-transform');
});

test('coalescing is observed contract failure for every-tick and success for final-state', () => {
  const failedSample = measured(everyUpdate, { coalesce: true });
  assert.equal(stormContractPass(failedSample.control), false);
  const failedRecords = deriveStormRecords(emitStormRecords({
    entry: { id: 'react' },
    kase: everyUpdate,
    scale: 1000,
    samples: [failedSample],
    attemptedCount: 1,
  }));
  const failed = stormContractClassification(
    failedRecords,
    failedRecords.find((record) => record.metric === 'operationTime'),
  );
  assert.equal(failed.status, 'contract-failed');
  assert.equal(failedRecords[0].dnfCount, 0);

  const finalSample = measured(finalUpdate, { coalesce: true });
  assert.equal(stormContractPass(finalSample.control), true);
  const finalRecords = deriveStormRecords(emitStormRecords({
    entry: { id: 'react' },
    kase: finalUpdate,
    scale: 1000,
    samples: [finalSample],
    attemptedCount: 1,
  }));
  assert.equal(stormContractClassification(finalRecords, finalRecords[0]).status, 'controlled');
});

test('input schedule drift is retained but fails comparability closed', () => {
  const sample = measured(finalUpdate);
  sample.control.actualIssueOffsetsMs[10] = 500;
  const records = deriveStormRecords(emitStormRecords({
    entry: { id: 'react' },
    kase: finalUpdate,
    scale: 1000,
    samples: [sample],
    attemptedCount: 1,
  }));
  assert.deepEqual(stormContractClassification(records, records[0]), {
    status: 'invalid',
    reason: 'storm-input-schedule-outside-tolerance',
  });
});

test('storm DNF attempts emit a complete source metric set with zero observations', () => {
  const records = emitStormRecords({
    entry: { id: 'react' },
    kase: finalUpdate,
    scale: 1000,
    samples: [],
    attemptedCount: 1,
    dnfCount: 1,
    failures: [{ category: 'storm-terminal-timeout' }],
  });
  assert.equal(records.length, 9);
  assert.ok(records.every((record) => record.samples.length === 0));
  assert.ok(records.every((record) => record.dnfCount === 1));
});
