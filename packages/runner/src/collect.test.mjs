import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { collectRuns } from './collect.mjs';

const machine = (id) => ({
  id, hostname: id, platform: 'test', arch: 'x64', cpuModel: id, cores: 1, memGB: 1, node: 'test',
});

const record = (entry, workload = 'create') => ({
  suite: 'table', harness: 'web', environment: 'test', entry, workload, scale: 1000,
  metric: 'latency', boundary: 'test', unit: 'ms', n: 1, median: 1, mean: 1,
  std: null, min: 1, p95: null, ci95: null, samples: [1], detail: null, dnfCount: 0,
});

const writeRun = (root, file, { machineId, score, entries, generatedAt = file }) => {
  fs.writeFileSync(path.join(root, 'results/runs', file), JSON.stringify({
    schemaVersion: 2,
    meta: { generatedAt, machine: machine(machineId), calibration: { probeVersion: 1, score } },
    records: entries.map((entry) => record(entry)),
  }));
};

test('collect keeps record calibration and charts one coherent broadest run', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-bench-collect-'));
  fs.mkdirSync(path.join(root, 'results/runs'), { recursive: true });
  try {
    writeRun(root, '2026-01-01-a.json', { machineId: 'a', score: 100, entries: ['react', 'vue'] });
    writeRun(root, '2026-01-02-b.json', { machineId: 'b', score: 200, entries: ['octane'] });
    writeRun(root, '2026-01-03-a.json', { machineId: 'a', score: 110, entries: ['octane'] });

    const out = collectRuns({ root, generatedAt: 'test', log: () => {} });

    assert.equal(out.comparison.runFile, '2026-01-01-a.json');
    assert.deepEqual([...new Set(out.comparisonRecords.map((r) => r.machineId))], ['a']);
    assert.deepEqual([...new Set(out.comparisonRecords.map((r) => r.calibration.score))], [100]);
    assert.deepEqual(out.comparison.entryIds, ['react', 'vue']);

    const oldReact = out.records.find((r) => r.entry === 'react');
    const newOctane = out.records.find((r) => r.entry === 'octane' && r.machineId === 'a');
    assert.equal(oldReact.calibration.score, 100);
    assert.equal(newOctane.calibration.score, 110);
    assert.equal(out.machines.a.latestCalibration.score, 110);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('comparison tie-breaks by matrix coverage, then newest run', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-bench-collect-'));
  fs.mkdirSync(path.join(root, 'results/runs'), { recursive: true });
  try {
    writeRun(root, '2026-01-01-a.json', { machineId: 'a', score: 100, entries: ['react', 'vue'] });
    const richer = {
      schemaVersion: 2,
      meta: { generatedAt: '2026-01-02T00:00:00Z', machine: machine('b'), calibration: { probeVersion: 1, score: 200 } },
      records: [record('react'), record('vue'), record('react', 'select')],
    };
    fs.writeFileSync(path.join(root, 'results/runs/2026-01-02-b.json'), JSON.stringify(richer));
    fs.writeFileSync(path.join(root, 'results/runs/2026-01-03-c.json'), JSON.stringify({
      ...richer, meta: { ...richer.meta, generatedAt: '2026-01-03T00:00:00Z', machine: machine('c') },
    }));

    const out = collectRuns({ root, generatedAt: 'test', log: () => {} });
    assert.equal(out.comparison.runFile, '2026-01-03-c.json');
    assert.equal(out.comparison.recordCount, 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
