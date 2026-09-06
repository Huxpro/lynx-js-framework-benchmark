// Frozen M0/M4 scorecard for Huxpro/octane#282. Keep this in the shared
// package: the runner, collector, and site must not grow independent copies of
// the cells or weights after results are visible.

const freezeRows = (rows) =>
  Object.freeze(rows.map((row) => Object.freeze(row)));

export const JS_FRAMEWORK_SCORE_OPS = freezeRows([
  {
    key: 'create@1000',
    label: 'create 1k',
    workload: 'create',
    scale: 1000,
    weight: 0.64280248137063,
  },
  {
    key: 'replace@1000',
    label: 'replace 1k',
    workload: 'replace',
    scale: 1000,
    weight: 0.5607178150466176,
  },
  {
    key: 'update10th@1000',
    label: 'update 10th',
    workload: 'update10th',
    scale: 1000,
    weight: 0.5643800750716564,
  },
  {
    key: 'select@1000',
    label: 'select row',
    workload: 'select',
    scale: 1000,
    weight: 0.1925635870170522,
  },
  {
    key: 'swap@1000',
    label: 'swap rows',
    workload: 'swap',
    scale: 1000,
    weight: 0.13200612879341714,
  },
  {
    key: 'remove@1000',
    label: 'remove row',
    workload: 'remove',
    scale: 1000,
    weight: 0.5277091212292658,
  },
  {
    key: 'create@10000',
    label: 'create 10k',
    workload: 'create',
    scale: 10000,
    weight: 0.5644449600965534,
  },
  {
    key: 'append1k@1000',
    label: 'append 1k',
    workload: 'append1k',
    scale: 1000,
    weight: 0.5508359820582848,
  },
  {
    key: 'clear@1000',
    label: 'clear 1k',
    workload: 'clear',
    scale: 1000,
    weight: 0.4225836631419211,
  },
]);

export const JS_FRAMEWORK_SCORE_WEIGHTS = Object.freeze(
  Object.fromEntries(
    JS_FRAMEWORK_SCORE_OPS.map((operation) => [
      operation.key,
      operation.weight,
    ]),
  ),
);

const STARTUP_SCORE_OPS = freezeRows([
  {
    key: 'fcp@0',
    label: 'FCP 0',
    workload: 'startup',
    metric: 'fcp',
    scale: 0,
    weight: 1,
  },
  {
    key: 'fcp@1000',
    label: 'FCP 1k',
    workload: 'startup',
    metric: 'fcp',
    scale: 1000,
    weight: 1,
  },
  {
    key: 'fcp@10000',
    label: 'FCP 10k',
    workload: 'startup',
    metric: 'fcp',
    scale: 10000,
    weight: 1,
  },
]);

export const ROADMAP_SCORECARD = Object.freeze({
  version: 1,
  ratio: 'candidate/comparator',
  platforms: freezeRows([
    { id: 'web-jit', harness: 'web', engine: 'jit', ranking: true },
    {
      id: 'web-interpreter',
      harness: 'web',
      engine: 'interpreter',
      ranking: false,
    },
    {
      id: 'android-lepusng',
      harness: 'native',
      engine: 'lepusng',
      ranking: true,
    },
    {
      id: 'ios-native',
      harness: 'native',
      engine: 'pinned-ios-runtime',
      ranking: true,
    },
  ]),
  suites: Object.freeze({
    interaction: Object.freeze({
      aggregate: 'weighted-geomean-of-paired-ratios',
      cells: JS_FRAMEWORK_SCORE_OPS,
    }),
    startup: Object.freeze({
      aggregate: 'weighted-geomean-of-paired-ratios',
      cells: STARTUP_SCORE_OPS,
    }),
  }),
  diagnosticScales: Object.freeze({
    startup: Object.freeze([0, 1000, 10000]),
    bulk: Object.freeze([1000, 2000, 3000, 5000, 10000]),
  }),
  correctness: Object.freeze([
    'startup',
    'adoption',
    'native-tap',
    'create',
    'replace',
    'append1k',
    'remove',
    'select',
    'update10th',
    'swap',
    'clear',
    'recreate',
    'dispose',
  ]),
  correctnessAssertions: Object.freeze([
    'row-count',
    'row-text',
    'native-event',
    'survivor-identity',
    'host-structure-census',
  ]),
  engagement: Object.freeze({
    requiredPerCell: Object.freeze([
      'wire-operation',
      'load-bundle-pipeline-entry',
    ]),
    failure: 'dnf-with-reason',
  }),
  timeoutsMs: Object.freeze({ interaction: 240000, startup: 240000 }),
  statistics: Object.freeze({
    minimumPairs: 10,
    bootstrapResamples: 10000,
    confidence: 0.95,
    orderBalanceMaximumDifference: 1,
    strictWinUpperRatio: 1,
    engineeringPointRatio: 0.95,
    coreCellNonInferiorityUpperRatio: 1.05,
    outliers: 'none-removed',
    dnf: 'completeness-failure-no-renormalization',
  }),
  tail: Object.freeze({
    cells: Object.freeze(['ready', 'cold-first-hit', 'steady-interaction']),
    minimumSamples: 100,
    nonInferiorityUpperRatio: 1.05,
    groups: Object.freeze(['cold', 'warm']),
  }),
  memory: Object.freeze({
    cells: Object.freeze(['peak', 'settled', 'after-clear']),
    minimumCreateClearRecreateCycles: 20,
    m0NonInferiorityUpperRatio: 1.05,
    afterClearMustNotExceedUpstream: true,
  }),
  identity: Object.freeze({
    octaneRoles: Object.freeze([
      'historical',
      'm0-current-fork',
      'latest-upstream',
      'candidate',
    ]),
    comparators: Object.freeze(['reactlynx', 'vue-vdom', 'vue-vapor']),
    configurations: Object.freeze(['production-default', 'explicit-optimized']),
    upstreamBuild: 'source-at-pinned-sha-with-identical-toolchain',
    requiredReceipts: Object.freeze([
      'source-commit',
      'source-patch',
      'dependency-lock',
      'engine-and-toolchain',
      'configuration-capabilities',
      'bundle-sha256',
      'workload-contract-sha256',
    ]),
  }),
});
