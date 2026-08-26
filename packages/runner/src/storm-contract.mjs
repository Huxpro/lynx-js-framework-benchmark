import { BOUNDARIES, makeRecord } from '@lynx-bench/shared/schema';

function finiteNonNegative(value, label) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`invalid ${label}: ${value}`);
  return value;
}

function finiteInteger(value, label) {
  finiteNonNegative(value, label);
  if (!Number.isInteger(value)) throw new Error(`non-integer ${label}: ${value}`);
  return value;
}

export function stormContractReceipt(kase) {
  return {
    contractVersion: kase.contractVersion,
    commitPolicy: kase.commitPolicy,
    ticks: kase.ticks,
    tickIntervalMs: kase.tickIntervalMs,
    scheduleToleranceMs: kase.scheduleToleranceMs,
    mutationWidth: kase.mutationWidth,
    observation: kase.observation,
    action: kase.action,
  };
}

function expectedTransitionState(control, index) {
  return control.observation.kind === 'label-suffix'
    ? index + 1
    : control.observation.rowIndices[index % control.observation.rowIndices.length];
}

/** Derived semantic outcome. A false result is observed data, never a DNF. */
export function stormContractPass(control) {
  if (!control || control.finalState !== control.expectedFinalState) return false;
  if (control.commitPolicy === 'final-state') return true;
  if (control.commitPolicy !== 'every-tick' || control.transitions.length !== control.ticks) {
    return false;
  }
  return control.transitions.every((transition, index) =>
    transition.state === expectedTransitionState(control, index));
}

/** Validate one completed browser capture while retaining its actual schedule. */
export function deriveStormSample({ kase, capture, cpu, wire }) {
  if (!capture || capture.version !== 1 || capture.timedOut) {
    throw new Error('storm capture did not reach its terminal state');
  }
  const operationMs = finiteNonNegative(capture.operationMs, 'storm operation time');
  const ticksIssued = finiteInteger(capture.ticksIssued, 'storm ticks issued');
  const committedFrames = finiteInteger(capture.committedFrames, 'storm committed frames');
  if (ticksIssued !== kase.ticks || capture.issueOffsetsMs?.length !== kase.ticks) {
    throw new Error(`storm issued ${ticksIssued}/${kase.ticks} declared ticks`);
  }
  if (!Array.isArray(capture.transitions) || committedFrames !== capture.transitions.length) {
    throw new Error('storm committed-frame count disagrees with transition evidence');
  }
  if (committedFrames > ticksIssued) {
    throw new Error(`storm observed ${committedFrames} frames for ${ticksIssued} ticks`);
  }

  let previousOffset = -Infinity;
  for (const [index, offset] of capture.issueOffsetsMs.entries()) {
    finiteNonNegative(offset, `storm issue offset ${index}`);
    if (offset < previousOffset) throw new Error('storm issue offsets are not monotonic');
    if (index === 0 && offset > 0.05) throw new Error(`first storm issue offset is ${offset}ms`);
    // Schedule tolerance is a collect-time comparability control. Retain a
    // structurally valid completed capture even when the runner was delayed.
    previousOffset = offset;
  }
  let previousTransition = -Infinity;
  for (const [index, transition] of capture.transitions.entries()) {
    finiteNonNegative(transition?.atMs, `storm transition offset ${index}`);
    finiteInteger(transition?.issuedTicks, `storm transition issued ticks ${index}`);
    if (transition.atMs < previousTransition) throw new Error('storm transitions are not monotonic');
    if (transition.issuedTicks < 1 || transition.issuedTicks > ticksIssued) {
      throw new Error('storm transition references an impossible issued-tick count');
    }
    previousTransition = transition.atMs;
  }
  if (capture.finalState !== capture.expectedFinalState) {
    throw new Error('storm terminal state disagrees with its declared final state');
  }
  for (const [realm, value] of Object.entries(cpu ?? {})) {
    if (value != null) finiteNonNegative(value, `${realm} storm CPU`);
  }
  if (!Number.isFinite(cpu?.bts) || !Number.isFinite(cpu?.mts)) {
    throw new Error('storm capture requires aligned BTS and MTS CPU samples');
  }
  for (const side of ['toBts', 'toMts']) {
    finiteInteger(wire?.[side]?.messages, `${side} storm messages`);
    finiteInteger(wire?.[side]?.bytes, `${side} storm bytes`);
  }

  return {
    operationMs,
    ticksIssued,
    committedFrames,
    btsCpuMs: cpu.bts,
    mtsCpuMs: cpu.mts,
    wire,
    control: {
      ...stormContractReceipt(kase),
      actualIssueOffsetsMs: [...capture.issueOffsetsMs],
      transitions: capture.transitions.map((transition) => ({ ...transition })),
      finalState: capture.finalState,
      expectedFinalState: capture.expectedFinalState,
    },
  };
}

/** Emit only source observations. Contract outcomes and ratios are derived by collect. */
export function emitStormRecords({
  entry,
  kase,
  scale,
  samples,
  dnfCount = 0,
  failures = [],
  attemptedCount,
}) {
  const base = {
    suite: 'storm',
    entry: entry.id,
    workload: kase.name,
    scale,
    contractVersion: kase.contractVersion,
    commitPolicy: kase.commitPolicy,
    dnfCount,
    failures,
    attemptedCount,
    acceptedCount: samples.length,
  };
  const controls = samples.map((sample) => sample.control);
  const record = (metric, boundary, unit, values, detailSamples = null) => makeRecord({
    ...base,
    metric,
    boundary,
    unit,
    samples: values,
    detailSamples,
  });
  return [
    record('operationTime', BOUNDARIES.stormOperation, 'ms',
      samples.map((sample) => sample.operationMs), controls),
    record('ticksIssued', BOUNDARIES.stormInput, 'count',
      samples.map((sample) => sample.ticksIssued)),
    record('committedFrames', BOUNDARIES.stormCommits, 'count',
      samples.map((sample) => sample.committedFrames)),
    record('btsCpu', BOUNDARIES.btsCpu, 'ms',
      samples.map((sample) => sample.btsCpuMs)),
    record('mtsCpu', BOUNDARIES.mtsCpu, 'ms',
      samples.map((sample) => sample.mtsCpuMs)),
    ...[
      ['wireToBtsBytes', 'toBts', 'bytes'],
      ['wireToBtsMsgs', 'toBts', 'messages'],
      ['wireToMtsBytes', 'toMts', 'bytes'],
      ['wireToMtsMsgs', 'toMts', 'messages'],
    ].map(([metric, side, field]) => record(
      metric,
      BOUNDARIES.wire,
      field === 'bytes' ? 'bytes' : 'count',
      samples.map((sample) => sample.wire[side][field]),
      field === 'bytes'
        ? samples.map((sample) => ({ byName: sample.wire[side].byName }))
        : null,
    )),
  ];
}
