export const LIST_WORKLOAD_CONTRACT_VERSION = 'lynx-list-workloads-v1';
// The v1 fixture protocol remains the featured Web contract. Native diagnostic
// fixtures use a separate v2 manifest with exact per-scale artifacts.
export const LIST_FIXTURE_PROTOCOL = 'lynx-list-fixture-v1';
export const NATIVE_LIST_FIXTURE_PROTOCOL = 'lynx-list-fixture-v2';
export const NATIVE_LIST_CAPABILITY_PROTOCOL = 'lynx-native-list-capability-v1';
export const NATIVE_LIST_OBSERVER_PROTOCOL = 'lynx-native-list-allocation-observer-v1';

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

export const NATIVE_LIST_VISIBLE_ROW_COUNT = Math.ceil(
  LIST_CONFIG.viewport.heightPx / LIST_CONFIG.row.estimatedHeightPx,
);
export const NATIVE_LIST_MAX_LIVE_LIST_ITEM_BOUND = NATIVE_LIST_VISIBLE_ROW_COUNT
  + LIST_CONFIG.buffer.leadingRows
  + LIST_CONFIG.buffer.trailingRows;

export const NATIVE_LIST_OBSERVER_METRIC_CONTRACTS = Object.freeze({
  peakLiveNativeListItems: Object.freeze({
    unit: 'list-items', boundary: 'native-list-attempt-peak-concurrently-live-list-items',
  }),
  cumulativeNativeListItemCreations: Object.freeze({
    unit: 'list-items', boundary: 'native-list-attempt-cumulative-list-item-creations',
  }),
  reusedNativeListItems: Object.freeze({
    unit: 'list-items', boundary: 'native-list-attempt-reused-list-items',
  }),
  remainingLiveNativeListItemsAfterTeardown: Object.freeze({
    unit: 'list-items', boundary: 'native-list-post-teardown-live-list-items',
  }),
});

// This contract is separate from LIST_WORKLOAD_CONTRACT so adding a real-device
// allocation observer does not silently change the existing Web fixture hash.
export const NATIVE_LIST_DEVICE_CLAIM_CONTRACT = Object.freeze({
  protocol: NATIVE_LIST_OBSERVER_PROTOCOL,
  observation: LIST_CONFIG.observation.native,
  visibleRows: NATIVE_LIST_VISIBLE_ROW_COUNT,
  maxLiveListItems: NATIVE_LIST_MAX_LIVE_LIST_ITEM_BOUND,
  maxLiveListItemsDerivation: 'ceil(viewport-height/estimated-row-height)+leading+trailing',
  metrics: NATIVE_LIST_OBSERVER_METRIC_CONTRACTS,
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
