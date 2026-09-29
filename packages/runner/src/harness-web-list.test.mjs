import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { LIST_CONFIG } from '../../shared/src/list-workloads.mjs';
import { playwrightViewport, runFixedVelocityWheel } from './harness-web-list.mjs';

test('list contract viewport is translated to Playwright width and height', () => {
  assert.deepEqual(playwrightViewport(LIST_CONFIG.viewport), {
    width: 390,
    height: 640,
  });
});

test('CLI passes the publication repetition count to the Web list harness', () => {
  const source = fs.readFileSync(new URL('./cli.mjs', import.meta.url), 'utf8');
  assert.match(source, /reps: suites\.includes\('list'\) \? listReps : reps/);
});

test('fixed-velocity wheel dispatch does not serialize on renderer backpressure', async () => {
  let clock = 0;
  const dispatchTimes = [];
  const releases = [];
  const page = {
    mouse: {
      wheel: () => {
        dispatchTimes.push(clock);
        return new Promise((resolve) => releases.push(resolve));
      },
    },
  };
  const pending = runFixedVelocityWheel(
    page,
    { velocityPxPerSecond: 4800, durationMs: 50 },
    {
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(dispatchTimes.map(Math.round), [0, 17, 33]);
  releases.forEach((resolve) => resolve());
  await pending;
});
