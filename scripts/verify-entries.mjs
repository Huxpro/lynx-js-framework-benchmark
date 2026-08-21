// CI guard: every entry manifest is complete and every vendored bundle matches
// its recorded sha256 — a stale or hand-edited bundle cannot pass silently.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entriesDir = path.join(root, 'entries');

const REQUIRED = ['id', 'label', 'framework', 'frameworkVersion', 'config', 'tier', 'color', 'presentation', 'kind', 'provenance', 'bundles'];
const TIERS = new Set(['featured', 'lab']);
const NATIVE_LAB_CONTRACT = 'native-lab-entry-v1';
const WEB_LAB_CONTRACT = 'web-lab-entry-v1';
const AUTOROWS = [0, 1000, 10000, 30000];

let failures = 0;
const fail = (msg) => {
  console.error('  [FAIL]', msg);
  failures += 1;
};

const ids = fs.readdirSync(entriesDir).filter((d) =>
  fs.existsSync(path.join(entriesDir, d, 'entry.json')));
if (ids.length === 0) fail('no entries found');

for (const id of ids) {
  const dir = path.join(entriesDir, id);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'entry.json'), 'utf-8'));
  console.log(`[verify] ${id}`);
  for (const key of REQUIRED) {
    if (manifest[key] == null) fail(`${id}: missing manifest field "${key}"`);
  }
  if (manifest.id !== id) fail(`${id}: manifest id mismatch (${manifest.id})`);
  if (!TIERS.has(manifest.tier)) fail(`${id}: invalid tier "${manifest.tier}"`);
  if (!/^#[\da-f]{6}$/i.test(manifest.color ?? '')) fail(`${id}: invalid color "${manifest.color}"`);
  if (!Number.isFinite(manifest.presentation?.order)) fail(`${id}: invalid presentation.order`);
  for (const key of ['colorLight', 'colorDark']) {
    if (!/^#[\da-f]{6}$/i.test(manifest.presentation?.[key] ?? '')) {
      fail(`${id}: invalid presentation.${key} "${manifest.presentation?.[key]}"`);
    }
  }
  if (!manifest.provenance?.commit) fail(`${id}: provenance.commit missing`);
  if (manifest.ranking != null) {
    if (manifest.tier !== 'lab') fail(`${id}: ranking is only valid for tier=lab`);
    if (manifest.ranking.enabled !== true) fail(`${id}: ranking.enabled must be true`);
    if (manifest.webLab?.enabled !== true || manifest.nativeLab?.enabled !== true) {
      fail(`${id}: ranked Lab entries require complete Web and Native Lab contracts`);
    }
  }
  if (manifest.nativeLab != null) {
    if (manifest.tier !== 'lab') fail(`${id}: nativeLab is only valid for tier=lab`);
    if (manifest.nativeLab.enabled !== true) fail(`${id}: nativeLab.enabled must be true`);
    if (manifest.nativeLab.contract !== NATIVE_LAB_CONTRACT) {
      fail(`${id}: nativeLab.contract must be ${NATIVE_LAB_CONTRACT}`);
    }
    for (const rows of AUTOROWS) {
      for (const flavor of ['web', 'lynx']) {
        const rel = `rows-${rows}/main.${flavor}.bundle`;
        if (!manifest.provenance?.sha256?.[rel]) fail(`${id}: nativeLab checksum missing ${rel}`);
      }
    }
  }
  if (manifest.webLab != null) {
    if (manifest.tier !== 'lab') fail(`${id}: webLab is only valid for tier=lab`);
    if (manifest.webLab.enabled !== true) fail(`${id}: webLab.enabled must be true`);
    if (manifest.webLab.contract !== WEB_LAB_CONTRACT) {
      fail(`${id}: webLab.contract must be ${WEB_LAB_CONTRACT}`);
    }
  }
  if (manifest.provenance?.patched && manifest.provenance?.patchFile) {
    if (!fs.existsSync(path.join(root, manifest.provenance.patchFile))) {
      fail(`${id}: provenance.patchFile ${manifest.provenance.patchFile} does not exist`);
    }
  }
  const checks = manifest.provenance?.sha256 ?? {};
  if (Object.keys(checks).length === 0) fail(`${id}: no sha256 checksums`);
  for (const [rel, expected] of Object.entries(checks)) {
    const file = path.join(dir, 'dist', rel);
    if (!fs.existsSync(file)) {
      fail(`${id}: checksummed bundle missing: dist/${rel}`);
      continue;
    }
    const actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    if (actual !== expected) fail(`${id}: sha256 mismatch for dist/${rel}`);
  }
  const web = path.join(dir, manifest.bundles?.web ?? '');
  if (!fs.existsSync(web)) fail(`${id}: bundles.web missing (${manifest.bundles?.web})`);
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log(`\nall ${ids.length} entries verified`);
