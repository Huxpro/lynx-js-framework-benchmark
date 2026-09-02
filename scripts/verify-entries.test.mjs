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
const LIST_CONTRACT_SHA256 =
  '8cc9d901f97e6e17ac6207b13d9bb9afb5163ce0d1142cffd1b1921726a2f87b';

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function stageDiagnosticEntry() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-native-diagnostic-'));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.copyFileSync(sourceScript, path.join(root, 'scripts/verify-entries.mjs'));
  const listWorkloads = path.join(root, 'packages/shared/src/list-workloads.mjs');
  fs.mkdirSync(path.dirname(listWorkloads), { recursive: true });
  fs.copyFileSync(listWorkloadsSource, listWorkloads);

  const entryDir = path.join(root, 'entries/octane-native-diagnostic');
  const tableBundle = path.join(entryDir, 'dist/table/main.lynx.bundle');
  const listBundle = path.join(entryDir, 'dist/list/main.lynx.bundle');
  fs.mkdirSync(path.dirname(tableBundle), { recursive: true });
  fs.mkdirSync(path.dirname(listBundle), { recursive: true });
  fs.writeFileSync(tableBundle, 'eager-table-native');
  fs.writeFileSync(listBundle, 'bounded-list-native');
  const tableSha256 = sha256('eager-table-native');
  const listSha256 = sha256('bounded-list-native');
  const commit = 'a'.repeat(40);
  const receiptPayload = {
    protocol: 'octane-native-diagnostic-build-v1',
    sourceCommit: commit,
    artifacts: {
      table: {
        path: 'benchmarks/lynx-table/app/dist/main.lynx.bundle',
        sha256: tableSha256,
      },
      list: {
        path: 'benchmarks/lynx-list/app/dist/main.lynx.bundle',
        sha256: listSha256,
      },
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
    config: 'unranked Native eager-table capacity probe and 10,000-row bounded list',
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
        'list/main.lynx.bundle': listSha256,
      },
    },
    bundles: { lynx: 'dist/table/main.lynx.bundle' },
    listFixture: {
      protocol: 'lynx-list-fixture-v1',
      contractSha256: LIST_CONTRACT_SHA256,
      bundles: { native: 'dist/list/main.lynx.bundle' },
      sha256: { native: listSha256 },
    },
  };
  const manifestPath = path.join(entryDir, 'entry.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return { root, entryDir, manifestPath, manifest };
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
    'missing list bundle',
    ({ entryDir }) => fs.rmSync(path.join(entryDir, 'dist/list/main.lynx.bundle')),
    /checksummed bundle missing|listFixture Native bundle missing/,
  ],
  [
    'stale list bundle',
    ({ entryDir }) => fs.writeFileSync(
      path.join(entryDir, 'dist/list/main.lynx.bundle'),
      'stale-list-native',
    ),
    /sha256 mismatch/,
  ],
  [
    'mismatched list bundle path',
    ({ manifest }) => { manifest.listFixture.bundles.native = 'dist/table/main.lynx.bundle'; },
    /listFixture Native bundle path/,
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
      manifest.provenance.buildReceipt.artifacts.list.sha256 = 'c'.repeat(64);
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
