import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { collectRuns } from './collect.mjs';
import { repoRoot } from './entries.mjs';

const machine = (id) => ({
  id, hostname: id, platform: 'test', arch: 'x64', cpuModel: id, cores: 1, memGB: 1, node: 'test',
});

const record = (entry, workload = 'create') => ({
  suite: 'table', harness: 'web', environment: 'test', entry, workload, scale: 1000,
  metric: 'latency', boundary: 'test', unit: 'ms', n: 1, median: 1, mean: 1,
  std: null, min: 1, p95: null, ci95: null, samples: [1], detail: null, dnfCount: 0,
});

const nativeRecord = (entry, workload = 'create', environment = 'native-test') => ({
  ...record(entry, workload), harness: 'native', environment,
  boundary: 'native-input-handler-to-second-native-frame',
});

const writeRun = (root, file, {
  machineId, score, entries, generatedAt = '2026-01-01T00:00:00Z', entryCommits = null,
}) => {
  fs.writeFileSync(path.join(root, 'results/runs', file), JSON.stringify({
    schemaVersion: 2,
    meta: {
      generatedAt,
      machine: machine(machineId),
      calibration: { probeVersion: 1, score },
      ...(entryCommits ? { entryCommits } : {}),
    },
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

test('collector combines current per-entry Native runs only on one device and ignores stale commits', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-bench-collect-'));
  fs.mkdirSync(path.join(root, 'results/runs'), { recursive: true });
  try {
    writeRun(root, 'web.json', {
      machineId: 'web', score: 100, entries: ['react', 'vue'],
      entryCommits: { react: 'react-new', vue: 'vue-new' },
    });
    const writeNative = (file, machineId, generatedAt, entry, commit, records) => {
      fs.writeFileSync(path.join(root, 'results/runs', file), JSON.stringify({
        schemaVersion: 2,
        meta: {
          generatedAt,
          machine: machine(machineId),
          calibration: null,
          entryCommits: { [entry]: commit },
        },
        records,
      }));
    };
    writeNative('native-react-stale.json', 'device-a', '2026-01-04T00:00:00Z', 'react', 'old', [
      nativeRecord('react'), nativeRecord('react', 'select'), nativeRecord('react', 'swap'),
    ]);
    writeNative('native-react-current.json', 'device-a', '2026-01-02T00:00:00Z', 'react', 'react-new', [
      nativeRecord('react'), nativeRecord('react', 'select'),
    ]);
    writeNative('native-vue-current.json', 'device-a', '2026-01-03T00:00:00Z', 'vue', 'vue-new', [
      nativeRecord('vue'), nativeRecord('vue', 'select'),
    ]);
    writeNative('native-other-device.json', 'device-b', '2026-01-05T00:00:00Z', 'react', 'react-new', [
      nativeRecord('react', 'swap'),
    ]);

    const entries = [
      { id: 'react', distDir: path.join(root, 'missing-react'), provenance: { commit: 'react-new' } },
      { id: 'vue', distDir: path.join(root, 'missing-vue'), provenance: { commit: 'vue-new' } },
    ];
    const out = collectRuns({
      root,
      generatedAt: 'test',
      log: () => {},
      entryTiers: entryTiers(['react', 'vue']),
      entries,
    });
    const native = out.comparisonRecords.filter((candidate) => candidate.harness === 'native');
    assert.equal(native.length, 4);
    assert.deepEqual([...new Set(native.map((candidate) => candidate.machineId))], ['device-a']);
    assert.deepEqual([...new Set(native.map((candidate) => candidate.comparisonKind))], ['same-machine']);
    assert.equal(native.some((candidate) => candidate.runFile === 'native-react-stale.json'), false);
    assert.deepEqual(out.comparison.harnesses[1].entryIds, ['react', 'vue']);
    assert.deepEqual(out.comparison.harnesses[1].sourceRunFiles, [
      'native-react-current.json', 'native-vue-current.json',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('collector publishes a missing Native entry as one isolated run without merging leases', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-bench-collect-'));
  fs.mkdirSync(path.join(root, 'results/runs'), { recursive: true });
  try {
    writeRun(root, 'web.json', {
      machineId: 'web', score: 100, entries: ['react', 'vue', 'octane'],
      entryCommits: { react: 'react-new', vue: 'vue-new', octane: 'octane-new' },
    });
    const writeNative = (file, machineId, generatedAt, entry, commit, records) => {
      fs.writeFileSync(path.join(root, 'results/runs', file), JSON.stringify({
        schemaVersion: 2,
        meta: {
          generatedAt,
          machine: machine(machineId),
          calibration: null,
          entryCommits: { [entry]: commit },
        },
        records,
      }));
    };
    writeNative('native-react.json', 'device-a', '2026-01-01T00:00:00Z', 'react', 'react-new', [
      nativeRecord('react'),
    ]);
    writeNative('native-vue.json', 'device-a', '2026-01-01T00:01:00Z', 'vue', 'vue-new', [
      nativeRecord('vue'),
    ]);
    writeNative('native-octane-old-lease.json', 'device-b', '2026-01-02T00:00:00Z', 'octane', 'octane-new', [
      nativeRecord('octane'),
      nativeRecord('octane', 'select'),
    ]);
    writeNative('native-octane-new-lease.json', 'device-c', '2026-01-03T00:00:00Z', 'octane', 'octane-new', [
      { ...nativeRecord('octane'), samples: [3], median: 3 },
      { ...nativeRecord('octane', 'select'), samples: [4], median: 4 },
    ]);

    const entries = [
      { id: 'react', distDir: path.join(root, 'missing-react'), provenance: { commit: 'react-new' } },
      { id: 'vue', distDir: path.join(root, 'missing-vue'), provenance: { commit: 'vue-new' } },
      { id: 'octane', distDir: path.join(root, 'missing-octane'), provenance: { commit: 'octane-new' } },
    ];
    const out = collectRuns({
      root,
      generatedAt: 'test',
      log: () => {},
      entryTiers: entryTiers(['react', 'vue', 'octane']),
      entries,
    });

    assert.deepEqual(out.comparison.harnesses[1].entryIds, ['react', 'vue']);
    assert.equal(out.comparisonRecords.some((record) =>
      record.harness === 'native' && record.entry === 'octane'), false);
    assert.deepEqual(out.nativeObservations, [{
      entryId: 'octane',
      harness: 'native',
      environment: 'native-test',
      generatedAt: '2026-01-03T00:00:00Z',
      machineId: 'device-c',
      sourceRunFile: 'native-octane-new-lease.json',
      sourceRecordCount: 2,
    }]);
    assert.deepEqual(
      out.nativeObservationRecords.map((record) => [
        record.runFile, record.machineId, record.median, record.comparisonKind,
      ]),
      [
        ['native-octane-new-lease.json', 'device-c', 3, 'isolated-observation'],
        ['native-octane-new-lease.json', 'device-c', 4, 'isolated-observation'],
      ],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('collector combines split Native suites cell-by-cell on the same device', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-bench-collect-'));
  fs.mkdirSync(path.join(root, 'results/runs'), { recursive: true });
  try {
    writeRun(root, 'web.json', {
      machineId: 'web', score: 100, entries: ['octane'], entryCommits: { octane: 'current' },
    });
    const writeNative = (file, generatedAt, records) => {
      fs.writeFileSync(path.join(root, 'results/runs', file), JSON.stringify({
        schemaVersion: 2,
        meta: {
          generatedAt,
          machine: machine('device-a'),
          calibration: null,
          entryCommits: { octane: 'current' },
        },
        records,
      }));
    };
    writeNative('native-table.json', '2026-01-02T00:00:00Z', [
      nativeRecord('octane'), nativeRecord('octane', 'select'),
    ]);
    writeNative('native-startup.json', '2026-01-03T00:00:00Z', [{
      ...nativeRecord('octane', 'startup'),
      suite: 'startup', metric: 'fcp', scale: 0, boundary: 'native-open-to-fcp',
    }, {
      ...nativeRecord('octane', 'startup'),
      suite: 'startup', metric: 'settled', scale: 0, boundary: 'native-open-to-pipeline-end',
    }]);
    fs.writeFileSync(path.join(root, 'results/runs/native-driver-diagnostic.json'), JSON.stringify({
      schemaVersion: 2,
      meta: {
        generatedAt: '2026-01-04T00:00:00Z',
        machine: { ...machine('device-a'), octaneTriggerMode: 'driver' },
        calibration: null,
        entryCommits: { octane: 'current' },
      },
      records: [{
        ...nativeRecord('octane', 'swap'),
        boundary: 'native-devtool-driver-handler-to-second-native-frame',
      }],
    }));

    const entries = [{
      id: 'octane', distDir: path.join(root, 'missing-octane'), provenance: { commit: 'current' },
    }];
    const out = collectRuns({
      root,
      generatedAt: 'test',
      log: () => {},
      entryTiers: entryTiers(['octane']),
      entries,
    });
    const native = out.comparisonRecords.filter((candidate) => candidate.harness === 'native');
    assert.equal(native.length, 4);
    assert.deepEqual(out.comparison.harnesses[1].sourceRunFiles, [
      'native-startup.json', 'native-table.json',
    ]);
    assert.deepEqual(new Set(native.map((candidate) => candidate.suite)), new Set(['table', 'startup']));
    assert.equal(native.some((candidate) => candidate.runFile === 'native-driver-diagnostic.json'), false);
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

test('collector preserves structured DNF evidence and rejects impossible failure counts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-bench-collect-'));
  fs.mkdirSync(path.join(root, 'results/runs'), { recursive: true });
  try {
    const dnf = {
      ...record('react'),
      samples: [],
      n: 0,
      median: null,
      dnfCount: 1,
      failures: [{ rep: 0, category: 'timeout', timeoutMs: 240000 }],
    };
    fs.writeFileSync(path.join(root, 'results/runs/dnf.json'), JSON.stringify({
      schemaVersion: 2,
      meta: {
        generatedAt: '2026-01-01T00:00:00Z',
        machine: machine('a'),
        calibration: { probeVersion: 1, score: 100 },
      },
      records: [dnf],
    }));
    const out = collectRuns({ root, log: () => {}, entryTiers: entryTiers(['react']) });
    assert.deepEqual(out.comparisonRecords[0].failures, dnf.failures);

    dnf.failures.push({ rep: 1, category: 'timeout' });
    fs.writeFileSync(path.join(root, 'results/runs/dnf.json'), JSON.stringify({
      schemaVersion: 2,
      meta: {
        generatedAt: '2026-01-01T00:00:00Z',
        machine: machine('a'),
        calibration: { probeVersion: 1, score: 100 },
      },
      records: [dnf],
    }));
    assert.throws(
      () => collectRuns({ root, log: () => {}, entryTiers: entryTiers(['react']) }),
      /failures cannot exceed dnfCount/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('checked timeline snapshots keep Octane on the stable main identity', () => {
  const root = repoRoot();
  const out = collectRuns({ root, log: () => {} });
  assert.deepEqual(
    out.timelineSnapshots.map((snapshot) => snapshot.id),
    ['2026-08-11-main', '2026-08-12-main', '2026-08-15-main', 'current-main'],
  );
  for (const snapshot of out.timelineSnapshots) {
    const octaneIds = new Set(snapshot.records
      .filter((record) => record.harness === 'web' && record.entry.startsWith('octane'))
      .map((record) => record.entry));
    assert.deepEqual([...octaneIds], ['octane']);
    assert.equal(
      new Set(snapshot.records
        .filter((record) => record.harness === 'web' && record.suite !== 'bundle')
        .map((record) => record.entry)).size,
      6,
    );
  }
  const fast = out.timelineSnapshots.find((snapshot) => snapshot.id === '2026-08-12-main');
  const current = out.timelineSnapshots.find((snapshot) => snapshot.id === 'current-main');
  const selectStorm = (snapshot) => snapshot.records.find((record) =>
    record.harness === 'web'
    && record.entry === 'octane'
    && record.workload === 'selectStorm'
    && record.scale === 1000
    && record.metric === 'latency');
  assert.equal(selectStorm(fast).median, 34.44500017166138);
  assert.equal(selectStorm(current).median, 590.6499996185303);
});
