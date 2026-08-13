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

const writeRun = (root, file, {
  machineId, score, entries, generatedAt = '2026-01-01T00:00:00Z',
}) => {
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

test('collector ignores stale aggregate snapshots and re-derives display detail from source observations', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-bench-collect-'));
  fs.mkdirSync(path.join(root, 'results/runs'), { recursive: true });
  try {
    const wire = {
      ...record('react'),
      metric: 'wireToMtsBytes',
      unit: 'bytes',
      boundary: 'wire',
      samples: [100, 300, 900],
      n: 99,
      median: 777,
      mean: 777,
      min: 777,
      p95: 777,
      detail: { byName: { stale: { messages: 9, bytes: 777 } } },
      detailSamples: [
        { byName: { first: { messages: 1, bytes: 100 } } },
        { byName: { middle: { messages: 2, bytes: 300 } } },
        { byName: { last: { messages: 3, bytes: 900 } } },
      ],
    };
    const scalar = {
      ...record('react', 'memory'),
      metric: 'heapMts',
      boundary: 'heap',
      unit: 'bytes',
      samples: null,
      n: 1,
      median: 42,
      mean: 999,
      min: 999,
    };
    fs.writeFileSync(path.join(root, 'results/runs/z-old-name.json'), JSON.stringify({
      schemaVersion: 2,
      meta: {
        generatedAt: '2026-01-04T00:00:00Z',
        machine: machine('a'),
        calibration: { probeVersion: 1, score: 100 },
      },
      records: [wire, scalar],
    }));

    const out = collectRuns({
      root,
      log: () => {},
      entryTiers: entryTiers(['react']),
    });
    const derivedWire = out.comparisonRecords.find((r) => r.metric === 'wireToMtsBytes');
    assert.equal(derivedWire.n, 3);
    assert.equal(derivedWire.median, 300);
    assert.equal(derivedWire.mean, 1300 / 3);
    assert.equal(derivedWire.min, 100);
    assert.equal(derivedWire.max, 900);
    assert.deepEqual(derivedWire.detail, wire.detailSamples[1]);
    assert.equal(derivedWire.detailKind, 'sample-nearest-median');

    const derivedScalar = out.comparisonRecords.find((r) => r.metric === 'heapMts');
    assert.equal(derivedScalar.value, 42);
    assert.equal(derivedScalar.mean, 42);
    assert.equal(derivedScalar.min, 42);
    assert.equal(out.generatedAt, '2026-01-04T00:00:00Z');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('newest-per-cell uses source generatedAt rather than a misleading filename', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-bench-collect-'));
  fs.mkdirSync(path.join(root, 'results/runs'), { recursive: true });
  try {
    writeRun(root, 'z-looks-new.json', {
      machineId: 'a', score: 100, entries: ['react'], generatedAt: '2026-01-01T00:00:00Z',
    });
    const newer = {
      schemaVersion: 2,
      meta: {
        generatedAt: '2026-01-02T00:00:00Z',
        machine: machine('a'),
        calibration: { probeVersion: 1, score: 101 },
      },
      records: [{ ...record('react'), samples: [2], median: 1 }],
    };
    fs.writeFileSync(path.join(root, 'results/runs/a-looks-old.json'), JSON.stringify(newer));

    const out = collectRuns({ root, log: () => {}, entryTiers: entryTiers(['react']) });
    const latest = out.records.find((r) => r.entry === 'react' && r.metric === 'latency');
    assert.equal(latest.runFile, 'a-looks-old.json');
    assert.equal(latest.median, 2);
    assert.equal(out.machines.a.latestCalibration.score, 101);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('collector rejects ambiguous duplicate source cells', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-bench-collect-'));
  fs.mkdirSync(path.join(root, 'results/runs'), { recursive: true });
  try {
    const duplicated = record('react');
    fs.writeFileSync(path.join(root, 'results/runs/duplicate.json'), JSON.stringify({
      schemaVersion: 2,
      meta: {
        generatedAt: '2026-01-01T00:00:00Z',
        machine: machine('a'),
        calibration: { probeVersion: 1, score: 100 },
      },
      records: [duplicated, { ...duplicated, median: 999 }],
    }));
    assert.throws(
      () => collectRuns({ root, log: () => {}, entryTiers: entryTiers(['react']) }),
      /duplicate source record/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
