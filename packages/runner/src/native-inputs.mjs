import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { bundleFor } from './entries.mjs';

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const IMPORT_PATTERN = /\b(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const FORBIDDEN_DYNAMIC = /\b(?:require\s*\(|createRequire\s*\(|import\s*\((?!\s*['"]))/;

function treeEntries(root) {
  const entries = [];
  const visit = (directory, prefix = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === 'node_modules') continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.posix.join(prefix, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Native dependency graph must not contain symlinks: ${relative}`);
      }
      if (entry.isDirectory()) visit(absolute, relative);
      else if (entry.isFile()) {
        const bytes = fs.readFileSync(absolute);
        entries.push({ path: relative, bytes: bytes.length, sha256: sha256(bytes) });
      }
    }
  };
  visit(root);
  return entries;
}

function packageRoot(file) {
  let current = path.dirname(file);
  while (true) {
    const manifest = path.join(current, 'package.json');
    if (fs.existsSync(manifest)) return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`cannot locate package root for ${file}`);
    current = parent;
  }
}

function resolveImport(specifier, parent) {
  if (specifier.startsWith('node:')) return null;
  try {
    if (specifier.startsWith('.') || specifier.startsWith('/')) {
      return fileURLToPath(new URL(specifier, pathToFileURL(parent)));
    }
    return fileURLToPath(import.meta.resolve(specifier, pathToFileURL(parent).href));
  } catch (error) {
    throw new Error(`unresolved Native adapter import ${specifier} from ${parent}`, { cause: error });
  }
}

function dependencyNames(manifest) {
  return [...new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ])].sort();
}

function resolvePackageManifest(name, fromManifest, required) {
  const resolver = createRequire(fromManifest);
  try {
    let resolved;
    try {
      resolved = resolver.resolve(`${name}/package.json`);
    } catch {
      resolved = resolver.resolve(name);
    }
    let current = fs.statSync(resolved).isDirectory()
      ? resolved
      : path.dirname(resolved);
    while (true) {
      const candidate = path.join(current, 'package.json');
      if (fs.existsSync(candidate)) {
        const manifest = JSON.parse(fs.readFileSync(candidate));
        if (manifest.name === name && typeof manifest.version === 'string') return candidate;
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  } catch (error) {
    if (required) {
      throw new Error(`unresolved Native adapter package ${name}`, { cause: error });
    }
  }
  return null;
}

function moduleImports(file) {
  const source = fs.readFileSync(file, 'utf8');
  if (FORBIDDEN_DYNAMIC.test(source)) {
    throw new Error(`unsupported dynamic Native adapter import in ${file}`);
  }
  const imports = [];
  for (const match of source.matchAll(IMPORT_PATTERN)) imports.push(match[1] ?? match[2]);
  return imports;
}

export function pinNativeAdapterGraph(adapterPath) {
  const entry = fs.realpathSync(path.resolve(adapterPath));
  if (!fs.statSync(entry).isFile()) throw new Error('Native adapter entry must be a regular file');
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-native-adapter-'));
  const modules = new Map();
  const packages = new Map();
  const visit = (file) => {
    const real = fs.realpathSync(file);
    if (modules.has(real)) return;
    const bytes = fs.readFileSync(real);
    modules.set(real, { path: real, bytes: bytes.length, sha256: sha256(bytes) });
    for (const specifier of moduleImports(real)) {
      const resolved = resolveImport(specifier, real);
      if (!resolved) continue;
      if (specifier.startsWith('.') || specifier.startsWith('/')) visit(resolved);
      else {
        const root = packageRoot(resolved);
        visitPackage(path.join(root, 'package.json'));
      }
    }
  };
  const visitPackage = (manifestPath) => {
    const root = fs.realpathSync(path.dirname(manifestPath));
    if (packages.has(root)) return;
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
    const entries = treeEntries(root);
    packages.set(root, {
      name: manifest.name,
      version: manifest.version,
      root,
      files: entries.length,
      treeSha256: sha256(Buffer.from(JSON.stringify(entries))),
    });
    const optional = new Set(Object.keys(manifest.optionalDependencies ?? {}));
    const optionalPeers = new Set(Object.entries(manifest.peerDependenciesMeta ?? {})
      .filter(([, meta]) => meta?.optional)
      .map(([name]) => name));
    for (const name of dependencyNames(manifest)) {
      const dependency = resolvePackageManifest(
        name,
        path.join(root, 'package.json'),
        !optional.has(name) && !optionalPeers.has(name),
      );
      if (dependency) visitPackage(dependency);
    }
  };
  visit(entry);

  const entryRoot = packageRoot(entry);
  for (const source of modules.keys()) {
    const relative = path.relative(entryRoot, source);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Native adapter relative module escapes entry root: ${source}`);
    }
    const target = path.join(workspace, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
  for (const [root, identity] of packages) {
    const target = path.join(workspace, 'node_modules', ...identity.name.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(root, target, {
      recursive: true,
      dereference: false,
      filter: (source) => path.basename(source) !== 'node_modules',
    });
  }
  const manifest = {
    schemaVersion: 1,
    platform: process.platform,
    arch: process.arch,
    nodeAbi: process.versions.modules ?? null,
    entrySha256: modules.get(entry).sha256,
    modules: [...modules.values()].sort((a, b) => a.path.localeCompare(b.path)),
    packages: [...packages.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
  const fingerprint = sha256(Buffer.from(JSON.stringify(manifest)));
  const pinnedPath = path.join(workspace, path.relative(entryRoot, entry));
  return {
    originalPath: entry,
    pinnedPath,
    fingerprint,
    manifest,
    async factory(context) {
      const module = await import(`${pathToFileURL(pinnedPath).href}?graph=${fingerprint}`);
      if (typeof module.default !== 'function') {
        throw new Error('Native adapter must default-export a factory');
      }
      return module.default(context);
    },
    dispose() {
      fs.rmSync(workspace, { recursive: true, force: true });
    },
  };
}

export function materializeNativeBundleSnapshots({
  entries,
  suites,
  startupScales,
}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-native-bundles-'));
  const snapshots = new Map();
  const rows = new Set([
    ...(suites.includes('table') ? [0] : []),
    ...(suites.includes('startup') ? startupScales : []),
  ]);
  for (const entry of entries) {
    for (const row of rows) {
      const bundle = bundleFor(entry, { rows: row, flavor: 'lynx' });
      if (!bundle) throw new Error(`${entry.id}: missing rows-${row} Native bundle`);
      const bytes = fs.readFileSync(bundle.abs);
      if (row === 0 && suites.includes('table')) {
        const text = bytes.toString('utf8');
        for (const marker of ['__NATIVE_BENCH_RESULT__', 'vue-lynx-native-bench-v1']) {
          if (!text.includes(marker)) throw new Error(`${entry.id}: table bundle lacks ${marker}`);
        }
      }
      const directory = path.join(root, entry.id, `rows-${row}`);
      fs.mkdirSync(directory, { recursive: true });
      const snapshotPath = path.join(directory, 'main.lynx.bundle');
      fs.writeFileSync(snapshotPath, bytes, { flag: 'wx' });
      snapshots.set(`${entry.id}\0${row}`, Object.freeze({
        entryId: entry.id,
        rows: row,
        bundlePath: snapshotPath,
        bundleBytes: Buffer.from(bytes),
        sha256: sha256(bytes),
      }));
    }
  }
  return {
    snapshots,
    fingerprint: sha256(Buffer.from(JSON.stringify(
      [...snapshots.values()].map(({ entryId, rows, sha256: digest }) => ({
        entryId, rows, sha256: digest,
      })),
    ))),
    dispose() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

export function nativeBundleSnapshotFor(snapshots, entryId, rows) {
  const snapshot = snapshots?.get(`${entryId}\0${rows}`);
  if (!snapshot) throw new Error(`missing immutable Native snapshot ${entryId}@${rows}`);
  return snapshot;
}
