import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { STORM_SELECT_TICKS } from '@lynx-bench/shared/workloads';

import { collectRuns } from './collect.mjs';
import {
  CONNECTOR_PACKAGE_NAMES,
  CONNECTOR_PACKAGE_TREES_PROTOCOL,
  connectorPackageTreesSha256,
} from './connector-receipt.mjs';
import { repoRoot } from './entries.mjs';
import { buildNativeMatrixContract, nativeCellKey } from './native-coverage.mjs';
import {
  NATIVE_SANDBOX_CAMPAIGN_VERSION,
  appendNativeLeaseReceipt,
  buildNativeDeviceCohort,
  parseNativeLeaseReceipt,
} from './native-protocol.mjs';

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

const nativeEntries = (ids) => ids.map((id) => ({
  id,
  framework: id === 'octane' ? 'octane' : 'test',
  distDir: `/missing-${id}`,
  provenance: { commit: `${id}-new` },
}));

const nativeContractRecords = (entries, environment = 'native-test') =>
  buildNativeMatrixContract(entries).cells.map((cell) => ({
    ...cell,
    harness: 'native',
    environment,
    samples: [1],
    n: 1,
    median: 1,
    mean: 1,
    std: null,
    min: 1,
    max: 1,
    p95: null,
    ci95: null,
    detail: null,
    dnfCount: 0,
    failures: [],
  }));

const connectorReceipt = ({ available = true, suffix = 'a' } = {}) => {
  const packages = CONNECTOR_PACKAGE_NAMES.map((name, index) => available ? {
    name,
    version: `1.0.${index}`,
    available: true,
    resolvedPath: `/connector-${suffix}/${index}`,
    rootSha256: String(index + 1).repeat(64),
    fileCount: index + 1,
    byteCount: index + 10,
  } : {
    name,
    version: null,
    available: false,
    resolvedPath: null,
    rootSha256: null,
    fileCount: null,
    byteCount: null,
    reason: 'not-installed',
    errorCode: null,
  });
  const payload = { protocol: CONNECTOR_PACKAGE_TREES_PROTOCOL, packages };
  return { ...payload, sha256: connectorPackageTreesSha256(payload) };
};

const defaultConnectorReceipt = connectorReceipt();
const defaultNativeSerial = 'sandbox.test:41315';
const nativeLease = ({
  issueId = 'issue-a',
  expiredAt = 2_000,
  serial = defaultNativeSerial,
} = {}) => parseNativeLeaseReceipt(
  { serial, issueId, expiredAt },
  { serial, now: 1 },
);
const nativeLeaseChain = (...receipts) => receipts.reduce(appendNativeLeaseReceipt, null);

function nativeCampaignMeta(entries, {
  generatedAt = '2026-01-02T00:00:00Z',
  records = nativeContractRecords(entries),
  leaseChain = nativeLeaseChain(nativeLease()),
  recordLeaseId = leaseChain.receipts.at(-1)?.deviceLeaseId,
  harnessConfigId = 'method-a',
  campaignId = 'campaign-a',
  inputReceiptSha256 = 'input-a',
  environment = 'native-test',
  hardware = { cpuModel: 'test-device', cores: 8, osVersion: '10' },
  connectorPackageTrees = defaultConnectorReceipt,
  machineConnectorPackageTrees = connectorPackageTrees,
  connectorPackageTreesSha256 = connectorPackageTrees?.sha256,
  deviceCohort: suppliedDeviceCohort = null,
  cellLeaseIds: suppliedCellLeaseIds = null,
} = {}) {
  const contract = buildNativeMatrixContract(entries);
  const campaign = {
    version: NATIVE_SANDBOX_CAMPAIGN_VERSION,
    id: campaignId,
    matrixContractSha256: contract.sha256,
    inputReceiptSha256,
    connectorPackageTreesSha256,
  };
  const deviceCohort = suppliedDeviceCohort ?? buildNativeDeviceCohort({
    serialSha256: leaseChain.serialSha256,
    environment,
    hardware,
    campaignId,
    matrixContractSha256: contract.sha256,
    inputReceiptSha256,
    connectorPackageTreesSha256: connectorPackageTreesSha256 ?? 'missing-connector',
    harnessConfigId,
  });
  const cellLeaseIds = suppliedCellLeaseIds ?? Object.fromEntries(
    records.map((candidate) => [nativeCellKey(candidate), recordLeaseId]),
  );
  return {
    generatedAt,
    checkpoint: true,
    checkpointComplete: records.length === contract.cells.length,
    machine: {
      ...machine(`lease-${recordLeaseId}`),
      deviceLeaseId: recordLeaseId,
      deviceCohortId: deviceCohort.id,
      deviceCohort,
      harnessConfigId,
      campaignId,
      matrixContractSha256: contract.sha256,
      inputReceiptSha256,
      connectorPackageTreesSha256,
      connectorPackageTrees: machineConnectorPackageTrees,
    },
    calibration: null,
    campaign,
    matrixContract: contract,
    inputReceipt: { sha256: inputReceiptSha256, connectorPackageTrees },
    leaseChain,
    deviceCohort,
    cellLeaseIds,
    entryCommits: Object.fromEntries(entries.map((entry) => [
      entry.id, entry.provenance.commit,
    ])),
  };
}

const writeRun = (root, file, {
  machineId, score, entries, generatedAt = '2026-01-01T00:00:00Z', entryCommits = null,
  receipt = null,
}) => {
  fs.writeFileSync(path.join(root, 'results/runs', file), JSON.stringify({
    schemaVersion: 2,
    meta: {
      generatedAt,
      machine: machine(machineId),
      calibration: { probeVersion: 1, score },
      ...(entryCommits ? { entryCommits } : {}),
      ...(receipt ? { receipt } : {}),
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

test('incomplete DNF cells stay visible but cannot win comparison-run coverage', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-bench-collect-'));
  fs.mkdirSync(path.join(root, 'results/runs'), { recursive: true });
  try {
    writeRun(root, 'complete.json', {
      machineId: 'complete', score: 100, entries: ['react', 'vue'],
      generatedAt: '2026-01-01T00:00:00Z',
    });
    const incomplete = {
      ...record('vue', 'selectStorm'),
      samples: [],
      n: 0,
      median: null,
      mean: null,
      min: null,
      dnfCount: 1,
      failures: [{
        rep: 0,
        category: 'incomplete-storm-transport',
        evidence: { toMtsMessages: 6, toBtsMessages: 14 },
      }],
    };
    fs.writeFileSync(path.join(root, 'results/runs/incomplete-newer.json'), JSON.stringify({
      schemaVersion: 2,
      meta: {
        generatedAt: '2026-01-02T00:00:00Z',
        machine: machine('incomplete'),
        calibration: { probeVersion: 1, score: 100 },
      },
      records: [record('react'), incomplete],
    }));

    const out = collectRuns({
      root, generatedAt: 'test', log: () => {}, entryTiers: entryTiers(['react', 'vue']),
    });
    assert.equal(out.comparison.runFile, 'complete.json');
    const archived = out.records.find((candidate) =>
      candidate.entry === 'vue' && candidate.workload === 'selectStorm');
    assert.equal(archived.comparabilityStatus, 'incomplete-work');
    assert.equal(archived.rankingEligible, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('collector publishes only a complete exact-identity Native campaign', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-bench-collect-'));
  fs.mkdirSync(path.join(root, 'results/runs'), { recursive: true });
  try {
    writeRun(root, 'web.json', {
      machineId: 'web', score: 100, entries: ['react', 'vue'],
      entryCommits: { react: 'react-new', vue: 'vue-new' },
    });
    const entries = nativeEntries(['react', 'vue']);
    fs.writeFileSync(path.join(root, 'results/runs/native-legacy-stale.json'), JSON.stringify({
      schemaVersion: 2,
      meta: {
        generatedAt: '2026-01-04T00:00:00Z',
        machine: machine('device-a'),
        calibration: null,
        entryCommits: { react: 'old' },
      },
      records: [
      nativeRecord('react'), nativeRecord('react', 'select'), nativeRecord('react', 'swap'),
      ],
    }));
    fs.writeFileSync(path.join(root, 'results/runs/native-v1-incomplete.json'), JSON.stringify({
      schemaVersion: 2,
      meta: {
        generatedAt: '2026-01-05T00:00:00Z',
        machine: machine('device-diagnostic'),
        calibration: null,
        checkpoint: true,
        checkpointComplete: false,
        campaign: { version: 'native-sandbox-campaign-v1' },
        entryCommits: { react: 'react-new' },
      },
      records: [nativeRecord('react')],
    }));
    const validRecords = nativeContractRecords(entries);
    const validMeta = nativeCampaignMeta(entries, {
      generatedAt: '2026-01-03T00:00:00Z',
      records: validRecords,
    });
    fs.writeFileSync(path.join(root, 'results/runs/native-campaign.json'), JSON.stringify({
      schemaVersion: 2,
      meta: validMeta,
      records: validRecords,
    }));
    const unavailableConnectorReceipt = connectorReceipt({ available: false });
    const invalidConnectorCampaigns = [
      ['native-missing-connector.json', {
        connectorPackageTrees: null,
        machineConnectorPackageTrees: null,
        connectorPackageTreesSha256: null,
      }],
      ['native-unavailable-connector.json', {
        connectorPackageTrees: unavailableConnectorReceipt,
        machineConnectorPackageTrees: unavailableConnectorReceipt,
        connectorPackageTreesSha256: unavailableConnectorReceipt.sha256,
      }],
      ['native-mismatched-connector.json', {
        connectorPackageTrees: defaultConnectorReceipt,
        machineConnectorPackageTrees: connectorReceipt({ suffix: 'runtime-mismatch' }),
        connectorPackageTreesSha256: defaultConnectorReceipt.sha256,
      }],
    ];
    for (const [file, overrides] of invalidConnectorCampaigns) {
      fs.writeFileSync(path.join(root, 'results/runs', file), JSON.stringify({
        schemaVersion: 2,
        meta: nativeCampaignMeta(entries, {
          generatedAt: '2026-01-04T00:00:00Z',
          records: validRecords,
          ...overrides,
        }),
        records: validRecords,
      }));
    }
    const out = collectRuns({
      root,
      generatedAt: 'test',
      log: () => {},
      entryTiers: entryTiers(['react', 'vue']),
      entries,
    });
    const native = out.comparisonRecords.filter((candidate) => candidate.harness === 'native');
    assert.equal(native.length, 70);
    assert.deepEqual(
      [...new Set(native.map((candidate) => candidate.machineId))],
      [validMeta.deviceCohort.id],
    );
    assert.deepEqual(
      [...new Set(native.map((candidate) => candidate.comparisonKind))],
      ['same-device-cohort'],
    );
    assert.equal(native.some((candidate) => candidate.runFile === 'native-legacy-stale.json'), false);
    assert.equal(out.records.some(({ runFile }) => runFile === 'native-v1-incomplete.json'), false);
    assert.equal(
      out.nativeObservationRecords.some(({ runFile }) => runFile === 'native-v1-incomplete.json'),
      false,
    );
    assert.deepEqual(out.comparison.harnesses[1].entryIds, ['react', 'vue']);
    assert.deepEqual(out.comparison.harnesses[1].sourceRunFiles, ['native-campaign.json']);
    assert.equal(native.some(({ runFile }) => runFile.includes('connector')), false);
    assert.deepEqual(out.nativeCoverage.summary, { measured: 70 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('legacy Native runs remain archive-only and are selected separately per entry', () => {
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

    assert.equal(out.comparison.harnesses.some(({ harness }) => harness === 'native'), false);
    assert.equal(out.comparisonRecords.some((record) => record.harness === 'native'), false);
    assert.deepEqual(out.nativeObservations.map((observation) => [
      observation.entryId, observation.machineId, observation.sourceRunFile,
    ]), [
      ['react', 'device-a', 'native-react.json'],
      ['vue', 'device-a', 'native-vue.json'],
      ['octane', 'device-c', 'native-octane-new-lease.json'],
    ]);
    assert.equal(out.nativeObservationRecords.every((record) =>
      record.comparisonKind === 'isolated-observation'), true);
    assert.equal(out.nativeCoverage.summary['invalid-incomparable'], 4);
    assert.equal(out.nativeCoverage.summary.unscheduled, 101);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('collector combines split checkpoints only inside one exact Native campaign identity', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-bench-collect-'));
  fs.mkdirSync(path.join(root, 'results/runs'), { recursive: true });
  try {
    writeRun(root, 'web.json', {
      machineId: 'web', score: 100, entries: ['octane'], entryCommits: { octane: 'current' },
    });
    const entries = nativeEntries(['octane']);
    entries[0].provenance.commit = 'current';
    const contractRecords = nativeContractRecords(entries);
    const firstLease = nativeLease({ issueId: 'split-a', expiredAt: 2_000 });
    const secondLease = nativeLease({ issueId: 'split-b', expiredAt: 3_000 });
    const firstChain = nativeLeaseChain(firstLease);
    const completeChain = nativeLeaseChain(firstLease, secondLease);
    const writeNative = (file, generatedAt, records, overrides = {}) => {
      fs.writeFileSync(path.join(root, 'results/runs', file), JSON.stringify({
        schemaVersion: 2,
        meta: nativeCampaignMeta(entries, { generatedAt, records, ...overrides }),
        records,
      }));
    };
    writeNative('native-table.json', '2026-01-02T00:00:00Z',
      contractRecords.filter(({ suite }) => suite === 'table'), {
        leaseChain: firstChain,
        recordLeaseId: firstLease.deviceLeaseId,
      });
    writeNative('native-startup.json', '2026-01-03T00:00:00Z',
      contractRecords.filter(({ suite }) => suite === 'startup'), {
        leaseChain: completeChain,
        recordLeaseId: secondLease.deviceLeaseId,
      });
    writeNative('native-wrong-receipt.json', '2026-01-04T00:00:00Z', [
      contractRecords.find(({ workload }) => workload === 'create'),
    ], { campaignId: 'campaign-b', inputReceiptSha256: 'input-b' });
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

    const out = collectRuns({
      root,
      generatedAt: 'test',
      log: () => {},
      entryTiers: entryTiers(['octane']),
      entries,
    });
    const native = out.comparisonRecords.filter((candidate) => candidate.harness === 'native');
    assert.equal(native.length, 35);
    assert.deepEqual(out.comparison.harnesses[1].sourceRunFiles, [
      'native-startup.json', 'native-table.json',
    ]);
    assert.deepEqual(
      out.comparison.harnesses[1].leaseChain.receipts.map(({ deviceLeaseId }) => deviceLeaseId),
      [firstLease.deviceLeaseId, secondLease.deviceLeaseId],
    );
    assert.deepEqual(new Set(native.map((candidate) => candidate.suite)), new Set(['table', 'startup']));
    assert.equal(native.some((candidate) => candidate.runFile === 'native-driver-diagnostic.json'), false);
    assert.equal(native.some((candidate) => candidate.runFile === 'native-wrong-receipt.json'), false);
    assert.deepEqual(out.nativeCoverage.summary, { measured: 35 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('collector keeps same-serial forked lease chains archive-only', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-bench-forked-chain-'));
  fs.mkdirSync(path.join(root, 'results/runs'), { recursive: true });
  try {
    writeRun(root, 'web.json', {
      machineId: 'web', score: 100, entries: ['octane'], entryCommits: { octane: 'current' },
    });
    const entries = nativeEntries(['octane']);
    entries[0].provenance.commit = 'current';
    const records = nativeContractRecords(entries);
    const table = records.filter(({ suite }) => suite === 'table');
    const startup = records.filter(({ suite }) => suite === 'startup');
    const first = nativeLease({ issueId: 'fork-a', expiredAt: 2_000 });
    const left = nativeLease({ issueId: 'fork-b', expiredAt: 3_000 });
    const right = nativeLease({ issueId: 'fork-c', expiredAt: 4_000 });
    for (const [file, generatedAt, subset, leaseChain, recordLeaseId] of [
      ['native-left.json', '2026-01-02T00:00:00Z', table,
        nativeLeaseChain(first, left), left.deviceLeaseId],
      ['native-right.json', '2026-01-03T00:00:00Z', startup,
        nativeLeaseChain(first, right), right.deviceLeaseId],
    ]) {
      fs.writeFileSync(path.join(root, 'results/runs', file), JSON.stringify({
        schemaVersion: 2,
        meta: nativeCampaignMeta(entries, {
          generatedAt, records: subset, leaseChain, recordLeaseId,
        }),
        records: subset,
      }));
    }

    const out = collectRuns({
      root, generatedAt: 'test', log: () => {},
      entryTiers: entryTiers(['octane']), entries,
    });
    assert.equal(out.comparison.harnesses.some(({ harness }) => harness === 'native'), false);
    assert.equal(out.comparisonRecords.some(({ harness }) => harness === 'native'), false);
    assert.equal(out.nativeObservationRecords.some(({ runFile }) =>
      runFile === 'native-left.json' || runFile === 'native-right.json'), false);
    assert.equal(out.records.some(({ runFile }) => runFile === 'native-left.json'), true);
    assert.equal(out.records.some(({ runFile }) => runFile === 'native-right.json'), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('collector rejects missing, malformed, overlapping, and cross-serial Native lease evidence', () => {
  const scenarios = [
    {
      name: 'missing-chain',
      write(root, entries, records) {
        const meta = nativeCampaignMeta(entries, { records });
        delete meta.leaseChain;
        fs.writeFileSync(path.join(root, 'results/runs/native.json'), JSON.stringify({
          schemaVersion: 2, meta, records,
        }));
      },
    },
    {
      name: 'malformed-chain',
      write(root, entries, records) {
        const meta = nativeCampaignMeta(entries, { records });
        meta.leaseChain.sha256 = '0'.repeat(64);
        fs.writeFileSync(path.join(root, 'results/runs/native.json'), JSON.stringify({
          schemaVersion: 2, meta, records,
        }));
      },
    },
    {
      name: 'missing-cell-attribution',
      write(root, entries, records) {
        const meta = nativeCampaignMeta(entries, { records });
        delete meta.cellLeaseIds[nativeCellKey(records[0])];
        fs.writeFileSync(path.join(root, 'results/runs/native.json'), JSON.stringify({
          schemaVersion: 2, meta, records,
        }));
      },
    },
    {
      name: 'overlap',
      write(root, entries, records) {
        for (const [file, generatedAt] of [
          ['native-a.json', '2026-01-02T00:00:00Z'],
          ['native-b.json', '2026-01-03T00:00:00Z'],
        ]) {
          fs.writeFileSync(path.join(root, 'results/runs', file), JSON.stringify({
            schemaVersion: 2,
            meta: nativeCampaignMeta(entries, { generatedAt, records }),
            records,
          }));
        }
      },
    },
    {
      name: 'cross-serial-split',
      write(root, entries, records) {
        const table = records.filter(({ suite }) => suite === 'table');
        const startup = records.filter(({ suite }) => suite === 'startup');
        const leases = [
          nativeLease({ issueId: 'serial-a', expiredAt: 2_000, serial: 'sandbox-a:1' }),
          nativeLease({ issueId: 'serial-b', expiredAt: 3_000, serial: 'sandbox-b:2' }),
        ];
        for (const [index, subset] of [table, startup].entries()) {
          const leaseChain = nativeLeaseChain(leases[index]);
          fs.writeFileSync(path.join(root, 'results/runs', `native-${index}.json`), JSON.stringify({
            schemaVersion: 2,
            meta: nativeCampaignMeta(entries, {
              generatedAt: `2026-01-0${index + 2}T00:00:00Z`,
              records: subset,
              leaseChain,
              recordLeaseId: leases[index].deviceLeaseId,
            }),
            records: subset,
          }));
        }
      },
    },
  ];

  for (const scenario of scenarios) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `lynx-bench-${scenario.name}-`));
    fs.mkdirSync(path.join(root, 'results/runs'), { recursive: true });
    try {
      writeRun(root, 'web.json', {
        machineId: 'web', score: 100, entries: ['octane'],
        entryCommits: { octane: 'current' },
      });
      const entries = nativeEntries(['octane']);
      entries[0].provenance.commit = 'current';
      scenario.write(root, entries, nativeContractRecords(entries));
      const out = collectRuns({
        root,
        generatedAt: 'test',
        log: () => {},
        entryTiers: entryTiers(['octane']),
        entries,
      });
      assert.equal(
        out.comparisonRecords.some(({ harness }) => harness === 'native'),
        false,
        scenario.name,
      );
      assert.equal(
        out.comparison.harnesses.some(({ harness }) => harness === 'native'),
        false,
        scenario.name,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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

test('prospective Lab estimates cannot cross comparison cohorts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-bench-collect-'));
  fs.mkdirSync(path.join(root, 'results/runs'), { recursive: true });
  try {
    const prospective = (entry, workload = 'create') => ({
      ...record(entry, workload), attemptedCount: 1, acceptedCount: 1,
    });
    const writeProspective = (file, generatedAt, cohort, records) => {
      fs.writeFileSync(path.join(root, 'results/runs', file), JSON.stringify({
        schemaVersion: 2,
        meta: {
          generatedAt,
          machine: machine(file),
          calibration: { probeVersion: 1, score: 100 },
          receipt: { comparabilityCohort: cohort },
        },
        records,
      }));
    };
    writeProspective('comparison.json', '2026-01-01T00:00:00Z', 'sha256:cohort-a', [
      prospective('react'),
    ]);
    writeProspective('lab-compatible.json', '2026-01-02T00:00:00Z', 'sha256:cohort-a', [
      prospective('lab'),
    ]);
    writeProspective('lab-incompatible-newer.json', '2026-01-03T00:00:00Z', 'sha256:cohort-b', [
      prospective('lab'), prospective('lab', 'select'),
    ]);

    const out = collectRuns({
      root, generatedAt: 'test', log: () => {}, entryTiers: entryTiers(['react'], ['lab']),
    });
    assert.equal(out.comparison.runFile, 'comparison.json');
    assert.equal(out.comparison.labEstimates[0].sourceRunFile, 'lab-compatible.json');
    assert.deepEqual(
      [...new Set(out.labComparisonRecords.map((candidate) => candidate.comparabilityCohort))],
      ['sha256:cohort-a'],
    );
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

test('collector keeps incomplete historical storms auditable but removes them from rankings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-bench-collect-'));
  fs.mkdirSync(path.join(root, 'results/runs'), { recursive: true });
  try {
    const storm = (entry, metric, samples) => ({
      ...record(entry, 'selectStorm'),
      metric,
      boundary: metric === 'latency' ? 'test' : 'wire',
      unit: metric === 'latency' ? 'ms' : 'count',
      samples,
      n: samples.length,
      median: samples[0],
    });
    fs.writeFileSync(path.join(root, 'results/runs/incomplete.json'), JSON.stringify({
      schemaVersion: 2,
      meta: {
        generatedAt: '2026-01-01T00:00:00Z',
        machine: machine('a'),
        calibration: { probeVersion: 1, score: 100 },
      },
      records: [
        record('react'),
        storm('react', 'latency', [30]),
        storm('react', 'wireToMtsMsgs', [6]),
        storm('react', 'wireToBtsMsgs', [14]),
      ],
    }));

    const out = collectRuns({
      root, log: () => {}, entryTiers: entryTiers(['react']), generatedAt: 'test',
    });
    assert.equal(out.comparisonRecords.some((candidate) =>
      candidate.workload === 'selectStorm'), false);
    const latency = out.records.find((candidate) =>
      candidate.workload === 'selectStorm' && candidate.metric === 'latency');
    assert.equal(latency.median, 30);
    assert.equal(latency.comparabilityStatus, 'incomplete-work');
    assert.equal(latency.rankingEligible, false);
    assert.deepEqual(latency.workClassification, {
      status: 'incomplete',
      expectedSequentialCommits: STORM_SELECT_TICKS,
      observed: {
        toMtsMessages: { min: 6, max: 6 },
        toBtsMessages: { min: 14, max: 14 },
      },
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('collector rejects prospective sampling mismatches and preserves complete storm cohorts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-bench-collect-'));
  fs.mkdirSync(path.join(root, 'results/runs'), { recursive: true });
  try {
    const receipt = { comparabilityCohort: 'sha256:test-cohort' };
    const prospective = (workload, metric, samples, attemptedCount = samples.length) => ({
      ...record('react', workload),
      metric,
      boundary: metric === 'latency' ? 'test' : 'wire',
      unit: metric === 'latency' ? 'ms' : 'count',
      samples,
      n: samples.length,
      median: samples[0],
      attemptedCount,
      acceptedCount: samples.length,
    });
    fs.writeFileSync(path.join(root, 'results/runs/prospective.json'), JSON.stringify({
      schemaVersion: 2,
      meta: {
        generatedAt: '2026-01-01T00:00:00Z',
        machine: machine('a'),
        calibration: { probeVersion: 1, score: 100 },
        receipt,
      },
      records: [
        { ...prospective('create', 'latency', [1, 2], 2), acceptedCount: 1 },
        prospective('select', 'latency', [20], 2),
        prospective('selectStorm', 'latency', [500]),
        prospective('selectStorm', 'wireToMtsMsgs', [60]),
        prospective('selectStorm', 'wireToBtsMsgs', [92]),
      ],
    }));

    const out = collectRuns({
      root, log: () => {}, entryTiers: entryTiers(['react']), generatedAt: 'test',
    });
    assert.equal(out.comparisonRecords.some((candidate) => candidate.workload === 'create'), false);
    const complete = out.comparisonRecords.find((candidate) =>
      candidate.workload === 'selectStorm' && candidate.metric === 'latency');
    assert.equal(complete.comparabilityStatus, 'comparable');
    assert.equal(complete.comparabilityCohort, receipt.comparabilityCohort);
    assert.equal(complete.rankingEligible, true);
    assert.equal(complete.workClassification.status, 'complete');
    const incompatible = out.records.find((candidate) => candidate.workload === 'create');
    assert.equal(incompatible.comparabilityStatus, 'incompatible-sampling');
    assert.deepEqual(incompatible.comparabilityReasons, ['accepted-count-mismatch']);
    const underfilled = out.records.find((candidate) => candidate.workload === 'select');
    assert.equal(underfilled.comparabilityStatus, 'incompatible-sampling');
    assert.deepEqual(underfilled.comparabilityReasons, ['attempt-accounting-underflow']);
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
  const historical = fast.records.find((record) =>
    record.harness === 'web'
    && record.entry === 'octane'
    && record.workload === 'selectStorm'
    && record.scale === 1000
    && record.metric === 'latency');
  assert.equal(historical.comparabilityStatus, 'incomplete-work');
  assert.equal(historical.rankingEligible, false);
});
