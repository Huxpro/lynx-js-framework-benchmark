import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const script = new URL('./audit-memory-runs.mjs', import.meta.url);
const metrics = [
  ['memoryPeak', 'heapMtsPeak', 'ungc-heap-at-post-create-10k-rows'],
  ['memoryPeak', 'heapBtsPeak', 'ungc-heap-at-post-create-10k-rows'],
  ['memory', 'heapMts', 'gc-heap-with-10k-rows'],
  ['memory', 'heapBts', 'gc-heap-with-10k-rows'],
  ['memoryAfterClear', 'heapMtsAfterClear', 'gc-heap-after-clearing-10k-rows'],
  ['memoryAfterClear', 'heapBtsAfterClear', 'gc-heap-after-clearing-10k-rows'],
];

function record(entry, workload, metric, boundary, value) {
  return {
    suite: 'table',
    harness: 'web',
    entry,
    workload,
    scale: 10000,
    metric,
    boundary,
    unit: 'bytes',
    value,
    dnfCount: 0,
    failures: [],
  };
}

test('memory audit keeps three arms paired and gates every M0 heap phase', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-memory-audit-'));
  try {
    const runs = [];
    for (let index = 0; index < 10; index++) {
      const order = index % 2 === 0
        ? ['candidate', 'm0', 'upstream']
        : ['upstream', 'm0', 'candidate'];
      const records = [];
      for (const entry of order) {
        const multiplier = entry === 'candidate' ? 0.8 : entry === 'm0' ? 1 : 1.2;
        for (const [workload, metric, boundary] of metrics) {
          records.push(record(entry, workload, metric, boundary, 1000000 * multiplier));
        }
      }
      const file = path.join(root, `run-${index}.json`);
      fs.writeFileSync(file, JSON.stringify({
        schemaVersion: 2,
        meta: {
          sessionId: `session-${index}`,
          machine: { id: 'machine', platform: 'linux' },
          browser: { name: 'chromium', version: '1' },
          environment: { jsRegime: 'jit', cpuThrottle: 1 },
          entryOrder: order,
          entryCommits: { candidate: 'candidate-sha', m0: 'm0-sha', upstream: 'upstream-sha' },
          receipt: {
            repository: { commit: 'harness-sha', dirty: false, diffSha256: null },
            comparabilityCohort: 'sha256:cohort',
            entryBundles: {},
          },
        },
        records,
      }));
      runs.push(file);
    }
    const output = path.join(root, 'audit.json');
    const args = [
      '--candidate', 'candidate',
      '--baseline', 'm0',
      '--upstream', 'upstream',
      '--output', output,
      ...runs.flatMap((file) => ['--run', file]),
    ];
    execFileSync(process.execPath, [script.pathname, ...args]);
    const audit = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.equal(audit.decision.pass, true);
    assert.equal(audit.protocol.sessions, 10);
    assert.deepEqual(audit.protocol.orderCounts, {
      baseline: { candidateFirst: 5, comparatorFirst: 5 },
      upstream: { candidateFirst: 5, comparatorFirst: 5 },
    });
    assert.equal(Object.keys(audit.versusM0).length, 6);
    assert.equal(audit.versusM0.mtsPeak.point, 0.8);
    assert.ok(Math.abs(audit.versusUpstream.mtsAfterClear.point - 2 / 3) < 1e-12);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
