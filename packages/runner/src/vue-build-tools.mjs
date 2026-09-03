import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import {
  assertContainedPath,
  assertDirectory,
  assertRegularFile,
} from './path-safety.mjs';

const RSPEEDY_PACKAGE = '@lynx-js/rspeedy';
const SHA256 = /^[a-f0-9]{64}$/;

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;

function expectEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

function expectKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  expectEqual(
    JSON.stringify(Object.keys(value).sort()),
    JSON.stringify([...keys].sort()),
    `${label} keys`,
  );
}

function sourcePath(...parts) {
  return path.posix.join(...parts.map((part) => part.replaceAll(path.sep, '/')));
}

function installedSourceFile(checkout, relative, label) {
  const resolvedRoot = fs.realpathSync(path.resolve(checkout));
  const logical = path.resolve(resolvedRoot, relative);
  const logicalRelative = path.relative(resolvedRoot, logical);
  if (logicalRelative.startsWith('..') || path.isAbsolute(logicalRelative)) {
    throw new Error(`${label} must stay inside ${resolvedRoot}: ${logical}`);
  }
  let resolved;
  try {
    resolved = fs.realpathSync(logical);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    throw new Error(`missing ${label}: ${relative}`);
  }
  const resolvedRelative = path.relative(resolvedRoot, resolved);
  if (resolvedRelative.startsWith('..') || path.isAbsolute(resolvedRelative)) {
    throw new Error(`${label} resolves outside the source checkout: ${relative}`);
  }
  if (!fs.statSync(resolved).isFile()) {
    throw new Error(`${label} must be a regular file: ${relative}`);
  }
  return resolved;
}

function evidenceFile(root, relative, label) {
  const resolved = path.resolve(root, relative);
  assertContainedPath(root, resolved, { label });
  assertRegularFile(resolved, label);
  return resolved;
}

function normalizedPackagePath(relative) {
  const normalized = path.posix.normalize(relative.replaceAll(path.sep, '/'));
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')
    || path.posix.isAbsolute(normalized)) {
    throw new Error(`invalid Rspeedy package path: ${relative}`);
  }
  return normalized;
}

function packageTreeEntries(root) {
  const entries = [];
  const visit = (directory, prefix = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => compareText(left.name, right.name))) {
      if (entry.name === 'node_modules') continue;
      const relative = normalizedPackagePath(path.posix.join(prefix, entry.name));
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Rspeedy package tree must not contain symlinks: ${relative}`);
      }
      if (entry.isDirectory()) {
        visit(absolute, relative);
      } else if (entry.isFile()) {
        const bytes = fs.readFileSync(absolute);
        entries.push({
          path: relative,
          sha256: sha256(bytes),
          size: bytes.length,
        });
      } else {
        throw new Error(`unsupported Rspeedy package entry: ${relative}`);
      }
    }
  };
  visit(root);
  return entries;
}

function packageTreeIdentity(entries) {
  return {
    packageTreeSha256: sha256(Buffer.from(JSON.stringify(entries))),
    packageTreeFiles: entries.length,
  };
}

function packageRootForManifest(checkout, manifestPath, label) {
  const checkoutRoot = fs.realpathSync(path.resolve(checkout));
  const resolvedManifest = fs.realpathSync(manifestPath);
  const relative = path.relative(checkoutRoot, resolvedManifest);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} resolves outside the source checkout`);
  }
  return path.dirname(resolvedManifest);
}

function findPackageManifest(checkout, fromManifest, packageName, required) {
  const requireFromPackage = createRequire(fromManifest);
  const checkoutRoot = fs.realpathSync(path.resolve(checkout));
  let resolved;
  try {
    resolved = requireFromPackage.resolve(`${packageName}/package.json`);
  } catch {
    try {
      resolved = requireFromPackage.resolve(packageName);
    } catch {
      // Handled below so optional dependencies may be absent.
    }
  }
  let manifestPath = null;
  if (resolved) {
    let current = fs.statSync(resolved).isDirectory()
      ? resolved
      : path.dirname(resolved);
    while (true) {
      const relative = path.relative(checkoutRoot, current);
      if (relative.startsWith('..') || path.isAbsolute(relative)) break;
      const candidate = path.join(current, 'package.json');
      if (fs.existsSync(candidate)) {
        const manifest = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        if (manifest.name === packageName
          && typeof manifest.version === 'string'
          && manifest.version.length > 0) {
          manifestPath = candidate;
          break;
        }
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  if (!manifestPath) {
    if (!required) return null;
    throw new Error(`unresolved required compiler dependency ${packageName}`);
  }
  const root = packageRootForManifest(
    checkout,
    manifestPath,
    `compiler dependency ${packageName}`,
  );
  return path.join(root, 'package.json');
}

function dependencyRequirements(manifest) {
  const requirements = new Map();
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    requirements.set(name, { kind: 'dependency', required: true });
  }
  for (const name of Object.keys(manifest.optionalDependencies ?? {})) {
    requirements.set(name, { kind: 'optionalDependency', required: false });
  }
  for (const name of Object.keys(manifest.peerDependencies ?? {})) {
    if (requirements.has(name)) continue;
    const optional = manifest.peerDependenciesMeta?.[name]?.optional === true;
    requirements.set(name, { kind: 'peerDependency', required: !optional });
  }
  return [...requirements.entries()]
    .sort(([left], [right]) => compareText(left, right));
}

function compilerGraphBytes(value) {
  return Buffer.from(JSON.stringify(value));
}

function compilerGraphHash(value) {
  return sha256(compilerGraphBytes(value));
}

function resolveCompilerGraph(checkout, rootManifestPath) {
  const checkoutRoot = fs.realpathSync(path.resolve(checkout));
  const byRoot = new Map();
  const visit = (manifestPath) => {
    const packageRoot = packageRootForManifest(
      checkout,
      manifestPath,
      'compiler package',
    );
    if (byRoot.has(packageRoot)) return byRoot.get(packageRoot);
    const manifestBytes = fs.readFileSync(path.join(packageRoot, 'package.json'));
    const manifest = JSON.parse(manifestBytes);
    if (typeof manifest.name !== 'string' || manifest.name.length === 0
      || typeof manifest.version !== 'string' || manifest.version.length === 0) {
      throw new Error(`compiler package has invalid name/version: ${packageRoot}`);
    }
    const tree = packageTreeIdentity(packageTreeEntries(packageRoot));
    const location = path.relative(checkoutRoot, packageRoot).replaceAll(path.sep, '/');
    if (location.startsWith('../') || path.posix.isAbsolute(location)) {
      throw new Error(`compiler package location escapes checkout: ${packageRoot}`);
    }
    const id =
      `${manifest.name}@${manifest.version}#${tree.packageTreeSha256}@${location}`;
    const node = {
      id,
      name: manifest.name,
      version: manifest.version,
      location,
      packageJsonSha256: sha256(manifestBytes),
      ...tree,
      dependencies: [],
    };
    byRoot.set(packageRoot, node);
    for (const [name, requirement] of dependencyRequirements(manifest)) {
      const dependencyManifest = findPackageManifest(
        checkout,
        path.join(packageRoot, 'package.json'),
        name,
        requirement.required,
      );
      if (!dependencyManifest) continue;
      const dependency = visit(dependencyManifest);
      node.dependencies.push({
        name,
        kind: requirement.kind,
        target: dependency.id,
      });
    }
    node.dependencies.sort((left, right) =>
      compareText(
        `${left.name}\0${left.kind}\0${left.target}`,
        `${right.name}\0${right.kind}\0${right.target}`,
      ));
    return node;
  };
  const root = visit(rootManifestPath);
  const graph = {
    schemaVersion: 1,
    platform: process.platform,
    arch: process.arch,
    nodeAbi: process.versions.modules ?? null,
    root: root.id,
    packages: [...byRoot.values()].sort((left, right) => compareText(left.id, right.id)),
  };
  return {
    ...graph,
    graphSha256: compilerGraphHash(graph),
  };
}

function verifyCompilerGraph(graph, label) {
  expectKeys(graph, [
    'schemaVersion',
    'platform',
    'arch',
    'nodeAbi',
    'root',
    'packages',
    'graphSha256',
  ], `${label} compiler graph`);
  expectEqual(graph.schemaVersion, 1, `${label} compiler graph schema version`);
  if (!Array.isArray(graph.packages) || graph.packages.length === 0) {
    throw new Error(`${label} compiler graph packages must be non-empty`);
  }
  const canonicalPackages = [...graph.packages]
    .sort((left, right) => compareText(left.id, right.id));
  expectEqual(
    JSON.stringify(graph.packages),
    JSON.stringify(canonicalPackages),
    `${label} compiler graph package order`,
  );
  const ids = new Set();
  for (const packageNode of graph.packages) {
    expectKeys(packageNode, [
      'id',
      'name',
      'version',
      'location',
      'packageJsonSha256',
      'packageTreeSha256',
      'packageTreeFiles',
      'dependencies',
    ], `${label} compiler graph package`);
    if (ids.has(packageNode.id)) {
      throw new Error(`${label} compiler graph contains duplicate package ${packageNode.id}`);
    }
    if (typeof packageNode.location !== 'string'
      || packageNode.location.length === 0
      || packageNode.location.startsWith('../')
      || path.posix.isAbsolute(packageNode.location)) {
      throw new Error(`${label} compiler graph package location is invalid`);
    }
    ids.add(packageNode.id);
    for (const key of ['packageJsonSha256', 'packageTreeSha256']) {
      if (!SHA256.test(packageNode[key])) {
        throw new Error(`${label} compiler graph ${key} is invalid`);
      }
    }
    if (!Number.isSafeInteger(packageNode.packageTreeFiles)
      || packageNode.packageTreeFiles <= 0) {
      throw new Error(`${label} compiler graph packageTreeFiles is invalid`);
    }
    if (!Array.isArray(packageNode.dependencies)) {
      throw new Error(`${label} compiler graph dependencies must be an array`);
    }
  }
  if (!ids.has(graph.root)) {
    throw new Error(`${label} compiler graph root is missing`);
  }
  for (const packageNode of graph.packages) {
    for (const dependency of packageNode.dependencies) {
      expectKeys(dependency, ['name', 'kind', 'target'], `${label} compiler dependency`);
      if (!ids.has(dependency.target)) {
        throw new Error(`${label} compiler dependency target is missing`);
      }
    }
  }
  const canonical = {
    schemaVersion: graph.schemaVersion,
    platform: graph.platform,
    arch: graph.arch,
    nodeAbi: graph.nodeAbi,
    root: graph.root,
    packages: graph.packages,
  };
  expectEqual(
    graph.graphSha256,
    compilerGraphHash(canonical),
    `${label} compiler graph sha256`,
  );
  return graph;
}

export function vueBuildToolCompilerGraphIdentity({
  name = RSPEEDY_PACKAGE,
  version,
  files,
} = {}) {
  const entries = Object.entries(files ?? {}).map(([relative, value]) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    return {
      path: normalizedPackagePath(relative),
      sha256: sha256(bytes),
      size: bytes.length,
    };
  }).sort((left, right) => compareText(left.path, right.path));
  const tree = packageTreeIdentity(entries);
  const packageJson = files?.['package.json'];
  if (!packageJson || typeof version !== 'string' || version.length === 0) {
    throw new Error('compiler graph fixture requires version and package.json');
  }
  const packageJsonBytes = Buffer.isBuffer(packageJson)
    ? packageJson
    : Buffer.from(packageJson);
  const location = `node_modules/${name}`;
  const id = `${name}@${version}#${tree.packageTreeSha256}@${location}`;
  const graph = {
    schemaVersion: 1,
    platform: process.platform,
    arch: process.arch,
    nodeAbi: process.versions.modules ?? null,
    root: id,
    packages: [{
      id,
      name,
      version,
      location,
      packageJsonSha256: sha256(packageJsonBytes),
      ...tree,
      dependencies: [],
    }],
  };
  return {
    ...graph,
    graphSha256: compilerGraphHash(graph),
  };
}

export function vueBuildToolPackageTreeIdentity(files) {
  const entries = Object.entries(files).map(([relative, value]) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    return {
      path: normalizedPackagePath(relative),
      sha256: sha256(bytes),
      size: bytes.length,
    };
  }).sort((left, right) => compareText(left.path, right.path));
  return packageTreeIdentity(entries);
}

function packageBinary(packageJson) {
  const binary = typeof packageJson.bin === 'string'
    ? packageJson.bin
    : packageJson.bin?.rspeedy;
  if (typeof binary !== 'string' || binary.length === 0) {
    throw new Error(`${RSPEEDY_PACKAGE} package has no rspeedy binary`);
  }
  return normalizedPackagePath(binary);
}

export function vueBuildToolFingerprint(identity) {
  return sha256(Buffer.from(JSON.stringify({
    package: identity.package,
    toolRoot: identity.toolRoot,
    shimPath: identity.shimPath,
    binaryPath: identity.binaryPath,
    packagePath: identity.packagePath,
    version: identity.version,
    binarySha256: identity.binarySha256,
    packageSha256: identity.packageSha256,
    packageTreeSha256: identity.packageTreeSha256,
    packageTreeFiles: identity.packageTreeFiles,
    compilerGraphSha256: identity.compilerGraph.graphSha256,
    compilerGraphPackages: identity.compilerGraph.packages.length,
  })));
}

export function vueBuildToolEvidencePaths(fingerprint) {
  return {
    binary: `build-tools/${fingerprint}/rspeedy.js`,
    package: `build-tools/${fingerprint}/package.json`,
    packageTree: `build-tools/${fingerprint}/package`,
    compilerGraph: `build-tools/${fingerprint}/compiler-graph.json`,
  };
}

export function resolveVueFeaturedRspeedy(checkout, cell) {
  if (typeof cell?.rspeedyRoot !== 'string' || cell.rspeedyRoot.length === 0) {
    throw new Error(`${cell?.id ?? 'build cell'} has no Rspeedy tool root`);
  }
  const packagePath = sourcePath(
    cell.rspeedyRoot,
    'node_modules/@lynx-js/rspeedy/package.json',
  );
  const shimPath = sourcePath(
    cell.rspeedyRoot,
    'node_modules/.bin/rspeedy',
  );
  installedSourceFile(
    checkout,
    shimPath,
    `${cell.id} Rspeedy install shim`,
  );
  const absolutePackagePath = installedSourceFile(
    checkout,
    packagePath,
    `${cell.id} Rspeedy package`,
  );
  const packageBytes = fs.readFileSync(absolutePackagePath);
  const packageJson = JSON.parse(packageBytes);
  expectEqual(packageJson.name, RSPEEDY_PACKAGE, `${cell.id} Rspeedy package name`);
  if (typeof packageJson.version !== 'string' || packageJson.version.length === 0) {
    throw new Error(`${cell.id} Rspeedy package has no version`);
  }
  const binaryPath = sourcePath(
    cell.rspeedyRoot,
    'node_modules/@lynx-js/rspeedy',
    packageBinary(packageJson),
  );
  const absoluteBinaryPath = installedSourceFile(
    checkout,
    binaryPath,
    `${cell.id} Rspeedy binary`,
  );
  const binaryBytes = fs.readFileSync(absoluteBinaryPath);
  const absolutePackageRoot = path.dirname(absolutePackagePath);
  const treeIdentity = packageTreeIdentity(packageTreeEntries(absolutePackageRoot));
  const compilerGraph = resolveCompilerGraph(checkout, absolutePackagePath);
  const identity = {
    package: RSPEEDY_PACKAGE,
    toolRoot: cell.rspeedyRoot,
    shimPath,
    binaryPath,
    packagePath,
    version: packageJson.version,
    binarySha256: sha256(binaryBytes),
    packageSha256: sha256(packageBytes),
    ...treeIdentity,
    compilerGraph,
  };
  return {
    identity: {
      ...identity,
      fingerprint: vueBuildToolFingerprint(identity),
    },
    absoluteBinaryPath,
    absolutePackagePath,
    absolutePackageRoot,
    checkout: fs.realpathSync(path.resolve(checkout)),
  };
}

export function prepareVueFeaturedBuildTools(checkout, cells) {
  const byRoot = new Map();
  return cells.map((cell) => {
    if (!byRoot.has(cell.rspeedyRoot)) {
      byRoot.set(cell.rspeedyRoot, resolveVueFeaturedRspeedy(checkout, cell));
    }
    return {
      cell,
      tool: byRoot.get(cell.rspeedyRoot),
    };
  });
}

export function vueFeaturedBuildMetadata(prepared) {
  return {
    schemaVersion: 1,
    cells: prepared.map(({ cell, tool }) => ({
      id: cell.id,
      rows: cell.rows,
      rspeedy: tool.identity,
    })),
  };
}

export function vueFeaturedBuildMetadataBytes(value) {
  return Buffer.from(`${JSON.stringify(value)}\n`);
}

export function writeVueFeaturedBuildMetadata(out, prepared) {
  const metadata = vueFeaturedBuildMetadata(prepared);
  const copied = new Set();
  for (const { tool } of prepared) {
    const { fingerprint } = tool.identity;
    if (copied.has(fingerprint)) continue;
    copied.add(fingerprint);
    const evidence = vueBuildToolEvidencePaths(fingerprint);
    const currentTreeEntries = packageTreeEntries(tool.absolutePackageRoot);
    const currentTreeIdentity = packageTreeIdentity(currentTreeEntries);
    const currentCompilerGraph = resolveCompilerGraph(
      tool.checkout,
      tool.absolutePackagePath,
    );
    expectEqual(
      currentTreeIdentity.packageTreeSha256,
      tool.identity.packageTreeSha256,
      `${tool.identity.toolRoot} Rspeedy package tree sha256 after build`,
    );
    expectEqual(
      currentTreeIdentity.packageTreeFiles,
      tool.identity.packageTreeFiles,
      `${tool.identity.toolRoot} Rspeedy package tree file count after build`,
    );
    expectEqual(
      currentCompilerGraph.graphSha256,
      tool.identity.compilerGraph.graphSha256,
      `${tool.identity.toolRoot} compiler graph sha256 after build`,
    );
    for (const [source, relative] of [
      [tool.absoluteBinaryPath, evidence.binary],
      [tool.absolutePackagePath, evidence.package],
    ]) {
      const target = path.join(out, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    }
    fs.writeFileSync(
      path.join(out, evidence.compilerGraph),
      compilerGraphBytes(currentCompilerGraph),
    );
    for (const entry of currentTreeEntries) {
      const source = path.join(tool.absolutePackageRoot, ...entry.path.split('/'));
      const target = path.join(out, evidence.packageTree, ...entry.path.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    }
  }
  fs.writeFileSync(
    path.join(out, 'build-metadata.json'),
    vueFeaturedBuildMetadataBytes(metadata),
  );
  verifyVueFeaturedBuildMetadata(
    metadata,
    prepared.map(({ cell }) => cell),
    out,
  );
  return metadata;
}

function verifyIdentity(identity, cell, root) {
  expectKeys(identity, [
    'package',
    'toolRoot',
    'shimPath',
    'binaryPath',
    'packagePath',
    'version',
    'binarySha256',
    'packageSha256',
    'packageTreeSha256',
    'packageTreeFiles',
    'compilerGraph',
    'fingerprint',
  ], `${cell.id} Rspeedy identity`);
  expectEqual(identity.package, RSPEEDY_PACKAGE, `${cell.id} Rspeedy package`);
  expectEqual(identity.toolRoot, cell.rspeedyRoot, `${cell.id} Rspeedy tool root`);
  expectEqual(
    identity.shimPath,
    `${cell.rspeedyRoot}/node_modules/.bin/rspeedy`,
    `${cell.id} Rspeedy install shim path`,
  );
  const packagePrefix = `${cell.rspeedyRoot}/node_modules/@lynx-js/rspeedy/`;
  if (!identity.binaryPath.startsWith(packagePrefix)
    || identity.binaryPath === packagePrefix) {
    throw new Error(`${cell.id} Rspeedy binary path is outside its expected tool root`);
  }
  expectEqual(
    identity.packagePath,
    `${packagePrefix}package.json`,
    `${cell.id} Rspeedy package path`,
  );
  if (typeof identity.version !== 'string' || identity.version.length === 0) {
    throw new Error(`${cell.id} Rspeedy version is invalid`);
  }
  for (const key of [
    'binarySha256',
    'packageSha256',
    'packageTreeSha256',
    'fingerprint',
  ]) {
    if (!SHA256.test(identity[key])) {
      throw new Error(`${cell.id} Rspeedy ${key} is invalid`);
    }
  }
  if (!Number.isSafeInteger(identity.packageTreeFiles) || identity.packageTreeFiles <= 0) {
    throw new Error(`${cell.id} Rspeedy packageTreeFiles is invalid`);
  }
  verifyCompilerGraph(identity.compilerGraph, cell.id);
  expectEqual(
    identity.fingerprint,
    vueBuildToolFingerprint(identity),
    `${cell.id} Rspeedy fingerprint`,
  );

  const evidence = vueBuildToolEvidencePaths(identity.fingerprint);
  const binaryFile = evidenceFile(root, evidence.binary, `${cell.id} Rspeedy binary evidence`);
  const packageFile = evidenceFile(root, evidence.package, `${cell.id} Rspeedy package evidence`);
  const packageTreeRoot = path.resolve(root, evidence.packageTree);
  const compilerGraphFile = evidenceFile(
    root,
    evidence.compilerGraph,
    `${cell.id} compiler graph evidence`,
  );
  assertContainedPath(root, packageTreeRoot, { label: `${cell.id} Rspeedy package tree evidence` });
  assertDirectory(packageTreeRoot, `${cell.id} Rspeedy package tree evidence`);
  const binaryBytes = fs.readFileSync(binaryFile);
  const packageBytes = fs.readFileSync(packageFile);
  expectEqual(sha256(binaryBytes), identity.binarySha256, `${cell.id} Rspeedy binary sha256`);
  expectEqual(sha256(packageBytes), identity.packageSha256, `${cell.id} Rspeedy package sha256`);
  const compilerGraphBytesOnDisk = fs.readFileSync(compilerGraphFile);
  expectEqual(
    Buffer.compare(
      compilerGraphBytesOnDisk,
      compilerGraphBytes(identity.compilerGraph),
    ),
    0,
    `${cell.id} compiler graph evidence bytes`,
  );
  const packageJson = JSON.parse(packageBytes);
  expectEqual(packageJson.name, RSPEEDY_PACKAGE, `${cell.id} evidence package name`);
  expectEqual(packageJson.version, identity.version, `${cell.id} evidence package version`);
  const expectedBinaryPath = sourcePath(
    cell.rspeedyRoot,
    'node_modules/@lynx-js/rspeedy',
    packageBinary(packageJson),
  );
  expectEqual(identity.binaryPath, expectedBinaryPath, `${cell.id} Rspeedy binary path`);
  const treeEntries = packageTreeEntries(packageTreeRoot);
  const treeIdentity = packageTreeIdentity(treeEntries);
  expectEqual(
    treeIdentity.packageTreeSha256,
    identity.packageTreeSha256,
    `${cell.id} Rspeedy package tree sha256`,
  );
  expectEqual(
    treeIdentity.packageTreeFiles,
    identity.packageTreeFiles,
    `${cell.id} Rspeedy package tree file count`,
  );
  const treePackage = evidenceFile(
    packageTreeRoot,
    'package.json',
    `${cell.id} Rspeedy package tree manifest`,
  );
  const binaryRelative = packageBinary(packageJson);
  const treeBinary = evidenceFile(
    packageTreeRoot,
    binaryRelative,
    `${cell.id} Rspeedy package tree binary`,
  );
  expectEqual(
    sha256(fs.readFileSync(treePackage)),
    identity.packageSha256,
    `${cell.id} Rspeedy package tree manifest sha256`,
  );
  expectEqual(
    sha256(fs.readFileSync(treeBinary)),
    identity.binarySha256,
    `${cell.id} Rspeedy package tree binary sha256`,
  );
}

export function verifyVueFeaturedBuildMetadata(value, cells, root) {
  expectKeys(value, ['schemaVersion', 'cells'], 'Vue build metadata');
  expectEqual(value.schemaVersion, 1, 'Vue build metadata schema version');
  if (!Array.isArray(value.cells)) throw new Error('Vue build metadata cells must be an array');
  expectEqual(value.cells.length, cells.length, 'Vue build metadata cell count');
  for (let index = 0; index < cells.length; index++) {
    const expected = cells[index];
    const actual = value.cells[index];
    expectKeys(actual, ['id', 'rows', 'rspeedy'], `Vue build metadata cell ${index}`);
    expectEqual(actual.id, expected.id, `Vue build metadata cell ${index} id`);
    expectEqual(actual.rows, expected.rows, `Vue build metadata cell ${index} rows`);
    verifyIdentity(actual.rspeedy, expected, root);
  }
  return value;
}
