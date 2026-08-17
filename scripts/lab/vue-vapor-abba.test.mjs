import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  createAbbaPlan,
  executeAbbaPlan,
} from './vue-vapor-abba.mjs';

test('ABBA helper emits four isolated single-entry commands without conclusions', () => {
  const plan = createAbbaPlan({
    a: 'vue-vapor-a',
    b: 'vue-vapor-b',
    labRoot: path.join(process.cwd(), '.tmp/vue-vapor-lab'),
    runArgs: ['--suite', 'startup', '--scale', '10000', '--startup-reps', '7'],
  });
  assert.deepEqual(plan.map(({ entry }) => entry), [
    'vue-vapor-a',
    'vue-vapor-b',
    'vue-vapor-b',
    'vue-vapor-a',
  ]);
  assert.deepEqual(plan.map(({ arm, ordinal }) => `${arm}${ordinal}`), [
    'A1',
    'B1',
    'B2',
    'A2',
  ]);
  for (const step of plan) {
    assert.equal(step.argv.filter((argument) => argument === '--entry').length, 1);
    assert.equal(step.argv.includes('--lab-root'), true);
    assert.equal(step.argv.includes('--harness'), true);
  }
  assert.throws(
    () => createAbbaPlan({
      a: 'vue-vapor-a',
      b: 'vue-vapor-b',
      labRoot: '/tmp/lab',
      runArgs: ['--entry', 'other'],
    }),
    /controlled by the ABBA helper/,
  );
  assert.throws(
    () => createAbbaPlan({
      a: 'vue-vapor-a,vue-vapor-b',
      b: 'vue-vapor-c',
      labRoot: path.join(process.cwd(), '.tmp/vue-vapor-lab'),
    }),
    /--a must match/,
  );
});

test('ABBA execute re-verifies each pinned entry before and after every spawn', () => {
  const labRoot = path.join(process.cwd(), '.tmp/vue-vapor-lab');
  const plan = createAbbaPlan({
    a: 'vue-vapor-a',
    b: 'vue-vapor-b',
    labRoot,
  });
  const pinned = new Map([
    ['vue-vapor-a', 'fingerprint-a'],
    ['vue-vapor-b', 'fingerprint-b'],
  ]);
  let spawnCount = 0;
  let replaced = false;
  assert.throws(
    () => executeAbbaPlan({
      plan,
      labRoot,
      pinned,
      verifyEntry: (entryDir, expected) => {
        const entry = path.basename(entryDir);
        const actual = replaced && entry === 'vue-vapor-a'
          ? 'replaced-a'
          : pinned.get(entry);
        if (actual !== expected) throw new Error(`${entry} changed after it was pinned`);
        return { fingerprint: actual };
      },
      spawn: () => {
        spawnCount++;
        replaced = true;
        return { status: 0 };
      },
      log: () => {},
    }),
    /changed after it was pinned/,
  );
  assert.equal(spawnCount, 1);
});
