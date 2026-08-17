#!/usr/bin/env node
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import {
  assertContainedPath,
  assertDirectory,
  assertLabEntryId,
  assertRegularFile,
} from '../../packages/runner/src/path-safety.mjs';
import { captureGitState } from '../../packages/runner/src/lab-artifacts.mjs';
import {
  verifyVueArtifactAssertions,
  vueArtifactAssertionsBytes,
  vueVaporBuildCell,
  vueVaporArtifactExpectation,
} from '../../packages/runner/src/vue-artifact-assertions.mjs';
import {
  verifyVueFeaturedBuildMetadata,
  vueBuildToolEvidencePaths,
  vueFeaturedBuildMetadataBytes,
} from '../../packages/runner/src/vue-build-tools.mjs';
import { parseVueFeaturedRows } from '../vue-featured-plan.mjs';

export { captureGitState };

const benchmarkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FORMAL_IDS = new Set(['vue-vapor', 'vue-vapor-ifr']);
const SOURCE_OUTPUTS = [
  'packages/vue-lynx/internal/dist',
  'packages/vue-lynx/internal/tsconfig.build.tsbuildinfo',
  'packages/vue-lynx/runtime/dist',
  'packages/vue-lynx/runtime/.rslib',
  'packages/vue-lynx/runtime/tsconfig.build.tsbuildinfo',
  'packages/vue-lynx/main-thread/dist',
  'packages/vue-lynx/main-thread/.rslib',
  'packages/vue-lynx/main-thread/tsconfig.build.tsbuildinfo',
  'packages/vue-lynx/plugin/dist',
  'packages/vue-lynx/plugin/.rslib',
  'packages/vue-lynx/plugin/tsconfig.build.tsbuildinfo',
  'packages/benchmark/apps/ui-vapor/dist',
  'packages/benchmark/apps/ui-vapor/dist-ifr',
  'packages/benchmark/apps/ui-vapor/node_modules/.cache',
];

const sha256Buffer = (value) =>
  crypto.createHash('sha256').update(value).digest('hex');

export function parseRows(value) {
  return parseVueFeaturedRows(value);
}

export function resolveEntryId({ variant, id = null, suffix = null }) {
  if (variant !== 'vapor' && variant !== 'ifr') {
    throw new Error('variant must be vapor or ifr');
  }
  if (Boolean(id) === Boolean(suffix)) {
    throw new Error('pass exactly one of --id or --suffix');
  }
  const base = variant === 'ifr' ? 'vue-vapor-ifr' : 'vue-vapor';
  const resolved = id ?? `${base}-${suffix}`;
  assertLabEntryId(resolved, 'lab entry id');
  if (FORMAL_IDS.has(resolved)) {
    throw new Error(`refusing to overwrite formal entry id: ${resolved}`);
  }
  return resolved;
}

function readVueVersion(sourceCheckout) {
  const rootPackage = JSON.parse(fs.readFileSync(path.join(sourceCheckout, 'package.json'), 'utf8'));
  const vueLynxPackage = JSON.parse(
    fs.readFileSync(path.join(sourceCheckout, 'packages/vue-lynx/package.json'), 'utf8'),
  );
  const vue = rootPackage.pnpm?.overrides?.vue ?? 'unknown';
  return `vue ${vue} vapor / vue-lynx ${vueLynxPackage.version}`;
}

function pnpmInvocation(executable) {
  if (executable) {
    const resolved = path.resolve(executable);
    assertRegularFile(resolved, 'pnpm executable override');
    return resolved.endsWith('.cjs') || resolved.endsWith('.js')
      ? { command: process.execPath, args: [resolved], path: resolved }
      : { command: resolved, args: [], path: resolved };
  }
  return { command: 'corepack', args: ['pnpm'], path: 'corepack pnpm' };
}

function declaredPnpmVersion(root) {
  const packageManager = JSON.parse(
    fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
  ).packageManager;
  const match = /^pnpm@(.+)$/.exec(packageManager ?? '');
  if (!match) throw new Error(`packageManager must declare pnpm@<version>: ${packageManager}`);
  return { packageManager, version: match[1] };
}

function actualToolchain(root, executable = process.env.VUE_VAPOR_PNPM ?? null) {
  const invocation = pnpmInvocation(executable);
  let version;
  try {
    version = execFileSync(
      invocation.command,
      [...invocation.args, '--version'],
      { cwd: root, encoding: 'utf8' },
    ).trim();
  } catch (error) {
    throw new Error(
      `pnpm is unavailable via ${invocation.path}; pass --pnpm or VUE_VAPOR_PNPM`,
      { cause: error },
    );
  }
  const declared = declaredPnpmVersion(root);
  if (version !== declared.version) {
    throw new Error(
      `pnpm version mismatch: declared ${declared.version}, actual ${version} via ${invocation.path}`,
    );
  }
  return {
    node: process.version,
    pnpm: version,
    pnpmCommand: [invocation.command, ...invocation.args],
    pnpmPath: invocation.path,
    declaredPnpm: declared.packageManager,
  };
}

function defaultRunBuild({
  root,
  sourceCheckout,
  variant,
  rows,
  buildOut,
}) {
  const args = [
    path.join(root, 'scripts/build-vue-featured.mjs'),
    sourceCheckout,
    '--lab',
    '--variant',
    variant,
    '--rows',
    rows.join(','),
    '--out',
    buildOut,
  ];
  execFileSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  return [process.execPath, ...args];
}

function bundleMetadata(file, relativePath) {
  const bytes = fs.readFileSync(file);
  return {
    path: relativePath,
    sha256: sha256Buffer(bytes),
    rawBytes: bytes.length,
    gzipBytes: zlib.gzipSync(bytes, { level: 9 }).length,
  };
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function writeAtomic(file, bytes) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, bytes);
  fs.renameSync(temporary, file);
}

function sourceLockPath(sourceCheckout) {
  return execFileSync(
    'git',
    ['rev-parse', '--path-format=absolute', '--git-path', 'vue-vapor-build.lock'],
    { cwd: sourceCheckout, encoding: 'utf8' },
  ).trim();
}

function acquireLocks(paths) {
  const acquired = [];
  try {
    for (const lock of [...new Set(paths)].sort()) {
      fs.mkdirSync(path.dirname(lock), { recursive: true });
      try {
        fs.mkdirSync(lock);
      } catch (error) {
        if (error?.code === 'EEXIST') {
          throw new Error(`build lock is already held: ${lock}`);
        }
        throw error;
      }
      fs.writeFileSync(
        path.join(lock, 'owner.json'),
        jsonBytes({ pid: process.pid, startedAt: new Date().toISOString() }),
      );
      acquired.push(lock);
    }
    return () => {
      for (const lock of acquired.reverse()) {
        fs.rmSync(lock, { recursive: true, force: true });
      }
    };
  } catch (error) {
    for (const lock of acquired.reverse()) {
      fs.rmSync(lock, { recursive: true, force: true });
    }
    throw error;
  }
}

function snapshotSourceOutputs(sourceCheckout, snapshotRoot) {
  const present = [];
  for (const relative of SOURCE_OUTPUTS) {
    const source = path.join(sourceCheckout, relative);
    if (!fs.existsSync(source)) continue;
    const target = path.join(snapshotRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
    });
    present.push(relative);
  }
  return present;
}

function restoreSourceOutputs(sourceCheckout, snapshotRoot, present) {
  for (const relative of SOURCE_OUTPUTS) {
    fs.rmSync(path.join(sourceCheckout, relative), { recursive: true, force: true });
  }
  for (const relative of present) {
    const source = path.join(snapshotRoot, relative);
    const target = path.join(sourceCheckout, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
    });
  }
}

function publishEntry(staging, entryDir, backup, replace) {
  let movedPrevious = false;
  try {
    if (fs.existsSync(entryDir)) {
      if (!replace) {
        throw new Error(`lab entry already exists: ${path.basename(entryDir)}; pass --replace`);
      }
      fs.renameSync(entryDir, backup);
      movedPrevious = true;
    }
    fs.renameSync(staging, entryDir);
    if (movedPrevious) fs.rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    if (!fs.existsSync(entryDir) && movedPrevious && fs.existsSync(backup)) {
      fs.renameSync(backup, entryDir);
    }
    throw error;
  }
}

export function createVueVaporLabEntry({
  root = benchmarkRoot,
  labRoot = path.join(root, '.tmp/vue-vapor-lab'),
  sourceCheckout,
  variant,
  id = null,
  suffix = null,
  rows = [0, 1000, 10000, 30000],
  label = null,
  allowDirty = false,
  replace = false,
  runBuild = defaultRunBuild,
  toolchain = null,
  pnpmExecutable = null,
  now = () => new Date(),
} = {}) {
  if (!sourceCheckout) throw new Error('--source is required');
  const resolvedRoot = path.resolve(root);
  const resolvedLabRoot = path.resolve(labRoot);
  const resolvedSource = path.resolve(sourceCheckout);
  assertContainedPath(resolvedRoot, resolvedLabRoot, {
    requiredTopLevel: '.tmp',
    label: 'lab root',
  });
  for (const child of ['entries', 'locks', 'work']) {
    assertContainedPath(resolvedRoot, path.join(resolvedLabRoot, child), {
      requiredTopLevel: '.tmp',
      label: `lab ${child}`,
    });
  }
  const selectedRows = parseRows(rows);
  const buildCells = selectedRows.map((row) => vueVaporBuildCell(variant, row));
  const entryId = resolveEntryId({ variant, id, suffix });
  const entryDir = path.join(resolvedLabRoot, 'entries', entryId);
  const token = `${process.pid}-${crypto.randomUUID()}`;
  const workRoot = path.join(resolvedLabRoot, 'work', `${entryId}-${token}`);
  const buildOut = path.join(workRoot, 'build');
  const staging = path.join(workRoot, 'staging');
  const backup = path.join(workRoot, 'previous-entry');
  const snapshotRoot = path.join(workRoot, 'source-output-snapshot');
  for (const [target, labelName] of [
    [entryDir, 'lab entry'],
    [workRoot, 'lab work directory'],
    [buildOut, 'lab build output'],
    [staging, 'lab entry staging'],
  ]) {
    assertContainedPath(resolvedRoot, target, {
      requiredTopLevel: '.tmp',
      label: labelName,
    });
  }
  if (fs.existsSync(entryDir) && !replace) {
    throw new Error(`lab entry already exists: ${entryId}; pass --replace to replace it`);
  }
  if (!fs.existsSync(path.join(resolvedSource, 'packages/benchmark'))) {
    throw new Error(`source checkout has no packages/benchmark: ${resolvedSource}`);
  }

  const releaseLocks = acquireLocks([
    sourceLockPath(resolvedSource),
    path.join(resolvedLabRoot, 'locks', `${entryId}.lock`),
  ]);
  let sourceOutputSnapshot = [];
  let sourceOutputSnapshotComplete = false;
  try {
  fs.mkdirSync(workRoot, { recursive: true });
  const sourceBefore = captureGitState(resolvedSource);
  if (sourceBefore.dirty && !allowDirty) {
    throw new Error(
      `source checkout is dirty: ${resolvedSource}; commit/stash it or pass --allow-dirty`,
    );
  }
  const benchmarkState = captureGitState(resolvedRoot);
  const benchmark = {
    checkout: benchmarkState.checkout,
    remote: benchmarkState.remote,
    ref: benchmarkState.ref,
    head: benchmarkState.head,
    dirty: benchmarkState.dirty,
    status: benchmarkState.status,
    patch: {
      path: benchmarkState.patch.length > 0 ? 'benchmark.patch' : null,
      sha256: benchmarkState.patchSha256,
      bytes: benchmarkState.patch.length,
    },
  };
  const resolvedToolchain = toolchain ?? actualToolchain(resolvedRoot, pnpmExecutable);
  const startedAt = now().toISOString();
  sourceOutputSnapshot = snapshotSourceOutputs(resolvedSource, snapshotRoot);
  sourceOutputSnapshotComplete = true;
  fs.mkdirSync(buildOut, { recursive: true });
  const command = runBuild({
    root: resolvedRoot,
    sourceCheckout: resolvedSource,
    variant,
    rows: selectedRows,
    buildOut,
  }) ?? [
    process.execPath,
    path.join(resolvedRoot, 'scripts/build-vue-featured.mjs'),
    resolvedSource,
    '--lab',
    '--variant',
    variant,
    '--rows',
    selectedRows.join(','),
    '--out',
    buildOut,
  ];
  const completedAt = now().toISOString();
  const sourceAfter = captureGitState(resolvedSource);
  if (sourceAfter.head !== sourceBefore.head
    || sourceAfter.patchSha256 !== sourceBefore.patchSha256) {
    throw new Error('source checkout changed during the build; refusing to issue a receipt');
  }
  const benchmarkAfter = captureGitState(resolvedRoot);
  if (benchmarkAfter.head !== benchmarkState.head
    || benchmarkAfter.patchSha256 !== benchmarkState.patchSha256) {
    throw new Error('benchmark worktree changed during the build; refusing to issue a receipt');
  }

  const buildMetadataSource = path.join(buildOut, 'build-metadata.json');
  assertRegularFile(buildMetadataSource, 'build metadata');
  const buildMetadataBytes = fs.readFileSync(buildMetadataSource);
  const buildMetadata = JSON.parse(buildMetadataBytes);
  if (!buildMetadataBytes.equals(vueFeaturedBuildMetadataBytes(buildMetadata))) {
    throw new Error(`${buildMetadataSource}: build metadata is not canonical`);
  }
  verifyVueFeaturedBuildMetadata(buildMetadata, buildCells, buildOut);

  fs.mkdirSync(path.join(staging, 'dist'), { recursive: true });
  const bundles = {};
  const artifactAssertions = {};
  for (const cell of buildCells) {
    const { id: upstreamId, rows: row } = cell;
    const sourceDir = path.join(buildOut, upstreamId, `rows-${row}`);
    const targetDir = path.join(staging, 'dist', `rows-${row}`);
    fs.mkdirSync(targetDir, { recursive: true });
    const bundleFiles = {};
    for (const flavor of ['web', 'lynx']) {
      const name = `main.${flavor}.bundle`;
      const source = path.join(sourceDir, name);
      if (!fs.existsSync(source)) {
        throw new Error(`missing built bundle: ${source}`);
      }
      const relative = `rows-${row}/${name}`;
      const target = path.join(targetDir, name);
      fs.copyFileSync(source, target);
      bundleFiles[name] = target;
      bundles[relative] = bundleMetadata(target, `dist/${relative}`);
    }
    const assertionName = 'artifact-assertions.json';
    const assertionRelative = `rows-${row}/${assertionName}`;
    const assertionTarget = path.join(targetDir, assertionName);
    fs.copyFileSync(path.join(sourceDir, assertionName), assertionTarget);
    const assertionBytes = fs.readFileSync(assertionTarget);
    const assertions = JSON.parse(assertionBytes);
    if (!assertionBytes.equals(vueArtifactAssertionsBytes(assertions))) {
      throw new Error(`${assertionTarget}: artifact assertions are not canonical`);
    }
    verifyVueArtifactAssertions(
      assertions,
      vueVaporArtifactExpectation(variant, row),
      bundleFiles,
    );
    artifactAssertions[assertionRelative] = {
      path: `dist/${assertionRelative}`,
      sha256: sha256Buffer(assertionBytes),
      bytes: assertionBytes.length,
      assertions,
    };
  }
  if (sourceBefore.patch.length > 0) {
    fs.writeFileSync(path.join(staging, 'source.patch'), sourceBefore.patch);
  }
  if (benchmarkState.patch.length > 0) {
    fs.writeFileSync(path.join(staging, 'benchmark.patch'), benchmarkState.patch);
  }
  fs.copyFileSync(buildMetadataSource, path.join(staging, 'build-metadata.json'));
  const copiedTools = new Set();
  for (const { rspeedy } of buildMetadata.cells) {
    if (copiedTools.has(rspeedy.fingerprint)) continue;
    copiedTools.add(rspeedy.fingerprint);
    const evidence = vueBuildToolEvidencePaths(rspeedy.fingerprint);
    for (const relative of [
      evidence.binary,
      evidence.package,
      evidence.compilerGraph,
    ]) {
      const source = path.join(buildOut, relative);
      assertRegularFile(source, 'build tool evidence');
      const target = path.join(staging, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    }
    const packageTreeSource = path.join(buildOut, evidence.packageTree);
    assertDirectory(packageTreeSource, 'build tool package tree evidence');
    fs.cpSync(
      packageTreeSource,
      path.join(staging, evidence.packageTree),
      { recursive: true, errorOnExist: true, force: false },
    );
  }
  verifyVueFeaturedBuildMetadata(buildMetadata, buildCells, staging);

  const receipt = {
    schemaVersion: 3,
    kind: 'vue-vapor-ab-lab-receipt',
    entryId,
    variant,
    rows: selectedRows,
    source: {
      checkout: sourceBefore.checkout,
      remote: sourceBefore.remote,
      ref: sourceBefore.ref,
      head: sourceBefore.head,
      dirty: sourceBefore.dirty,
      dirtyAllowed: Boolean(sourceBefore.dirty && allowDirty),
      status: sourceBefore.status,
      patch: {
        path: sourceBefore.patch.length > 0 ? 'source.patch' : null,
        sha256: sourceBefore.patchSha256,
        bytes: sourceBefore.patch.length,
      },
    },
    benchmark,
    build: {
      startedAt,
      completedAt,
      command,
      cells: buildCells,
      metadata: {
        path: 'build-metadata.json',
        sha256: sha256Buffer(buildMetadataBytes),
        bytes: buildMetadataBytes.length,
      },
      tools: buildMetadata.cells,
    },
    toolchain: resolvedToolchain,
    bundles,
    artifactAssertions,
  };
  const receiptBytes = jsonBytes(receipt);
  const receiptSha256 = sha256Buffer(receiptBytes);
  writeAtomic(path.join(staging, 'receipt.json'), receiptBytes);

  const baseBundle = `dist/rows-${selectedRows[0]}`;
  const manifest = {
    id: entryId,
    label: label ?? `Vue-Lynx Vapor${variant === 'ifr' ? ' +IFR' : ''} lab ${sourceBefore.head.slice(0, 8)}`,
    framework: 'vue-lynx',
    frameworkVersion: readVueVersion(resolvedSource),
    config: `vapor mode, IFR ${variant === 'ifr' ? 'on' : 'off'}; lab source ${sourceBefore.ref}@${sourceBefore.head.slice(0, 12)}`,
    tags: [variant === 'ifr' ? 'optimized' : 'baseline', 'experiment'],
    tier: 'lab',
    color: variant === 'ifr' ? '#397a46' : '#a85686',
    presentation: {
      order: 900,
      colorLight: variant === 'ifr' ? '#397a46' : '#a85686',
      colorDark: variant === 'ifr' ? '#65a873' : '#d17baa',
    },
    kind: 'vendored',
    provenance: {
      source: sourceBefore.remote ?? sourceBefore.checkout,
      ref: sourceBefore.ref,
      commit: sourceBefore.head,
      patched: sourceBefore.dirty,
      patchFile: sourceBefore.patch.length > 0 ? 'source.patch' : null,
      patchSha256: sourceBefore.patchSha256,
      benchmarkCommit: benchmark.head,
      benchmarkPatchSha256: benchmark.patch.sha256,
      buildCommand: command.join(' '),
      builtAt: completedAt,
      toolchain: resolvedToolchain,
      receipt: 'receipt.json',
      receiptSha256,
      sha256: Object.fromEntries(
        Object.entries(bundles).map(([relative, metadata]) => [relative, metadata.sha256]),
      ),
    },
    bundles: {
      web: `${baseBundle}/main.web.bundle`,
      lynx: `${baseBundle}/main.lynx.bundle`,
    },
  };
  const manifestBytes = jsonBytes(manifest);
  writeAtomic(path.join(staging, 'entry.json'), manifestBytes);
  const artifactHashes = {
    'entry.json': sha256Buffer(manifestBytes),
    'receipt.json': receiptSha256,
  };
  writeAtomic(path.join(staging, 'artifact-hashes.json'), jsonBytes(artifactHashes));

  fs.mkdirSync(path.dirname(entryDir), { recursive: true });
  publishEntry(staging, entryDir, backup, replace);
  return {
    entryId,
    entryDir,
    manifest,
    receipt,
    artifactHashes,
  };
  } finally {
    try {
      if (sourceOutputSnapshotComplete) {
        restoreSourceOutputs(resolvedSource, snapshotRoot, sourceOutputSnapshot);
      }
    } finally {
      fs.rmSync(workRoot, { recursive: true, force: true });
      releaseLocks();
    }
  }
}

function parseArgs(argv) {
  const args = {};
  const valued = new Set([
    'source', 'variant', 'id', 'suffix', 'rows', 'lab-root', 'label', 'pnpm',
  ]);
  const flags = new Set(['help', 'allow-dirty', 'replace']);
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
    const equals = arg.indexOf('=');
    if (equals > 0) {
      const key = arg.slice(2, equals);
      if (!valued.has(key)) throw new Error(`unknown argument: --${key}`);
      if (Object.hasOwn(args, key)) throw new Error(`duplicate argument: --${key}`);
      const value = arg.slice(equals + 1);
      if (value.length === 0) throw new Error(`--${key} requires a value`);
      args[key] = value;
    } else if (argv[index + 1] && !argv[index + 1].startsWith('--')) {
      const key = arg.slice(2);
      if (!valued.has(key)) throw new Error(`unknown argument: --${key}`);
      if (Object.hasOwn(args, key)) throw new Error(`duplicate argument: --${key}`);
      args[key] = argv[++index];
    } else {
      const key = arg.slice(2);
      if (!flags.has(key)) throw new Error(`--${key} requires a value`);
      if (Object.hasOwn(args, key)) throw new Error(`duplicate argument: --${key}`);
      args[key] = true;
    }
  }
  return args;
}

function usage() {
  return [
    'usage: node scripts/lab/vue-vapor-entry.mjs',
    '  --source <vue-lynx-checkout> --variant vapor|ifr (--id <id> | --suffix <suffix>)',
    '  [--rows 0,1k,10k,30k] [--lab-root .tmp/vue-vapor-lab]',
    '  [--label <label>] [--pnpm <executable>] [--allow-dirty] [--replace]',
  ].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log(usage());
    } else {
      const result = createVueVaporLabEntry({
        sourceCheckout: args.source,
        variant: args.variant,
        id: typeof args.id === 'string' ? args.id : null,
        suffix: typeof args.suffix === 'string' ? args.suffix : null,
        rows: args.rows ?? '0,1k,10k,30k',
        labRoot: path.resolve(args['lab-root'] ?? path.join(benchmarkRoot, '.tmp/vue-vapor-lab')),
        label: typeof args.label === 'string' ? args.label : null,
        pnpmExecutable: typeof args.pnpm === 'string' ? args.pnpm : null,
        allowDirty: Boolean(args['allow-dirty']),
        replace: Boolean(args.replace),
      });
      console.log(
        `[vue-vapor-lab] ${result.entryId} → ${path.relative(benchmarkRoot, result.entryDir)}`,
      );
      console.log(`[vue-vapor-lab] receipt sha256 ${result.artifactHashes['receipt.json']}`);
    }
  } catch (error) {
    console.error(String(error?.stack ?? error));
    console.error(`\n${usage()}`);
    process.exitCode = 1;
  }
}
