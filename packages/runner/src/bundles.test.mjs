import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';

import { bundleRecords } from './bundles.mjs';

test('bundle derivation preserves legacy scale-0 records and adds exact per-scale artifacts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-scale-'));
  try {
    const distDir = path.join(dir, 'dist');
    for (const scale of [0, 1000, 10000, 30000]) {
      const scaleDir = path.join(distDir, `rows-${scale}`);
      fs.mkdirSync(scaleDir, { recursive: true });
      fs.writeFileSync(path.join(scaleDir, 'main.web.bundle'), JSON.stringify({
        lepusCode: { root: `mts-${scale}` },
        manifest: { '/app-service.js': `bts-${scale}` },
      }));
      fs.writeFileSync(path.join(scaleDir, 'main.lynx.bundle'), `binary-${scale}`);
    }
    const records = bundleRecords({ id: 'example', dir, distDir });
    const legacy = records.filter(({ suite }) => suite === 'bundle');
    assert.equal(legacy.length, 8);
    assert.ok(legacy.every(({ scale, harness }) => scale === 0 && harness === 'web'));

    const scaled = records.filter(({ suite }) => suite === 'bundle-scale');
    assert.equal(scaled.length, 24);
    assert.deepEqual([...new Set(scaled.map(({ scale }) => scale))], [0, 1000, 10000, 30000]);
    assert.equal(scaled.filter(({ metric }) => metric === 'totalArtifactGzip').length, 8);
    assert.equal(scaled.filter(({ metric }) => metric === 'mtsSectionGzip').length, 4);
    assert.equal(scaled.some(({ harness, metric }) =>
      harness === 'native' && metric === 'mtsSectionGzip'), false);
    const point = scaled.find(({ harness, scale, metric }) =>
      harness === 'web' && scale === 1000 && metric === 'totalArtifactGzip');
    const buf = fs.readFileSync(path.join(distDir, 'rows-1000/main.web.bundle'));
    assert.equal(point.value, zlib.gzipSync(buf, { level: 9 }).length);
    assert.deepEqual(point.artifact, {
      path: 'dist/rows-1000/main.web.bundle',
      sha256: crypto.createHash('sha256').update(buf).digest('hex'),
      flavor: 'web',
      section: 'whole-artifact',
    });
    assert.equal(point.rankingEligible, false);
    assert.equal(point.descriptiveEligible, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
