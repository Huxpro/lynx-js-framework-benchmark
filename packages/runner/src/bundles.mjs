// Static bundle metrics per entry: raw/gzip sizes for both flavors, and the
// MTS/BTS section split for JSON-format web bundles (lepusCode.root is the
// main-thread program, manifest['/app-service.js'] the background program).
// Binary-format bundles (e.g. ReactLynx templates) report whole-bundle only.
import crypto from 'node:crypto';
import fs from 'node:fs';
import zlib from 'node:zlib';

import { makeRecord, BOUNDARIES } from '../../shared/src/schema.mjs';
import { STARTUP_CASES } from '@lynx-bench/shared/workloads';

import { bundleFor } from './entries.mjs';

const gz = (buf) => zlib.gzipSync(buf, { level: 9 }).length;
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const STARTUP_SCALES = STARTUP_CASES[0].scales;

function readableMtsSection(buf) {
  try {
    const json = JSON.parse(buf.toString('utf-8'));
    return typeof json?.lepusCode?.root === 'string' ? json.lepusCode.root : null;
  } catch {
    return null;
  }
}

function scaleBundleRecords(entry) {
  const records = [];
  for (const scale of STARTUP_SCALES) {
    for (const [harness, flavor] of [['web', 'web'], ['native', 'lynx']]) {
      const bundle = bundleFor(entry, { rows: scale, flavor });
      if (bundle == null) continue;
      const buf = fs.readFileSync(bundle.abs);
      const artifact = {
        path: `dist/${bundle.rel.split('\\').join('/')}`,
        sha256: sha256(buf),
        flavor,
        section: 'whole-artifact',
      };
      const base = {
        suite: 'bundle-scale',
        harness,
        environment: harness === 'web' ? 'lynx-for-web' : 'lynx-native-static-artifact',
        entry: entry.id,
        workload: 'startup-bundle',
        scale,
      };
      const emit = (metric, value, sourceArtifact = artifact) => {
        records.push({
          ...makeRecord({
            ...base,
            metric,
            boundary: BOUNDARIES.bundleScale,
            unit: 'bytes',
            value,
          }),
          artifact: sourceArtifact,
          rankingEligible: false,
          descriptiveEligible: true,
        });
      };
      emit('totalArtifactRaw', buf.length);
      emit('totalArtifactGzip', gz(buf));
      const mts = readableMtsSection(buf);
      if (mts != null) {
        const mtsBuf = Buffer.from(mts);
        const sectionArtifact = { ...artifact, section: 'lepusCode.root' };
        emit('mtsSectionRaw', mtsBuf.length, sectionArtifact);
        emit('mtsSectionGzip', gz(mtsBuf), sectionArtifact);
      }
    }
  }
  return records;
}

export function bundleRecords(entry) {
  const records = [];
  const base = { suite: 'bundle', entry: entry.id, workload: 'bundle', scale: 0 };
  const emit = (metric, value, detail = null) => {
    records.push(makeRecord({
      ...base,
      metric,
      boundary: BOUNDARIES.bundle,
      unit: 'bytes',
      value,
      detail,
    }));
  };

  const web = bundleFor(entry, { rows: 0, flavor: 'web' });
  if (web) {
    const buf = fs.readFileSync(web.abs);
    emit('bundleWebRaw', buf.length);
    emit('bundleWebGzip', gz(buf));
    try {
      const json = JSON.parse(buf.toString('utf-8'));
      const mts = json?.lepusCode?.root;
      const bts = json?.manifest?.['/app-service.js'];
      if (typeof mts === 'string') {
        emit('mtsSectionRaw', Buffer.byteLength(mts));
        emit('mtsSectionGzip', gz(Buffer.from(mts)));
      }
      if (typeof bts === 'string') {
        emit('btsSectionRaw', Buffer.byteLength(bts));
        emit('btsSectionGzip', gz(Buffer.from(bts)));
      }
    } catch {
      // binary bundle format — whole-bundle sizes only
    }
  }
  const lynx = bundleFor(entry, { rows: 0, flavor: 'lynx' });
  if (lynx) {
    const buf = fs.readFileSync(lynx.abs);
    emit('bundleLynxRaw', buf.length);
    emit('bundleLynxGzip', gz(buf));
  }
  return [...records, ...scaleBundleRecords(entry)];
}
