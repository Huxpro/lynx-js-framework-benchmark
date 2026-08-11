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

const entryTiers = (featured, lab = []) => new Map([
  ...featured.map((id) => [id, 'featured']),
  ...lab.map((id) => [id, 'lab']),
]);

test('collect keeps record calibration and charts one coherent broadest run', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-bench-collect-'));
  fs.mkdirSync(path.join(root, 'results/runs'), { recursive: true });
  try {
    writeRun(root, '2026-01-01-a.json', { machineId: 'a', score: 100, entries: ['react', 'vue'] });
    writeRun(root, '2026-01-02-b.json', { machineId: 'b', score: 200, entries: ['octane'] });
    writeRun(root, '2026-01-03-a.json', { machineId: 'a', score: 110, entries: ['octane'] });

    const out = collectRuns({
      root,
      generatedAt: 'test',
      log: () => {},
      entryTiers: entryTiers(['react', 'vue', 'octane']),
    });

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

    const out = collectRuns({
      root,
      generatedAt: 'test',
      log: () => {},
      entryTiers: entryTiers(['react', 'vue']),
    });
    assert.equal(out.comparison.runFile, '2026-01-03-c.json');
    assert.equal(out.comparison.recordCount, 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('featured cohort wins over broad Lab run and legacy Octane IDs become calibrated estimates', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-bench-collect-'));
  fs.mkdirSync(path.join(root, 'results/runs'), { recursive: true });
  try {
    const oldRun = {
      schemaVersion: 2,
      meta: {
        generatedAt: '2026-01-01T00:00:00Z',
        machine: machine('old'),
        calibration: { probeVersion: 1, score: 100 },
        entryCommits: {
          octane: '4a53620fe811a016cb9966fab53ca181a89159c8',
          'octane-main': 'prior-sha',
        },
      },
      records: [record('react'), { ...record('octane'), median: 10, mean: 10, min: 10, samples: [10] }, {
        ...record('octane-main'), metric: 'wireToMtsBytes', unit: 'bytes', median: 42, mean: 42, min: 42, samples: [42],
      }],
    };
    fs.writeFileSync(path.join(root, 'results/runs/2026-01-01-old.json'), JSON.stringify(oldRun));
    writeRun(root, '2026-01-02-current.json', {
      machineId: 'current', score: 200, entries: ['react', 'octane'], generatedAt: '2026-01-02T00:00:00Z',
    });

    const out = collectRuns({
      root,
      generatedAt: 'test',
      log: () => {},
      entryTiers: entryTiers(['react', 'octane'], ['octane-hux1', 'octane-prior']),
    });

    assert.equal(out.comparison.runFile, '2026-01-02-current.json');
    assert.deepEqual(out.comparison.entryIds, ['octane', 'react']);
    assert.equal(out.comparisonRecords.every((r) => r.comparisonKind === 'same-run'), true);

    const hux1 = out.labComparisonRecords.find((r) => r.entry === 'octane-hux1');
    assert.equal(hux1.sourceEntry, 'octane');
    assert.equal(hux1.entryCommit, '4a53620fe811a016cb9966fab53ca181a89159c8');
    assert.equal(hux1.sourceMedian, 10);
    assert.equal(hux1.median, 5);
    assert.equal(hux1.calibrationRatio, 0.5);
    assert.equal(hux1.comparisonKind, 'calibrated-estimate');

    const prior = out.labComparisonRecords.find((r) => r.entry === 'octane-prior');
    assert.equal(prior.median, 42);
    assert.equal(prior.comparisonKind, 'historical');
    assert.equal(prior.calibrationRatio, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
