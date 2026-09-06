import { qualifyPairedScorecard } from '@lynx-bench/shared/qualification';
import { ROADMAP_SCORECARD } from '@lynx-bench/shared/scorecard';
import { deriveRecord, SCHEMA_VERSION } from '@lynx-bench/shared/schema';

const SUITES = Object.freeze({
  interaction: Object.freeze({
    recordSuite: 'table',
    repetitions: 'table',
    cells: ROADMAP_SCORECARD.suites.interaction.cells,
    matches: (record, cell) => record.workload === cell.workload
      && record.scale === cell.scale
      && record.metric === 'latency',
  }),
  startup: Object.freeze({
    recordSuite: 'startup',
    repetitions: 'startup',
    cells: ROADMAP_SCORECARD.suites.startup.cells,
    matches: (record, cell) => record.workload === cell.workload
      && record.scale === cell.scale
      && record.metric === cell.metric,
  }),
});

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value != null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function recordContract(record) {
  return stable({
    harness: record.harness,
    environment: record.environment,
    suite: record.suite,
    workload: record.workload,
    scale: record.scale,
    metric: record.metric,
    boundary: record.boundary,
    unit: record.unit,
    contractVersion: record.contractVersion ?? null,
    commitPolicy: record.commitPolicy ?? null,
  });
}

function oneCellRecord(run, entry, suite, cell, expectedRepetitions, runIndex) {
  const matches = run.records.filter((record) => record.entry === entry
    && record.suite === suite.recordSuite
    && suite.matches(record, cell));
  if (matches.length !== 1) {
    throw new Error(
      `run ${runIndex} ${entry} ${cell.key} requires exactly one source record; found ${matches.length}.`,
    );
  }
  const source = matches[0];
  if (!Array.isArray(source.samples)) {
    throw new Error(`run ${runIndex} ${entry} ${cell.key} requires raw samples.`);
  }
  if ((source.dnfCount ?? 0) !== 0 || (source.failures?.length ?? 0) !== 0) {
    throw new Error(`run ${runIndex} ${entry} ${cell.key} contains DNF evidence.`);
  }
  if (source.attemptedCount !== expectedRepetitions
    || source.acceptedCount !== expectedRepetitions
    || source.samples.length !== expectedRepetitions) {
    throw new Error(
      `run ${runIndex} ${entry} ${cell.key} does not account for all ${expectedRepetitions} repetitions.`,
    );
  }
  const derived = deriveRecord(source);
  if (typeof derived.median !== 'number' || !Number.isFinite(derived.median)
    || derived.median <= 0) {
    throw new Error(`run ${runIndex} ${entry} ${cell.key} has no positive derived median.`);
  }
  return { source, value: derived.median };
}

function assertRunIdentity(run, { candidate, comparator, runIndex }) {
  if (run?.schemaVersion !== SCHEMA_VERSION || !Array.isArray(run.records)) {
    throw new Error(`run ${runIndex} is not a schema-v${SCHEMA_VERSION} raw run.`);
  }
  const { meta } = run;
  const receipt = meta?.receipt;
  if (receipt?.repository?.dirty !== false) {
    throw new Error(`run ${runIndex} was not produced from a clean benchmark checkout.`);
  }
  if (typeof meta.sessionId !== 'string' || meta.sessionId.length === 0
    || meta.sessionId !== receipt.execution?.sessionId) {
    throw new Error(`run ${runIndex} has missing or inconsistent session identity.`);
  }
  const order = meta.entryOrder;
  if (!Array.isArray(order) || order.length !== 2
    || stable(order) !== stable(receipt.execution?.entryOrder)) {
    throw new Error(`run ${runIndex} has missing or inconsistent two-arm entry order.`);
  }
  const ab = stable([candidate, comparator]);
  const ba = stable([comparator, candidate]);
  const serializedOrder = stable(order);
  if (serializedOrder !== ab && serializedOrder !== ba) {
    throw new Error(
      `run ${runIndex} entry order must contain only candidate and comparator; received ${order.join(', ')}.`,
    );
  }
  if (typeof receipt.comparabilityCohort !== 'string'
    || !receipt.comparabilityCohort.startsWith('sha256:')) {
    throw new Error(`run ${runIndex} has no prospective comparability cohort.`);
  }
  if (meta.entryCommits?.[candidate] == null || meta.entryCommits?.[comparator] == null) {
    throw new Error(`run ${runIndex} is missing candidate/comparator source commits.`);
  }
  return {
    session: meta.sessionId,
    order: serializedOrder === ab ? 'AB' : 'BA',
    cohort: receipt.comparabilityCohort,
    machine: stable(meta.machine),
    harness: receipt.execution.harness,
    commits: stable({
      candidate: meta.entryCommits[candidate],
      comparator: meta.entryCommits[comparator],
    }),
  };
}

export function qualifyRawRuns({ runs, candidate, comparator }) {
  if (!Array.isArray(runs) || runs.length === 0) {
    throw new Error('qualification requires raw runs.');
  }
  if (typeof candidate !== 'string' || candidate.length === 0
    || typeof comparator !== 'string' || comparator.length === 0
    || candidate === comparator) {
    throw new Error('qualification requires distinct candidate and comparator entry IDs.');
  }

  const identities = runs.map((run, runIndex) =>
    assertRunIdentity(run, { candidate, comparator, runIndex }));
  for (const field of ['cohort', 'machine', 'harness', 'commits']) {
    if (new Set(identities.map((identity) => identity[field])).size !== 1) {
      throw new Error(`qualification runs do not share one ${field}.`);
    }
  }

  const suiteResults = {};
  for (const [suiteName, suite] of Object.entries(SUITES)) {
    const pairs = runs.map((run, runIndex) => {
      const expectedRepetitions = run.meta.receipt.sampling?.repetitions?.[suite.repetitions];
      if (!Number.isSafeInteger(expectedRepetitions) || expectedRepetitions <= 0) {
        throw new Error(`run ${runIndex} has no valid ${suite.repetitions} repetition receipt.`);
      }
      const cells = Object.fromEntries(suite.cells.map((cell) => {
        const candidateRecord = oneCellRecord(
          run, candidate, suite, cell, expectedRepetitions, runIndex,
        );
        const comparatorRecord = oneCellRecord(
          run, comparator, suite, cell, expectedRepetitions, runIndex,
        );
        if (recordContract(candidateRecord.source) !== recordContract(comparatorRecord.source)) {
          throw new Error(`run ${runIndex} ${cell.key} arms have different measurement contracts.`);
        }
        return [cell.key, {
          candidate: candidateRecord.value,
          comparator: comparatorRecord.value,
        }];
      }));
      return { session: identities[runIndex].session, order: identities[runIndex].order, cells };
    });
    suiteResults[suiteName] = qualifyPairedScorecard({
      pairs,
      cells: suite.cells,
      minimumPairs: ROADMAP_SCORECARD.statistics.minimumPairs,
      resamples: ROADMAP_SCORECARD.statistics.bootstrapResamples,
      confidence: ROADMAP_SCORECARD.statistics.confidence,
      strictWinUpperRatio: ROADMAP_SCORECARD.statistics.strictWinUpperRatio,
      engineeringPointRatio: ROADMAP_SCORECARD.statistics.engineeringPointRatio,
      coreCellNonInferiorityUpperRatio:
        ROADMAP_SCORECARD.statistics.coreCellNonInferiorityUpperRatio,
      orderBalanceMaximumDifference:
        ROADMAP_SCORECARD.statistics.orderBalanceMaximumDifference,
    });
  }

  return {
    scorecardVersion: ROADMAP_SCORECARD.version,
    candidate,
    comparator,
    harness: identities[0].harness,
    machine: runs[0].meta.machine,
    comparabilityCohort: identities[0].cohort,
    entryCommits: {
      candidate: runs[0].meta.entryCommits[candidate],
      comparator: runs[0].meta.entryCommits[comparator],
    },
    sessions: identities.map(({ session, order }) => ({ session, order })),
    suites: suiteResults,
    pass: Object.values(suiteResults).every((suite) => suite.pass),
  };
}
