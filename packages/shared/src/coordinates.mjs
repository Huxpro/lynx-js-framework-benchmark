// Typed coordinates for the six-axis design space described by
// Huxpro/octane#204. Missing coordinates mean "unclassified" and are valid;
// partial or free-text coordinates are rejected so an apparently classified
// point can never leak into causal attribution.

export const AXIS_ORDER = [
  'invalidation',
  'recompute',
  'sharing',
  'staging',
  'residency',
  'handover',
];

export const AXIS_VALUES = {
  invalidation: ['runtime', 'compile-time'],
  recompute: ['tree', 'component', 'block', 'slot'],
  sharing: ['none', 'runtime-taught', 'compile-time-data', 'compile-time-code'],
  staging: ['ops', 'data', 'code', 'native'],
  residency: {
    firstFrame: ['background', 'main', 'native'],
    steadyState: ['background', 'main', 'native'],
  },
  handover: ['none', 'tree-description', 'operation-stream', 'data-delta', 'slot-state', 'native'],
};

const isPlainObject = (value) => value != null
  && typeof value === 'object'
  && !Array.isArray(value);

function enumError(entryId, field, value, allowed) {
  return new Error(
    `entry ${entryId}: coordinates.${field} must be one of ${allowed.join(', ')}; got ${JSON.stringify(value)}`,
  );
}

/** Validate a complete coordinate tuple. `null` means deliberately unclassified. */
export function validateCoordinates(coordinates, entryId = '<unknown>') {
  if (coordinates == null) return null;
  if (!isPlainObject(coordinates)) {
    throw new Error(`entry ${entryId}: coordinates must be an object when present`);
  }
  const keys = Object.keys(coordinates).sort();
  const expected = [...AXIS_ORDER].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected)) {
    const missing = AXIS_ORDER.filter((axis) => !Object.hasOwn(coordinates, axis));
    const unknown = keys.filter((axis) => !AXIS_ORDER.includes(axis));
    throw new Error(
      `entry ${entryId}: coordinates must contain exactly all six axes`
      + `${missing.length ? `; missing ${missing.join(', ')}` : ''}`
      + `${unknown.length ? `; unknown ${unknown.join(', ')}` : ''}`,
    );
  }
  for (const axis of AXIS_ORDER) {
    if (axis === 'residency') continue;
    if (!AXIS_VALUES[axis].includes(coordinates[axis])) {
      throw enumError(entryId, axis, coordinates[axis], AXIS_VALUES[axis]);
    }
  }
  const residency = coordinates.residency;
  if (!isPlainObject(residency)
    || Object.keys(residency).sort().join('|') !== 'firstFrame|steadyState') {
    throw new Error(
      `entry ${entryId}: coordinates.residency must contain exactly firstFrame and steadyState`,
    );
  }
  for (const phase of ['firstFrame', 'steadyState']) {
    if (!AXIS_VALUES.residency[phase].includes(residency[phase])) {
      throw enumError(entryId, `residency.${phase}`, residency[phase], AXIS_VALUES.residency[phase]);
    }
  }
  return coordinates;
}

export function coordinateValue(coordinates, axis) {
  if (!coordinates || !AXIS_ORDER.includes(axis)) return null;
  if (axis === 'residency') {
    return `${coordinates.residency.firstFrame}/${coordinates.residency.steadyState}`;
  }
  return coordinates[axis];
}

export function changedAxes(against, candidate) {
  if (!against || !candidate) return [];
  return AXIS_ORDER.filter((axis) =>
    coordinateValue(against, axis) !== coordinateValue(candidate, axis));
}
