import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import {
  assertContainedPath,
  assertDirectory,
  assertLabEntryId,
  assertRegularFile,
} from './path-safety.mjs';
import {
  expectedVueArtifactMarker,
  VUE_ARTIFACT_BUNDLES,
  verifyVueArtifactAssertions,
  vueArtifactAssertionsBytes,
  vueVaporBuildCell,
  vueVaporArtifactExpectation,
} from './vue-artifact-assertions.mjs';
import {
  verifyVueFeaturedBuildMetadata,
  vueFeaturedBuildMetadataBytes,
} from './vue-build-tools.mjs';

const EMPTY_SHA256 = crypto.createHash('sha256').update('').digest('hex');
const ALLOWED_ROWS = new Set([0, 1000, 10000, 30000]);
const VARIANTS = new Set(['vapor', 'ifr']);

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const stableJson = (value) => JSON.stringify(value);

function git(checkout, args, options = {}) {
  return execFileSync('git', args, {
    cwd: checkout,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  }).trim();
}

function tryGit(checkout, args) {
  try {
    return git(checkout, args);
  } catch {
    return null;
  }
}

function untrackedPatch(checkout, relativePath) {
  const result = spawnSync(
    'git',
    ['diff', '--binary', '--no-index', '--', '/dev/null', relativePath],
    { cwd: checkout, maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(
      `cannot capture untracked source file ${relativePath}: ${result.stderr?.toString() ?? ''}`,
    );
  }
  return result.stdout;
}

export function captureGitState(checkout) {
  const root = path.resolve(checkout);
  if (!fs.existsSync(path.join(root, '.git'))) {
    try {
      git(root, ['rev-parse', '--git-dir']);
    } catch {
      throw new Error(`source checkout is not a git worktree: ${root}`);
    }
  }
  const status = git(root, ['status', '--porcelain=v1', '--untracked-files=all']);
  const trackedPatch = execFileSync(
    'git',
    ['diff', '--binary', 'HEAD', '--', '.'],
    { cwd: root, maxBuffer: 64 * 1024 * 1024 },
  );
  const untracked = execFileSync(
    'git',
    ['ls-files', '--others', '--exclude-standard', '-z'],
    { cwd: root, maxBuffer: 64 * 1024 * 1024 },
  ).toString().split('\0').filter(Boolean).sort();
  const patch = Buffer.concat([
    trackedPatch,
    ...untracked.map((file) => untrackedPatch(root, file)),
  ]);
  const branch = tryGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return {
    checkout: fs.realpathSync(root),
    remote: tryGit(root, ['config', '--get', 'remote.origin.url']),
    ref: branch ?? 'HEAD',
    head: git(root, ['rev-parse', 'HEAD']),
    dirty: status.length > 0,
    status: status ? status.split('\n') : [],
    patch,
    patchSha256: sha256(patch),
  };
}

function readArtifact(entryDir, relativePath, label) {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new Error(`invalid ${label} path: ${relativePath}`);
  }
  const resolved = path.resolve(entryDir, relativePath);
  assertContainedPath(entryDir, resolved, { label });
  assertRegularFile(resolved, label);
  return resolved;
}

function expectEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

function verifyPatch(entryDir, patch, label) {
  if (patch?.path == null) {
    expectEqual(patch?.bytes, 0, `empty ${label} bytes`);
    expectEqual(patch?.sha256, EMPTY_SHA256, `empty ${label} sha256`);
    return;
  }
  const patchBytes = fs.readFileSync(readArtifact(entryDir, patch.path, label));
  expectEqual(patchBytes.length, patch.bytes, `${label} bytes`);
  expectEqual(sha256(patchBytes), patch.sha256, `${label} sha256`);
}

function validateRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0
    || rows.some((row) => !Number.isInteger(row) || !ALLOWED_ROWS.has(row))
    || new Set(rows).size !== rows.length) {
    throw new Error('receipt rows must be a unique non-empty subset of 0,1000,10000,30000');
  }
}

export function labArtifactFingerprint({
  receiptSha256,
  sourcePatchSha256,
  benchmarkPatchSha256,
  bundleSha256,
}) {
  return sha256(Buffer.from(stableJson({
    receiptSha256,
    sourcePatchSha256,
    benchmarkPatchSha256,
    bundleSha256: Object.fromEntries(
      Object.entries(bundleSha256).sort(([left], [right]) => left.localeCompare(right)),
    ),
  })));
}

export function verifyVueVaporLabEntry(entryDir) {
  const resolved = path.resolve(entryDir);
  assertDirectory(resolved, 'lab entry directory');
  const manifestPath = readArtifact(resolved, 'entry.json', 'entry manifest');
  const receiptPath = readArtifact(resolved, 'receipt.json', 'receipt');
  const hashesPath = readArtifact(resolved, 'artifact-hashes.json', 'artifact hashes');
  const manifestBytes = fs.readFileSync(manifestPath);
  const receiptBytes = fs.readFileSync(receiptPath);
  const manifest = JSON.parse(manifestBytes);
  const receipt = JSON.parse(receiptBytes);
  const artifactHashes = JSON.parse(fs.readFileSync(hashesPath, 'utf8'));

  assertLabEntryId(manifest.id, 'manifest id');
  expectEqual(manifest.id, path.basename(resolved), 'manifest id');
  expectEqual(manifest.tier, 'lab', 'manifest tier');
  expectEqual(receipt.entryId, manifest.id, 'receipt entry id');
  expectEqual(receipt.kind, 'vue-vapor-ab-lab-receipt', 'receipt kind');
  if (receipt.schemaVersion !== 3) {
    throw new Error(
      `receipt schema ${receipt.schemaVersion ?? 'missing'} is not supported; `
      + 'remove and rebuild this legacy .tmp lab entry',
    );
  }
  if (!VARIANTS.has(receipt.variant)) throw new Error(`invalid receipt variant: ${receipt.variant}`);
  const expectedConfig = `vapor mode, IFR ${receipt.variant === 'ifr' ? 'on' : 'off'};`;
  if (typeof manifest.config !== 'string' || !manifest.config.startsWith(expectedConfig)) {
    throw new Error(`manifest config does not match receipt variant ${receipt.variant}`);
  }
  validateRows(receipt.rows);
  expectEqual(
    stableJson(receipt.build?.cells),
    stableJson(receipt.rows.map((row) => vueVaporBuildCell(receipt.variant, row))),
    'receipt build cells',
  );
  expectEqual(receipt.build?.metadata?.path, 'build-metadata.json', 'build metadata path');
  const buildMetadataBytes = fs.readFileSync(
    readArtifact(resolved, receipt.build.metadata.path, 'build metadata'),
  );
  expectEqual(
    buildMetadataBytes.length,
    receipt.build.metadata.bytes,
    'build metadata bytes',
  );
  expectEqual(
    sha256(buildMetadataBytes),
    receipt.build.metadata.sha256,
    'build metadata sha256',
  );
  const buildMetadata = JSON.parse(buildMetadataBytes);
  expectEqual(
    Buffer.compare(buildMetadataBytes, vueFeaturedBuildMetadataBytes(buildMetadata)),
    0,
    'build metadata canonical bytes',
  );
  verifyVueFeaturedBuildMetadata(buildMetadata, receipt.build.cells, resolved);
  expectEqual(
    stableJson(receipt.build.tools),
    stableJson(buildMetadata.cells),
    'receipt build tools',
  );

  const receiptSha256 = sha256(receiptBytes);
  expectEqual(artifactHashes['entry.json'], sha256(manifestBytes), 'entry.json sha256');
  expectEqual(artifactHashes['receipt.json'], receiptSha256, 'receipt.json sha256');
  expectEqual(manifest.provenance?.receipt, 'receipt.json', 'manifest receipt path');
  expectEqual(manifest.provenance?.receiptSha256, receiptSha256, 'manifest receipt sha256');
  expectEqual(manifest.provenance?.commit, receipt.source?.head, 'source commit');
  expectEqual(
    manifest.provenance?.benchmarkCommit,
    receipt.benchmark?.head,
    'benchmark commit',
  );
  expectEqual(
    manifest.provenance?.patchSha256,
    receipt.source?.patch?.sha256,
    'source patch sha256',
  );
  expectEqual(
    manifest.provenance?.benchmarkPatchSha256,
    receipt.benchmark?.patch?.sha256,
    'benchmark patch sha256',
  );
  expectEqual(
    stableJson(manifest.provenance?.toolchain),
    stableJson(receipt.toolchain),
    'toolchain',
  );
  expectEqual(manifest.provenance?.patched, receipt.source?.dirty, 'source dirty state');
  expectEqual(
    manifest.provenance?.patchFile,
    receipt.source?.patch?.path,
    'source patch path',
  );

  verifyPatch(resolved, receipt.source?.patch, 'source patch');
  verifyPatch(resolved, receipt.benchmark?.patch, 'benchmark patch');

  const expectedBundleKeys = receipt.rows.flatMap((row) => [
    `rows-${row}/main.web.bundle`,
    `rows-${row}/main.lynx.bundle`,
  ]);
  const bundleEntries = Object.entries(receipt.bundles ?? {});
  expectEqual(
    stableJson(bundleEntries.map(([relative]) => relative).sort()),
    stableJson([...expectedBundleKeys].sort()),
    'receipt bundle set',
  );
  const bundleSha256 = {};
  for (const [relative, metadata] of bundleEntries) {
    const expectedPath = `dist/${relative}`;
    expectEqual(metadata.path, expectedPath, `${relative} receipt path`);
    const bytes = fs.readFileSync(readArtifact(resolved, metadata.path, `${relative} bundle`));
    expectEqual(bytes.length, metadata.rawBytes, `${relative} raw bytes`);
    expectEqual(
      zlib.gzipSync(bytes, { level: 9 }).length,
      metadata.gzipBytes,
      `${relative} gzip bytes`,
    );
    expectEqual(sha256(bytes), metadata.sha256, `${relative} sha256`);
    expectEqual(
      manifest.provenance?.sha256?.[relative],
      metadata.sha256,
      `${relative} manifest sha256`,
    );
    bundleSha256[relative] = metadata.sha256;
  }
  expectEqual(
    stableJson(Object.keys(manifest.provenance?.sha256 ?? {}).sort()),
    stableJson([...expectedBundleKeys].sort()),
    'manifest bundle set',
  );

  const expectedAssertionKeys = receipt.rows.map(
    (row) => `rows-${row}/artifact-assertions.json`,
  );
  const assertionEntries = Object.entries(receipt.artifactAssertions ?? {});
  expectEqual(
    stableJson(assertionEntries.map(([relative]) => relative).sort()),
    stableJson([...expectedAssertionKeys].sort()),
    'receipt artifact assertion set',
  );
  for (const [relative, metadata] of assertionEntries) {
    const row = Number(relative.slice('rows-'.length, relative.indexOf('/')));
    const expectedPath = `dist/${relative}`;
    expectEqual(metadata.path, expectedPath, `${relative} receipt path`);
    const assertionBytes = fs.readFileSync(
      readArtifact(resolved, metadata.path, `${relative} artifact assertions`),
    );
    expectEqual(assertionBytes.length, metadata.bytes, `${relative} bytes`);
    expectEqual(sha256(assertionBytes), metadata.sha256, `${relative} sha256`);
    const assertions = JSON.parse(assertionBytes);
    expectEqual(
      Buffer.compare(assertionBytes, vueArtifactAssertionsBytes(assertions)),
      0,
      `${relative} canonical bytes`,
    );
    expectEqual(
      stableJson(assertions),
      stableJson(metadata.assertions),
      `${relative} receipt assertions`,
    );
    verifyVueArtifactAssertions(
      assertions,
      vueVaporArtifactExpectation(receipt.variant, row),
      Object.fromEntries(VUE_ARTIFACT_BUNDLES.map((name) => [
        name,
        readArtifact(
          resolved,
          `dist/rows-${row}/${name}`,
          `rows-${row}/${name} bundle`,
        ),
      ])),
    );
  }

  const firstRow = receipt.rows[0];
  for (const flavor of ['web', 'lynx']) {
    const expected = `dist/rows-${firstRow}/main.${flavor}.bundle`;
    expectEqual(manifest.bundles?.[flavor], expected, `manifest ${flavor} bundle`);
    const receiptKey = expected.slice('dist/'.length);
    if (!Object.hasOwn(receipt.bundles, receiptKey)) {
      throw new Error(`manifest ${flavor} bundle is not in receipt.bundles`);
    }
  }

  const cohort = {
    receiptSha256,
    sourcePatchSha256: receipt.source.patch.sha256,
    benchmarkHead: receipt.benchmark.head,
    benchmarkPatchSha256: receipt.benchmark.patch.sha256,
    bundleSha256,
  };
  const fingerprint = labArtifactFingerprint(cohort);
  return {
    entryId: manifest.id,
    sourceHead: receipt.source.head,
    receiptSha256,
    bundleCount: bundleEntries.length,
    fingerprint,
    cohort,
    manifest,
    receipt,
  };
}

export function assertVueVaporLabSelectedRows(
  entries,
  verifiedEntries,
  suites,
  scales,
  flavor = 'web',
  startupScales = scales,
) {
  const selectedRows = new Set([
    ...(suites.includes('table') ? [0] : []),
    ...(suites.includes('startup') ? startupScales : []),
  ]);
  for (const entry of entries) {
    const pinned = verifiedEntries.get(entry.id);
    if (!pinned) throw new Error(`unverified lab entry: ${entry.id}`);
    const verified = verifyPinnedVueVaporLabEntry(entry.dir, pinned.fingerprint);
    for (const row of selectedRows) {
      if (!verified.receipt.rows.includes(row)) {
        throw new Error(`${entry.id}: selected row ${row} is not receipted`);
      }
      const cell = verified.receipt.build.cells.find((candidate) => candidate.rows === row);
      if (stableJson(cell) !== stableJson(vueVaporBuildCell(verified.receipt.variant, row))) {
        throw new Error(`${entry.id}: selected row ${row} producer cell is not receipted`);
      }
      const assertion = verified.receipt.artifactAssertions?.[
        `rows-${row}/artifact-assertions.json`
      ]?.assertions;
      const expected = vueVaporArtifactExpectation(verified.receipt.variant, row);
      if (stableJson(assertion?.assertions) !== stableJson(expected)
        || assertion?.marker !== expectedVueArtifactMarker(expected)
        || assertion?.bundles?.[`main.${flavor}.bundle`]?.prefixCount !== 1
        || assertion?.bundles?.[`main.${flavor}.bundle`]?.bannerCount !== 1) {
        throw new Error(`${entry.id}: selected row ${row} artifact assertion does not match`);
      }
    }
  }
}

export function verifyPinnedVueVaporLabEntry(entryDir, expectedFingerprint) {
  const verified = verifyVueVaporLabEntry(entryDir);
  if (verified.fingerprint !== expectedFingerprint) {
    throw new Error(
      `${verified.entryId} changed after it was pinned; refusing to record mixed artifacts`,
    );
  }
  return verified;
}

export function verifyVueVaporLabBenchmarkState(
  benchmarkRoot,
  verifiedEntries,
  pinnedState = null,
) {
  const state = captureGitState(benchmarkRoot);
  if (pinnedState
    && (state.head !== pinnedState.head || state.patchSha256 !== pinnedState.patchSha256)) {
    throw new Error(
      'benchmark worktree changed while the measurement was running; refusing to write a run',
    );
  }
  for (const entry of verifiedEntries) {
    const expected = entry.receipt.benchmark;
    if (state.head !== expected.head || state.patchSha256 !== expected.patch.sha256) {
      throw new Error(
        `${entry.entryId} was built with a different benchmark worktree; rebuild the lab entry`,
      );
    }
  }
  return state;
}

export function verifyVueVaporLabRoot(labRoot) {
  const entriesDir = path.join(path.resolve(labRoot), 'entries');
  assertDirectory(entriesDir, 'lab entries directory');
  const entries = fs.readdirSync(entriesDir).sort().filter((entry) => {
    if (!fs.existsSync(path.join(entriesDir, entry, 'entry.json'))) return false;
    assertLabEntryId(entry, 'lab entry directory name');
    return true;
  });
  if (entries.length === 0) throw new Error(`no lab entries at ${entriesDir}`);
  return entries.map((entry) => verifyVueVaporLabEntry(path.join(entriesDir, entry)));
}
