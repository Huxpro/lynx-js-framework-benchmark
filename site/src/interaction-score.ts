import {
  JS_FRAMEWORK_SCORE_OPS as SHARED_JS_FRAMEWORK_SCORE_OPS,
  JS_FRAMEWORK_SCORE_WEIGHTS as SHARED_JS_FRAMEWORK_SCORE_WEIGHTS,
} from '@lynx-bench/shared/scorecard';

export const INTERACTION_WORKLOADS = [
  'create', 'replace', 'append1k', 'update10th', 'select', 'swap', 'remove', 'clear',
] as const;

export const INTERACTION_SCORE_SCALES = [1000, 10000] as const;

// Exact CPU-score order and weights from js-framework-benchmark's results UI.
// The operations are measured at this lab's pointerdown → composed-DOM boundary;
// matching the upstream formula does not turn them into Chrome trace durations.
export const JS_FRAMEWORK_SCORE_OPS = SHARED_JS_FRAMEWORK_SCORE_OPS;

export const JS_FRAMEWORK_SCORE_WEIGHTS = SHARED_JS_FRAMEWORK_SCORE_WEIGHTS;
