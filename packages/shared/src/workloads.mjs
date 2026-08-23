// The workload contract: every entry app renders the same krausest-style
// table and is driven through the same buttons/cells (see docs/DESIGN.md).
// A case is data, not code — the harness interprets these specs.
//
// pre-states:
//   empty        fresh table
//   rows:N       table populated with N rows (via the Create button)
//   rows:N+sel   N rows with one row pre-selected (steady-state select)

export const READY_TEXT = 'Benchmark on Lynx';

export const CREATE_BUTTON = {
  1000: 'Create 1,000 rows',
  3000: 'Create 3,000 rows',
  5000: 'Create 5,000 rows',
  10000: 'Create 10,000 rows',
  20000: 'Create 20,000 rows',
  30000: 'Create 30,000 rows',
};

export const STORM_UPDATE_TICKS = 50;
export const STORM_SELECT_TICKS = 30;

// suite: "table" — interactive ops, measured pointerdown → dom-predicate.
// `scales` lists the row counts the op runs at; `defaultScales` is the
// standard run, the rest are reachable with --scale.
export const TABLE_CASES = [
  {
    name: 'create',
    pre: 'empty',
    trigger: { button: (scale) => CREATE_BUTTON[scale] },
    predicate: (scale) => ({ type: 'rowCount', value: scale }),
    scales: [1000, 3000, 5000, 10000, 20000, 30000],
    defaultScales: [1000, 10000],
    timeoutMs: 240000,
  },
  {
    name: 'replace',
    pre: 'rows',
    // expected id is computed by the harness: last row's id + 1 (ids are
    // globally monotonic in every entry's buildData)
    trigger: { button: (scale) => CREATE_BUTTON[scale] },
    predicate: 'replace-first-id',
    scales: [1000],
    defaultScales: [1000],
  },
  {
    name: 'append1k',
    pre: 'rows',
    trigger: { button: () => 'Append 1,000 rows' },
    predicate: (scale) => ({ type: 'rowCount', value: scale + 1000 }),
    scales: [1000],
    defaultScales: [1000],
  },
  {
    name: 'update10th',
    pre: 'rows',
    // expected label is computed by the harness from labelAt(0) + ' !!!'
    trigger: { button: () => 'Update every 10th row' },
    predicate: 'label0-suffixed',
    scales: [1000, 10000],
    defaultScales: [1000, 10000],
  },
  {
    // Web js-framework-benchmark parity: select a row from an unselected 1k
    // table. Keep the existing `select` case below as the steady-state Lynx
    // extension, where moving selection changes both the old and new rows.
    name: 'selectInitial',
    pre: 'rows',
    trigger: { cell: { rowIndex: 1, cls: 'col-label' } },
    predicate: () => ({ type: 'dangerAt', index: 1 }),
    scales: [1000],
    defaultScales: [1000],
    harnesses: ['web'],
  },
  {
    name: 'select',
    pre: 'rows+preselect',
    trigger: { cell: { rowIndex: 1, cls: 'col-label' } },
    predicate: () => ({ type: 'dangerAt', index: 1 }),
    scales: [1000, 10000],
    defaultScales: [1000, 10000],
  },
  {
    name: 'swap',
    pre: 'rows',
    trigger: { button: () => 'Swap Rows' },
    predicate: 'swap-1-998',
    scales: [1000],
    defaultScales: [1000],
  },
  {
    name: 'remove',
    pre: 'rows',
    trigger: { cell: { rowIndex: 2, cls: 'col-remove' } },
    predicate: (scale) => ({ type: 'rowCount', value: scale - 1 }),
    scales: [1000],
    defaultScales: [1000],
  },
  {
    name: 'clear',
    pre: 'rows',
    trigger: { button: () => 'Clear' },
    predicate: () => ({ type: 'rowCount', value: 0 }),
    // 1k is the Web js-framework-benchmark workload; 10k is the existing
    // Lynx scale/memory extension. Native retains its published 10k contract.
    scales: [1000, 10000],
    defaultScales: [1000, 10000],
    nativeScales: [10000],
  },
];

// Archived experiment definitions. These are intentionally excluded from the
// featured matrix: the current entry apps do not share one black-box scheduling
// contract for each intermediate tick, so their storm timings are not rankings.
export const EXPERIMENTAL_STORM_CASES = [
  {
    name: 'updateStorm',
    pre: 'rows',
    freshPage: true,
    trigger: { button: () => 'Update storm' },
    predicate: () => ({ type: 'labelAt', index: 0, equals: `bench ${STORM_UPDATE_TICKS}` }),
    scales: [1000, 3000, 5000, 10000, 20000, 30000],
    defaultScales: [1000, 10000],
    timeoutMs: 240000,
  },
  {
    name: 'selectStorm',
    pre: 'rows',
    freshPage: true,
    trigger: { button: () => 'Select storm' },
    predicate: () => ({ type: 'dangerAt', index: 0 }),
    scales: [1000, 3000, 5000, 10000, 20000, 30000],
    defaultScales: [1000, 10000],
    timeoutMs: 240000,
  },
];

// suite: "startup" — view attach → first content / settled, measured on the
// autoRows bundle variants. scale = pre-populated row count.
export const STARTUP_CASES = [
  {
    name: 'startup',
    scales: [0, 1000, 10000, 30000],
    defaultScales: [0, 1000, 10000, 30000],
    minContent: 5,
    timeoutMs: 240000,
  },
];

export function tableCase(name) {
  const c = [...TABLE_CASES, ...EXPERIMENTAL_STORM_CASES].find((c) => c.name === name);
  if (!c) throw new Error(`unknown table case: ${name}`);
  return c;
}

/** Resolve the shared table contract for one harness without mutating it. */
export function tableCasesForHarness(harness) {
  return TABLE_CASES.flatMap((kase) => {
    if (kase.harnesses != null && !kase.harnesses.includes(harness)) return [];
    const scales = harness === 'native' && kase.nativeScales != null
      ? kase.nativeScales
      : kase.scales;
    return scales.length === 0 ? [] : [{ ...kase, scales: [...scales] }];
  });
}
