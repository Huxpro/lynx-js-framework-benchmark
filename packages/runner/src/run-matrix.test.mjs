import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveRunMatrix, validateRunMatrix } from './run-matrix.mjs';

test('run matrix preserves formal Web and Native defaults', () => {
  const web = resolveRunMatrix({}, 'web');
  assert.deepEqual(web.suites, ['table', 'startup']);
  assert.deepEqual(web.scales, [1000, 10000]);
  assert.deepEqual(web.startupScales, [0, 1000, 10000, 30000]);
  assert.equal(web.reps, 7);
  assert.equal(web.stormReps, 3);
  assert.equal(web.startupReps, 5);
  assert.ok(web.cases.length > 0);

  const quick = resolveRunMatrix({ quick: true }, 'web');
  assert.deepEqual(quick.scales, [1000]);
  assert.deepEqual(quick.startupScales, [0, 1000, 10000, 30000]);
  assert.equal(quick.reps, 3);
  assert.equal(quick.stormReps, 1);
  assert.equal(quick.startupReps, 2);

  const native = resolveRunMatrix({}, 'native');
  assert.deepEqual(native.suites, ['table', 'startup']);
  assert.deepEqual(native.scales, [1000, 10000]);
  assert.deepEqual(native.startupScales, [0, 1000, 10000, 30000]);
  assert.equal(native.reps, 5);
  assert.equal(native.startupReps, 3);
  assert.equal(Object.hasOwn(native, 'stormReps'), false);
});

test('run matrix rejects every invalid repetition form', () => {
  for (const harness of ['web', 'native']) {
    for (const key of ['reps', 'startup-reps']) {
      for (const value of ['0', '-1', '1.5', 'NaN', 'Infinity']) {
        assert.throws(
          () => resolveRunMatrix({ [key]: value }, harness),
          new RegExp(`--${key} must be a positive safe integer`),
          `${harness} ${key}=${value}`,
        );
      }
    }
  }
  for (const value of ['0', '-1', '1.5', 'NaN', 'Infinity']) {
    assert.throws(
      () => resolveRunMatrix({ 'storm-reps': value }, 'web'),
      /--storm-reps must be a positive safe integer/,
      `web storm-reps=${value}`,
    );
  }
});

test('run matrix rejects blank, invalid, and duplicate scales', () => {
  for (const harness of ['web', 'native']) {
    for (const value of [',1000', '1000,', '1000,,10000']) {
      assert.throws(
        () => resolveRunMatrix({ scale: value }, harness),
        /--scale must not contain blank tokens/,
        `${harness} scale=${value}`,
      );
    }
    for (const value of ['-1', '-0', '1.5', 'NaN', 'Infinity', '9007199254740992']) {
      assert.throws(
        () => resolveRunMatrix({ scale: value }, harness),
        /--scale must contain non-negative safe integers/,
        `${harness} scale=${value}`,
      );
    }
    for (const value of ['1000,1000', '1e3,1000']) {
      assert.throws(
        () => resolveRunMatrix({ scale: value }, harness),
        /--scale must not contain duplicate/,
        `${harness} scale=${value}`,
      );
    }
  }
});

test('run matrix rejects blank or duplicate suites and cases', () => {
  for (const harness of ['web', 'native']) {
    for (const [key, values] of [
      ['suite', ['table,', ',startup', 'table,,startup', 'table,table']],
      ['case', ['create,', ',clear', 'create,,clear', 'create,create']],
    ]) {
      for (const value of values) {
        assert.throws(
          () => resolveRunMatrix({ [key]: value }, harness),
          new RegExp(`--${key} must not contain (blank|duplicate)`),
          `${harness} ${key}=${value}`,
        );
      }
    }
  }
});

test('run matrix rejects every selected case without a selected scale', () => {
  for (const harness of ['web', 'native']) {
    assert.throws(
      () => resolveRunMatrix({
        suite: 'table',
        case: 'clear',
        scale: '1000',
      }, harness),
      /requested table matrix drops case clear/,
    );
    assert.throws(
      () => resolveRunMatrix({
        suite: 'table',
        case: 'create,clear',
        scale: '1000',
      }, harness),
      /requested table matrix drops case clear/,
    );
  }
});

test('startup scales are exact, unique, and restricted to producer rows', () => {
  for (const harness of ['web', 'native']) {
    assert.deepEqual(
      resolveRunMatrix({ suite: 'startup', scale: '0,10000' }, harness).startupScales,
      [0, 10000],
    );
    for (const scale of ['2000', '3000']) {
      assert.throws(
        () => resolveRunMatrix({ suite: 'startup', scale }, harness),
        /startupScales must be a subset of 0,1000,10000,30000/,
      );
    }
  }
  assert.deepEqual(
    resolveRunMatrix({}, 'web', { exactStartupScales: true }).startupScales,
    [1000, 10000],
  );
});

test('direct matrix validation rejects invalid Native inputs before execution', () => {
  const valid = {
    cases: ['create'],
    suites: ['table', 'startup'],
    scales: [1000],
    startupScales: [0, 1000],
    reps: 1,
    startupReps: 1,
    stormReps: null,
  };
  assert.throws(
    () => validateRunMatrix({ ...valid, quick: true }, 'native'),
    /--quick is not supported/,
  );
  assert.throws(
    () => validateRunMatrix({ ...valid, stormReps: 1 }, 'native'),
    /--storm-reps is not supported/,
  );
  assert.throws(
    () => validateRunMatrix({ ...valid, scales: [1000, 1000] }, 'native'),
    /duplicate scales/,
  );
  assert.throws(
    () => validateRunMatrix({ ...valid, startupScales: [2000] }, 'native'),
    /subset of 0,1000,10000,30000/,
  );
});
