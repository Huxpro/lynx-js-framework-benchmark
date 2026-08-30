import assert from 'node:assert/strict';
import test from 'node:test';

import { BOUNDARIES } from '../packages/shared/src/schema.mjs';
import {
  ISSUE45_N1_COUNTS,
  classifyIssue45Counts,
  makeIssue45Audit,
  makeIssue45Run,
} from './issue45-native-evidence.mjs';

test('issue #45 uses the shared classifier and preserves the exact method multisets', () => {
  assert.deepEqual(classifyIssue45Counts(ISSUE45_N1_COUNTS['octane-hux']), {
    create: 7042, props: 8056, events: 2012, topology: 7041, read: 1, flush: 1,
  });
  assert.deepEqual(classifyIssue45Counts(ISSUE45_N1_COUNTS.octane), {
    create: 5873, props: 6720, events: 1676, topology: 5861, read: 1, flush: 0,
  });
  assert.deepEqual(classifyIssue45Counts(ISSUE45_N1_COUNTS.react), {
    create: 6029, props: 7042, events: 2012, topology: 6028, read: 1, flush: 1,
  });
});

test('issue #45 emits isolated count records and no timing records', () => {
  const run = makeIssue45Run();
  assert.equal(run.records.length, 18);
  assert.ok(run.records.every((record) => record.suite === 'pipeline-native'));
  assert.ok(run.records.every((record) => record.rankingEligible === false));
  assert.ok(run.records.every((record) => record.boundary === BOUNDARIES.papiNativeCalls));
  assert.ok(run.records.every((record) => record.unit === 'count'));
  assert.ok(run.records.every((record) => record.metric.endsWith('Calls')));
  assert.equal(run.records.some((record) => record.metric.endsWith('Time')), false);
});

test('issue #45 audit records the N2 clock gate and exact Web oracle differences', () => {
  const audit = makeIssue45Audit();
  assert.equal(audit.decision.N0.papiRebindable, true);
  assert.equal(audit.N2.status, 'NO-GO');
  assert.equal(audit.N2.timingRecordsPublished, 0);
  assert.match(audit.decision.isolation.collectorPolicy, /descriptive outlet only/);
  assert.match(audit.decision.isolation.collectorPolicy, /excluded from ordinary records/);
  assert.equal(audit.N1.webOracle.equality, false);
  assert.deepEqual(audit.N1.webOracle.exactMethodDifferences.__AppendElement,
    { native: 7041, web: 0, delta: 7041 });
  assert.deepEqual(audit.N1.webOracle.exactMethodDifferences.__InsertElementBefore,
    { native: 0, web: 7000, delta: -7000 });
});
