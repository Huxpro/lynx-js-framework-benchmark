import { STARTUP_CASES, TABLE_CASES } from '@lynx-bench/shared/workloads';

export const NATIVE_TABLE_SCALES = [...new Set(
  TABLE_CASES.flatMap((kase) => kase.scales),
)].sort((a, b) => a - b);

export const NATIVE_STARTUP_SCALES = [...STARTUP_CASES[0].scales];

function csv(value, name) {
  if (typeof value !== 'string') return null;
  const values = value.split(',').map((item) => item.trim());
  if (values.some((item) => item.length === 0)) {
    throw new Error(`--${name} must not contain blank values.`);
  }
  if (new Set(values).size !== values.length) {
    throw new Error(`--${name} must not contain duplicate values.`);
  }
  return values;
}

function integer(value, name, fallback) {
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive safe integer.`);
  }
  return parsed;
}

function scales(value, name, fallback, allowed) {
  const values = csv(value, name)?.map((item) => Number(item)) ?? [...fallback];
  if (values.some((item) => !Number.isSafeInteger(item) || item < 0)) {
    throw new Error(`--${name} must contain non-negative safe integers.`);
  }
  const unknown = values.filter((item) => !allowed.includes(item));
  if (unknown.length > 0) {
    throw new Error(
      `--${name} contains unsupported scales ${unknown.join(',')}; expected a subset of ${allowed.join(',')}.`,
    );
  }
  return values.sort((a, b) => a - b);
}

export function resolveNativeRunMatrix(args = {}) {
  if (args.quick) throw new Error('--quick is not supported by Native runs.');
  if (args['storm-reps'] != null) {
    throw new Error('--storm-reps is not supported by Native runs; --reps applies to every table cell.');
  }

  const suites = csv(args.suite, 'suite') ?? ['table', 'startup'];
  const unknownSuites = suites.filter((suite) => !['table', 'startup'].includes(suite));
  if (unknownSuites.length > 0) throw new Error(`unknown Native suites: ${unknownSuites.join(',')}`);

  const requestedCases = csv(args.case, 'case');
  const unknownCases = (requestedCases ?? []).filter(
    (name) => !TABLE_CASES.some((kase) => kase.name === name),
  );
  if (unknownCases.length > 0) throw new Error(`unknown Native cases: ${unknownCases.join(',')}`);
  const cases = requestedCases
    ? TABLE_CASES.filter((kase) => requestedCases.includes(kase.name))
    : TABLE_CASES;

  const tableScales = scales(args.scale, 'scale', NATIVE_TABLE_SCALES, NATIVE_TABLE_SCALES);
  const startupScales = scales(
    args['startup-scale'],
    'startup-scale',
    NATIVE_STARTUP_SCALES,
    NATIVE_STARTUP_SCALES,
  );

  if (suites.includes('table')) {
    for (const kase of cases) {
      if (!kase.scales.some((scale) => tableScales.includes(scale))) {
        throw new Error(
          `requested Native table matrix drops case ${kase.name}; `
          + `select at least one of ${kase.scales.join(',')}.`,
        );
      }
    }
  }
  if (suites.includes('startup') && startupScales.length === 0) {
    throw new Error('Native startup suite requires at least one --startup-scale.');
  }

  return {
    suites,
    cases,
    scales: tableScales,
    startupScales,
    reps: integer(args.reps, 'reps', 5),
    startupReps: integer(args['startup-reps'], 'startup-reps', 3),
  };
}
