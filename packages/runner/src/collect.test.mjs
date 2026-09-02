import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { STORM_SELECT_TICKS } from '@lynx-bench/shared/workloads';

import {
  collectRuns,
  DATASET_CHECKPOINT_SPECS,
  HISTORY_REPLAY_SPEC,
} from './collect.mjs';
import {
  CONNECTOR_PACKAGE_NAMES,
  CONNECTOR_PACKAGE_TREES_PROTOCOL,
  connectorPackageTreesSha256,
} from './connector-receipt.mjs';
import { repoRoot } from './entries.mjs';
import { buildNativeMatrixContract, nativeCellKey } from './native-coverage.mjs';
import {
  NATIVE_SANDBOX_CAMPAIGN_VERSION,
  appendNativeMethodRevision,
  appendNativeLeaseReceipt,
  buildNativeDeviceCohort,
  createNativeMethodRevisionChain,
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
const sha256Json = (value) => crypto.createHash('sha256')
  .update(JSON.stringify(value))
  .digest('hex');
const methodInputReceipt = (sources, connectorPackageTrees = defaultConnectorReceipt) => {
  const payload = {
    version: 'native-input-receipt-v2',
    adapter: 'packages/runner/adapters/test.mjs',
    connectorPackageTrees,
    sources,
    entryArtifacts: {},
  };
  return { ...payload, sha256: sha256Json(payload) };
};

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
  receipt = null, schemaVersion = 2, regime = null,
}) => {
  fs.writeFileSync(path.join(root, 'results/runs', file), JSON.stringify({
    schemaVersion,
    meta: {
      generatedAt,
      machine: machine(machineId),
      calibration: { probeVersion: 1, score },
      ...(entryCommits ? { entryCommits } : {}),
      ...(receipt ? { receipt } : {}),
    },
    records: entries.map((entry) => schemaVersion === 3
      ? { ...record(entry), environment: regime }
      : record(entry)),
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

test('collector accepts byte-identical Web artifacts across source commits', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-bench-web-artifact-'));
  fs.mkdirSync(path.join(root, 'results/runs'), { recursive: true });
  const entries = [
    {
      id: 'peer',
      distDir: path.join(root, 'missing-peer'),
      provenance: { commit: 'peer-current' },
    },
    {
      id: 'equivalent',
      distDir: path.join(root, 'missing-equivalent'),
      provenance: {
        commit: 'equivalent-current',
        sha256: {
          'rows-0/main.web.bundle': 'web-zero',
          'rows-1000/main.web.bundle': 'web-one-thousand',
          'rows-0/main.lynx.bundle': 'native-current',
        },
      },
    },
    {
      id: 'stale',
      distDir: path.join(root, 'missing-stale'),
      provenance: {
        commit: 'stale-current',
        sha256: { 'rows-0/main.web.bundle': 'web-current' },
      },
    },
  ];
  try {
    fs.writeFileSync(path.join(root, 'results/runs/web.json'), JSON.stringify({
      schemaVersion: 4,
      meta: {
        generatedAt: '2026-01-01T00:00:00Z',
        machine: machine('web'),
        calibration: { probeVersion: 1, score: 100 },
        entryCommits: {
          peer: 'peer-current',
          equivalent: 'equivalent-older-source',
          stale: 'stale-older-source',
        },
        receipt: {
          comparabilityCohort: 'sha256:web-artifact-identity',
          entryBundles: {
            equivalent: {
              'rows-0/main.web.bundle': 'web-zero',
              'rows-1000/main.web.bundle': 'web-one-thousand',
              'rows-0/main.lynx.bundle': 'native-older-and-irrelevant-to-web',
            },
            stale: { 'rows-0/main.web.bundle': 'web-older' },
          },
        },
      },
      records: entries.map(({ id }) => ({
        ...record(id),
        environment: {
          jsRegime: 'jit',
          jsFlags: '--expose-gc',
          cpuThrottle: 1,
          throttleScope: 'none',
        },
        attemptedCount: 1,
        acceptedCount: 1,
      })),
    }));

    const out = collectRuns({
      root,
      generatedAt: 'test',
      log: () => {},
      entryTiers: entryTiers(entries.map(({ id }) => id)),
      entries,
    });

    assert.deepEqual(out.comparison.entryIds, ['equivalent', 'peer']);
    assert.equal(out.comparisonRecords.some(({ entry }) => entry === 'stale'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('collector defaults historical Web records to jit x1 and never mixes regime rankings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-bench-collect-regime-'));
  fs.mkdirSync(path.join(root, 'results/runs'), { recursive: true });
  try {
    writeRun(root, 'baseline-v2.json', {
      machineId: 'same-machine', score: 100, entries: ['react', 'vue'],
      generatedAt: '2026-01-01T00:00:00Z',
    });
    writeRun(root, 'interp-react-v3.json', {
      machineId: 'same-machine', score: 50, entries: ['react'],
      generatedAt: '2026-01-02T00:00:00Z', schemaVersion: 3,
      regime: {
        jsRegime: 'interp',
        jsFlags: '--expose-gc,--no-opt,--no-sparkplug,--no-maglev',
        cpuThrottle: 4,
      },
    });
    writeRun(root, 'interp-vue-v3.json', {
      machineId: 'same-machine', score: 51, entries: ['vue'],
      generatedAt: '2026-01-03T00:00:00Z', schemaVersion: 3,
      regime: {
        jsRegime: 'interp',
        jsFlags: '--expose-gc,--no-opt,--no-sparkplug,--no-maglev',
        cpuThrottle: 4,
      },
    });
    const out = collectRuns({
      root,
      generatedAt: 'test',
      log: () => {},
      entryTiers: entryTiers(['react', 'vue']),
    });
    const webCohorts = out.comparison.harnesses.filter(({ harness }) => harness === 'web');
    assert.deepEqual(webCohorts.map(({ jsRegime, cpuThrottle }) =>
      [jsRegime, cpuThrottle]), [['jit', 1], ['interp', 4]]);
    assert.deepEqual(webCohorts.map(({ sourceRunFiles }) => sourceRunFiles), [
      ['baseline-v2.json'],
      ['interp-react-v3.json', 'interp-vue-v3.json'],
    ]);
    assert.equal(out.comparisonRecords.filter((candidate) => candidate.jsRegime === 'jit').length, 2);
    assert.equal(out.comparisonRecords.filter((candidate) => candidate.jsRegime === 'interp').length, 2);
    assert.deepEqual(Object.keys(out.machineRegimes).sort(), [
      'same-machine|interp:--expose-gc,--no-opt,--no-sparkplug,--no-maglev:4:page-cdp',
      'same-machine|jit:--expose-gc:1:none',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('prospective Web checkpoints never combine across control receipts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-bench-collect-regime-cohort-'));
  fs.mkdirSync(path.join(root, 'results/runs'), { recursive: true });
  try {
    const regime = {
      jsRegime: 'interp',
      jsFlags: '--expose-gc,--no-opt,--no-sparkplug,--no-maglev',
      cpuThrottle: 4,
    };
    writeRun(root, 'react.json', {
      machineId: 'same-machine', score: 50, entries: ['react'], schemaVersion: 3, regime,
      generatedAt: '2026-01-02T00:00:00Z',
      receipt: { comparabilityCohort: 'cohort-react' },
    });
    writeRun(root, 'vue.json', {
      machineId: 'same-machine', score: 51, entries: ['vue'], schemaVersion: 3, regime,
      generatedAt: '2026-01-03T00:00:00Z',
      receipt: { comparabilityCohort: 'cohort-vue' },
    });
    for (const file of ['react.json', 'vue.json']) {
      const runPath = path.join(root, 'results/runs', file);
      const run = JSON.parse(fs.readFileSync(runPath, 'utf8'));
      run.records = run.records.map((candidate) => ({
        ...candidate,
        attemptedCount: 1,
        acceptedCount: 1,
      }));
      fs.writeFileSync(runPath, JSON.stringify(run));
    }

    const out = collectRuns({
      root,
      generatedAt: 'test',
      log: () => {},
      entryTiers: entryTiers(['react', 'vue']),
    });
    assert.deepEqual(out.comparison.entryIds, ['vue']);
    assert.deepEqual(out.comparison.harnesses[0].sourceRunFiles, ['vue.json']);
    assert.equal(out.comparisonRecords.length, 1);
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
    assert.equal(native.length, 46);
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
    assert.deepEqual(out.nativeCoverage.summary, { measured: 46 });
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
    assert.equal(out.nativeCoverage.summary.unscheduled, 65);
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
    assert.equal(native.length, 23);
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
    assert.deepEqual(out.nativeCoverage.summary, { measured: 23 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('collector drops incomplete same-serial forked lease chains from the dataset', () => {
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
    assert.equal(out.records.some(({ runFile }) => runFile === 'native-left.json'), false);
    assert.equal(out.records.some(({ runFile }) => runFile === 'native-right.json'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('collector publishes only completely attributed Native method-revision chains', () => {
  for (const invalid of [null, 'missing-attribution', 'unknown-revision']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-bench-method-revision-'));
    fs.mkdirSync(path.join(root, 'results/runs'), { recursive: true });
    try {
      writeRun(root, 'web.json', {
        machineId: 'web', score: 100, entries: ['octane'],
        entryCommits: { octane: 'current' },
      });
      const entries = nativeEntries(['octane']);
      entries[0].provenance.commit = 'current';
      const records = nativeContractRecords(entries);
      const baseInput = methodInputReceipt({
        adapter: { bytes: 1, sha256: 'a'.repeat(64) },
      });
      const currentInput = methodInputReceipt({
        adapter: { bytes: 2, sha256: 'b'.repeat(64) },
      });
      const methodRevisionChain = appendNativeMethodRevision(
        createNativeMethodRevisionChain(baseInput),
        currentInput,
        'transport-containment-test',
      );
      const [baseRevision, currentRevision] = methodRevisionChain.revisions;
      const cellMethodRevisionIds = Object.fromEntries(records.map((candidate, index) => [
        nativeCellKey(candidate),
        index < 10 ? baseRevision.id : currentRevision.id,
      ]));
      if (invalid === 'missing-attribution') {
        delete cellMethodRevisionIds[nativeCellKey(records[0])];
      } else if (invalid === 'unknown-revision') {
        cellMethodRevisionIds[nativeCellKey(records[0])] = 'unknown';
      }
      const meta = nativeCampaignMeta(entries, {
        records, inputReceiptSha256: baseInput.sha256,
      });
      meta.inputReceipt = baseInput;
      meta.methodRevisionChain = methodRevisionChain;
      meta.cellMethodRevisionIds = cellMethodRevisionIds;
      fs.writeFileSync(path.join(root, 'results/runs/native.json'), JSON.stringify({
        schemaVersion: 2, meta, records,
      }));

      const out = collectRuns({
        root, generatedAt: 'test', log: () => {},
        entryTiers: entryTiers(['octane']), entries,
      });
      const nativeHarness = out.comparison.harnesses.find(({ harness }) => harness === 'native');
      if (invalid === null) {
        assert.equal(nativeHarness.recordCount, 23);
        assert.equal(nativeHarness.methodRevisionChain.sha256, methodRevisionChain.sha256);
        const native = out.comparisonRecords.filter(({ harness }) => harness === 'native');
        assert.equal(native.length, 23);
        assert.deepEqual(
          new Set(native.map(({ methodRevisionId }) => methodRevisionId)),
          new Set([baseRevision.id, currentRevision.id]),
        );
      } else {
        assert.equal(nativeHarness, undefined, invalid);
        assert.equal(out.comparisonRecords.some(({ harness }) => harness === 'native'), false);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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

test('collector archives but never ranks background CPU from a page-only throttled lane', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-bench-throttled-bts-'));
  fs.mkdirSync(path.join(root, 'results/runs'), { recursive: true });
  try {
    const environment = {
      jsRegime: 'interp',
      jsFlags: '--expose-gc,--no-opt,--no-sparkplug,--no-maglev',
      cpuThrottle: 4,
    };
    const measured = (metric) => ({
      suite: 'table', harness: 'web', environment, entry: 'react', workload: 'create', scale: 10000,
      metric,
      boundary: metric === 'btsCpu'
        ? 'sampled-js-cpu-background-realm'
        : 'pointerdown-to-dom-predicate',
      unit: 'ms', samples: [10, 11], attemptedCount: 2, acceptedCount: 2, dnfCount: 0,
    });
    fs.writeFileSync(path.join(root, 'results/runs/throttled.json'), JSON.stringify({
      schemaVersion: 3,
      meta: {
        generatedAt: '2026-01-01T00:00:00Z', machine: machine('a'),
        calibration: { probeVersion: 1, score: 100 },
        receipt: { comparabilityCohort: 'sha256:throttled' },
      },
      records: [measured('latency'), measured('btsCpu')],
    }));

    const out = collectRuns({
      root, log: () => {}, entryTiers: entryTiers(['react']), generatedAt: 'test',
    });
    const archived = out.records.find(({ metric }) => metric === 'btsCpu');
    assert.equal(archived.comparabilityStatus, 'invalid-measurement');
    assert.deepEqual(archived.comparabilityReasons, [
      'cpu-throttle-does-not-cover-background-worker',
    ]);
    assert.equal(archived.rankingEligible, false);
    assert.equal(out.comparisonRecords.some(({ metric }) => metric === 'btsCpu'), false);
    assert.equal(out.comparisonRecords.some(({ metric }) => metric === 'latency'), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('collector keeps background CPU eligible for a whole-process throttled lane', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-bench-process-throttled-bts-'));
  fs.mkdirSync(path.join(root, 'results/runs'), { recursive: true });
  try {
    const environment = {
      jsRegime: 'interp',
      jsFlags: '--expose-gc,--no-opt,--no-sparkplug,--no-maglev',
      cpuThrottle: 4,
      throttleScope: 'process-cgroup',
      verifiedSlowdown: 4.06,
    };
    const measured = (metric) => ({
      suite: 'table', harness: 'web', environment, entry: 'react', workload: 'create', scale: 10000,
      metric,
      boundary: metric === 'btsCpu'
        ? 'sampled-js-cpu-background-realm'
        : 'pointerdown-to-dom-predicate',
      unit: 'ms', samples: [10, 11], attemptedCount: 2, acceptedCount: 2, dnfCount: 0,
    });
    fs.writeFileSync(path.join(root, 'results/runs/throttled.json'), JSON.stringify({
      schemaVersion: 4,
      meta: {
        generatedAt: '2026-01-01T00:00:00Z', machine: machine('a'),
        calibration: { probeVersion: 1, score: 25 },
        receipt: { comparabilityCohort: 'sha256:process-throttled' },
      },
      records: [measured('latency'), measured('btsCpu')],
    }));

    const out = collectRuns({
      root, log: () => {}, entryTiers: entryTiers(['react']), generatedAt: 'test',
    });
    const bts = out.comparisonRecords.find(({ metric }) => metric === 'btsCpu');
    assert.equal(bts?.throttleScope, 'process-cgroup');
    assert.equal(bts?.verifiedSlowdown, 4.06);
    assert.notEqual(bts?.comparabilityStatus, 'invalid-measurement');
    assert.equal(bts?.rankingEligible, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('collector marks the pre-verifier process-cgroup run invalid-measurement', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-bench-invalid-process-throttle-'));
  fs.mkdirSync(path.join(root, 'results/runs'), { recursive: true });
  try {
    fs.writeFileSync(path.join(root, 'results/runs/throttled.json'), JSON.stringify({
      schemaVersion: 4,
      meta: {
        generatedAt: '2026-01-01T00:00:00Z', machine: machine('a'),
        calibration: { probeVersion: 1, score: 25 },
        receipt: { comparabilityCohort: 'sha256:invalid-process-throttle' },
        measurementValidity: {
          status: 'invalid-measurement',
          reasons: ['process-throttle-not-inherited-at-launch'],
        },
      },
      records: [{
        suite: 'table', harness: 'web',
        environment: {
          jsRegime: 'interp',
          jsFlags: '--expose-gc,--no-opt,--no-sparkplug,--no-maglev',
          cpuThrottle: 4,
          throttleScope: 'process-cgroup',
        },
        entry: 'react', workload: 'create', scale: 10000, metric: 'latency',
        boundary: 'pointerdown-to-dom-predicate', unit: 'ms', samples: [10, 11],
        attemptedCount: 2, acceptedCount: 2, dnfCount: 0,
      }],
    }));
    fs.writeFileSync(path.join(root, 'results/runs/control.json'), JSON.stringify({
      schemaVersion: 4,
      meta: {
        generatedAt: '2026-01-02T00:00:00Z', machine: machine('a'),
        calibration: { probeVersion: 1, score: 100 },
        receipt: { comparabilityCohort: 'sha256:control' },
      },
      records: [{
        suite: 'table', harness: 'web',
        environment: {
          jsRegime: 'jit', jsFlags: '--expose-gc', cpuThrottle: 1, throttleScope: 'none',
        },
        entry: 'react', workload: 'create', scale: 10000, metric: 'latency',
        boundary: 'pointerdown-to-dom-predicate', unit: 'ms', samples: [5, 6],
        attemptedCount: 2, acceptedCount: 2, dnfCount: 0,
      }],
    }));

    const out = collectRuns({
      root, log: () => {}, entryTiers: entryTiers(['react']), generatedAt: 'test',
    });
    const archived = out.records.find(({ throttleScope }) => throttleScope === 'process-cgroup');
    assert.equal(archived.comparabilityStatus, 'invalid-measurement');
    assert.deepEqual(archived.comparabilityReasons, [
      'process-throttle-not-inherited-at-launch',
      'process-throttle-slowdown-unverified',
    ]);
    assert.equal(archived.rankingEligible, false);
    assert.equal(out.comparisonRecords.some(
      ({ throttleScope }) => throttleScope === 'process-cgroup',
    ), false);
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

test('prospective one-shot memory observations do not require repetition accounting', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-bench-memory-'));
  fs.mkdirSync(path.join(root, 'results/runs'), { recursive: true });
  try {
    const measured = (entry) => ({
      ...record(entry), attemptedCount: 1, acceptedCount: 1,
    });
    const memoryAfterClear = (entry) => ({
      ...record(entry, 'memoryAfterClear'),
      metric: 'heapMtsAfterClear',
      boundary: 'gc-heap-after-clearing-10k-rows',
      unit: 'bytes',
      samples: null,
      value: 1024,
      n: 1,
      median: 1024,
    });
    fs.writeFileSync(path.join(root, 'results/runs/complete.json'), JSON.stringify({
      schemaVersion: 2,
      meta: {
        generatedAt: '2026-01-01T00:00:00Z',
        machine: machine('memory-machine'),
        calibration: { probeVersion: 1, score: 100 },
        receipt: { comparabilityCohort: 'sha256:memory-cohort' },
        entryCommits: { octane: 'octane-sha', react: 'react-sha' },
      },
      records: [
        measured('octane'), memoryAfterClear('octane'),
        measured('react'), memoryAfterClear('react'),
      ],
    }));

    const out = collectRuns({
      root,
      generatedAt: 'test',
      log: () => {},
      entryTiers: entryTiers(['octane', 'react']),
    });
    const memory = out.records.filter(({ workload }) => workload === 'memoryAfterClear');
    assert.equal(memory.length, 2);
    assert.equal(memory.every(({ comparabilityStatus }) => comparabilityStatus === 'comparable'), true);
    assert.equal(memory.every(({ rankingEligible }) => rankingEligible), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('history keeps a complete past entry set without requiring future featured entries', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-bench-history-'));
  fs.mkdirSync(path.join(root, 'results/runs'), { recursive: true });
  const writeHistoryRun = (file, generatedAt, records) => {
    fs.writeFileSync(path.join(root, 'results/runs', file), JSON.stringify({
      schemaVersion: 2,
      meta: {
        generatedAt,
        machine: machine('history-machine'),
        calibration: { probeVersion: 1, score: 100 },
        entryCommits: Object.fromEntries(
          [...new Set(records.map(({ entry }) => entry))].map((entry) => [entry, `${entry}-sha`]),
        ),
      },
      records,
    }));
  };
  try {
    writeHistoryRun('past-complete.json', '2026-01-01T00:00:00Z', [
      record('octane'), record('octane', 'select'),
      record('react'), record('react', 'select'),
    ]);
    writeHistoryRun('past-incomplete.json', '2026-01-02T00:00:00Z', [
      record('octane'), record('octane', 'select'),
      record('react'),
    ]);
    writeHistoryRun('current.json', '2026-01-03T00:00:00Z', [
      record('octane'), record('octane', 'select'),
      record('react'), record('react', 'select'),
      record('octane-new'), record('octane-new', 'select'),
    ]);

    const out = collectRuns({
      root,
      generatedAt: 'test',
      log: () => {},
      entryTiers: entryTiers(['octane', 'react', 'octane-new']),
      datasetCheckpoints: [{
        id: 'past-complete',
        label: 'Past complete',
        description: 'A complete historical dataset.',
        webRunFile: 'past-complete.json',
        entryIds: ['octane', 'react'],
      }],
    });
    const checkpointFiles = out.history.checkpoints.flatMap((checkpoint) =>
      checkpoint.harnesses.flatMap(({ sourceRunFiles }) => sourceRunFiles));
    assert.ok(checkpointFiles.includes('past-complete.json'));
    assert.equal(checkpointFiles.includes('past-incomplete.json'), false);
    const past = out.history.checkpoints.find((checkpoint) =>
      checkpoint.harnesses.some(({ sourceRunFiles }) =>
        sourceRunFiles.includes('past-complete.json')));
    assert.deepEqual(past.harnesses[0].entryIds, ['octane', 'react']);
    assert.equal(past.harnesses[0].rankEligible, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('history audits every run but publishes only complete source-defined featured matrices', () => {
  const root = repoRoot();
  const out = collectRuns({ root, log: () => {} });
  assert.equal(out.listCoverage.expectedCellCount, 56);
  assert.deepEqual(out.listCoverage.summary, { unsupported: 56 });
  assert.ok(out.listCoverage.cells.every((cell) =>
    cell.fixture.kind === 'entry-manifest'
    && cell.fixture.declared === false
    && cell.reason === 'list-fixture-not-declared'));
  assert.equal(out.comparisonRecords.some((record) => record.suite === 'list'), false);
  const bundleScale = out.comparisonRecords.filter((record) => record.suite === 'bundle-scale');
  assert.equal(bundleScale.length, 144);
  const retainedRecords = out.comparisonRecords.filter((record) => record.suite !== 'bundle-scale');
  // The invalidated pre-verifier process-cgroup source remains archive-only.
  // The replacement run contributes one verified 108-record matrix for every
  // current comparison entry. The older Hux source commit is admissible here
  // because its complete Web bundle receipt is byte-identical to the manifest.
  const verifiedProcessRun = retainedRecords.filter((record) => record.runFile ===
    '2026-08-30T17-58-27-65160668d8d9-issue43-featured-web-interp-4x-cg-inherited-clean-v3.json');
  assert.equal(verifiedProcessRun.length, 756);
  assert.deepEqual(
    [...new Set(verifiedProcessRun.map((record) => record.entry))].sort(),
    ['octane', 'octane-hux', 'react', 'vue-vapor', 'vue-vapor-ifr', 'vue-vdom',
      'vue-vdom-ifr-et'],
  );
  assert.ok(verifiedProcessRun.every((record) =>
    record.throttleScope === 'process-cgroup'
    && record.cpuThrottle === 4));
  // The current JIT cohort also includes 196 retained records from the complete
  // seven-entry create matrix at 3k/5k/20k/30k across table and pipeline. Native
  // contributes the exact six-entry × 23-cell instrumented-v3 matrix; the prior
  // five-entry/115-cell cohort is archive-only after the contract transition.
  const retainedNative = retainedRecords.filter((record) => record.harness === 'native');
  assert.equal(retainedNative.length, 138);
  assert.equal(out.nativeCoverage.version, 'native-featured-instrumented-matrix-v3');
  assert.ok(retainedNative.every((record) => record.runFile ===
    '2026-09-02T07-28-32-lynx-native-android-aries_10-10-devtool-direct-recycle5-738c5271a1bf-2056a19666bd-native-octane-native-app-contract-v3-2026-09-02.json'));
  assert.equal(retainedRecords.length, 5334);
  assert.ok(bundleScale.every((record) => record.rankingEligible === false
    && record.descriptiveEligible === true
    && record.runFile === null
    && record.artifact?.sha256?.length === 64));
  assert.equal(out.history.sources.length, out.sources.runFiles.length);
  assert.deepEqual(
    out.history.sources.map((source) => source.runFile),
    out.sources.runFiles,
  );
  assert.equal(out.history.checkpoints.at(-1).id, 'current-main');
  assert.equal(out.history.checkpoints.at(-1).listCoverage.expectedCellCount, 56);
  const currentWeb = out.history.checkpoints.at(-1).harnesses.find(
    (cohort) => cohort.harness === 'web',
  );
  // Source commits may differ only when the complete Web artifact receipt is
  // byte-identical, so both Octane identities remain in every Web regime.
  assert.equal(currentWeb.entryIds.length, 7);
  assert.equal(currentWeb.entryIds.includes('octane'), true);
  assert.equal(currentWeb.entryIds.includes('octane-hux'), true);
  assert.equal(currentWeb.entryIds.includes('octane-pr-791'), false);
  assert.equal(currentWeb.sourceRunFiles.includes(
    '2026-09-01T16-38-06-65160668d8d9-full-web-2026-09-01.json',
  ), true);
  assert.equal(currentWeb.sourceRunFiles.includes(
    '2026-09-01T17-15-14-65160668d8d9-extended-create-scales-web-2026-09-01.json',
  ), true);
  assert.equal(currentWeb.sourceRunFiles.includes(
    '2026-08-30T11-50-00-65160668d8d9-issue-201-current-bundle-storm-interp-v3.json',
  ), false);
  const currentInterpWeb = out.history.checkpoints.at(-1).harnesses.find(
    (cohort) => cohort.harness === 'web'
      && cohort.jsRegime === 'interp'
      && cohort.cpuThrottle === 1,
  );
  assert.equal(currentInterpWeb.sourceRunFiles.includes(
    '2026-08-30T11-50-00-65160668d8d9-issue-201-current-bundle-storm-interp-v3.json',
  ), true);
  assert.equal(currentWeb.sourceRunFiles.some((file) =>
    file.includes('2026-08-26T11-5') && file.includes('issue-30-')), false);
  const currentRecords = out.history.checkpoints.at(-1).activeRecordIndexes
    .map((index) => out.history.records[index]);
  assert.equal(currentRecords.filter((record) => record.suite === 'bundle-scale').length, 144);
  assert.ok(currentRecords.filter((record) => record.suite === 'bundle-scale')
    .every((record) => record.rankEligible === false && record.descriptiveEligible === true));
  const stormOperations = currentRecords.filter((record) =>
    record.suite === 'storm' && record.metric === 'operationTime');
  assert.equal(stormOperations.length, 28);
  assert.equal(stormOperations.filter((record) =>
    record.commitPolicy === 'final-state'
    && !record.rankEligible
    && record.descriptiveEligible
    && record.comparabilityStatus === 'comparable'
    && record.dnfCount === 0).length, 14);
  assert.equal(stormOperations.filter((record) =>
    record.commitPolicy === 'every-tick'
    && !record.rankEligible
    && record.descriptiveEligible
    && record.comparabilityStatus === 'contract-failed'
    && record.dnfCount === 0).length, 14);
  // The refreshed current cohort uses the default three storm repetitions and
  // retains each raw operation observation plus its matching detail receipt.
  assert.equal(stormOperations.every((record) =>
    record.samples.length === 3 && record.detailSamples.length === 3), true);
  assert.equal(currentRecords.filter((record) =>
    record.suite === 'storm' && record.metric !== 'operationTime')
    .every((record) => record.samples.length === 3 && record.detailSamples == null), true);
  const materializedStormOperations = out.comparisonRecords.filter((record) =>
    record.suite === 'storm' && record.metric === 'operationTime');
  assert.equal(materializedStormOperations.length, 56);
  for (const environment of ['lynx-for-web', 'lynx-for-web-interp']) {
    const environmentOperations = materializedStormOperations.filter((record) =>
      record.environment === environment);
    assert.equal(environmentOperations.length, 28);
    assert.equal(environmentOperations.filter((record) =>
      record.commitPolicy === 'final-state'
      && record.rankingEligible
      && record.comparabilityStatus === 'comparable'
      && record.dnfCount === 0).length, 14);
    assert.equal(environmentOperations.filter((record) =>
      record.commitPolicy === 'every-tick'
      && !record.rankingEligible
      && record.comparabilityStatus === 'contract-failed'
      && record.dnfCount === 0).length, 14);
  }
  assert.equal(out.history.sources.some((source) =>
    source.entryIds.includes('octane-pr-791')), true);

  const webCheckpointIds = out.history.checkpoints
    .filter((checkpoint) => checkpoint.harnesses.some((cohort) => cohort.harness === 'web'))
    .map((checkpoint) => checkpoint.id);
  assert.deepEqual(webCheckpointIds, [
    ...DATASET_CHECKPOINT_SPECS.map((checkpoint) => checkpoint.id),
    'current-main',
  ]);
  const checkpointLabels = out.history.checkpoints.map((checkpoint) => checkpoint.label);
  assert.deepEqual(
    checkpointLabels.filter((label) => !label.startsWith('Native · ')),
    [
      'Aug 8 · React/Vue reference',
      'Aug 10 · slow Octane joins',
      'Aug 11 · Octane step change',
      'Aug 15 · Octane converges',
      'Aug 22 · Octane (Hux) joins',
      'Current · merged upstream',
    ],
  );
  assert.deepEqual(
    checkpointLabels.filter((label) => label.startsWith('Native · ')),
    [
      'Native · 2026-08-18T11:21:23.892Z',
      'Native · 2026-09-02T08:31:20.507Z',
    ],
  );
  assert.equal(out.history.checkpoints.every((checkpoint) =>
    !Object.hasOwn(checkpoint, 'octaneCommit')), true);

  assert.equal(out.history.replays.length, 1);
  const replay = out.history.replays[0];
  assert.equal(replay.id, HISTORY_REPLAY_SPEC.id);
  assert.equal(replay.runFile, HISTORY_REPLAY_SPEC.runFile);
  assert.equal(replay.minimumReps, 11);
  assert.equal(replay.cellKeys.length, 12);
  assert.equal(replay.cellKeys.includes('clear@1000'), true);
  assert.equal(replay.checkpoints.length, webCheckpointIds.length - 1);
  assert.equal(replay.checkpoints.some(({ checkpointId }) => checkpointId === 'current-main'), false);
  const stablePeerCells = [];
  for (const replayCheckpoint of replay.checkpoints) {
    const checkpoint = out.history.checkpoints.find((candidate) =>
      candidate.id === replayCheckpoint.checkpointId);
    assert.ok(checkpoint);
    const records = replayCheckpoint.activeRecordIndexes.map((index) => replay.records[index]);
    assert.equal(records.length, replayCheckpoint.entryIds.length * replay.cellKeys.length);
    assert.equal(records.every((record) =>
      record.n >= replay.minimumReps
      && record.dnfCount === 0
      && Number.isFinite(record.median)
      && record.comparisonKind === 'historical-replay'), true);
    assert.equal(records.filter((record) =>
      record.workload === 'clear' && record.scale === 1000).length,
    replayCheckpoint.entryIds.length);
    for (const [entryId, sourceEntryId] of Object.entries(replayCheckpoint.sourceByEntry)) {
      const pointer = checkpoint.identityPointers.find((item) => item.entryId === entryId);
      const record = records.find((item) => item.entry === entryId);
      assert.ok(record);
      assert.equal(record.entryCommit, pointer.commit);
      assert.equal(record.sourceEntry ?? record.entry, sourceEntryId);
    }
    stablePeerCells.push(Object.fromEntries(records
      .filter((record) => record.entry === 'react')
      .map((record) => [`${record.workload}@${record.scale}`, record.median])));
  }
  for (const cells of stablePeerCells.slice(1)) assert.deepEqual(cells, stablePeerCells[0]);
  assert.equal(out.history.sources.find((source) =>
    source.runFile === HISTORY_REPLAY_SPEC.runFile).reason,
  'partial Web run; explicit suite, case, or scale selection');

  for (const checkpoint of out.history.checkpoints) {
    const entryIds = new Set(checkpoint.harnesses.flatMap((cohort) => cohort.entryIds));
    assert.deepEqual(
      new Set(checkpoint.identityPointers.map((pointer) => pointer.entryId)),
      entryIds,
    );
    assert.equal(checkpoint.identityPointers.every((pointer) =>
      pointer.version != null || pointer.commit != null), true);
    assert.equal(checkpoint.identityPointers.every((pointer) => pointer.href != null), true);
    const records = checkpoint.activeRecordIndexes.map((index) => out.history.records[index]);
    for (const cohort of checkpoint.harnesses) {
      const cohortRecords = records.filter((record) => record.harness === cohort.harness
        && record.environment === cohort.environment
        && record.rankEligible);
      const crossEntryRecords = cohort.harness === 'native'
        ? cohortRecords.filter((record) => record.suite !== 'startup')
        : cohortRecords;
      const cellKeys = cohort.entryIds.map((entryId) => new Set(crossEntryRecords
        .filter((record) => record.entry === entryId)
        .map((record) => [
          record.suite, record.environment, record.workload, record.scale,
          record.metric, record.boundary, record.unit,
        ].join('|'))));
      for (const cells of cellKeys.slice(1)) assert.deepEqual(cells, cellKeys[0]);
      if (cohort.harness === 'native') {
        const startupRecords = cohortRecords.filter((record) => record.suite === 'startup');
        if (startupRecords.length > 0) {
          for (const entryId of cohort.entryIds) {
            assert.equal(startupRecords.filter((record) => record.entry === entryId).length, 8);
          }
        }
      }
    }
  }

  const currentCheckpointRecords = out.history.checkpoints.find((checkpoint) => checkpoint.id === 'current-main')
    .activeRecordIndexes.map((index) => out.history.records[index]);
  const currentCheckpoint = out.history.checkpoints.find((checkpoint) =>
    checkpoint.id === 'current-main');
  const pipelineOperations = currentCheckpointRecords.filter((record) =>
    record.suite === 'pipeline' && record.metric === 'operationTime');
  const materializedPipeline = out.comparisonRecords.filter((record) =>
    record.suite === 'pipeline');
  assert.equal(currentCheckpoint.pipelineCoverage.expectedCellCount, 84);
  assert.equal([0, 84].includes(pipelineOperations.length), true);
  if (pipelineOperations.length === 0) {
    assert.deepEqual(currentCheckpoint.pipelineCoverage.summary, { unscheduled: 84 });
  } else {
    assert.deepEqual(
      [...new Set(pipelineOperations.map((record) => record.entry))].sort(),
      ['octane', 'octane-hux', 'react', 'vue-vapor', 'vue-vapor-ifr', 'vue-vdom', 'vue-vdom-ifr-et'],
    );
    assert.equal(new Set(pipelineOperations.map((record) =>
      `${record.entry}|${record.workload}|${record.scale}`)).size, 84);
  }
  assert.equal(pipelineOperations.every((record) =>
    (record.samples.length > 0 || record.dnfCount > 0)
    && record.detailSamples.length === record.samples.length
    && !record.rankEligible
    && record.descriptiveEligible), true);
  assert.equal(materializedPipeline.filter((record) =>
    record.metric !== 'operationTime').every((record) =>
    record.detailSamples == null && record.pipelineControl == null), true);
  assert.equal(materializedPipeline.filter((record) =>
    record.metric === 'operationTime').every((record) =>
    record.detailSamples.every((detail) => detail.surfaceNames == null)
    && record.pipelineControl.surfaceNames.includes('__FlushElementTree')), true);

  const aug8File = '2026-08-08T07-22-33-b0fcfd511132-full.json';
  const aug8 = out.history.checkpoints.find((checkpoint) =>
    checkpoint.harnesses.some((cohort) => cohort.sourceRunFiles.includes(aug8File)));
  assert.ok(aug8);
  assert.deepEqual(aug8.harnesses[0].entryIds, [
    'react', 'vue-vapor', 'vue-vapor-ifr', 'vue-vdom', 'vue-vdom-ifr-et',
  ]);
  assert.equal(aug8.identityPointers.some(({ framework }) => framework === 'octane'), false);
  assert.equal(
    out.history.sources.find((source) => source.runFile === aug8File).reason,
    'selected dataset checkpoint 2026-08-08-peer-reference',
  );

  const aug10File = '2026-08-10T21-20-16-65160668d8d9-full-frameworks-65160668d8d9.json';
  const aug10 = out.history.checkpoints.find((checkpoint) =>
    checkpoint.harnesses.some((cohort) => cohort.sourceRunFiles.includes(aug10File)));
  assert.ok(aug10);
  assert.deepEqual(aug10.harnesses[0].entryIds, [
    'octane', 'react', 'vue-vapor', 'vue-vapor-ifr', 'vue-vdom', 'vue-vdom-ifr-et',
  ]);
  assert.equal(aug10.identityPointers.find(({ entryId }) => entryId === 'octane').commit,
    'e81fd879308a4367c8c1af920e0d59ef648b8ffe');
  assert.equal(aug10.identityPointers.find(({ entryId }) => entryId === 'octane').channel,
    'upstream HEAD at measurement time');
  assert.equal(aug10.identityPointers.some(({ entryId }) => entryId === 'octane-hux1'), false);
  assert.equal(aug10.identityPointers.some(({ entryId }) => entryId === 'octane-hux2'), false);
  assert.equal(aug10.identityPointers.some(({ entryId }) => entryId === 'octane-hux'), false);
  const aug10Source = out.history.sources.find((source) => source.runFile === aug10File);
  assert.ok(aug10Source);
  assert.equal(aug10Source.entryCommits['octane-main'],
    'e81fd879308a4367c8c1af920e0d59ef648b8ffe');
  assert.equal(aug10Source.rankEligible, true);
  assert.equal(aug10Source.reason, 'selected dataset checkpoint 2026-08-10-slow-octane');

  const aug16File = '2026-08-16T15-36-12-65160668d8d9-2026-08-16-web-six-framework-full.json';
  const aug16 = out.history.checkpoints.find((checkpoint) =>
    checkpoint.harnesses.some((cohort) => cohort.sourceRunFiles.includes(aug16File)));
  assert.equal(aug16, undefined);

  const incompleteFiles = [
    '2026-08-08T18-37-25-b0fcfd511132-octane-main.json',
    '2026-08-11T13-06-38-65160668d8d9-verify-featured-select10k.json',
    aug16File,
  ];
  for (const file of incompleteFiles) {
    assert.equal(out.history.checkpoints.some((checkpoint) =>
      checkpoint.harnesses.some((cohort) => cohort.sourceRunFiles.includes(file))), false);
    const source = out.history.sources.find((candidate) => candidate.runFile === file);
    assert.ok(source);
    assert.equal(source.rankEligible, false);
  }
  assert.equal(
    out.history.sources.find(({ runFile }) =>
      runFile === '2026-08-11T13-06-38-65160668d8d9-verify-featured-select10k.json').reason,
    'partial Web run; explicit suite, case, or scale selection',
  );

  const native = out.history.checkpoints.find((checkpoint) =>
    checkpoint.harnesses.some((cohort) => cohort.sourceRunFiles.includes(
      '2026-08-17T23-25-11-lynx-native-android-aries_10-10-devtool-direct-recycle5-9dd16c73a8b1-34a7cf1707b5-native-native-matrix-backfill-v2-r1-20260817.json',
    )));
  assert.ok(native);
  const nativeCohort = native.harnesses.find((cohort) => cohort.harness === 'native');
  assert.equal(nativeCohort.rankEligible, true);
  assert.equal(nativeCohort.sourceRunFiles.length, 1);
  assert.equal(out.history.checkpoints.some((checkpoint) =>
    checkpoint.harnesses.some((cohort) => cohort.sourceRunFiles.includes(
      '2026-08-16T16-43-55-lynx-native-android-aries_10-10-devtool-direct-recycle1-0582f99c1abc-ce0729fa-native-2026-08-16-native-six-framework-final-bounded.json',
    ))), false);
});

test('history omits non-standard storm rows and ranks the complete retained cohort', () => {
  const out = collectRuns({ root: repoRoot(), log: () => {} });
  const aug12File = '2026-08-12T18-02-55-65160668d8d9-upstream-main-6079a680-featured.json';
  assert.equal(out.history.checkpoints.some((checkpoint) =>
    checkpoint.harnesses.some((cohort) => cohort.sourceRunFiles.includes(aug12File))), false);
  const aug12Source = out.history.sources.find((source) => source.runFile === aug12File);
  assert.ok(aug12Source);
  assert.equal(aug12Source.rankEligible, false);

  const current = out.history.checkpoints.find((checkpoint) =>
    checkpoint.harnesses.some((cohort) => cohort.sourceRunFiles.includes(
      '2026-08-22T03-28-41-65160668d8d9-octane-new-2026-08-22-block-web-rerun.json',
    )));
  const currentRecords = current.activeRecordIndexes.map((index) => out.history.records[index]);
  assert.equal(currentRecords.some((candidate) =>
    ['updateStorm', 'selectStorm'].includes(candidate.workload)), false);
  const currentRecord = currentRecords
    .find((candidate) => candidate.entry === 'octane-hux'
      && candidate.harness === 'web'
      && candidate.workload === 'select'
      && candidate.scale === 1000
      && candidate.metric === 'latency');
  assert.equal(currentRecord.median, 23.894999980926514);
  assert.equal(currentRecord.rankEligible, true);
  assert.equal(currentRecord.transport, undefined);
});
