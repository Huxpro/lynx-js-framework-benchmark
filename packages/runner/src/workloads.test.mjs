import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TABLE_CASES,
  tableCasesForHarness,
} from '@lynx-bench/shared/workloads';

const byName = (cases, name) => cases.find((kase) => kase.name === name);

test('Web exposes the complete js-framework-benchmark CPU workload states', () => {
  const web = tableCasesForHarness('web');
  const standardCells = [
    ['create', 1000],
    ['replace', 1000],
    ['update10th', 1000],
    ['selectInitial', 1000],
    ['swap', 1000],
    ['remove', 1000],
    ['create', 10000],
    ['append1k', 1000],
    ['clear', 1000],
  ];

  for (const [name, scale] of standardCells) {
    assert.ok(byName(web, name)?.scales.includes(scale), `missing Web ${name}@${scale}`);
  }
  assert.equal(byName(web, 'selectInitial').pre, 'rows');
  assert.deepEqual(byName(web, 'clear').scales, [1000, 10000]);
});

test('Web parity additions do not expand the published Native matrix', () => {
  const native = tableCasesForHarness('native');

  assert.equal(byName(native, 'selectInitial'), undefined);
  assert.deepEqual(byName(native, 'clear').scales, [10000]);
  assert.equal(native.reduce((total, kase) => total + kase.scales.length, 0), 15);
  assert.equal(TABLE_CASES.some((kase) => kase.name === 'selectInitial'), true);
});
