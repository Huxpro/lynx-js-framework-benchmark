import { canonicalMetricKey } from '@lynx-bench/shared/schema';
import { TABLE_CASES } from '@lynx-bench/shared/workloads';

const WEB_TABLE_METRICS = [
  ['latency', 'pointerdown-to-dom-predicate', 'ms'],
  ['btsCpu', 'sampled-js-cpu-background-realm', 'ms'],
  ['mtsCpu', 'sampled-js-cpu-ui-thread', 'ms'],
  ['wireToBtsBytes', 'web-core-rpc-channel', 'bytes'],
  ['wireToBtsMsgs', 'web-core-rpc-channel', 'count'],
  ['wireToMtsBytes', 'web-core-rpc-channel', 'bytes'],
  ['wireToMtsMsgs', 'web-core-rpc-channel', 'count'],
];
const WEB_STARTUP_METRICS = [
  ['fcp', 'view-attach-to-first-content', 'ms'],
  ['settled', 'view-attach-to-dom-settled', 'ms'],
  ['mtsCpu', 'sampled-js-cpu-ui-thread', 'ms'],
  ['wireToMtsBytes', 'web-core-rpc-channel', 'bytes'],
  ['wireToBtsBytes', 'web-core-rpc-channel', 'bytes'],
];
const BUNDLE_METRICS = [
  'bundleWebRaw',
  'bundleWebGzip',
  'mtsSectionRaw',
  'mtsSectionGzip',
  'btsSectionRaw',
  'btsSectionGzip',
  'bundleLynxRaw',
  'bundleLynxGzip',
];

function record({
  suite,
  harness,
  environment,
  workload,
  scale,
  metric,
  boundary,
  unit,
}) {
  return {
    suite,
    harness,
    environment,
    workload,
    scale,
    metric,
    boundary,
    unit,
  };
}

export function expectedVueVaporKeys(variant, {
  nativeEnvironment,
  webEnvironment = 'lynx-for-web',
} = {}) {
  if (typeof nativeEnvironment !== 'string' || nativeEnvironment.length === 0) {
    throw new Error('nativeEnvironment is required for expected coverage');
  }
  const keys = [];
  for (const candidate of TABLE_CASES) {
    for (const scale of candidate.scales) {
      for (const [metric, boundary, unit] of WEB_TABLE_METRICS) {
        keys.push(canonicalMetricKey(record({
          suite: 'table',
          harness: 'web',
          environment: webEnvironment,
          workload: candidate.name,
          scale,
          metric,
          boundary,
          unit,
        }), variant));
      }
      keys.push(canonicalMetricKey(record({
        suite: 'table',
        harness: 'native',
        environment: nativeEnvironment,
        workload: candidate.name,
        scale,
        metric: 'latency',
        boundary: 'native-input-handler-to-second-native-frame',
        unit: 'ms',
      }), variant));
    }
  }
  for (const metric of ['heapMts', 'heapBts']) {
    keys.push(canonicalMetricKey(record({
      suite: 'table',
      harness: 'web',
      environment: webEnvironment,
      workload: 'memory',
      scale: 10000,
      metric,
      boundary: 'gc-heap-with-10k-rows',
      unit: 'bytes',
    }), variant));
  }
  for (const scale of [0, 1000, 10000, 30000]) {
    for (const [metric, boundary, unit] of WEB_STARTUP_METRICS) {
      keys.push(canonicalMetricKey(record({
        suite: 'startup',
        harness: 'web',
        environment: webEnvironment,
        workload: 'startup',
        scale,
        metric,
        boundary,
        unit,
      }), variant));
    }
    for (const [metric, boundary] of [
      ['fcp', 'native-open-to-fcp'],
      ['settled', 'native-open-to-pipeline-end'],
    ]) {
      keys.push(canonicalMetricKey(record({
        suite: 'startup',
        harness: 'native',
        environment: nativeEnvironment,
        workload: 'startup',
        scale,
        metric,
        boundary,
        unit: 'ms',
      }), variant));
    }
  }
  for (const metric of BUNDLE_METRICS) {
    keys.push(canonicalMetricKey(record({
      suite: 'bundle',
      harness: 'web',
      environment: webEnvironment,
      workload: 'bundle',
      scale: 0,
      metric,
      boundary: 'static',
      unit: 'bytes',
    }), variant));
  }
  return [...new Set(keys)].sort();
}

export function expectedVueVaporCoverage(environments) {
  const keys = [
    ...expectedVueVaporKeys('vapor', environments),
    ...expectedVueVaporKeys('ifr', environments),
  ].sort();
  const web = keys.filter((key) => JSON.parse(key)[2] === 'web');
  const native = keys.filter((key) => JSON.parse(key)[2] === 'native');
  if (web.length !== 438 || native.length !== 70 || keys.length !== 508) {
    throw new Error(
      `coverage construction mismatch: web=${web.length} native=${native.length} total=${keys.length}`,
    );
  }
  return { keys, web, native };
}
