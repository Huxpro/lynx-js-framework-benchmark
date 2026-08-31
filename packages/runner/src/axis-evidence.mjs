import fs from 'node:fs';
import path from 'node:path';

import { AXIS_ORDER, validateCoordinates } from '@lynx-bench/shared/coordinates';

export const AXIS_EVIDENCE_SOURCE_VERSION = 'axis-evidence-source-v1';
export const AXIS_EVIDENCE_LEDGER_VERSION = 'axis-evidence-ledger-v1';

const GROUPS = new Set(['architecture', 'residue']);
const SHAPES = new Set(['pair', 'point-set']);
const RELATIONSHIPS = new Set(['same-codebase', 'cross-framework']);
const CONTROL_KEYS = ['sameCodebase', 'sameFixture', 'singlePhysicalRun', 'singleBuildVariable'];

function fail(file, message) {
  throw new Error(`${file}: ${message}`);
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function validateObservation(observation, file, comparisonId, index) {
  const prefix = `${comparisonId}.observations[${index}]`;
  if (!observation || typeof observation !== 'object') fail(file, `${prefix} must be an object`);
  for (const field of ['label', 'metric', 'unit']) {
    if (typeof observation[field] !== 'string' || observation[field].length === 0) {
      fail(file, `${prefix}.${field} must be a non-empty string`);
    }
  }
  if (typeof observation.lowerIsBetter !== 'boolean') {
    fail(file, `${prefix}.lowerIsBetter must be boolean`);
  }
  for (const side of ['before', 'after']) {
    if (typeof observation[side]?.label !== 'string' || !finite(observation[side]?.value)) {
      fail(file, `${prefix}.${side} must have a label and finite value`);
    }
    for (const optional of ['ci95', 'n']) {
      if (observation[side][optional] != null && !finite(observation[side][optional])) {
        fail(file, `${prefix}.${side}.${optional} must be finite when present`);
      }
    }
  }
  if (observation.effect != null) {
    for (const field of ['ratio', 'ci95Low', 'ci95High']) {
      if (!finite(observation.effect[field])) fail(file, `${prefix}.effect.${field} must be finite`);
    }
    if (observation.effect.ci95Low > observation.effect.ci95High) {
      fail(file, `${prefix}.effect CI is reversed`);
    }
  }
}

function validateComparison(comparison, file) {
  if (typeof comparison?.id !== 'string' || comparison.id.length === 0) {
    fail(file, 'comparison id must be a non-empty string');
  }
  if (!GROUPS.has(comparison.group)) fail(file, `${comparison.id}: invalid group`);
  if (!SHAPES.has(comparison.shape)) fail(file, `${comparison.id}: invalid shape`);
  if (!RELATIONSHIPS.has(comparison.relationship)) fail(file, `${comparison.id}: invalid relationship`);
  if (!Array.isArray(comparison.subjects) || comparison.subjects.length < 2
    || comparison.subjects.some((subject) => typeof subject !== 'string' || subject.length === 0)) {
    fail(file, `${comparison.id}: subjects must contain at least two names`);
  }
  if (!Array.isArray(comparison.changedAxes)
    || comparison.changedAxes.some((axis) => !AXIS_ORDER.includes(axis))
    || new Set(comparison.changedAxes).size !== comparison.changedAxes.length) {
    fail(file, `${comparison.id}: changedAxes must be unique typed axes`);
  }
  if (comparison.intendedAxis != null && !AXIS_ORDER.includes(comparison.intendedAxis)) {
    fail(file, `${comparison.id}: intendedAxis must be null or a typed axis`);
  }
  if (!comparison.source || typeof comparison.source.label !== 'string'
    || !/^https:\/\//.test(comparison.source.url ?? '')) {
    fail(file, `${comparison.id}: source must contain a label and HTTPS URL`);
  }
  for (const key of CONTROL_KEYS) {
    if (![true, false, null].includes(comparison.controls?.[key])) {
      fail(file, `${comparison.id}: controls.${key} must be true, false, or null`);
    }
  }
  if (!Array.isArray(comparison.observations)) fail(file, `${comparison.id}: observations must be an array`);
  comparison.observations.forEach((observation, index) =>
    validateObservation(observation, file, comparison.id, index));
  if (comparison.group === 'residue'
    && (comparison.intendedAxis !== null || comparison.changedAxes.length !== 0)) {
    fail(file, `${comparison.id}: implementation residue must keep all six coordinates fixed`);
  }
}

export function loadAxisEvidenceSources({ root }) {
  const dir = path.join(root, 'results', 'axis-evidence');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((file) => file.endsWith('.json')).sort().map((file) => {
    const relativeFile = `axis-evidence/${file}`;
    const source = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    if (source.schemaVersion !== AXIS_EVIDENCE_SOURCE_VERSION) {
      fail(relativeFile, `unsupported schema ${source.schemaVersion}`);
    }
    if (typeof source.cohortId !== 'string' || !Array.isArray(source.comparisons)
      || !Array.isArray(source.points ?? [])) {
      fail(relativeFile, 'cohortId, optional points, and comparisons must be valid');
    }
    const pointIds = new Set();
    for (const point of source.points ?? []) {
      if (typeof point?.id !== 'string' || pointIds.has(point.id)) {
        fail(relativeFile, 'historical point IDs must be non-empty and unique');
      }
      pointIds.add(point.id);
      if (point.tier !== 'lab' || typeof point.framework !== 'string'
        || typeof point.fixture !== 'string' || typeof point.provenance?.commit !== 'string') {
        fail(relativeFile, `${point.id}: historical points require Lab identity and provenance`);
      }
      validateCoordinates(point.coordinates, point.id);
    }
    source.comparisons.forEach((comparison) => validateComparison(comparison, relativeFile));
    return { file: relativeFile, source };
  });
}

export function axisEvidencePoints(sources) {
  const ids = new Set();
  return sources.flatMap(({ file, source }) => (source.points ?? []).map((point) => {
    if (ids.has(point.id)) fail(file, `duplicate historical point id ${point.id}`);
    ids.add(point.id);
    return point;
  }));
}

function verdict(comparison) {
  if (comparison.group === 'residue') return 'implementation-residue';
  if (comparison.relationship === 'cross-framework' || comparison.shape === 'point-set') {
    return 'descriptive';
  }
  if (comparison.changedAxes.length > 1) return 'coupled';
  const controlsPass = CONTROL_KEYS.every((key) => comparison.controls[key] === true);
  if (!controlsPass || comparison.changedAxes.length !== 1
    || comparison.changedAxes[0] !== comparison.intendedAxis) return 'uncontrolled';
  return 'attributable';
}

function deriveObservation(observation) {
  const delta = observation.after.value - observation.before.value;
  const relativeDelta = observation.before.value === 0 ? null : delta / observation.before.value;
  const improved = observation.lowerIsBetter ? delta < 0 : delta > 0;
  const unchanged = delta === 0;
  return {
    ...observation,
    delta,
    relativeDelta,
    direction: unchanged ? 'unchanged' : improved ? 'improved' : 'regressed',
  };
}

export function buildAxisEvidenceLedger({ sources, pairs = [] }) {
  const pairById = new Map(pairs.map((pair) => [pair.id, pair]));
  const ids = new Set();
  const comparisons = sources.flatMap(({ file, source }) => source.comparisons.map((comparison) => {
    if (ids.has(comparison.id)) fail(file, `duplicate comparison id ${comparison.id}`);
    ids.add(comparison.id);
    const linkedPair = comparison.pairRef == null ? null : pairById.get(comparison.pairRef);
    if (comparison.pairRef != null && !linkedPair) fail(file, `${comparison.id}: pairRef not found`);
    const status = verdict(comparison);
    if (status === 'attributable' && linkedPair && !linkedPair.attributable) {
      fail(file, `${comparison.id}: ledger cannot override a non-attributable manifest pair`);
    }
    return {
      ...comparison,
      sourceFile: file,
      verdict: status,
      observations: comparison.observations.map(deriveObservation),
      auditEffectCount: linkedPair == null
        ? 0
        : (linkedPair.effects.length || linkedPair.descriptiveEffects.length),
    };
  }));
  const count = (status) => comparisons.filter((comparison) => comparison.verdict === status).length;
  return {
    version: AXIS_EVIDENCE_LEDGER_VERSION,
    derivedOnly: true,
    sourceFiles: sources.map((source) => source.file),
    summary: {
      comparisonCount: comparisons.length,
      attributableCount: count('attributable'),
      coupledCount: count('coupled'),
      descriptiveCount: count('descriptive'),
      uncontrolledCount: count('uncontrolled'),
      implementationResidueCount: count('implementation-residue'),
    },
    comparisons,
  };
}
