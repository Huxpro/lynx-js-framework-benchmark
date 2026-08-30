import assert from 'node:assert/strict';
import test from 'node:test';

import {
  paretoFrontier,
  paretoLine,
  paretoRegimeKey,
  paretoRegimeRecords,
} from './pareto.mjs';

test('Pareto frontier keeps lower-left non-dominated points and exact ties', () => {
  const points = [
    { entry: 'small-slow', bytes: 1, fcp: 9 },
    { entry: 'middle', bytes: 3, fcp: 5 },
    { entry: 'large-fast', bytes: 7, fcp: 2 },
    { entry: 'dominated', bytes: 5, fcp: 8 },
    { entry: 'middle-tie', bytes: 3, fcp: 5 },
    { entry: 'missing', bytes: null, fcp: 1 },
  ];
  assert.deepEqual(
    paretoFrontier(points).map(({ entry }) => entry),
    ['small-slow', 'middle', 'large-fast', 'middle-tie'],
  );
  assert.deepEqual(
    paretoLine(points).map(({ entry }) => entry),
    ['small-slow', 'middle-tie', 'large-fast'],
  );
});

test('equal x or y keeps only the better point', () => {
  const points = [
    { entry: 'same-x-better', bytes: 2, fcp: 3 },
    { entry: 'same-x-worse', bytes: 2, fcp: 4 },
    { entry: 'same-y-better', bytes: 3, fcp: 2 },
    { entry: 'same-y-worse', bytes: 4, fcp: 2 },
  ];
  assert.deepEqual(
    paretoFrontier(points).map(({ entry }) => entry),
    ['same-x-better', 'same-y-better'],
  );
});

test('Pareto joins only the default Web JIT 1x regime', () => {
  const records = [
    { id: 'legacy-default', harness: 'web' },
    { id: 'jit-1x', harness: 'web', jsRegime: 'jit', jsFlags: '--expose-gc', cpuThrottle: 1 },
    { id: 'interp-1x', harness: 'web', jsRegime: 'interp', jsFlags: '--expose-gc,--no-opt,--no-sparkplug,--no-maglev', cpuThrottle: 1 },
    { id: 'interp-4x', harness: 'web', jsRegime: 'interp', jsFlags: '--expose-gc,--no-opt,--no-sparkplug,--no-maglev', cpuThrottle: 4 },
    { id: 'native', harness: 'native' },
  ];
  assert.deepEqual(
    paretoRegimeRecords(records).map(({ id }) => id),
    ['legacy-default', 'jit-1x'],
  );
  assert.equal(paretoRegimeKey(records[0]), 'web:jit:--expose-gc:1');
});

test('Pareto frontier fails closed instead of pooling regime lanes', () => {
  assert.throws(() => paretoFrontier([
    { entry: 'jit', bytes: 2, fcp: 5, regimeKey: 'web:jit:--expose-gc:1' },
    { entry: 'interp', bytes: 3, fcp: 4, regimeKey: 'web:interp:--expose-gc,--no-opt:1' },
  ]), /cannot mix regimes/);
});
