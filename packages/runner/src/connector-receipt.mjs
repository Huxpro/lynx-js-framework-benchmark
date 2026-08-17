import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';

export const CONNECTOR_PACKAGE_TREES_PROTOCOL = 'connector-package-trees-v1';
export const CONNECTOR_PACKAGE_NAMES = Object.freeze([
  '@byted/agent-lynx',
  '@byted-lynx/devtool-connector',
  '@byted-lynx/bdc-client',
]);

const PACKAGE_ENTRIES = new Map([
  ['@byted/agent-lynx', ['@byted/agent-lynx/package.json', '@byted/agent-lynx/connector']],
  [
    '@byted-lynx/devtool-connector',
    ['@byted-lynx/devtool-connector/package.json', '@byted-lynx/devtool-connector'],
  ],
  ['@byted-lynx/bdc-client', ['@byted-lynx/bdc-client/package.json', '@byted-lynx/bdc-client']],
]);

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const relativePath = (root, file) => relative(root, file).split(sep).join('/');

function findPackageRoot(resolvedPath, packageName) {
  let current = dirname(realpathSync(resolvedPath));
  while (true) {
    try {
      const manifest = JSON.parse(readFileSync(join(current, 'package.json'), 'utf8'));
      if (manifest.name === packageName) return current;
    } catch {
      // Exported entry points are commonly nested below the package root.
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function packageFiles(packageRoot) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolutePath);
      else if (entry.isFile()) files.push(absolutePath);
    }
  };
  visit(packageRoot);
  return files.sort((left, right) => {
    const leftRelative = relativePath(packageRoot, left);
    const rightRelative = relativePath(packageRoot, right);
    return leftRelative < rightRelative ? -1 : leftRelative > rightRelative ? 1 : 0;
  });
}

export function createPackageTreeReceipt(packageName, packageRoot) {
  const resolvedPath = realpathSync(packageRoot);
  const manifest = JSON.parse(readFileSync(join(resolvedPath, 'package.json'), 'utf8'));
  if (manifest.name !== packageName) {
    throw new Error(
      `resolved package root ${resolvedPath} contains ${JSON.stringify(manifest.name)}, `
      + `expected ${JSON.stringify(packageName)}.`,
    );
  }
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new Error(`resolved package ${packageName} has no version.`);
  }

  const hash = createHash('sha256');
  let byteCount = 0;
  const files = packageFiles(resolvedPath);
  for (const absolutePath of files) {
    const bytes = readFileSync(absolutePath);
    hash.update(relativePath(resolvedPath, absolutePath));
    hash.update('\0');
    hash.update(bytes);
    byteCount += bytes.byteLength;
  }
  return Object.freeze({
    name: packageName,
    version: manifest.version,
    available: true,
    resolvedPath,
    rootSha256: hash.digest('hex'),
    fileCount: files.length,
    byteCount,
  });
}

function unavailablePackage(name, reason, errorCode = null) {
  return Object.freeze({
    name,
    version: null,
    available: false,
    resolvedPath: null,
    rootSha256: null,
    fileCount: null,
    byteCount: null,
    reason,
    errorCode,
  });
}

function resolveFrom(requireContexts, entries) {
  for (const requireContext of requireContexts) {
    for (const entry of entries) {
      try {
        return requireContext.resolve(entry);
      } catch {
        // Try the next export or a context rooted at an already-resolved package.
      }
    }
  }
  return null;
}

export function connectorPackageTreesSha256(receipt) {
  return sha256(Buffer.from(JSON.stringify({
    protocol: receipt?.protocol,
    packages: receipt?.packages,
  })));
}

export function resolveConnectorPackageTrees({
  fromPath = import.meta.url,
  requireContext = createRequire(
    typeof fromPath === 'string' && !fromPath.startsWith('file:') ? resolve(fromPath) : fromPath,
  ),
} = {}) {
  const requireContexts = [requireContext];
  const packages = CONNECTOR_PACKAGE_NAMES.map((name) => {
    const resolvedEntry = resolveFrom(requireContexts, PACKAGE_ENTRIES.get(name));
    const packageRoot = resolvedEntry && findPackageRoot(resolvedEntry, name);
    if (!packageRoot) {
      return unavailablePackage(name, 'not-resolvable-from-adapter-or-resolved-package-roots');
    }
    try {
      const receipt = createPackageTreeReceipt(name, packageRoot);
      requireContexts.push(createRequire(join(receipt.resolvedPath, 'package.json')));
      return receipt;
    } catch (error) {
      return unavailablePackage(
        name,
        'package-tree-receipt-failed',
        typeof error?.code === 'string' ? error.code : null,
      );
    }
  });
  const receipt = {
    protocol: CONNECTOR_PACKAGE_TREES_PROTOCOL,
    packages: Object.freeze(packages),
  };
  return Object.freeze({ ...receipt, sha256: connectorPackageTreesSha256(receipt) });
}

export function connectorPackageTreesError(receipt, { requireAvailable = true } = {}) {
  if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return 'connector package-tree receipt must be an object';
  }
  if (receipt.protocol !== CONNECTOR_PACKAGE_TREES_PROTOCOL) {
    return `connector package-tree protocol must be ${CONNECTOR_PACKAGE_TREES_PROTOCOL}`;
  }
  if (!Array.isArray(receipt.packages) || receipt.packages.length !== CONNECTOR_PACKAGE_NAMES.length) {
    return `connector package-tree receipt must contain ${CONNECTOR_PACKAGE_NAMES.length} packages`;
  }
  for (let index = 0; index < CONNECTOR_PACKAGE_NAMES.length; index++) {
    const expectedName = CONNECTOR_PACKAGE_NAMES[index];
    const candidate = receipt.packages[index];
    if (candidate?.name !== expectedName) return `connector package ${index} must be ${expectedName}`;
    if (candidate.available !== true) {
      if (requireAvailable) return `${expectedName} is unavailable`;
      if (
        candidate.version !== null
        || candidate.resolvedPath !== null
        || candidate.rootSha256 !== null
        || candidate.fileCount !== null
        || candidate.byteCount !== null
        || typeof candidate.reason !== 'string'
      ) return `${expectedName} has malformed unavailable metadata`;
      continue;
    }
    if (typeof candidate.version !== 'string' || candidate.version.length === 0) {
      return `${expectedName} has no version`;
    }
    if (typeof candidate.resolvedPath !== 'string' || candidate.resolvedPath.length === 0) {
      return `${expectedName} has no resolved path`;
    }
    if (!/^[a-f0-9]{64}$/.test(candidate.rootSha256)) return `${expectedName} has invalid root hash`;
    if (!Number.isInteger(candidate.fileCount) || candidate.fileCount < 1) {
      return `${expectedName} has invalid file count`;
    }
    if (!Number.isInteger(candidate.byteCount) || candidate.byteCount < 1) {
      return `${expectedName} has invalid byte count`;
    }
  }
  if (receipt.sha256 !== connectorPackageTreesSha256(receipt)) {
    return 'connector package-tree digest does not match its payload';
  }
  return null;
}

export function assertConnectorPackageTrees(receipt, options) {
  const error = connectorPackageTreesError(receipt, options);
  if (error) throw new Error(error);
  return receipt;
}

export function assertConnectorPackageTreesMatch(
  expected,
  actual,
  { requireAvailable = true } = {},
) {
  assertConnectorPackageTrees(expected, { requireAvailable });
  assertConnectorPackageTrees(actual, { requireAvailable });
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `runtime connector package-tree receipt ${actual.sha256} does not match `
      + `campaign receipt ${expected.sha256}.`,
    );
  }
  return expected;
}

export function refreshConnectorPackageTrees(receipt) {
  assertConnectorPackageTrees(receipt, { requireAvailable: false });
  const packages = receipt.packages.map((candidate) => candidate.available
    ? createPackageTreeReceipt(candidate.name, candidate.resolvedPath)
    : candidate);
  const refreshed = { protocol: CONNECTOR_PACKAGE_TREES_PROTOCOL, packages };
  return Object.freeze({ ...refreshed, sha256: connectorPackageTreesSha256(refreshed) });
}
