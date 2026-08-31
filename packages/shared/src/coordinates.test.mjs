import assert from 'node:assert/strict';
import test from 'node:test';

import {
  changedAxes,
  coordinateValue,
  validateCoordinates,
} from './coordinates.mjs';

const COORDINATES = {
  invalidation: 'runtime',
  recompute: 'block',
  sharing: 'compile-time-code',
  staging: 'ops',
  residency: { firstFrame: 'background', steadyState: 'background' },
  handover: 'operation-stream',
};

test('coordinates are optional but classified tuples are complete and enumerated', () => {
  assert.equal(validateCoordinates(null, 'unclassified'), null);
  assert.equal(validateCoordinates(COORDINATES, 'classified'), COORDINATES);
  assert.throws(
    () => validateCoordinates({ ...COORDINATES, staging: 'sometimes-code' }, 'free-text'),
    /must be one of ops, data, code, native/,
  );
  const { handover: _handover, ...partial } = COORDINATES;
  assert.throws(() => validateCoordinates(partial, 'partial'), /missing handover/);
});

test('residency is a typed first-frame and steady-state coordinate', () => {
  assert.equal(coordinateValue(COORDINATES, 'residency'), 'background/background');
  assert.throws(
    () => validateCoordinates({
      ...COORDINATES,
      residency: { firstFrame: 'worker', steadyState: 'background' },
    }, 'bad-residency'),
    /residency.firstFrame must be one of/,
  );
});

test('changedAxes treats the nested residency tuple as one axis', () => {
  const candidate = {
    ...COORDINATES,
    staging: 'code',
    residency: { firstFrame: 'main', steadyState: 'background' },
  };
  assert.deepEqual(changedAxes(COORDINATES, candidate), ['staging', 'residency']);
});
