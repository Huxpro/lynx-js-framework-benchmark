import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  LIST_FIXTURE_PROTOCOL,
  LIST_SOURCE_METRIC_CONTRACTS,
  LIST_WORKLOAD_CONTRACT_VERSION,
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
