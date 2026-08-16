import crypto from 'node:crypto';
import fs from 'node:fs';

export const VUE_ARTIFACT_PREFIX = 'vue-lynx-bench-artifact-v1|';
export const VUE_ARTIFACT_BUNDLES = ['main.web.bundle', 'main.lynx.bundle'];

export const VUE_FEATURED_CELLS = Object.freeze([
  Object.freeze({
    id: 'react',
    app: 'ui-react',
    rspeedyRoot: 'packages/benchmark/apps/ui-react',
    benchCell: null,
    outputDir: 'dist',
    mode: 'react',
    ifr: 0,
    et: 0,
  }),
  Object.freeze({
    id: 'vue-vdom',
    app: 'ui-vdom',
    rspeedyRoot: 'packages/benchmark',
    benchCell: 'off',
    outputDir: 'dist',
    mode: 'vdom',
    ifr: 0,
    et: 0,
  }),
  Object.freeze({
    id: 'vue-vdom-ifr-et',
    app: 'ui-vdom',
    rspeedyRoot: 'packages/benchmark',
    benchCell: 'ifr-et',
    outputDir: 'dist-ifr-et',
    mode: 'vdom-ifr-et',
    ifr: 1,
    et: 1,
  }),
  Object.freeze({
    id: 'vue-vapor',
    app: 'ui-vapor',
    rspeedyRoot: 'packages/benchmark',
    benchCell: 'off',
    outputDir: 'dist',
    mode: 'vapor',
    ifr: 0,
    et: 0,
  }),
  Object.freeze({
    id: 'vue-vapor-ifr',
    app: 'ui-vapor',
    rspeedyRoot: 'packages/benchmark',
    benchCell: 'ifr',
    outputDir: 'dist-ifr',
    mode: 'vapor-ifr',
    ifr: 1,
    et: 0,
  }),
]);

const CELLS_BY_ID = new Map(VUE_FEATURED_CELLS.map((cell) => [cell.id, cell]));
const MODES = new Set(VUE_FEATURED_CELLS.map(({ mode }) => mode));
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

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

function countBytes(bytes, needle) {
  let count = 0;
  let offset = 0;
  while ((offset = bytes.indexOf(needle, offset)) !== -1) {
    count++;
    offset += needle.length;
  }
  return count;
}

export function expectedVueArtifactMarker({ mode, rows, ifr, et }) {
  if (!MODES.has(mode)) throw new Error(`invalid artifact mode: ${mode}`);
  if (!Number.isSafeInteger(rows) || rows < 0) {
    throw new Error(`invalid artifact rows: ${rows}`);
  }
  if ((ifr !== 0 && ifr !== 1) || (et !== 0 && et !== 1)) {
    throw new Error(`invalid artifact flags: ifr=${ifr} et=${et}`);
  }
  return `${VUE_ARTIFACT_PREFIX}mode=${mode}|rows=${rows}|ifr=${ifr}|et=${et}`;
}

export function expectedVueArtifactBanner(expectation) {
  const marker = typeof expectation === 'string'
    ? expectation
    : expectedVueArtifactMarker(expectation);
  return `/*! ${marker} */`;
}

export function vueArtifactBuildCell(id, rows) {
  const cell = CELLS_BY_ID.get(id);
  if (!cell) throw new Error(`invalid Vue featured cell: ${id}`);
  expectedVueArtifactMarker({ mode: cell.mode, rows, ifr: cell.ifr, et: cell.et });
  const sourcePath = `packages/benchmark/apps/${cell.app}`;
  return {
    id: cell.id,
    sourcePath,
    app: cell.app,
    rspeedyRoot: cell.rspeedyRoot,
    benchCell: cell.benchCell,
    mode: cell.mode,
    rows,
    ifr: cell.ifr,
    et: cell.et,
    outputPath: `${sourcePath}/${cell.outputDir}`,
  };
}

export function vueVaporBuildCell(variant, rows) {
  if (variant === 'vapor') return vueArtifactBuildCell('vue-vapor', rows);
  if (variant === 'ifr') return vueArtifactBuildCell('vue-vapor-ifr', rows);
  throw new Error(`invalid Vapor artifact variant: ${variant}`);
}

export function vueVaporArtifactExpectation(variant, rows) {
  const { mode, ifr, et } = vueVaporBuildCell(variant, rows);
  return { mode, rows, ifr, et };
}

export function inspectVueArtifactBundle(file, marker) {
  const bytes = fs.readFileSync(file);
  const prefixBytes = Buffer.from(VUE_ARTIFACT_PREFIX, 'ascii');
  const banner = expectedVueArtifactBanner(marker);
  const bannerBytes = Buffer.from(banner, 'ascii');
  const prefixCount = countBytes(bytes, prefixBytes);
  const bannerCount = countBytes(bytes, bannerBytes);
  if (prefixCount !== 1 || bannerCount !== 1) {
    throw new Error(
      `${file}: expected exactly one static banner ${banner}; `
      + `found expected-banner=${bannerCount}, all-v1=${prefixCount}`,
    );
  }
  return {
    prefixCount,
    bannerCount,
    sha256: sha256(bytes),
    size: bytes.length,
  };
}

export function createVueArtifactAssertions(expectation, bundleFiles) {
  const marker = expectedVueArtifactMarker(expectation);
  return {
    schemaVersion: 2,
    marker,
    banner: expectedVueArtifactBanner(marker),
    assertions: { ...expectation },
    bundles: Object.fromEntries(VUE_ARTIFACT_BUNDLES.map((name) => {
      const file = bundleFiles[name];
      if (!file) throw new Error(`missing artifact bundle path: ${name}`);
      return [name, inspectVueArtifactBundle(file, marker)];
    })),
  };
}

export function verifyVueArtifactAssertions(value, expectation, bundleFiles) {
  expectKeys(
    value,
    ['schemaVersion', 'marker', 'banner', 'assertions', 'bundles'],
    'artifact assertions',
  );
  expectEqual(value.schemaVersion, 2, 'artifact assertions schema version');
  const marker = expectedVueArtifactMarker(expectation);
  expectEqual(value.marker, marker, 'artifact marker');
  expectEqual(value.banner, expectedVueArtifactBanner(marker), 'artifact banner');
  expectKeys(value.assertions, ['mode', 'rows', 'ifr', 'et'], 'artifact assertion values');
  for (const key of ['mode', 'rows', 'ifr', 'et']) {
    expectEqual(value.assertions[key], expectation[key], `artifact assertion ${key}`);
  }
  expectKeys(value.bundles, VUE_ARTIFACT_BUNDLES, 'artifact assertion bundles');
  for (const name of VUE_ARTIFACT_BUNDLES) {
    expectKeys(
      value.bundles[name],
      ['prefixCount', 'bannerCount', 'sha256', 'size'],
      `${name} artifact assertion`,
    );
    const actual = inspectVueArtifactBundle(bundleFiles[name], marker);
    for (const key of ['prefixCount', 'bannerCount', 'sha256', 'size']) {
      expectEqual(value.bundles[name][key], actual[key], `${name} artifact ${key}`);
    }
  }
  return value;
}

export function vueArtifactAssertionsBytes(value) {
  return Buffer.from(`${JSON.stringify(value)}\n`);
}
