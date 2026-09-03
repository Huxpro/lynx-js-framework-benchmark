// CI guard: every entry manifest is complete and every vendored bundle matches
// its recorded sha256 — a stale or hand-edited bundle cannot pass silently.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entriesDir = path.join(root, 'entries');

const REQUIRED = ['id', 'label', 'framework', 'frameworkVersion', 'config', 'tier', 'color', 'presentation', 'kind', 'provenance', 'bundles'];
const TIERS = new Set(['featured', 'lab', 'archive']);
const HARNESSES = new Set(['web', 'native']);

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
  if (manifest.harnesses != null && (
    !Array.isArray(manifest.harnesses)
    || manifest.harnesses.length === 0
    || new Set(manifest.harnesses).size !== manifest.harnesses.length
    || manifest.harnesses.some((harness) => !HARNESSES.has(harness))
  )) fail(`${id}: invalid harnesses ${JSON.stringify(manifest.harnesses)}`);
  if (!/^#[\da-f]{6}$/i.test(manifest.color ?? '')) fail(`${id}: invalid color "${manifest.color}"`);
  if (!Number.isFinite(manifest.presentation?.order)) fail(`${id}: invalid presentation.order`);
  for (const key of ['colorLight', 'colorDark']) {
    if (!/^#[\da-f]{6}$/i.test(manifest.presentation?.[key] ?? '')) {
      fail(`${id}: invalid presentation.${key} "${manifest.presentation?.[key]}"`);
    }
  }
  if (!manifest.provenance?.commit) fail(`${id}: provenance.commit missing`);
  if (manifest.tier === 'featured' && manifest.framework === 'octane' && id !== 'octane-hux') {
    if (manifest.provenance.patched !== false || manifest.provenance.patchFile != null) {
      fail(`${id}: featured Octane entries must use an unpatched source checkout`);
    }
    if (JSON.stringify(manifest.harnesses) !== JSON.stringify(['web'])) {
      fail(`${id}: featured Octane entries must be explicitly Web-only`);
    }
  }
  if (id === 'octane-hux') {
    if (manifest.label !== 'Octane (Hux)') fail(`${id}: public label must be Octane (Hux)`);
    if (manifest.tier !== 'featured') fail(`${id}: Hux composite entry must be featured`);
    if (manifest.provenance.ref !== 'composite:pull/269/head+pull/272/head') {
      fail(`${id}: provenance.ref must identify the #269 + #272 composite`);
    }
    const expectedInputs = {
      'pull/269/head': 'b166e43f9a59864c1c887f24e8448d6014542631',
      'pull/272/head': '66ff34a3f50d6b53fdb7b55e594c4fa11e4bfe6f',
    };
    if (JSON.stringify(manifest.provenance.inputCommits) !== JSON.stringify(expectedInputs)) {
      fail(`${id}: provenance.inputCommits must pin PR #269 and PR #272 heads`);
    }
    if (manifest.provenance.patched !== true
      || manifest.provenance.patchFile !== 'entries/_patches/octane-hux-native-bench.patch') {
      fail(`${id}: Hux Native instrumentation patch provenance is missing`);
    }
    if (manifest.provenance.buildEnv?.BENCH_CORE !== 'universal'
      || manifest.provenance.buildEnv?.WEB_SOURCE !== 'clean-composite'
      || manifest.provenance.buildEnv?.NATIVE_SOURCE !== 'reviewed-instrumentation-patch'
      || manifest.provenance.buildEnv?.NATIVE_TABLE_PROTOCOL !== 'lynx-native-bench-v2'
      || manifest.provenance.buildEnv?.NATIVE_STARTUP_PROTOCOL !== 'lynx-native-startup-v1') {
      fail(`${id}: Hux composite build environment does not pin the Native producer contracts`);
    }
    if (manifest.webLab != null || manifest.nativeLab != null || manifest.ranking != null) {
      fail(`${id}: Hux new-lynx entry must not use Lab contracts`);
    }
    if (JSON.stringify(manifest.harnesses) !== JSON.stringify(['web', 'native'])) {
      fail(`${id}: Hux composite entry must explicitly support Web and Native`);
    }
  }
  if (id === 'octane-hux1' || id === 'octane-hux2') {
    if (manifest.tier !== 'archive' || manifest.supersededBy !== 'octane-hux') {
      fail(`${id}: historical Hux attempt must be archive evidence superseded by octane-hux`);
    }
  }
  if (id === 'octane-pr-791') {
    if (manifest.tier !== 'archive') fail(`${id}: merged PR #791 entry must be archive evidence`);
    if (manifest.supersededBy !== 'octane') fail(`${id}: merged PR #791 must be superseded by octane`);
    if (manifest.provenance.ref !== 'pull/791/head') fail(`${id}: provenance.ref must be pull/791/head`);
    if (manifest.provenance.mergedInto !== '939c64dc9d9f0fd5c5fe50255fe75ce592d0b31a') {
      fail(`${id}: provenance.mergedInto must identify PR #791's upstream merge commit`);
    }
    if (manifest.provenance.patched !== false || manifest.provenance.patchFile != null) {
      fail(`${id}: archived PR #791 evidence must use a clean source checkout`);
    }
    if (JSON.stringify(manifest.harnesses) !== JSON.stringify(['web'])) {
      fail(`${id}: PR #791 entry must be explicitly Web-only`);
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
