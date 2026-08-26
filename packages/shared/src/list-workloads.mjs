export const LIST_WORKLOAD_CONTRACT_VERSION = 'lynx-list-workloads-v1';
export const LIST_FIXTURE_PROTOCOL = 'lynx-list-fixture-v1';

export const LIST_SOURCE_METRIC_CONTRACTS = Object.freeze({
  firstVisibleContentMs: Object.freeze({
    unit: 'ms', boundary: 'list-attach-to-first-visible-content-frame',
  }),
  operationTimeMs: Object.freeze({
    unit: 'ms', boundary: 'list-one-viewport-scroll-input-to-presented-frame',
  }),
  recycledCells: Object.freeze({
    unit: 'cells', boundary: 'list-visible-cell-key-replacement-count-during-one-viewport-scroll',
  }),
  wireToMtsBytes: Object.freeze({
    unit: 'bytes', boundary: 'list-host-transport-during-one-viewport-scroll',
  }),
  wireToBtsBytes: Object.freeze({
    unit: 'bytes', boundary: 'list-host-transport-during-one-viewport-scroll',
  }),
  elapsedMs: Object.freeze({
    unit: 'ms', boundary: 'list-fixed-velocity-fling-input-to-terminal-presented-frame',
  }),
  materializedCells: Object.freeze({
    unit: 'cells', boundary: 'list-visible-cell-first-appearance-count-during-fling',
  }),
  blankFrames: Object.freeze({
    unit: 'frames', boundary: 'list-presented-frame-with-zero-expected-visible-cells-count',
  }),
  materializationTimesMs: Object.freeze({
    unit: 'ms', boundary: 'list-expected-viewport-entry-to-first-visible-presented-frame',
  }),
});

export const LIST_CONFIG = Object.freeze({
  viewport: Object.freeze({ widthPx: 390, heightPx: 640 }),
  row: Object.freeze({ estimatedHeightPx: 40, itemKey: 'id' }),
  buffer: Object.freeze({ leadingRows: 2, trailingRows: 2 }),
  recycle: Object.freeze({ distancePx: 640, repetitions: 20 }),
  fling: Object.freeze({ velocityPxPerSecond: 4800, durationMs: 1500 }),
  observation: Object.freeze({
    web: 'composed-dom-visible-list-cell-window-v1',
    native: 'native-visible-list-cell-tree-v1',
  }),
  input: Object.freeze({
    web: Object.freeze({
      recycle: 'shared-wheel-one-viewport-v1',
      fling: 'shared-pointer-wheel-velocity-schedule-v1',
    }),
    native: Object.freeze({
      recycle: 'shared-touch-drag-one-viewport-v1',
      fling: 'shared-native-touch-fling-velocity-v1',
    }),
  }),
  semantics: Object.freeze({
    materializedCell: 'stable-item-key-first-visible-at-presented-frame-v1',
    blankFrame: 'presented-frame-with-zero-expected-visible-cells-v1',
  }),
});

// Cases are data. A fixture implements this contract once; the shared harness
// supplies the viewport movement and observes the host boundary. Applications
// never call renderer-internal recycling APIs such as componentAtIndex.
export const LIST_CASES = Object.freeze([
  Object.freeze({
    name: 'list-startup',
    scales: Object.freeze([1000, 10000]),
    stimulus: 'attach-prepopulated-list',
    sourceMetrics: Object.freeze(['firstVisibleContentMs']),
    derivedMetrics: Object.freeze([]),
  }),
  Object.freeze({
    name: 'list-recycle',
    scales: Object.freeze([10000]),
    stimulus: 'scroll-exactly-one-viewport',
    sourceMetrics: Object.freeze([
      'operationTimeMs', 'recycledCells', 'wireToMtsBytes', 'wireToBtsBytes',
    ]),
    derivedMetrics: Object.freeze([
      'timePerRecycledCellMs', 'wireToMtsBytesPerCell', 'wireToBtsBytesPerCell',
    ]),
  }),
  Object.freeze({
    name: 'list-fling',
    scales: Object.freeze([10000]),
    stimulus: 'fixed-velocity-fling',
    sourceMetrics: Object.freeze([
      'elapsedMs', 'materializedCells', 'blankFrames', 'materializationTimesMs',
    ]),
    derivedMetrics: Object.freeze([
      'materializedCellsPerSecond', 'materializationP50Ms', 'materializationP99Ms',
    ]),
  }),
]);

export const LIST_WORKLOAD_CONTRACT = Object.freeze({
  version: LIST_WORKLOAD_CONTRACT_VERSION,
  fixtureProtocol: LIST_FIXTURE_PROTOCOL,
  config: LIST_CONFIG,
  cases: LIST_CASES,
  sourceMetricContracts: LIST_SOURCE_METRIC_CONTRACTS,
});

export function listCaseKey({ entry, harness, workload, scale }) {
  return [entry, harness, workload, scale].join('|');
}
