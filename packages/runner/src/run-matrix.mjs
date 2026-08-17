import { STARTUP_CASES, TABLE_CASES } from '@lynx-bench/shared/workloads';

const SUITES = new Set(['table', 'startup']);
const CASES_BY_NAME = new Map(TABLE_CASES.map((candidate) => [candidate.name, candidate]));
const STARTUP_SCALES = STARTUP_CASES[0].scales;

function explicitValue(args, key) {
  if (!Object.hasOwn(args, key)) return null;
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`--${key} requires a value`);
  }
  return value;
}

function tokenList(args, key, fallback) {
  const value = explicitValue(args, key);
  if (value == null) return [...fallback];
  const tokens = value.split(',').map((token) => token.trim());
  if (tokens.some((token) => token.length === 0)) {
    throw new Error(`--${key} must not contain blank tokens`);
  }
  if (new Set(tokens).size !== tokens.length) {
    throw new Error(`--${key} must not contain duplicate tokens`);
  }
  return tokens;
}

function positiveInteger(args, key, fallback) {
  const value = explicitValue(args, key);
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`--${key} must be a positive safe integer`);
  }
  return parsed;
}

function scalesForRun(args, fallback) {
  const tokens = tokenList(args, 'scale', fallback.map(String));
  const scales = tokens.map((token) => Number(token));
  if (scales.some((scale) =>
    !Number.isSafeInteger(scale) || scale < 0 || Object.is(scale, -0))) {
    throw new Error('--scale must contain non-negative safe integers');
  }
  if (new Set(scales).size !== scales.length) {
    throw new Error('--scale must not contain duplicate scales');
  }
  return scales;
}

function validateScales(scales, label, { startup = false } = {}) {
  if (!Array.isArray(scales) || scales.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }
  if (scales.some((scale) =>
    !Number.isSafeInteger(scale) || scale < 0 || Object.is(scale, -0))) {
    throw new Error(`${label} must contain non-negative safe integers`);
  }
  if (new Set(scales).size !== scales.length) {
    throw new Error(`${label} must not contain duplicate scales`);
  }
  if (startup && scales.some((scale) => !STARTUP_SCALES.includes(scale))) {
    throw new Error(
      `${label} must be a subset of ${STARTUP_SCALES.join(',')}`,
    );
  }
  return [...scales];
}

function validatePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function canonicalSuites(suites) {
  if (!Array.isArray(suites) || suites.length === 0) {
    throw new Error('suites must be a non-empty array');
  }
  if (new Set(suites).size !== suites.length) {
    throw new Error('suites must not contain duplicates');
  }
  for (const suite of suites) {
    if (typeof suite !== 'string' || suite.length === 0) {
      throw new Error('suites must not contain blank values');
    }
    if (!SUITES.has(suite)) throw new Error(`unknown suite: ${suite}`);
  }
  return [...suites];
}

function canonicalCases(cases, { required }) {
  if (!Array.isArray(cases) || (required && cases.length === 0)) {
    throw new Error(required ? 'cases must be a non-empty array' : 'cases must be an array');
  }
  const names = cases.map((candidate) =>
    typeof candidate === 'string' ? candidate : candidate?.name);
  if (names.some((name) => typeof name !== 'string' || name.length === 0)) {
    throw new Error('cases must not contain blank values');
  }
  if (new Set(names).size !== names.length) {
    throw new Error('cases must not contain duplicates');
  }
  return names.map((name) => {
    const candidate = CASES_BY_NAME.get(name);
    if (!candidate) throw new Error(`unknown case: ${name}`);
    return candidate;
  });
}

export function validateRunMatrix(matrix, harness) {
  if (harness !== 'web' && harness !== 'native') {
    throw new Error(`unknown harness: ${harness}`);
  }
  if (!matrix || typeof matrix !== 'object' || Array.isArray(matrix)) {
    throw new Error('run matrix must be an object');
  }
  if (harness === 'native' && matrix.quick) {
    throw new Error('--quick is not supported by native runs');
  }
  if (harness === 'native' && matrix.stormReps != null) {
    throw new Error('--storm-reps is not supported by native runs');
  }

  const suites = canonicalSuites(matrix.suites);
  const cases = canonicalCases(matrix.cases, { required: suites.includes('table') });
  const scales = validateScales(matrix.scales, 'scales');
  const startupScales = suites.includes('startup')
    ? validateScales(matrix.startupScales, 'startupScales', { startup: true })
    : [];

  if (suites.includes('table')) {
    for (const candidate of cases) {
      if (!candidate.scales.some((scale) => scales.includes(scale))) {
        throw new Error(
          `requested table matrix drops case ${candidate.name}: `
          + 'selected case and scales do not intersect',
        );
      }
    }
  }

  const reps = validatePositiveInteger(matrix.reps, 'reps');
  const startupReps = validatePositiveInteger(matrix.startupReps, 'startupReps');
  const stormReps = harness === 'web'
    ? validatePositiveInteger(matrix.stormReps, 'stormReps')
    : null;

  return {
    cases,
    suites,
    scales,
    startupScales,
    reps,
    startupReps,
    ...(stormReps == null ? {} : { stormReps }),
  };
}

export function resolveRunMatrix(args, harness, { exactStartupScales = false } = {}) {
  if (harness !== 'web' && harness !== 'native') {
    throw new Error(`unknown harness: ${harness}`);
  }
  const quick = harness === 'web' && Boolean(args.quick);
  const suites = tokenList(args, 'suite', ['table', 'startup']);
  const scales = scalesForRun(
    args,
    harness === 'web' && quick ? [1000] : [1000, 10000],
  );
  const explicitCases = Object.hasOwn(args, 'case');
  const caseNames = tokenList(
    args,
    'case',
    TABLE_CASES
      .filter((candidate) =>
        candidate.scales.some((scale) => scales.includes(scale)))
      .map((candidate) => candidate.name),
  );
  if (!explicitCases && !suites.includes('table')) {
    caseNames.length = 0;
  }
  const explicitScales = Object.hasOwn(args, 'scale');
  const startupScales = suites.includes('startup')
    ? (explicitScales || exactStartupScales ? scales : STARTUP_SCALES)
    : [];
  const reps = positiveInteger(args, 'reps', harness === 'native' ? 5 : quick ? 3 : 7);
  const startupReps = positiveInteger(
    args,
    'startup-reps',
    harness === 'native' ? 3 : quick ? 2 : 5,
  );
  const stormReps = positiveInteger(
    args,
    'storm-reps',
    harness === 'web' ? (quick ? 1 : 3) : null,
  );

  return validateRunMatrix({
    cases: caseNames,
    suites,
    scales,
    startupScales,
    reps,
    startupReps,
    stormReps,
    quick,
  }, harness);
}
