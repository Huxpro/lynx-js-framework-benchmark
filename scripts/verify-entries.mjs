// CI guard: every entry manifest is complete and every vendored bundle matches
// its recorded sha256 — a stale or hand-edited bundle cannot pass silently.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LIST_FIXTURE_PROTOCOL,
  LIST_WORKLOAD_CONTRACT,
} from '../packages/shared/src/list-workloads.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entriesDir = path.join(root, 'entries');

const REQUIRED = ['id', 'label', 'framework', 'frameworkVersion', 'config', 'tier', 'color', 'presentation', 'kind', 'provenance', 'bundles'];
const TIERS = new Set(['featured', 'lab', 'archive']);
const HARNESSES = new Set(['web', 'native']);
const NATIVE_DIAGNOSTIC_BUILD_PROTOCOL = 'octane-native-diagnostic-build-v1';
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const LIST_WORKLOAD_CONTRACT_SHA256 = sha256(JSON.stringify(LIST_WORKLOAD_CONTRACT));
const fileHashes = new Map();
const sha256File = (file) => {
  let digest = fileHashes.get(file);
  if (digest == null) {
    digest = sha256(fs.readFileSync(file));
    fileHashes.set(file, digest);
  }
  return digest;
};

let failures = 0;
const fail = (msg) => {
  console.error('  [FAIL]', msg);
  failures += 1;
};

function resolveEntryPath(dir, relative, label) {
  if (typeof relative !== 'string' || relative.length === 0) {
    fail(`${label} missing (${relative})`);
    return null;
  }
  const file = path.resolve(dir, relative);
  const withinEntry = path.relative(dir, file);
  if (withinEntry.startsWith('..') || path.isAbsolute(withinEntry)) {
    fail(`${label} must stay inside its entry (${relative})`);
    return null;
  }
  return file;
}

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
  if (manifest.tier === 'featured' && manifest.framework === 'octane') {
    if (manifest.provenance.patched !== false || manifest.provenance.patchFile != null) {
      fail(`${id}: featured Octane entries must use an unpatched source checkout`);
    }
    if (JSON.stringify(manifest.harnesses) !== JSON.stringify(['web'])) {
      fail(`${id}: featured Octane entries must be explicitly Web-only`);
    }
  }
  if (id === 'octane-hux') {
    if (manifest.label !== 'Octane (Hux)') fail(`${id}: public label must be Octane (Hux)`);
    if (manifest.tier !== 'featured') fail(`${id}: Hux new-lynx entry must be featured`);
    if (manifest.provenance.ref !== 'new-lynx') fail(`${id}: provenance.ref must be new-lynx`);
    if (
      manifest.provenance.buildEnv?.BENCH_CORE !== 'block'
      || manifest.provenance.buildEnv?.BENCH_BLOCK_MODE !== 'scoped'
      || !String(manifest.provenance.buildCommand).includes('BENCH_CORE=block')
    ) {
      fail(`${id}: Hux new-lynx entry must prove the scoped block-core build`);
    }
    if (manifest.webLab != null || manifest.nativeLab != null || manifest.ranking != null) {
      fail(`${id}: Hux new-lynx entry must not use Lab contracts`);
    }
    if (JSON.stringify(manifest.harnesses) !== JSON.stringify(['web'])) {
      fail(`${id}: Hux new-lynx entry must be explicitly Web-only`);
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
  if (id === 'octane-native-diagnostic') {
    if (manifest.tier !== 'lab') {
      fail(`${id}: must remain an unranked lab entry`);
    }
    if (JSON.stringify(manifest.harnesses) !== JSON.stringify(['native'])) {
      fail(`${id}: must remain explicitly Native-only`);
    }
    if (manifest.ranking != null || manifest.webLab != null || manifest.nativeLab != null) {
      fail(`${id}: must remain unranked and outside featured/Lab comparison contracts`);
    }
    if (JSON.stringify(manifest.tags) !== JSON.stringify(['diagnostic', 'capacity-probe'])) {
      fail(`${id}: must retain its diagnostic capacity-probe role`);
    }
    if (manifest.bundles?.lynx !== 'dist/table/main.lynx.bundle') {
      fail(`${id}: eager table Native bundle path must be dist/table/main.lynx.bundle`);
    }
    if (manifest.bundles?.web != null) {
      fail(`${id}: diagnostic entry must not declare a Web bundle`);
    }
    if (manifest.listFixture?.bundles?.native !== 'dist/list/main.lynx.bundle') {
      fail(`${id}: listFixture Native bundle path must be dist/list/main.lynx.bundle`);
    }
    if (manifest.listFixture?.bundles?.web != null) {
      fail(`${id}: diagnostic listFixture must not declare a Web bundle`);
    }
    if (!/^[0-9a-f]{40}$/.test(manifest.provenance?.commit ?? '')
      || manifest.provenance?.ref !== manifest.provenance?.commit) {
      fail(`${id}: provenance must name one immutable source revision`);
    }
    if (manifest.provenance?.patched !== false || manifest.provenance?.patchFile != null) {
      fail(`${id}: Native artifacts must come from a clean Octane checkout`);
    }
    const diagnosticChecks = manifest.provenance?.sha256 ?? {};
    const expectedKeys = ['list/main.lynx.bundle', 'table/main.lynx.bundle'];
    if (JSON.stringify(Object.keys(diagnosticChecks).sort()) !== JSON.stringify(expectedKeys)) {
      fail(`${id}: provenance must checksum exactly the table and list Native bundles`);
    }
    if (manifest.listFixture?.sha256?.native !== diagnosticChecks['list/main.lynx.bundle']) {
      fail(`${id}: listFixture Native checksum must match vendored provenance`);
    }
    const receipt = manifest.provenance?.buildReceipt;
    if (receipt == null) {
      fail(`${id}: versioned Native build receipt is missing`);
    } else {
      const { sha256: receiptSha256, ...receiptPayload } = receipt;
      if (
        receipt.protocol !== NATIVE_DIAGNOSTIC_BUILD_PROTOCOL
        || receiptSha256
          !== sha256(JSON.stringify(receiptPayload))
      ) {
        fail(`${id}: Native build receipt protocol or checksum is invalid`);
      }
      if (receipt.sourceCommit !== manifest.provenance?.commit) {
        fail(`${id}: Native build receipt source revision does not match provenance`);
      }
      const expectedArtifacts = {
        table: {
          path: 'benchmarks/lynx-table/app/dist/main.lynx.bundle',
          sha256: diagnosticChecks['table/main.lynx.bundle'],
        },
        list: {
          path: 'benchmarks/lynx-list/app/dist/main.lynx.bundle',
          sha256: diagnosticChecks['list/main.lynx.bundle'],
        },
      };
      if (JSON.stringify(receipt.artifacts) !== JSON.stringify(expectedArtifacts)) {
        fail(`${id}: Native build receipt artifacts do not match vendored bundles`);
      }
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
    if (!/^[0-9a-f]{64}$/.test(expected)) {
      fail(`${id}: invalid sha256 for dist/${rel}`);
      continue;
    }
    const file = resolveEntryPath(path.join(dir, 'dist'), rel, `${id}: checksum path`);
    if (file == null) continue;
    if (!fs.existsSync(file)) {
      fail(`${id}: checksummed bundle missing: dist/${rel}`);
      continue;
    }
    const actual = sha256File(file);
    if (actual !== expected) fail(`${id}: sha256 mismatch for dist/${rel}`);
  }
  for (const harness of manifest.harnesses ?? ['web', 'native']) {
    const key = harness === 'native' ? 'lynx' : 'web';
    const relative = manifest.bundles?.[key];
    const bundle = resolveEntryPath(dir, relative, `${id}: bundles.${key}`);
    if (bundle == null) continue;
    if (!fs.existsSync(bundle)) fail(`${id}: bundles.${key} missing (${relative})`);
  }
  if (manifest.listFixture != null) {
    if (manifest.listFixture.protocol !== LIST_FIXTURE_PROTOCOL) {
      fail(`${id}: listFixture protocol must be ${LIST_FIXTURE_PROTOCOL}`);
    }
    if (manifest.listFixture.contractSha256 !== LIST_WORKLOAD_CONTRACT_SHA256) {
      fail(`${id}: listFixture contractSha256 does not match the current list workload`);
    }
    for (const harness of ['web', 'native']) {
      const relative = manifest.listFixture.bundles?.[harness];
      if (relative == null) continue;
      const bundle = resolveEntryPath(
        dir,
        relative,
        `${id}: listFixture ${harness} bundle path`,
      );
      if (bundle == null) continue;
      if (!fs.existsSync(bundle)) {
        fail(`${id}: listFixture ${harness} bundle missing (${relative})`);
        continue;
      }
      const expected = manifest.listFixture.sha256?.[harness];
      if (!/^[0-9a-f]{64}$/.test(expected ?? '')) {
        fail(`${id}: listFixture ${harness} checksum missing or invalid`);
        continue;
      }
      const actual = sha256File(bundle);
      if (actual !== expected) fail(`${id}: sha256 mismatch for listFixture ${harness} bundle`);
    }
  }
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log(`\nall ${ids.length} entries verified`);
