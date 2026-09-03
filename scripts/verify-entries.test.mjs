import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const sourceScript = new URL('./verify-entries.mjs', import.meta.url).pathname;
const listWorkloadsSource = new URL(
  '../packages/shared/src/list-workloads.mjs',
  import.meta.url,
).pathname;
const nativeDiagnosticContractSource = new URL(
  '../packages/shared/src/native-diagnostic-contract.mjs',
  import.meta.url,
).pathname;
const LIST_CONTRACT_SHA256 =
  '8cc9d901f97e6e17ac6207b13d9bb9afb5163ce0d1142cffd1b1921726a2f87b';
const CAPACITY_SCALES = [1000, 6000, 7000, 7500, 8000, 10000];
const LIST_SCALES = [1000, 10000];

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function stageDiagnosticEntry() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-native-diagnostic-'));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.copyFileSync(sourceScript, path.join(root, 'scripts/verify-entries.mjs'));
  const listWorkloads = path.join(root, 'packages/shared/src/list-workloads.mjs');
  fs.mkdirSync(path.dirname(listWorkloads), { recursive: true });
  fs.copyFileSync(listWorkloadsSource, listWorkloads);
  fs.copyFileSync(
    nativeDiagnosticContractSource,
    path.join(root, 'packages/shared/src/native-diagnostic-contract.mjs'),
  );

  const entryDir = path.join(root, 'entries/octane-native-diagnostic');
  const tableBundle = path.join(entryDir, 'dist/table/main.lynx.bundle');
  fs.mkdirSync(path.dirname(tableBundle), { recursive: true });
  fs.writeFileSync(tableBundle, 'empty-table-native');
  const tableSha256 = sha256('empty-table-native');
  const list = Object.fromEntries(LIST_SCALES.map((rows) => {
    const bundle = `dist/list/rows-${rows}/main.lynx.bundle`;
    const file = path.join(entryDir, bundle);
    const contents = `bounded-list-native-${rows}`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
    return [String(rows), { bundle, sha256: sha256(contents) }];
  }));
  const capacity = Object.fromEntries(CAPACITY_SCALES.map((rows) => {
    const bundle = `dist/capacity/rows-${rows}/main.lynx.bundle`;
    const file = path.join(entryDir, bundle);
    const contents = `lynx-native-startup-v1 eager-capacity-${rows}`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
    return [String(rows), { bundle, sha256: sha256(contents) }];
  }));
  const commit = 'a'.repeat(40);
  const receiptPayload = {
    protocol: 'octane-native-diagnostic-build-v3',
    sourceCommit: commit,
    artifacts: {
      table: {
        path: 'benchmarks/lynx-table/app/dist/main.lynx.bundle',
        sha256: tableSha256,
      },
      capacity: Object.fromEntries(CAPACITY_SCALES.map((rows) => [String(rows), {
        path: `benchmarks/lynx-table/app/dist-rows${rows}/main.lynx.bundle`,
        sha256: capacity[String(rows)].sha256,
      }])),
      list: Object.fromEntries(LIST_SCALES.map((rows) => [String(rows), {
        path: `benchmarks/lynx-list/app/dist/rows-${rows}/main.lynx.bundle`,
        sha256: list[String(rows)].sha256,
      }])),
    },
  };
  const buildReceipt = {
    ...receiptPayload,
    sha256: sha256(JSON.stringify(receiptPayload)),
  };
  const manifest = {
    id: 'octane-native-diagnostic',
    label: 'Octane Native diagnostics',
    framework: 'octane',
    frameworkVersion: '0.2.2',
    config: 'unranked Native eager-table capacity probe and scale-bound bounded list',
    tags: ['diagnostic', 'capacity-probe'],
    tier: 'lab',
    harnesses: ['native'],
    color: '#ff415a',
    presentation: { order: 999, colorLight: '#ff415a', colorDark: '#ff415a' },
    kind: 'vendored',
    provenance: {
      source: 'https://github.com/octanejs/octane',
      ref: commit,
      commit,
      patched: false,
      patchFile: null,
      buildCommand: 'node scripts/build-octane-upstream.mjs <clean-octane-checkout>',
      builtAt: '2026-09-02T00:00:00Z',
      buildReceipt,
      sha256: {
        'table/main.lynx.bundle': tableSha256,
        ...Object.fromEntries(CAPACITY_SCALES.map((rows) => [
          `capacity/rows-${rows}/main.lynx.bundle`,
          capacity[String(rows)].sha256,
        ])),
        ...Object.fromEntries(LIST_SCALES.map((rows) => [
          `list/rows-${rows}/main.lynx.bundle`,
          list[String(rows)].sha256,
        ])),
      },
    },
    bundles: { lynx: 'dist/table/main.lynx.bundle' },
    capacityFixture: {
      protocol: 'lynx-native-capacity-fixture-v1',
      fixtureRole: 'eager-capacity-probe',
      topology: { elementsPerRow: 7, chromeElements: 42 },
      scales: capacity,
    },
    listFixture: {
      protocol: 'lynx-list-fixture-v2',
      workloadProtocol: 'lynx-list-fixture-v1',
      contractSha256: LIST_CONTRACT_SHA256,
      scales: list,
    },
  };
  const manifestPath = path.join(entryDir, 'entry.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return { root, entryDir, manifestPath, manifest, capacity, list };
}

function verify(root) {
  return spawnSync(process.execPath, [path.join(root, 'scripts/verify-entries.mjs')], {
    cwd: root,
    encoding: 'utf8',
  });
}

test('entry verification accepts the generated native-only diagnostic contract', () => {
  const fixture = stageDiagnosticEntry();
  try {
    const result = verify(fixture.root);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

for (const [name, mutate, error] of [
  [
    'missing capacity bundle',
    ({ entryDir }) => fs.rmSync(
      path.join(entryDir, 'dist/capacity/rows-7000/main.lynx.bundle'),
    ),
    /checksummed bundle missing|capacityFixture 7000 bundle missing/,
  ],
  [
    'stale capacity bundle',
    ({ entryDir }) => fs.writeFileSync(
      path.join(entryDir, 'dist/capacity/rows-7000/main.lynx.bundle'),
      'stale-capacity-native',
    ),
    /sha256 mismatch/,
  ],
  [
    'rows-0-only capacity mapping',
    ({ manifest }) => {
      manifest.capacityFixture.scales['1000'].bundle = 'dist/table/main.lynx.bundle';
    },
    /capacityFixture 1000 bundle path/,
  ],
  [
    'mismatched capacity protocol',
    ({ manifest }) => {
      manifest.capacityFixture.protocol = 'lynx-native-capacity-fixture-v0';
    },
    /capacityFixture protocol/,
  ],
  [
    'mismatched capacity topology',
    ({ manifest }) => {
      manifest.capacityFixture.topology.elementsPerRow = 6;
    },
    /capacityFixture topology/,
  ],
  [
    'missing list bundle',
    ({ entryDir }) => fs.rmSync(path.join(entryDir, 'dist/list/rows-1000/main.lynx.bundle')),
    /checksummed bundle missing|listFixture 1000 bundle missing/,
  ],
  [
    'stale list bundle',
    ({ entryDir }) => fs.writeFileSync(
      path.join(entryDir, 'dist/list/rows-10000/main.lynx.bundle'),
      'stale-list-native',
    ),
    /sha256 mismatch/,
  ],
  [
    'mismatched list bundle path',
    ({ manifest }) => {
      manifest.listFixture.scales['1000'].bundle = 'dist/table/main.lynx.bundle';
    },
    /listFixture 1000 bundle path/,
  ],
  [
    'missing list scale',
    ({ manifest }) => { delete manifest.listFixture.scales['1000']; },
    /listFixture must declare exactly scales/,
  ],
  [
    'extra list scale',
    ({ manifest }) => {
      manifest.listFixture.scales['2000'] = manifest.listFixture.scales['1000'];
    },
    /listFixture must declare exactly scales/,
  ],
  [
    'mismatched list protocol',
    ({ manifest }) => { manifest.listFixture.protocol = 'lynx-list-fixture-v0'; },
    /listFixture protocol/,
  ],
  [
    'mismatched source revision',
    ({ manifest }) => {
      manifest.provenance.commit = 'b'.repeat(40);
      manifest.provenance.ref = 'b'.repeat(40);
    },
    /build receipt source revision/,
  ],
  [
    'tampered build-receipt artifact binding',
    ({ manifest }) => {
      manifest.provenance.buildReceipt.artifacts.capacity['7000'].sha256 = 'c'.repeat(64);
      const { sha256: _prior, ...payload } = manifest.provenance.buildReceipt;
      manifest.provenance.buildReceipt.sha256 = sha256(JSON.stringify(payload));
    },
    /build receipt artifacts do not match vendored bundles/,
  ],
  [
    'ranked diagnostic entry',
    ({ manifest }) => { manifest.ranking = { eligible: true }; },
    /must remain unranked/,
  ],
  [
    'featured diagnostic entry',
    ({ manifest }) => { manifest.tier = 'featured'; },
    /must remain an unranked lab entry/,
  ],
]) {
  test(`entry verification rejects ${name}`, () => {
    const fixture = stageDiagnosticEntry();
    try {
      mutate(fixture);
      fs.writeFileSync(fixture.manifestPath, JSON.stringify(fixture.manifest, null, 2));
      const result = verify(fixture.root);
      assert.notEqual(result.status, 0, result.stdout);
      assert.match(result.stderr, error);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
}
