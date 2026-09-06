import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  combineWorkloadReceipts,
  hashFiles,
  M0_ENTRY_IDS,
  M0_PINNED_SOURCES,
  M0_ROWS,
} from './m0-artifact-contract.mjs';

test('M0 identity contract is complete and file receipts are path-sensitive', () => {
  assert.deepEqual(M0_ROWS, [0, 1000, 2000, 3000, 5000, 10000]);
  assert.equal(new Set(M0_ENTRY_IDS).size, 8);
  assert.equal(M0_PINNED_SOURCES['octane-m0-current'].ref, 'new-lynx');
  assert.equal(M0_PINNED_SOURCES['octane-m0-upstream'].ref, 'main');
  assert.equal(M0_PINNED_SOURCES.comparators.ref, 'pull/393/head');
  assert.equal(
    M0_PINNED_SOURCES.comparators.commit,
    'db60b3d32c4253400d0ae3b259ebf522ffdf859d',
  );

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm0-artifact-receipt-'));
  try {
    fs.writeFileSync(path.join(root, 'a'), 'same');
    fs.writeFileSync(path.join(root, 'b'), 'same');
    const a = hashFiles(root, ['a']);
    const b = hashFiles(root, ['b']);
    assert.notEqual(a.sha256, b.sha256);
    assert.equal(hashFiles(root, ['a']).sha256, a.sha256);
    const combined = combineWorkloadReceipts(a, b);
    assert.match(combined.sha256, /^[\da-f]{64}$/);
    assert.notEqual(combined.sha256, combineWorkloadReceipts(b, a).sha256);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
