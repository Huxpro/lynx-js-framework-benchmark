import { PAPI_SEGMENTS } from '@lynx-bench/shared/pipeline';
import { BOUNDARIES, makeRecord } from '@lynx-bench/shared/schema';

const metricSegment = (segment) => segment[0].toUpperCase() + segment.slice(1);

function finiteNonNegative(value, label) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`invalid ${label}: ${value}`);
  return value;
}

function sortedObject(entries) {
  return Object.fromEntries([...entries].sort(([left], [right]) => left.localeCompare(right)));
}

/** Validate and normalize one raw browser capture without discarding zeros. */
export function derivePipelineSample({ operationMs, capture, requestedRows, committedRows }) {
  finiteNonNegative(operationMs, 'pipeline operation time');
  if (!capture || capture.version !== 1 || !capture.segments) {
    throw new Error('invalid ElementPAPI capture payload');
  }
  if (!capture.surfaceNames?.includes('__FlushElementTree')) {
    throw new Error('ElementPAPI surface was not intercepted before web-core boot');
  }

  const segments = {};
  const callEntries = [];
  let totalPapiSelfMs = 0;
  for (const segment of PAPI_SEGMENTS) {
    const raw = capture.segments[segment];
    if (!raw) throw new Error(`ElementPAPI capture is missing segment ${segment}`);
    const calls = finiteNonNegative(raw.calls, `${segment} calls`);
    const selfMs = finiteNonNegative(raw.selfMs, `${segment} self time`);
    if (!Number.isInteger(calls)) throw new Error(`non-integer ${segment} calls: ${calls}`);
    const byName = raw.byName ?? {};
    const summedCalls = Object.values(byName).reduce((sum, item) => sum + item.calls, 0);
    if (summedCalls !== calls) {
      throw new Error(`${segment} call total ${calls} disagrees with by-name total ${summedCalls}`);
    }
    for (const [name, item] of Object.entries(byName)) {
      if (!Number.isInteger(item.calls) || item.calls < 0) {
        throw new Error(`invalid call count for ${name}`);
      }
      if (item.calls > 0) callEntries.push([name, item.calls]);
    }
    segments[segment] = { calls, selfMs };
    totalPapiSelfMs += selfMs;
  }

  // The PAPI interval is nested inside pointerdown→predicate. A material
  // overrun means the capture was not armed/frozen at the declared boundary.
  if (totalPapiSelfMs > operationMs + 0.05) {
    throw new Error(
      `ElementPAPI self time ${totalPapiSelfMs}ms exceeds operation time ${operationMs}ms`,
    );
  }

  return {
    operationMs,
    totalPapiSelfMs,
    segments,
    control: {
      requestedRows,
      committedRows,
      callMultiset: sortedObject(callEntries),
      surfaceNames: [...capture.surfaceNames].sort(),
    },
  };
}

/** Emit a separate suite so this instrument can never replace table latency. */
export function emitPipelineRecords({
  entry,
  kase,
  scale,
  samples,
  dnfCount = 0,
  failures = [],
  attemptedCount,
}) {
  const base = {
    suite: 'pipeline',
    entry: entry.id,
    workload: kase.name,
    scale,
    dnfCount,
    failures,
    attemptedCount,
    acceptedCount: samples.length,
  };
  const detailSamples = samples.map((sample) => sample.control);
  const records = [
    makeRecord({
      ...base,
      metric: 'operationTime',
      boundary: BOUNDARIES.pipelineOperation,
      unit: 'ms',
      samples: samples.map((sample) => sample.operationMs),
      detailSamples,
    }),
  ];

  for (const segment of PAPI_SEGMENTS) {
    const label = metricSegment(segment);
    records.push(makeRecord({
      ...base,
      metric: `papi${label}Time`,
      boundary: BOUNDARIES.papiSelfTime,
      unit: 'ms',
      samples: samples.map((sample) => sample.segments[segment].selfMs),
      detailSamples,
    }));
    records.push(makeRecord({
      ...base,
      metric: `papi${label}Calls`,
      boundary: BOUNDARIES.papiCalls,
      unit: 'count',
      samples: samples.map((sample) => sample.segments[segment].calls),
      detailSamples,
    }));
  }
  return records;
}
