// Static bundle metrics per entry: raw/gzip sizes for both flavors, and the
// MTS/BTS section split for JSON-format web bundles (lepusCode.root is the
// main-thread program, manifest['/app-service.js'] the background program).
// Binary-format bundles (e.g. ReactLynx templates) report whole-bundle only.
import fs from 'node:fs';
import zlib from 'node:zlib';

import { makeRecord, BOUNDARIES } from '@lynx-bench/shared/schema';

import { bundleFor } from './entries.mjs';

const gz = (buf) => zlib.gzipSync(buf, { level: 9 }).length;

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
  return records;
}
