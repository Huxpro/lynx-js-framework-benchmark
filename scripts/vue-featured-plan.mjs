import { spawnSync } from 'node:child_process';

import { VUE_FEATURED_CELLS } from '../packages/runner/src/vue-artifact-assertions.mjs';

export const VUE_FEATURED_ROWS = [0, 1000, 10000, 30000];

export function parseVueFeaturedRows(value) {
  const aliases = { 0: 0, '1k': 1000, '10k': 10000, '30k': 30000 };
  const parts = Array.isArray(value) ? value : String(value).split(',');
  if (parts.length === 0) {
    throw new Error('--rows must be a non-empty subset of 0,1k,10k,30k');
  }
  const rows = parts.map((part) => {
    const normalized = String(part).trim().toLowerCase();
    if (normalized.length === 0 || !/^(?:0|1000|10000|30000|1k|10k|30k)$/.test(normalized)) {
      throw new Error('--rows must be a non-empty subset of 0,1k,10k,30k');
    }
    return aliases[normalized] ?? Number(normalized);
  });
  const allowed = new Set(VUE_FEATURED_ROWS);
  if (rows.some((row) => !allowed.has(row))) {
    throw new Error('--rows must be a non-empty subset of 0,1k,10k,30k');
  }
  if (new Set(rows).size !== rows.length) {
    throw new Error('--rows must not contain duplicate rows');
  }
  return rows;
}

export function vueFeaturedSupportsAutoRows(checkout) {
  const result = spawnSync(
    'git',
    [
      'grep',
      '--quiet',
      '--extended-regexp',
      'BENCH_AUTOROWS|__BENCH_AUTOROWS__|autoRows',
      '--',
      'packages/benchmark',
    ],
    { cwd: checkout },
  );
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(
    `could not inspect autoRows support in ${checkout}: ${result.stderr?.toString().trim() ?? ''}`,
  );
}

export function vueFeaturedBuildPlan({
  lab = false,
  variant = null,
  rows = VUE_FEATURED_ROWS,
} = {}) {
  if (!lab) {
    return rows.flatMap((row) =>
      VUE_FEATURED_CELLS.map((configuration) => ({ ...configuration, rows: row })));
  }
  if (variant !== 'vapor' && variant !== 'ifr') {
    throw new Error('--lab requires --variant vapor|ifr');
  }
  const selectedId = variant === 'ifr' ? 'vue-vapor-ifr' : 'vue-vapor';
  const selected = VUE_FEATURED_CELLS.find(({ id }) => id === selectedId);
  return rows.map((row) => ({ ...selected, rows: row }));
}
