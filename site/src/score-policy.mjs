const cell = (suite, workload, scale, metric) => Object.freeze({ suite, workload, scale, metric });

const interactive1k = Object.freeze([
  cell('table', 'create', 1000, 'latency'),
  cell('table', 'replace', 1000, 'latency'),
  cell('table', 'append1k', 1000, 'latency'),
  cell('table', 'update10th', 1000, 'latency'),
  cell('table', 'select', 1000, 'latency'),
  cell('table', 'swap', 1000, 'latency'),
  cell('table', 'remove', 1000, 'latency'),
]);

const interactive10k = Object.freeze([
  cell('table', 'create', 10000, 'latency'),
  cell('table', 'update10th', 10000, 'latency'),
  cell('table', 'select', 10000, 'latency'),
  cell('table', 'clear', 10000, 'latency'),
]);

const profile = (key, label, cells) => Object.freeze({ key, label, cells: Object.freeze(cells) });

// Scoring policy is explicit instead of being inferred from whatever records happen to exist.
// Adding a measured cell must not silently change every published score's denominator.
export const SCORE_PROFILES = Object.freeze({
  interactive: profile('interactive', 'interactive overall', [...interactive1k, ...interactive10k]),
  interactive1k: profile('interactive1k', 'interactive @1k', [...interactive1k]),
  interactive10k: profile('interactive10k', 'interactive @10k', [...interactive10k]),
  storms: profile('storms', 'storms', [
    cell('table', 'updateStorm', 1000, 'latency'),
    cell('table', 'updateStorm', 10000, 'latency'),
    cell('table', 'selectStorm', 1000, 'latency'),
    cell('table', 'selectStorm', 10000, 'latency'),
  ]),
  startup: profile('startup', 'startup', [
    cell('startup', 'startup', 0, 'fcp'),
    cell('startup', 'startup', 1000, 'fcp'),
    cell('startup', 'startup', 10000, 'fcp'),
    cell('startup', 'startup', 30000, 'fcp'),
  ]),
});

export const HEATMAP_SCORE_KEYS = Object.freeze(['interactive', 'storms', 'startup']);

export const scoreCellKey = (scoreCell) => `${scoreCell.suite}:${scoreCell.metric}:${scoreCell.workload}@${scoreCell.scale}`;

