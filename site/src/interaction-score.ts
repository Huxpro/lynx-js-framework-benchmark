export const INTERACTION_WORKLOADS = [
  'create', 'replace', 'append1k', 'update10th', 'select', 'swap', 'remove', 'clear',
] as const;

// Exact CPU-score order and weights from js-framework-benchmark's results UI.
// The operations are measured at this lab's pointerdown → composed-DOM boundary;
// matching the upstream formula does not turn them into Chrome trace durations.
export const JS_FRAMEWORK_SCORE_OPS = [
  { key: 'create@1000', label: 'create 1k', workload: 'create', scale: 1000, weight: 0.64280248137063 },
  { key: 'replace@1000', label: 'replace 1k', workload: 'replace', scale: 1000, weight: 0.5607178150466176 },
  { key: 'update10th@1000', label: 'update 10th', workload: 'update10th', scale: 1000, weight: 0.5643800750716564 },
  { key: 'select@1000', label: 'select row', workload: 'select', scale: 1000, weight: 0.1925635870170522 },
  { key: 'swap@1000', label: 'swap rows', workload: 'swap', scale: 1000, weight: 0.13200612879341714 },
  { key: 'remove@1000', label: 'remove row', workload: 'remove', scale: 1000, weight: 0.5277091212292658 },
  { key: 'create@10000', label: 'create 10k', workload: 'create', scale: 10000, weight: 0.5644449600965534 },
  { key: 'append1k@1000', label: 'append 1k', workload: 'append1k', scale: 1000, weight: 0.5508359820582848 },
  { key: 'clear@1000', label: 'clear 1k', workload: 'clear', scale: 1000, weight: 0.4225836631419211 },
] as const;

export const JS_FRAMEWORK_SCORE_WEIGHTS = Object.fromEntries(
  JS_FRAMEWORK_SCORE_OPS.map((op) => [op.key, op.weight]),
);
