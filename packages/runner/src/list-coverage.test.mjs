import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  LIST_CASES,
  LIST_FIXTURE_PROTOCOL,
  LIST_SOURCE_METRIC_CONTRACTS,
  LIST_WORKLOAD_CONTRACT_VERSION,
  NATIVE_LIST_FIXTURE_PROTOCOL,
  NATIVE_LIST_OBSERVER_METRIC_CONTRACTS,
} from '../../shared/src/list-workloads.mjs';

import {
  LIST_WORKLOAD_CONTRACT_SHA256,
  assertListCoverage,
  buildListCoverage,
  selectListCampaignRecords,
} from './list-coverage.mjs';

test('list coverage makes absent fixtures explicit for both isolated harnesses', () => {
  const coverage = buildListCoverage({
    entries: [
      { id: 'b', tier: 'featured', dir: '/missing-b' },
      { id: 'a', tier: 'featured', dir: '/missing-a' },
      { id: 'lab', tier: 'lab', dir: '/missing-lab' },
    ],
  });
  assert.deepEqual(coverage.entryIds, ['a', 'b']);
  assert.equal(coverage.expectedCellCount, 16);
  assert.deepEqual(coverage.summary, { unsupported: 16 });
  assert.deepEqual(new Set(coverage.cells.map((cell) => cell.harness)), new Set(['native', 'web']));
  assert.ok(coverage.cells.every((cell) => cell.reason === 'list-fixture-not-declared'));
  assert.doesNotThrow(() => assertListCoverage(coverage));
});

test('declared fixtures become unscheduled, then measured or DNF without changing blank frames into DNF', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-list-fixture-'));
  try {
    fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(root, 'dist/list.web.bundle'), 'fixture');
    const bundleSha256 = crypto.createHash('sha256').update('fixture').digest('hex');
    const entry = {
      id: 'react', tier: 'featured', dir: root,
      listFixture: {
        protocol: LIST_FIXTURE_PROTOCOL,
        contractSha256: LIST_WORKLOAD_CONTRACT_SHA256,
        bundles: { web: 'dist/list.web.bundle' },
        sha256: { web: bundleSha256 },
      },
    };
    const sourceRecords = [
      'elapsedMs', 'materializedCells', 'blankFrames', 'materializationTimesMs',
    ].map((metric) => ({
      suite: 'list', entry: 'react', harness: 'web', workload: 'list-fling', scale: 10000,
      metric, contractVersion: LIST_WORKLOAD_CONTRACT_VERSION,
      ...LIST_SOURCE_METRIC_CONTRACTS[metric],
      n: 1, dnfCount: 0, samples: [metric === 'blankFrames' ? 3 : 1],
    })).concat([
      'operationTimeMs', 'recycledCells', 'wireToMtsBytes', 'wireToBtsBytes',
    ].map((metric) => ({
      suite: 'list', entry: 'react', harness: 'web', workload: 'list-recycle', scale: 10000,
      metric, contractVersion: LIST_WORKLOAD_CONTRACT_VERSION,
      ...LIST_SOURCE_METRIC_CONTRACTS[metric],
      n: 0, dnfCount: 1, samples: [], failures: [{ category: 'capture-timeout' }],
    })));
    const coverage = buildListCoverage({ entries: [entry], sourceRecords });
    assert.equal(coverage.cells.find((cell) => cell.harness === 'web'
      && cell.workload === 'list-fling').status, 'measured');
    assert.equal(coverage.cells.find((cell) => cell.harness === 'web'
      && cell.workload === 'list-recycle').status, 'dnf');
    assert.equal(coverage.cells.filter((cell) => cell.harness === 'web'
      && cell.status === 'unscheduled').length, 2);
    assert.equal(coverage.cells.filter((cell) => cell.harness === 'native'
      && cell.status === 'unsupported').length, 4);
    assert.equal(
      crypto.createHash('sha256').update(JSON.stringify(coverage.config)).digest('hex').length,
      64,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('list campaign selection is coherent per harness and ignores stale entry commits', () => {
  const entries = [
    { id: 'react', provenance: { commit: 'react-current' } },
    { id: 'vue', provenance: { commit: 'vue-current' } },
  ];
  const record = (entry, runFile, runGeneratedAt, harness = 'web', entryCommit = `${entry}-current`) => ({
    suite: 'list', harness, entry, entryCommit, runFile, runGeneratedAt,
    workload: 'list-startup', scale: 1000, metric: 'firstVisibleContentMs',
  });
  const selected = selectListCampaignRecords([
    record('react', 'older-broad.json', '2026-01-01'),
    record('vue', 'older-broad.json', '2026-01-01'),
    record('react', 'newer-narrow.json', '2026-01-02'),
    record('react', 'native.json', '2026-01-03', 'native'),
    record('vue', 'stale.json', '2026-01-04', 'web', 'vue-old'),
  ], entries);
  assert.deepEqual([...new Set(selected.filter(({ harness }) => harness === 'web')
    .map(({ runFile }) => runFile))], ['older-broad.json']);
  assert.deepEqual([...new Set(selected.filter(({ harness }) => harness === 'native')
    .map(({ runFile }) => runFile))], ['native.json']);
});

test('list campaign selection keeps featured and diagnostic Native cohorts independent', () => {
  const entries = [
    { id: 'react', tier: 'featured', provenance: { commit: 'react-current' } },
    {
      id: 'octane-native-diagnostic', tier: 'lab',
      provenance: { commit: 'diagnostic-current' },
    },
  ];
  const records = [
    {
      suite: 'list', harness: 'native', entry: 'react', entryCommit: 'react-current',
      runFile: 'featured.json', runGeneratedAt: '2026-01-01',
      workload: 'list-startup', scale: 1000, metric: 'firstVisibleContentMs',
    },
    {
      suite: 'list', harness: 'native', entry: 'octane-native-diagnostic',
      entryCommit: 'diagnostic-current', runFile: 'diagnostic.json',
      runGeneratedAt: '2026-01-02', workload: 'list-startup', scale: 1000,
      metric: 'firstVisibleContentMs',
    },
  ];
  const selected = selectListCampaignRecords(records, entries);
  assert.deepEqual(selected.map(({ runFile }) => runFile).sort(), [
    'diagnostic.json', 'featured.json',
  ]);
});

test('list coverage includes only explicitly diagnostic Native lab fixtures', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-native-list-coverage-'));
  try {
    const nativeBundle = Buffer.from('native-list');
    const nativeSha256 = crypto.createHash('sha256').update(nativeBundle).digest('hex');
    const diagnostic = {
      id: 'octane-native-diagnostic',
      tier: 'lab',
      harnesses: ['native'],
      dir: root,
      listFixture: {
        protocol: NATIVE_LIST_FIXTURE_PROTOCOL,
        workloadProtocol: LIST_FIXTURE_PROTOCOL,
        contractSha256: LIST_WORKLOAD_CONTRACT_SHA256,
        diagnostic: true,
        rankingEligible: false,
        scales: {
          1000: { bundle: 'dist/list/rows-1000/main.lynx.bundle', sha256: nativeSha256 },
          10000: { bundle: 'dist/list/rows-10000/main.lynx.bundle', sha256: nativeSha256 },
        },
      },
    };
    for (const scale of [1000, 10000]) {
      const bundle = path.join(root, `dist/list/rows-${scale}/main.lynx.bundle`);
      fs.mkdirSync(path.dirname(bundle), { recursive: true });
      fs.writeFileSync(bundle, nativeBundle);
    }
    const coverage = buildListCoverage({
      entries: [
        diagnostic,
        { ...diagnostic, id: 'ordinary-lab', listFixture: undefined },
      ],
    });
    assert.deepEqual(coverage.entryIds, []);
    assert.deepEqual(coverage.diagnosticEntryIds, ['octane-native-diagnostic']);
    assert.equal(coverage.expectedCellCount, 4);
    assert.ok(coverage.cells.every(({ harness, diagnostic: isDiagnostic, rankingEligible }) =>
      harness === 'native' && isDiagnostic === true && rankingEligible === false));
    assert.deepEqual(coverage.summary, { unscheduled: 4 });

    const malformed = buildListCoverage({
      entries: [{ ...diagnostic, tier: 'featured', harnesses: ['web'] }],
    });
    assert.deepEqual(malformed.entryIds, []);
    assert.deepEqual(malformed.diagnosticEntryIds, ['octane-native-diagnostic']);
    assert.equal(malformed.expectedCellCount, 4);
    assert.ok(malformed.cells.every((cell) =>
      cell.diagnostic === true
      && cell.rankingEligible === false
      && cell.status === 'unsupported'
      && cell.reason === 'native-list-diagnostic-entry-contract-mismatch'));

    const futureProtocol = buildListCoverage({
      entries: [{
        ...diagnostic,
        listFixture: { ...diagnostic.listFixture, protocol: 'lynx-list-fixture-v999' },
      }],
    });
    assert.deepEqual(futureProtocol.summary, { 'invalid-incomparable': 4 });
    assert.ok(futureProtocol.cells.every((cell) =>
      cell.reason === 'list-fixture-protocol-mismatch'));
    assert.throws(
      () => assertListCoverage(futureProtocol),
      /list coverage contains 4 invalid cells/,
    );

    const contradictory = structuredClone(coverage);
    contradictory.cells[0].rankingEligible = true;
    assert.throws(
      () => assertListCoverage(contradictory),
      /contradicts diagnostic or ranking identity/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Native list coverage distinguishes not measured, DNF, measured, and invalid evidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-native-list-states-'));
  try {
    const bundleSha256 = crypto.createHash('sha256').update('native-list').digest('hex');
    const entry = {
      id: 'octane-native-diagnostic', tier: 'lab', harnesses: ['native'], dir: root,
      listFixture: {
        protocol: NATIVE_LIST_FIXTURE_PROTOCOL,
        workloadProtocol: LIST_FIXTURE_PROTOCOL,
        contractSha256: LIST_WORKLOAD_CONTRACT_SHA256,
        diagnostic: true,
        rankingEligible: false,
        scales: {
          1000: { bundle: 'dist/list/rows-1000/main.lynx.bundle', sha256: bundleSha256 },
          10000: { bundle: 'dist/list/rows-10000/main.lynx.bundle', sha256: bundleSha256 },
        },
      },
    };
    for (const scale of [1000, 10000]) {
      const bundle = path.join(root, `dist/list/rows-${scale}/main.lynx.bundle`);
      fs.mkdirSync(path.dirname(bundle), { recursive: true });
      fs.writeFileSync(bundle, 'native-list');
    }
    const allMetrics = (kase) => ({
      ...Object.fromEntries(kase.sourceMetrics.map((metric) => [
        metric, LIST_SOURCE_METRIC_CONTRACTS[metric],
      ])),
      ...NATIVE_LIST_OBSERVER_METRIC_CONTRACTS,
    });
    const records = [];
    for (const kase of [{ name: 'list-startup', scale: 1000, status: 'not-measured' },
      { name: 'list-startup', scale: 10000, status: 'dnf' },
      { name: 'list-recycle', scale: 10000, status: 'measured' }]) {
      const contract = LIST_CASES.find(({ name }) => name === kase.name);
      for (const [metric, spec] of Object.entries(allMetrics(contract))) {
        records.push({
          suite: 'list', harness: 'native', entry: entry.id,
          workload: kase.name, scale: kase.scale, metric,
          contractVersion: LIST_WORKLOAD_CONTRACT_VERSION,
          ...spec,
          measurementStatus: kase.status,
          n: kase.status === 'measured' ? 1 : 0,
          dnfCount: kase.status === 'dnf' ? 1 : 0,
          notMeasuredCount: kase.status === 'not-measured' ? 1 : 0,
          notMeasuredReason: kase.status === 'not-measured'
            ? { category: 'native-list-allocation-observer-unavailable' }
            : null,
          samples: kase.status === 'measured' ? [1] : null,
          failures: kase.status === 'dnf' ? [{ category: 'capture-timeout' }] : [],
        });
      }
    }
    const coverage = buildListCoverage({ entries: [entry], sourceRecords: records });
    const status = (workload, scale) => coverage.cells.find((cell) =>
      cell.workload === workload && cell.scale === scale).status;
    assert.equal(status('list-startup', 1000), 'not-measured');
    assert.equal(status('list-startup', 10000), 'dnf');
    assert.equal(status('list-recycle', 10000), 'measured');
    assert.equal(status('list-fling', 10000), 'unscheduled');

    for (const record of records.filter((candidate) =>
      candidate.workload === 'list-startup'
      && candidate.scale === 1000
      && !Object.hasOwn(NATIVE_LIST_OBSERVER_METRIC_CONTRACTS, candidate.metric))) {
      record.measurementStatus = 'dnf';
      record.dnfCount = 1;
      record.notMeasuredCount = 0;
      record.notMeasuredReason = null;
      record.failures = [{ category: 'capture-timeout' }];
    }
    const observerMissingAfterSourceDnf = buildListCoverage({ entries: [entry], sourceRecords: records });
    assert.equal(observerMissingAfterSourceDnf.cells.find((cell) =>
      cell.workload === 'list-startup' && cell.scale === 1000).status, 'not-measured');

    records.find(({ workload, metric }) =>
      workload === 'list-recycle' && metric === 'peakLiveNativeListItems').boundary = 'wrong';
    const invalid = buildListCoverage({ entries: [entry], sourceRecords: records });
    assert.equal(invalid.cells.find(({ workload }) => workload === 'list-recycle').status,
      'invalid-incomparable');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
