// Entry discovery: every entries/<id>/entry.json is an entry. See
// docs/DESIGN.md for the manifest shape.
import fs from 'node:fs';
import path from 'node:path';

export function repoRoot() {
  let dir = path.dirname(new URL(import.meta.url).pathname);
  while (dir !== '/') {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('repo root not found');
}

export function discoverEntries({ only = null, root = repoRoot() } = {}) {
  const entriesDir = path.join(root, 'entries');
  const out = [];
  for (const id of fs.readdirSync(entriesDir).sort()) {
    const manifestPath = path.join(entriesDir, id, 'entry.json');
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    if (manifest.id !== id) {
      throw new Error(`entry ${id}: manifest id mismatch (${manifest.id})`);
    }
    out.push({
      ...manifest,
      dir: path.join(entriesDir, id),
      distDir: path.join(entriesDir, id, 'dist'),
    });
  }
  if (only != null) {
    if (new Set(only).size !== only.length) {
      throw new Error(`entry selection contains duplicates: ${only.join(', ')}`);
    }
    const byId = new Map(out.map((entry) => [entry.id, entry]));
    const missing = only.filter((id) => !byId.has(id));
    if (missing.length > 0) throw new Error(`unknown entry selection: ${missing.join(', ')}`);
    return only.map((id) => byId.get(id));
  }
  return out;
}

export function entrySupportsHarness(entry, harness) {
  return entry?.harnesses == null || entry.harnesses.includes(harness);
}

export function selectEntriesForHarness(entries, harness, { explicit = false } = {}) {
  const unsupported = entries.filter((entry) => !entrySupportsHarness(entry, harness));
  if (explicit && unsupported.length > 0) {
    throw new Error(unsupported.map((entry) => {
      const reason = entry.unsupportedHarnessReasons?.[harness] ?? 'not declared by the entry';
      return `${entry.id} does not support the ${harness} harness: ${reason}`;
    }).join('\n'));
  }
  return entries.filter((entry) => entrySupportsHarness(entry, harness));
}

/** Bundle path for a given autoRows scale; null when that variant is absent. */
export function bundleFor(entry, { rows = 0, flavor = 'web' } = {}) {
  const rel = path.join(`rows-${rows}`, `main.${flavor}.bundle`);
  const abs = path.join(entry.distDir, rel);
  return fs.existsSync(abs) ? { rel, abs } : null;
}
