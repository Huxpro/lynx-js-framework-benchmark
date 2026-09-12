import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveConnectorPackageTrees } from './connector-receipt.mjs';
import { repoRoot } from './entries.mjs';
import { LIST_FIXTURE_PROTOCOL } from '../../shared/src/list-workloads.mjs';
import { LIST_WORKLOAD_CONTRACT_SHA256 } from './list-coverage.mjs';
import {
  assertNativeListInputsUnchanged,
  snapshotNativeListInputs,
} from './list-native-inputs.mjs';

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

test('Native list input receipt pins scale bundles, sources, and provenance patches', () => {
  const root = repoRoot();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-list-inputs-'));
  try {
    const bundles = {};
    const hashes = {};
    for (const scale of [1000, 10000]) {
      const relative = `list-${scale}.lynx.bundle`;
      const bytes = Buffer.from(`list:${scale}`);
      fs.writeFileSync(path.join(dir, relative), bytes);
      bundles[scale] = relative;
      hashes[scale] = sha256(bytes);
    }
    const patchFile = path.join(dir, 'fixture.patch');
    fs.writeFileSync(patchFile, 'fixture patch');
    const manifest = {
      id: 'fixture',
      listFixture: {
        protocol: LIST_FIXTURE_PROTOCOL,
        contractSha256: LIST_WORKLOAD_CONTRACT_SHA256,
        bundles: { native: bundles },
        sha256: { native: hashes },
      },
    };
    fs.writeFileSync(path.join(dir, 'entry.json'), JSON.stringify(manifest));
    const adapterPath = path.join(root, 'packages/runner/adapters/lynx-sandbox-android.mjs');
    const connectorPackageTrees = resolveConnectorPackageTrees({
      fromPath: adapterPath,
    });
    const inputs = snapshotNativeListInputs({
      entries: [{ ...manifest, dir, provenance: { patchFile } }],
      adapterPath,
      connectorPackageTrees,
      root,
    });
    assert.equal(inputs.snapshots.size, 2);
    assert.equal(
      inputs.receipt.entryArtifacts.fixture.provenance.patchSha256,
      sha256('fixture patch'),
    );
    assert.doesNotThrow(() => assertNativeListInputsUnchanged(inputs));
    fs.writeFileSync(patchFile, 'mutated');
    assert.throws(() => assertNativeListInputsUnchanged(inputs), /changed after snapshot/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
