import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ANDROID_ART_GLOBAL_REF_OVERFLOW,
  classifyAndroidArtCapacity,
  selectAndroidCapacityTerminal,
  validateDevtoolDisabledLifecycle,
} from './android-art-capacity.mjs';

const marker = '__CAPACITY_ATTEMPT__unit-1';
const pid = 4242;
const launch = 1_700_000_000_100;
const epoch = (ms, process = pid, message = '') =>
  `${(ms / 1_000).toFixed(3)} ${process} ${process} F art : ${message}`;
const receipt = (overrides = {}) => ({
  protocol: 'lynx-native-startup-v1',
  moduleStartMs: launch + 10,
  commitAckMs: launch + 20,
  firstFrameMs: launch + 30,
  secondFrameMs: launch + 40,
  renderEvidence: { kind: 'native-animation-frame', frames: 2 },
  transportEvidence: { kind: 'octane-root.render', acknowledged: true, ackMs: launch + 20 },
  postState: { rowCount: 1_000 },
  ...overrides,
});
const line = (ms, message, process = pid) => epoch(ms, process, message);
const receiptLine = (ms, payload = receipt(), process = pid) =>
  line(ms, `__NATIVE_BENCH_STARTUP__ ${JSON.stringify(payload)}`, process);
const base = (...lines) => [
  epoch(launch - 10, 111, marker),
  ...lines,
].join('\n');
const classify = (log, terminal, overrides = {}) => classifyAndroidArtCapacity({
  log,
  marker,
  pid,
  launchedAtMs: launch,
  deadlineMs: launch + 180_000,
  terminal,
  entryId: 'octane-native-diagnostic',
  scale: 1_000,
  bundleSha256: 'a'.repeat(64),
  fixtureRole: 'eager-capacity-probe',
  bundleServed: 1,
  ...overrides,
});

test('requires the ordered DevTool-disabled lifecycle acknowledgement and rejects re-enable', () => {
  const good = base(
    line(launch, 'DevTool disabled. Transitioning to ATTACHED.'),
    line(launch + 1, '__OCTANE_DEVTOOL_DISABLED__=true'),
  );
  assert.equal(validateDevtoolDisabledLifecycle(good, marker).valid, true);
  assert.equal(validateDevtoolDisabledLifecycle(
    `${good}\n${line(launch + 2, 'DevTool enabled. Transitioning to ENABLED.')}`,
    marker,
  ).valid, false);
  assert.equal(validateDevtoolDisabledLifecycle(base(line(launch, '__OCTANE_DEVTOOL_DISABLED__=true')), marker).valid, false);
});

test('accepts exactly one same-PID Octane semantic completion receipt', () => {
  const log = base(receiptLine(launch + 50));
  const terminal = selectAndroidCapacityTerminal({
    log, marker, pid, launchedAtMs: launch, expectedRows: 1_000,
    nowMs: launch + 60, deadlineMs: launch + 180_000, currentPids: [pid],
  });
  assert.equal(terminal.kind, 'receipt');
  const result = classify(log, terminal);
  assert.equal(result.latencyMs, 40);
  assert.equal(result.detail.outcome, 'completed');
  assert.equal(classify(log, terminal, { bundleServed: 0 }).failure.category, 'process-failure');
});

test('rejects duplicate, malformed, wrong-row, wrong-PID, stale, and late receipts', () => {
  const terminal = { kind: 'receipt', atMs: launch + 50 };
  const duplicate = classify(base(
    receiptLine(launch + 50),
    receiptLine(launch + 51),
  ), terminal);
  assert.equal(duplicate.failure.category, 'process-failure');
  assert.match(duplicate.failure.message, /duplicate/);

  for (const invalid of [
    base(line(launch + 50, '__NATIVE_BENCH_STARTUP__ {bad')),
    base(receiptLine(launch + 50, receipt({ postState: { rowCount: 10_000 } }))),
    base(receiptLine(launch + 50, receipt(), 9999)),
    base(receiptLine(launch - 1, receipt({ moduleStartMs: launch - 2 }))),
  ]) {
    assert.equal(classify(invalid, terminal).failure.category, 'process-failure');
  }

  const death = line(launch + 60, 'Process com.lynx.explorer (pid 4242) has died', 1000);
  const selected = selectAndroidCapacityTerminal({
    log: base(death, receiptLine(launch + 70)), marker, pid, launchedAtMs: launch,
    expectedRows: 1_000, nowMs: launch + 80, deadlineMs: launch + 180_000,
    currentPids: [],
  });
  assert.equal(selected.kind, 'death');
});

test('recognizes issue #888 only with the complete same-attempt same-PID signature', () => {
  const signature = base(
    line(launch + 10, ANDROID_ART_GLOBAL_REF_OVERFLOW),
    line(launch + 11, 'Last 10 entries (of 51200):'),
    line(launch + 12, 'Summary:'),
    line(launch + 13, '30026 of com.lynx.tasm.behavior.PaintingContext$a (30026 unique instances)'),
    line(launch + 14, '20444 of m7.w (20444 unique instances)'),
    line(launch + 15, '403 of java.lang.Class'),
    line(launch + 16, '277 of java.nio.DirectByteBuffer'),
    line(launch + 17, '51200 global references (51027 unique instances)'),
    line(launch + 18, 'Fatal signal 6 (SIGABRT), code -1 (SI_QUEUE)'),
    line(launch + 19, 'Process com.lynx.explorer (pid 4242) has died', 1000),
  );
  const result = classify(signature, { kind: 'death', atMs: launch + 19 });
  assert.equal(result.failure.category, 'capacity/android-art-global-ref-table');
  assert.equal(result.failure.loadToCrashMs, 19);
  assert.match(result.failure.evidence.summary, /PaintingContext\$a/);
  assert.match(result.failure.evidence.summary, /m7\.w/);

  const interleavedPid = signature.replace(
    line(launch + 14, '20444 of m7.w (20444 unique instances)'),
    line(launch + 14, '20444 of m7.w (20444 unique instances)', 9999),
  );
  assert.equal(
    classify(interleavedPid, { kind: 'death', atMs: launch + 19 }).failure.category,
    'process-failure',
  );

  for (const changed of [
    signature.replace('20444 of m7.w (20444 unique instances)\n', ''),
    signature.replace('51200 global references (51027 unique instances)\n', ''),
    signature.replace('Fatal signal 6 (SIGABRT), code -1 (SI_QUEUE)\n', ''),
    signature.replace('(pid 4242) has died', '(pid 9999) has died'),
    signature.replace('Summary:', 'Summary truncated'),
    signature.replace(`${epoch(launch - 10, 111, marker)}\n`, ''),
  ]) {
    assert.equal(classify(changed, { kind: 'death', atMs: launch + 19 }).failure.category, 'process-failure');
  }
});

test('stale signatures, unrelated process failures, PID restarts, and live cutoffs stay non-capacity', () => {
  const stale = base(
    line(launch - 5, ANDROID_ART_GLOBAL_REF_OVERFLOW),
    line(launch + 10, 'Process com.lynx.explorer (pid 4242) has died', 1000),
  );
  assert.equal(classify(stale, { kind: 'death', atMs: launch + 10 }).failure.category, 'process-failure');
  const segfault = base(
    line(launch + 10, 'Fatal signal 11 (SIGSEGV), code 1'),
    line(launch + 11, 'Process com.lynx.explorer (pid 4242) has died', 1000),
  );
  assert.equal(classify(segfault, { kind: 'death', atMs: launch + 11 }).failure.category, 'process-failure');

  const restart = selectAndroidCapacityTerminal({
    log: base(), marker, pid, launchedAtMs: launch, expectedRows: 1_000,
    nowMs: launch + 100, deadlineMs: launch + 180_000, currentPids: [8888],
  });
  assert.equal(restart.kind, 'pid-restart');
  assert.equal(classify(base(), restart).failure.category, 'process-failure');

  const deadline = selectAndroidCapacityTerminal({
    log: base(), marker, pid, launchedAtMs: launch, expectedRows: 1_000,
    nowMs: launch + 180_000, deadlineMs: launch + 180_000, currentPids: [pid],
  });
  assert.equal(deadline.kind, 'deadline');
  assert.equal(classify(base(), deadline).failure.category, 'timeout');
  assert.equal(classify(
    base(line(launch + 10, 'ANR in com.lynx.explorer')),
    deadline,
  ).failure.category, 'process-failure');
  assert.equal(classify(
    base(line(launch + 10, 'Fatal signal 11 (SIGSEGV), code 1', 9999)),
    deadline,
  ).failure.category, 'timeout');
  assert.equal(classify(
    base(line(launch + 10, 'ANR in com.lynx.explorer PID: 4242', 1000)),
    deadline,
  ).failure.category, 'process-failure');
});
