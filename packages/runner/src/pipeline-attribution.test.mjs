import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';

import { PAPI_PAGE_INSTRUMENT_JS } from '@lynx-bench/shared/page-instrument';
import { classifyPapiMethod, PAPI_SEGMENTS } from '@lynx-bench/shared/pipeline';

import { derivePipelineSample, emitPipelineRecords } from './pipeline-attribution.mjs';
import {
  derivePipelineResidualRecords,
  pipelineRecordControl,
  pipelineWorkClassification,
} from './collect.mjs';
import { makeHarnessHtml } from './server.mjs';

test('PAPI classifier covers the fixed six-segment vocabulary', () => {
  assert.deepEqual(PAPI_SEGMENTS, ['create', 'props', 'events', 'topology', 'read', 'flush']);
  assert.equal(classifyPapiMethod('__CreateList'), 'create');
  assert.equal(classifyPapiMethod('__SetAttribute'), 'props');
  assert.equal(classifyPapiMethod('__AddEvent'), 'events');
  assert.equal(classifyPapiMethod('__ReplaceElements'), 'topology');
  assert.equal(classifyPapiMethod('__QuerySelectorAll'), 'read');
  assert.equal(classifyPapiMethod('__FlushElementTree'), 'flush');
});

test('dedicated page intercepts the pre-boot surface and excludes nested host time', () => {
  const clock = [0, 1, 3, 7];
  const capture = vm.runInNewContext(`${PAPI_PAGE_INSTRUMENT_JS}; (() => {
    const patchedAssign = Object.assign;
    const target = {};
    const source = {
      __FlushElementTree() {},
      __GetID() { return 'x'; },
      __SetAttribute() { return target.__GetID(); },
    };
    Object.assign(target, source);
    if (Object.assign === patchedAssign) throw new Error('Object.assign was not restored');
    __LYNX_PAPI_BEGIN__();
    target.__SetAttribute();
    return __LYNX_PAPI_END__();
  })()`, {
    performance: { now: () => clock.shift() },
  });

  assert.deepEqual([...capture.surfaceNames], [
    '__FlushElementTree', '__GetID', '__SetAttribute',
  ]);
  assert.equal(capture.segments.props.calls, 1);
  assert.equal(capture.segments.props.selfMs, 5);
  assert.equal(capture.segments.read.calls, 1);
  assert.equal(capture.segments.read.selfMs, 2);
});

test('ordinary harness HTML contains no PAPI wrapper while /pipeline does', () => {
  assert.doesNotMatch(makeHarnessHtml(), /ElementPAPI capture is already active/);
  assert.doesNotMatch(makeHarnessHtml(), /x\.armPipeline/);
  assert.match(makeHarnessHtml({ pipeline: true }), /ElementPAPI capture is already active/);
  assert.match(makeHarnessHtml({ pipeline: true }), /x\.armPipeline/);
});

test('pipeline source records retain raw controls without source-authoring the residual', () => {
  const capture = {
    version: 1,
    surfaceNames: ['__CreateView', '__FlushElementTree', '__SetAttribute'],
    segments: Object.fromEntries(PAPI_SEGMENTS.map((segment) => [segment, {
      calls: 0,
      selfMs: 0,
      byName: {},
    }])),
  };
  capture.segments.create = {
    calls: 1,
    selfMs: 2,
    byName: { __CreateView: { calls: 1, selfMs: 2 } },
  };
  capture.segments.props = {
    calls: 2,
    selfMs: 3,
    byName: { __SetAttribute: { calls: 2, selfMs: 3 } },
  };
  const sample = derivePipelineSample({
    operationMs: 20,
    capture,
    requestedRows: 1000,
    committedRows: 1000,
  });
  assert.equal(sample.totalPapiSelfMs, 5);
  assert.deepEqual(sample.control.callMultiset, { __CreateView: 1, __SetAttribute: 2 });

  const records = emitPipelineRecords({
    entry: { id: 'example' },
    kase: { name: 'create' },
    scale: 1000,
    samples: [sample],
    attemptedCount: 1,
  });
  assert.equal(records.length, 13);
  assert.ok(records.every((record) => record.suite === 'pipeline'));
  assert.ok(records.every((record) => record.attemptedCount === 1));
  assert.equal(records.find((record) => record.metric === 'operationTime').samples[0], 20);
  assert.equal(records.find((record) => record.metric === 'papiCreateCalls').samples[0], 1);
  assert.equal(records.some((record) => record.metric === 'outsidePapiTime'), false);
  assert.equal(records.some((record) => record.metric === 'latency'), false);

  const derived = derivePipelineResidualRecords(records);
  const residual = derived.find((record) => record.metric === 'outsidePapiTime');
  assert.equal(derived.length, 14);
  assert.deepEqual(residual.samples, [15]);
  assert.deepEqual(residual.detailSamples, records[0].detailSamples);
  assert.equal(residual.derivedFrom.kind, 'aligned-sample-subtraction');
});

const controlledRecord = (entry, committedRows, callMultisets) => ({
  suite: 'pipeline',
  harness: 'web',
  environment: 'lynx-for-web',
  entry,
  workload: 'select',
  scale: 1000,
  metric: 'operationTime',
  boundary: 'pipeline-page-pointerdown-to-dom-predicate',
  unit: 'ms',
  samples: callMultisets.map((_, index) => 10 + index),
  detailSamples: callMultisets.map((callMultiset) => ({
    requestedRows: 1000,
    committedRows,
    callMultiset,
    surfaceNames: ['__FlushElementTree'],
  })),
  dnfCount: 0,
});

test('call-multiset drift and cross-entry tree mismatch cannot publish', () => {
  const drifting = controlledRecord('react', 1000, [
    { __FlushElementTree: 1 },
    { __FlushElementTree: 2 },
  ]);
  assert.deepEqual(pipelineRecordControl(drifting), {
    status: 'invalid',
    reason: 'pipeline-call-or-tree-control-varies-across-samples',
  });

  const react = controlledRecord('react', 1000, [{ __FlushElementTree: 1 }]);
  const vue = controlledRecord('vue', 999, [{ __FlushElementTree: 1 }]);
  const classification = pipelineWorkClassification([react, vue], react);
  assert.equal(classification.status, 'invalid');
  assert.equal(classification.reason, 'pipeline-committed-tree-mismatch-between-entries');
});

test('a partial pipeline DNF remains explicit incomplete work', () => {
  const partial = {
    ...controlledRecord('react', 1000, [{ __FlushElementTree: 1 }]),
    attemptedCount: 2,
    acceptedCount: 1,
    dnfCount: 1,
    failures: [{ category: 'pipeline-predicate-timeout' }],
  };
  assert.deepEqual(pipelineRecordControl(partial), {
    status: 'incomplete',
    reason: 'pipeline-dnf-observed',
    requestedRows: 1000,
    committedRows: 1000,
    callMultiset: { __FlushElementTree: 1 },
    surfaceNames: ['__FlushElementTree'],
  });
});
