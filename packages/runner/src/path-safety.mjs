import fs from 'node:fs';
import path from 'node:path';

export const LAB_ENTRY_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
export const RUN_LABEL_PATTERN = /^[A-Za-z0-9._-]+$/;

function existingPathIsSymlink(file) {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export function assertContainedPath(root, target, {
  requiredTopLevel = null,
  label = 'path',
} = {}) {
  const resolvedRoot = fs.realpathSync(path.resolve(root));
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside ${resolvedRoot}: ${resolvedTarget}`);
  }
  if (requiredTopLevel && relative.split(path.sep)[0] !== requiredTopLevel) {
    throw new Error(`${label} must live below ${path.join(resolvedRoot, requiredTopLevel)}`);
  }

  let current = resolvedRoot;
  if (existingPathIsSymlink(current)) {
    throw new Error(`${label} traverses a symlink: ${current}`);
  }
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (existingPathIsSymlink(current)) {
      throw new Error(`${label} traverses a symlink: ${current}`);
    }
    if (!fs.existsSync(current)) break;
  }
  return { root: resolvedRoot, target: resolvedTarget };
}

export function assertLabEntryId(value, label = 'entry id') {
  if (typeof value !== 'string' || !LAB_ENTRY_ID_PATTERN.test(value)) {
    throw new Error(`${label} must match ${LAB_ENTRY_ID_PATTERN}`);
  }
  return value;
}

export function assertRunLabel(value) {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length === 0
    || value === '.' || value === '..' || !RUN_LABEL_PATTERN.test(value)) {
    throw new Error(
      '--label must be a non-empty filename token using only letters, digits, dot, underscore, or hyphen',
    );
  }
  return value;
}

export function assertRegularFile(file, label = 'file') {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`missing ${label}: ${file}`);
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symlink: ${file}`);
  if (!stat.isFile()) throw new Error(`${label} must be a regular file: ${file}`);
  return file;
}

export function assertDirectory(directory, label = 'directory') {
  let stat;
  try {
    stat = fs.lstatSync(directory);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`missing ${label}: ${directory}`);
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symlink: ${directory}`);
  if (!stat.isDirectory()) throw new Error(`${label} must be a directory: ${directory}`);
  return directory;
}
