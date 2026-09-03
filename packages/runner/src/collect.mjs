// Merge run files into results/latest.json. Newest record wins per
// (machine × entry × suite × every comparability dimension, including
// boundary and unit);
// records from different machines coexist, each tagged with its source run and
// calibration. Web weighted comparison records come from one coherent run;
// dedicated exact-observation suites attach their own coherent campaigns without
// entering that matrix.
// Native featured records may come from checkpoints of one campaign, but only
// when every record belongs to the same machine, lease, method and input receipt. Opt-in Lab
// records are separate, explicitly calibrated historical estimates.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  BOUNDARIES,
  comparisonKey,
  deriveRecord,
  LEGACY_SCHEMA_VERSIONS,
  normalizeWebRegime,
  SCHEMA_VERSION,
  webRegimeKey,
} from '@lynx-bench/shared/schema';
import { PAPI_SEGMENTS } from '@lynx-bench/shared/pipeline';
import {
  STORM_SELECT_TICKS,
  STORM_UPDATE_TICKS,
  TABLE_CASES,
} from '@lynx-bench/shared/workloads';
import {
  NATIVE_CAPACITY_SUITE,
  NATIVE_DIAGNOSTIC_ENTRY_ID,
} from '@lynx-bench/shared/native-diagnostic-contract';

import { bundleRecords } from './bundles.mjs';
import { connectorPackageTreesError } from './connector-receipt.mjs';
import { discoverEntries, entrySupportsHarness, repoRoot } from './entries.mjs';
import { assertNativeCoverage, classifyNativeCoverage, nativeCellKey } from './native-coverage.mjs';
import {
  assertPipelineCoverage,
  classifyPipelineCoverage,
} from './pipeline-coverage.mjs';
import {
  NATIVE_SANDBOX_CAMPAIGN_VERSION,
  assertNativeDeviceCohort,
  assertNativeLeaseChain,
  assertNativeMethodRevisionChain,
} from './native-protocol.mjs';
import { stormContractPass } from './storm-contract.mjs';
import {
  materializeRecordOutcomes,
  resolveReportability,
} from './result-json.mjs';
import {
  assertListCoverage,
  buildListCoverage,
  selectListCampaignRecords,
} from './list-coverage.mjs';
import { deriveListRecords } from './list-derivation.mjs';

const recordKey = (machineId, r) =>
  [machineId, r.entry, r.suite, comparisonKey(r)].join('|');

const cellKey = (r) => [r.suite, comparisonKey(r)].join('|');
const DEFAULT_WEB_REGIME_KEY = webRegimeKey({ harness: 'web' });
const isBenchmarkRecord = (r) => !['bundle', 'bundle-scale'].includes(r.suite);
const isRankingEligible = (record) => record.rankingEligible !== false
  && resolveReportability(record)?.status !== 'not-reportable';
const isComparisonVisible = (record) => isRankingEligible(record)
  || record.descriptiveEligible === true
  || record.diagnostic === true
  || resolveReportability(record) != null
  || (record.comparabilityStatus === 'incomplete-work'
    && observationValues(record).length === 0
    && (record.dnfCount ?? 0) > 0);

const STORM_TICKS = new Map([
  ['updateStorm', STORM_UPDATE_TICKS],
  ['selectStorm', STORM_SELECT_TICKS],
]);

const observationValues = (record) => {
  if (Array.isArray(record?.samples)) return record.samples.filter(Number.isFinite);
  if (Number.isFinite(record?.value)) return [record.value];
  if (record?.samples == null && record?.n === 1 && Number.isFinite(record?.median)) {
    return [record.median];
  }
  return [];
};

const operationCellKey = (record) => [
  record.suite,
  record.harness,
  record.environment,
  record.entry,
  record.workload,
  record.scale,
].join('|');

function stormWorkClassification(records, record) {
  const expected = STORM_TICKS.get(record.workload);
  if (expected == null || record.suite !== 'table' || record.harness !== 'web') return null;
  const siblings = records.filter((candidate) => operationCellKey(candidate) === operationCellKey(record));
  const failure = siblings.flatMap((candidate) => candidate.failures ?? [])
    .find((candidate) => candidate.category === 'incomplete-storm-transport');
  if (failure) {
    return {
      status: 'incomplete',
      expectedSequentialCommits: expected,
      observed: failure.evidence ?? null,
    };
  }
  const toMts = observationValues(siblings.find((candidate) => candidate.metric === 'wireToMtsMsgs'));
  const toBts = observationValues(siblings.find((candidate) => candidate.metric === 'wireToBtsMsgs'));
  const observed = {
    toMtsMessages: toMts.length ? { min: Math.min(...toMts), max: Math.max(...toMts) } : null,
    toBtsMessages: toBts.length ? { min: Math.min(...toBts), max: Math.max(...toBts) } : null,
  };
  if (toMts.some((value) => value < expected) || toBts.some((value) => value < expected)) {
    return { status: 'incomplete', expectedSequentialCommits: expected, observed };
  }
  if (toMts.length > 0 && toBts.length > 0) {
    return { status: 'complete', expectedSequentialCommits: expected, observed };
  }
  return { status: 'unverified', expectedSequentialCommits: expected, observed };
}

const pipelineOperationKey = (record) => [
  record.suite,
  record.harness,
  record.environment,
  record.workload,
  record.scale,
].join('|');

const stableJson = (value) => JSON.stringify(value);

const pipelineTimeMetric = (segment) =>
  `papi${segment[0].toUpperCase()}${segment.slice(1)}Time`;

/**
 * Materialize the residual only in the derived dataset. Raw run files retain
 * operation time and host-boundary self-times, never their subtraction.
 */
export function derivePipelineResidualRecords(records) {
  const residuals = [];
  for (const operation of records.filter((record) =>
    record.suite === 'pipeline' && record.metric === 'operationTime')) {
    const siblings = records.filter((candidate) =>
      operationCellKey(candidate) === operationCellKey(operation));
    const segmentRecords = PAPI_SEGMENTS.map((segment) => {
      const metric = pipelineTimeMetric(segment);
      const matches = siblings.filter((candidate) => candidate.metric === metric);
      if (matches.length !== 1) {
        throw new Error(`pipeline operation requires exactly one ${metric} source record`);
      }
      return matches[0];
    });
    const operationSamples = operation.samples ?? [];
    for (const segment of segmentRecords) {
      if (!Array.isArray(segment.samples) || segment.samples.length !== operationSamples.length) {
        throw new Error(`pipeline metric ${segment.metric} must align with operationTime samples`);
      }
      if (stableJson(segment.detailSamples) !== stableJson(operation.detailSamples)) {
        throw new Error(`pipeline metric ${segment.metric} must share operationTime controls`);
      }
    }
    const samples = operationSamples.map((operationMs, index) => {
      const selfMs = segmentRecords.reduce((sum, segment) => sum + segment.samples[index], 0);
      if (!Number.isFinite(operationMs) || !Number.isFinite(selfMs)) {
        throw new Error('pipeline residual inputs must be finite');
      }
      if (selfMs > operationMs + 0.05) {
        throw new Error(`pipeline PAPI self time ${selfMs}ms exceeds operation time ${operationMs}ms`);
      }
      return Math.max(0, operationMs - selfMs);
    });
    residuals.push(deriveRecord({
      ...operation,
      metric: 'outsidePapiTime',
      boundary: BOUNDARIES.pipelineResidual,
      samples,
      detailSamples: operation.detailSamples,
      derivedFrom: {
        kind: 'aligned-sample-subtraction',
        metrics: ['operationTime', ...segmentRecords.map((record) => record.metric)],
      },
    }));
  }
  return [...records, ...residuals];
}

const stormCellKey = (record, includeEntry = true) => [
  record.suite,
  record.harness,
  record.environment,
  includeEntry ? record.entry : null,
  record.workload,
  record.scale,
  record.contractVersion,
  record.commitPolicy,
].join('|');

const STORM_SOURCE_METRICS = [
  'ticksIssued',
  'committedFrames',
  'wireToBtsBytes',
  'wireToBtsMsgs',
  'wireToMtsBytes',
  'wireToMtsMsgs',
];

const stormDeclaredControl = (detail) => detail == null ? null : ({
  contractVersion: detail.contractVersion,
  commitPolicy: detail.commitPolicy,
  ticks: detail.ticks,
  tickIntervalMs: detail.tickIntervalMs,
  scheduleToleranceMs: detail.scheduleToleranceMs,
  mutationWidth: detail.mutationWidth,
  observation: detail.observation,
  action: detail.action,
});

/** Materialize semantic outcomes and per-tick values from aligned raw samples. */
export function deriveStormRecords(records) {
  const derived = [];
  for (const operation of records.filter((record) =>
    record.suite === 'storm' && record.metric === 'operationTime')) {
    const siblings = records.filter((candidate) =>
      stormCellKey(candidate) === stormCellKey(operation));
    const sources = new Map(STORM_SOURCE_METRICS.map((metric) => {
      const matches = siblings.filter((candidate) => candidate.metric === metric);
      if (matches.length !== 1) {
        throw new Error(`storm operation requires exactly one ${metric} source record`);
      }
      return [metric, matches[0]];
    }));
    const operationSamples = operation.samples ?? [];
    if (!Array.isArray(operation.detailSamples)
      || operation.detailSamples.length !== operationSamples.length) {
      throw new Error('storm operation detailSamples must align with source samples');
    }
    for (const source of sources.values()) {
      if (!Array.isArray(source.samples) || source.samples.length !== operationSamples.length) {
        throw new Error(`storm metric ${source.metric} must align with operationTime samples`);
      }
      if (source.detailSamples != null
        && (!Array.isArray(source.detailSamples)
          || source.detailSamples.length !== operationSamples.length)) {
        throw new Error(`storm metric ${source.metric} has misaligned endpoint details`);
      }
    }
    const ticks = sources.get('ticksIssued').samples;
    const frames = sources.get('committedFrames').samples;
    for (let index = 0; index < operationSamples.length; index++) {
      const control = operation.detailSamples[index];
      if (ticks[index] !== control.actualIssueOffsetsMs?.length
        || frames[index] !== control.transitions?.length) {
        throw new Error('storm count metrics disagree with raw schedule/transition evidence');
      }
    }
    const makeDerived = (metric, boundary, unit, samples, sourceMetrics) => {
      derived.push(deriveRecord({
        ...operation,
        metric,
        boundary,
        unit,
        samples,
        detailSamples: operation.detailSamples,
        derivedFrom: { kind: 'aligned-sample-transform', metrics: sourceMetrics },
      }));
    };
    makeDerived(
      'contractPass',
      BOUNDARIES.stormContract,
      'boolean-count',
      operation.detailSamples.map((control) => Number(stormContractPass(control))),
      ['operationTime', 'ticksIssued', 'committedFrames'],
    );
    makeDerived(
      'coalescingRatio',
      BOUNDARIES.stormCoalescing,
      'ratio',
      frames.map((value, index) => value / ticks[index]),
      ['committedFrames', 'ticksIssued'],
    );
    for (const metric of [
      'wireToBtsBytes',
      'wireToBtsMsgs',
      'wireToMtsBytes',
      'wireToMtsMsgs',
    ]) {
      const source = sources.get(metric);
      makeDerived(
        `${metric}PerTick`,
        BOUNDARIES.stormPerTick,
        metric.endsWith('Bytes') ? 'bytes/tick' : 'messages/tick',
        source.samples.map((value, index) => value / ticks[index]),
        [metric, 'ticksIssued'],
      );
    }
  }
  return [...records, ...derived];
}

export function stormContractClassification(records, record) {
  if (record.suite !== 'storm') return null;
  const operations = records.filter((candidate) =>
    candidate.metric === 'operationTime'
    && stormCellKey(candidate) === stormCellKey(record));
  if (operations.length !== 1) {
    return { status: 'invalid', reason: 'storm-operation-source-record-count-invalid' };
  }
  const operation = operations[0];
  const values = observationValues(operation);
  if ((operation.dnfCount ?? 0) > 0) {
    return { status: 'incomplete', reason: 'storm-dnf-observed' };
  }
  if (values.length === 0 || !Array.isArray(operation.detailSamples)
    || operation.detailSamples.length !== values.length) {
    return { status: 'invalid', reason: 'storm-control-sample-count-mismatch' };
  }
  const identities = [];
  const outcomes = [];
  for (const detail of operation.detailSamples) {
    const declared = stormDeclaredControl(detail);
    if (
      !Number.isInteger(declared?.contractVersion)
      || declared.contractVersion !== operation.contractVersion
      || !['every-tick', 'final-state'].includes(declared.commitPolicy)
      || declared.commitPolicy !== operation.commitPolicy
      || !Number.isInteger(declared.ticks)
      || declared.ticks < 1
      || !Number.isFinite(declared.tickIntervalMs)
      || declared.tickIntervalMs < 0
      || !Number.isFinite(declared.scheduleToleranceMs)
      || declared.scheduleToleranceMs < 0
      || declared.mutationWidth == null
      || declared.observation == null
      || declared.action == null
      || !Array.isArray(detail.actualIssueOffsetsMs)
      || detail.actualIssueOffsetsMs.length !== declared.ticks
      || !Array.isArray(detail.transitions)
      || detail.transitions.length > declared.ticks
      || detail.finalState !== detail.expectedFinalState
    ) {
      return { status: 'invalid', reason: 'storm-control-sample-invalid' };
    }
    let previous = -Infinity;
    for (const [index, offset] of detail.actualIssueOffsetsMs.entries()) {
      if (!Number.isFinite(offset) || offset < previous || (index === 0 && offset > 0.05)) {
        return { status: 'invalid', reason: 'storm-input-schedule-invalid' };
      }
      if (index > 0 && offset - previous > declared.tickIntervalMs + declared.scheduleToleranceMs) {
        return { status: 'invalid', reason: 'storm-input-schedule-outside-tolerance' };
      }
      previous = offset;
    }
    previous = -Infinity;
    for (const transition of detail.transitions) {
      if (!Number.isFinite(transition?.atMs)
        || transition.atMs < previous
        || !Number.isInteger(transition.issuedTicks)
        || transition.issuedTicks < 1
        || transition.issuedTicks > declared.ticks) {
        return { status: 'invalid', reason: 'storm-transition-evidence-invalid' };
      }
      previous = transition.atMs;
    }
    identities.push(stableJson(declared));
    outcomes.push(stormContractPass(detail));
  }
  if (new Set(identities).size !== 1) {
    return { status: 'invalid', reason: 'storm-declared-contract-varies-across-samples' };
  }
  const declared = stormDeclaredControl(operation.detailSamples[0]);
  const peers = records.filter((candidate) =>
    candidate.suite === 'storm'
    && candidate.metric === 'operationTime'
    && stormCellKey(candidate, false) === stormCellKey(operation, false));
  const peerIdentities = peers.flatMap((peer) =>
    peer.detailSamples?.[0] ? [stableJson(stormDeclaredControl(peer.detailSamples[0]))] : []);
  if (new Set(peerIdentities).size > 1) {
    return { status: 'invalid', reason: 'storm-declared-contract-mismatch-between-entries' };
  }
  if (outcomes.some((outcome) => !outcome)) {
    return {
      ...declared,
      status: 'contract-failed',
      reason: 'storm-every-tick-observable-commit-contract-failed',
      passedSamples: outcomes.filter(Boolean).length,
      observedSamples: outcomes.length,
    };
  }
  return {
    ...declared,
    status: 'controlled',
    passedSamples: outcomes.length,
    observedSamples: outcomes.length,
  };
}

export function pipelineRecordControl(record) {
  const values = observationValues(record);
  if (values.length === 0) {
    return (record.dnfCount ?? 0) > 0
      ? { status: 'incomplete', reason: 'pipeline-dnf-without-observation' }
      : { status: 'invalid', reason: 'pipeline-has-no-observation-or-dnf' };
  }
  if (!Array.isArray(record.detailSamples) || record.detailSamples.length !== values.length) {
    return { status: 'invalid', reason: 'pipeline-control-sample-count-mismatch' };
  }
  const identities = [];
  for (const detail of record.detailSamples) {
    if (
      !Number.isInteger(detail?.requestedRows)
      || !Number.isInteger(detail?.committedRows)
      || detail.requestedRows !== record.scale
      || detail.callMultiset == null
      || typeof detail.callMultiset !== 'object'
      || !Array.isArray(detail.surfaceNames)
      || !detail.surfaceNames.includes('__FlushElementTree')
    ) {
      return { status: 'invalid', reason: 'pipeline-control-sample-invalid' };
    }
    identities.push(stableJson({
      requestedRows: detail.requestedRows,
      committedRows: detail.committedRows,
      callMultiset: detail.callMultiset,
      surfaceNames: detail.surfaceNames,
    }));
  }
  if (new Set(identities).size !== 1) {
    return { status: 'invalid', reason: 'pipeline-call-or-tree-control-varies-across-samples' };
  }
  const detail = record.detailSamples[0];
  if ((record.dnfCount ?? 0) > 0) {
    return {
      status: 'incomplete',
      reason: 'pipeline-dnf-observed',
      requestedRows: detail.requestedRows,
      committedRows: detail.committedRows,
      callMultiset: detail.callMultiset,
      surfaceNames: detail.surfaceNames,
    };
  }
  return {
    status: 'controlled',
    requestedRows: detail.requestedRows,
    committedRows: detail.committedRows,
    callMultiset: detail.callMultiset,
    surfaceNames: detail.surfaceNames,
  };
}

export function pipelineWorkClassification(records, record) {
  if (record.suite !== 'pipeline') return null;
  const own = pipelineRecordControl(record);
  if (own.status !== 'controlled') return own;

  // Comparison eligibility is conservative at the whole operation cell: if
  // any observed peer committed a different tree size, no segment in that
  // cell is publishable as a cross-entry comparison.
  const peerControls = records
    .filter((candidate) => candidate.suite === 'pipeline'
      && candidate.metric === 'operationTime'
      && pipelineOperationKey(candidate) === pipelineOperationKey(record))
    .map(pipelineRecordControl)
    .filter((control) => control.status === 'controlled');
  if (new Set(peerControls.map((control) => control.requestedRows)).size > 1) {
    return { ...own, status: 'invalid', reason: 'pipeline-requested-tree-mismatch-between-entries' };
  }
  if (new Set(peerControls.map((control) => control.committedRows)).size > 1) {
    return { ...own, status: 'invalid', reason: 'pipeline-committed-tree-mismatch-between-entries' };
  }
  return own;
}

export function samplingProblems(run, record) {
  if (
    !run.meta.receipt
    || !isBenchmarkRecord(record)
    || record.workload === 'memory'
    || record.workload === 'memoryAfterClear'
  ) return [];
  const problems = [];
  const sourceCount = Array.isArray(record.samples)
    ? record.samples.length
    : Number.isFinite(record.value) ? 1 : 0;
  const distribution = record.suite === 'list'
    && record.harness === 'native'
    && record.metric === 'materializationTimesMs'
    && record.observationCardinality === 'many-observations-per-accepted-attempt';
  if (record.suite === 'list'
    && record.harness === 'native'
    && record.metric === 'materializationTimesMs'
    && record.observationCardinality !== 'many-observations-per-accepted-attempt') {
    problems.push('observation-cardinality-invalid');
  }
  if (distribution) {
    if (!Number.isInteger(record.observationCount)
      || record.observationCount !== sourceCount) {
      problems.push('observation-count-mismatch');
    }
    if (record.detailSamples != null
      && (!Array.isArray(record.detailSamples) || record.detailSamples.length !== sourceCount)) {
      problems.push('observation-detail-count-mismatch');
    }
    if (!Number.isInteger(record.acceptedCount) || record.acceptedCount < 0) {
      problems.push('accepted-count-invalid');
    }
  } else if (!Number.isInteger(record.acceptedCount) || record.acceptedCount !== sourceCount) {
    problems.push('accepted-count-mismatch');
  }
  if (!Number.isInteger(record.attemptedCount)
    || record.attemptedCount < (distribution ? record.acceptedCount ?? 0 : sourceCount)) {
    problems.push('attempted-count-invalid');
  }
  if (
    record.metric === 'latency'
    || record.metric === 'fcp'
    || record.metric === 'settled'
    || record.suite === 'list'
    || record.suite === 'pipeline'
    || record.suite === 'storm'
  ) {
    if (Number.isInteger(record.attemptedCount)) {
      const accounted = (distribution ? record.acceptedCount : sourceCount)
        + (record.dnfCount ?? 0);
      if (accounted < record.attemptedCount) problems.push('attempt-accounting-underflow');
      if (accounted > record.attemptedCount) problems.push('attempt-accounting-overflow');
    }
  }
  return problems;
}

function classifyComparability(run, records) {
  const cohort = run.meta.receipt?.comparabilityCohort ?? null;
  return records.map((record) => {
    const work = stormWorkClassification(records, record);
    const pipeline = pipelineWorkClassification(records, record);
    const storm = stormContractClassification(records, record);
    const problems = samplingProblems(run, record);
    const reportability = resolveReportability(record);
    const unthrottledWorkerCpu = record.harness === 'web'
      && record.metric === 'btsCpu'
      && record.cpuThrottle > 1
      && record.throttleScope === 'page-cdp';
    const invalidatedRun = run.meta.measurementValidity?.status === 'invalid-measurement';
    const unverifiedProcessThrottle = record.harness === 'web'
      && record.throttleScope === 'process-cgroup'
      && (!Number.isFinite(record.verifiedSlowdown)
        || record.verifiedSlowdown < record.cpuThrottle - 0.5
        || record.verifiedSlowdown > record.cpuThrottle + 0.5);
    let comparabilityStatus = null;
    const comparabilityReasons = [];
    if (invalidatedRun || unverifiedProcessThrottle) {
      comparabilityStatus = 'invalid-measurement';
      if (invalidatedRun) {
        comparabilityReasons.push(...(
          run.meta.measurementValidity.reasons ?? ['source-run-invalidated']
        ));
      }
      if (unverifiedProcessThrottle) {
        comparabilityReasons.push('process-throttle-slowdown-unverified');
      }
    } else if (unthrottledWorkerCpu) {
      // Emulation.setCPUThrottlingRate is target-scoped. The issue-40 runner
      // applied it to the page target, while lynx-bg runs in a separately
      // attached worker target. Preserve the raw samples as source evidence,
      // but never chart or rank them as throttled BTS CPU.
      comparabilityStatus = 'invalid-measurement';
      comparabilityReasons.push('cpu-throttle-does-not-cover-background-worker');
    } else if (problems.length) {
      comparabilityStatus = 'incompatible-sampling';
      comparabilityReasons.push(...problems);
    }
    if (invalidatedRun || unverifiedProcessThrottle || unthrottledWorkerCpu || problems.length) {
      // Source-integrity failures and measurement invalidation take
      // precedence over any derived work classification.
    } else if (storm?.status === 'invalid') {
      comparabilityStatus = 'incompatible-controls';
      comparabilityReasons.push(storm.reason);
    } else if (storm?.status === 'incomplete') {
      comparabilityStatus = 'incomplete-work';
      comparabilityReasons.push(storm.reason);
    } else if (storm?.status === 'contract-failed') {
      comparabilityStatus = 'contract-failed';
      comparabilityReasons.push(storm.reason);
    } else if (pipeline?.status === 'invalid') {
      comparabilityStatus = 'incompatible-controls';
      comparabilityReasons.push(pipeline.reason);
    } else if (pipeline?.status === 'incomplete') {
      comparabilityStatus = 'incomplete-work';
      comparabilityReasons.push(pipeline.reason);
    } else if (work?.status === 'incomplete') {
      comparabilityStatus = 'incomplete-work';
      comparabilityReasons.push('storm-transport-below-sequential-tick-contract');
    } else if (work?.status === 'unverified') {
      comparabilityStatus = 'unverified-work';
      comparabilityReasons.push('storm-transport-counts-unavailable');
    } else if (work?.status === 'complete') {
      comparabilityStatus = cohort ? 'comparable' : 'legacy-complete-work';
      if (!cohort) comparabilityReasons.push('run-has-no-prospective-receipt');
    } else if (cohort) {
      comparabilityStatus = 'comparable';
    }
    const rankingEligible = reportability?.status !== 'not-reportable'
      && comparabilityStatus !== 'incomplete-work'
      && comparabilityStatus !== 'unverified-work'
      && comparabilityStatus !== 'incompatible-sampling'
      && comparabilityStatus !== 'invalid-measurement'
      && comparabilityStatus !== 'incompatible-controls'
      && comparabilityStatus !== 'contract-failed';
    const descriptiveEligible = comparabilityStatus === 'contract-failed'
      || reportability?.status === 'not-reportable';
    if (comparabilityStatus === null && cohort === null) {
      return { ...record, comparabilityStatus: 'legacy-unverified' };
    }
    return {
      ...record,
      comparabilityStatus: comparabilityStatus ?? 'legacy-unverified',
      ...(comparabilityReasons.length ? { comparabilityReasons } : {}),
      ...(cohort ? { comparabilityCohort: cohort } : {}),
      rankingEligible,
      ...(descriptiveEligible ? { descriptiveEligible: true } : {}),
      ...(work ? { workClassification: work } : {}),
      ...(pipeline ? { pipelineControl: pipeline } : {}),
      ...(storm ? { stormControl: storm } : {}),
    };
  });
}

const HUX1_COMMITS = new Set([
  '99cae97204ff9ef2b0cb00765ee648078d7872e7',
  '4a53620fe811a016cb9966fab53ca181a89159c8',
]);

// Dataset history is editorially explicit. A complete run is necessary but no
// longer sufficient to create a time-machine stop: otherwise retries turn into
// near-duplicate checkpoints. A stop must either establish the peer reference,
// add a public source identity, change the workload contract, or capture a
// material framework-level performance regime change inside an otherwise stable
// cohort. Each checkpoint names one coherent dataset and its exact identities.
export const DATASET_CHECKPOINT_SPECS = [
  {
    id: '2026-08-08-peer-reference',
    label: 'Aug 8 · React/Vue reference',
    description: 'The first retained comparison is a five-entry React/Vue same-run reference with '
      + '90 shared non-storm benchmark cells. An early Octane build was captured in the same raw run, '
      + 'but this stop leaves it as source evidence so the next checkpoint shows Octane entering the '
      + 'ranked cohort instead of silently changing the baseline.',
    webRunFile: '2026-08-08T07-22-33-b0fcfd511132-full.json',
    excludedWorkloads: ['updateStorm', 'selectStorm'],
    minimumBenchmarkCellCount: 90,
    entryIds: [
      'react', 'vue-vdom', 'vue-vdom-ifr-et', 'vue-vapor', 'vue-vapor-ifr',
    ],
  },
  {
    id: '2026-08-10-slow-octane',
    label: 'Aug 10 · slow Octane joins',
    description: 'Upstream Octane e81fd879 enters the five-entry reference cohort. Across 11 shared '
      + 'interaction-latency cells its geomean is 3.91× React; Hux and DOM experiments captured in '
      + 'this run remain source evidence and do not enter this checkpoint.',
    webRunFile: '2026-08-10T21-20-16-65160668d8d9-full-frameworks-65160668d8d9.json',
    excludedWorkloads: ['updateStorm', 'selectStorm'],
    minimumBenchmarkCellCount: 90,
    entryIds: [
      'octane', 'react',
      'vue-vdom', 'vue-vdom-ifr-et', 'vue-vapor', 'vue-vapor-ifr',
    ],
  },
  {
    id: '2026-08-11-octane-step-change',
    label: 'Aug 11 · Octane step change',
    description: 'Upstream Octane moves to 9b147781 while the five peers and 99-cell non-storm matrix '
      + 'stay fixed. Its 11-cell latency geomean falls from 3.91× to 1.32× React (66% lower), '
      + 'making this a material framework change rather than another run.',
    webRunFile: '2026-08-11T13-03-50-65160668d8d9-upstream-main-9b147781-featured.json',
    excludedWorkloads: ['updateStorm', 'selectStorm'],
    minimumBenchmarkCellCount: 90,
    entryIds: [
      'octane', 'react', 'vue-vdom', 'vue-vdom-ifr-et', 'vue-vapor', 'vue-vapor-ifr',
    ],
  },
  {
    id: '2026-08-15-octane-converges',
    label: 'Aug 15 · Octane converges',
    description: 'Upstream Octane advances to 63eb7888 with the same six-entry cohort and 99 shared '
      + 'non-storm cells. Its 11-cell latency geomean reaches 1.14× React, 14% lower than Aug 11; '
      + 'the intermediate 6079a680 run remains source evidence because its additional change was only '
      + 'about 5.5% and changed neither the cohort nor workload contract.',
    webRunFile: '2026-08-15T18-26-24-65160668d8d9-latest-featured-upstream.json',
    excludedWorkloads: ['updateStorm', 'selectStorm'],
    minimumBenchmarkCellCount: 90,
    entryIds: [
      'octane', 'react', 'vue-vdom', 'vue-vdom-ifr-et', 'vue-vapor', 'vue-vapor-ifr',
    ],
  },
  {
    id: '2026-08-22-new-lynx',
    label: 'Aug 22 · Octane (Hux) joins',
    description: 'The cohort expands from six to seven entries with Huxpro/new-lynx fb8426e9 beside '
      + 'upstream Octane 0fc84da0, with 101 shared non-storm benchmark cells. Across the same 11 '
      + 'interaction cells Hux is 0.84× upstream and 0.92× React; this is a source-cohort change, '
      + 'not a date-only rerun.',
    webRunFile: '2026-08-22T03-28-41-65160668d8d9-octane-new-2026-08-22-block-web-rerun.json',
    excludedWorkloads: ['updateStorm', 'selectStorm'],
    minimumBenchmarkCellCount: 100,
    entryIds: [
      'octane', 'octane-hux', 'react',
      'vue-vdom', 'vue-vdom-ifr-et', 'vue-vapor', 'vue-vapor-ifr',
    ],
  },
];

export const HISTORY_REPLAY_SPEC = {
  id: 'web-history-replay-v1',
  label: 'Unified Web replay · 9/9 weighted cells',
  runFile: '2026-08-24T10-08-41-65160668d8d9-history-replay-v1.json',
  minimumReps: 11,
  octaneSources: {
    '2026-08-10-slow-octane': 'octane-prior',
    '2026-08-11-octane-step-change': 'octane-history-9b147781',
    '2026-08-15-octane-converges': 'octane-history-63eb7888',
    '2026-08-22-new-lynx': 'octane-history-0fc84da0',
    'current-main': 'octane',
  },
};

const normalizedEntryId = (run, entry) => {
  if (entry === 'octane-main') return 'octane-prior';
  if (entry === 'octane-hux2' || entry === 'octane-new-2026-08-22') return 'octane-hux';
  if (entry === 'octane' && HUX1_COMMITS.has(run.meta.entryCommits?.octane)) {
    return 'octane-hux1';
  }
  return entry;
};

const normalizeRecord = (run, record) => {
  const entry = normalizedEntryId(run, record.entry);
  const regime = normalizeWebRegime(record);
  // Prospective Web records devote `environment` to the execution-regime
  // object requested by issue #40. The derived dataset retains the historical
  // runtime label for existing site consumers and exposes normalized lane
  // fields alongside it. Native environment strings are never rewritten.
  const withRegime = record.harness === 'web'
    ? {
      ...record,
      environment: typeof record.environment === 'string'
        ? record.environment
        : 'lynx-for-web',
      ...regime,
    }
    : { ...record };
  if (record.harness === 'web') {
    if (regime.jsRegime !== 'jit' && regime.jsRegime !== 'interp') {
      throw new Error(`invalid Web jsRegime: ${regime.jsRegime}`);
    }
    const expectedJsFlags = regime.jsRegime === 'interp'
      ? '--expose-gc,--no-opt,--no-sparkplug,--no-maglev'
      : '--expose-gc';
    if (regime.jsFlags !== expectedJsFlags) {
      throw new Error(`invalid Web jsFlags for ${regime.jsRegime}: ${regime.jsFlags}`);
    }
    if (!Number.isFinite(regime.cpuThrottle) || regime.cpuThrottle < 1) {
      throw new Error(`invalid Web cpuThrottle: ${regime.cpuThrottle}`);
    }
    if (!['none', 'page-cdp', 'process-cgroup'].includes(regime.throttleScope)) {
      throw new Error(`invalid Web throttleScope: ${regime.throttleScope}`);
    }
    if ((regime.cpuThrottle === 1) !== (regime.throttleScope === 'none')) {
      throw new Error(
        `Web throttleScope ${regime.throttleScope} is incompatible with ${regime.cpuThrottle}x CPU`,
      );
    }
  }
  const normalized = entry === record.entry
    ? withRegime
    : { ...withRegime, entry, sourceEntry: record.entry };
  return deriveRecord(normalized);
};

const normalizeRun = (rawRun, file) => {
  if (!rawRun.meta?.machine?.id) throw new Error(`${file}: missing meta.machine.id`);
  if (!rawRun.meta?.generatedAt || Number.isNaN(Date.parse(rawRun.meta.generatedAt))) {
    throw new Error(`${file}: invalid meta.generatedAt`);
  }
  if (!Array.isArray(rawRun.records)) throw new Error(`${file}: records must be an array`);
  const normalizedRecords = rawRun.records.map((record, index) => {
    if (rawRun.schemaVersion === SCHEMA_VERSION && record.harness === 'web') {
      const environment = record.environment;
      if (environment == null || typeof environment !== 'object' || Array.isArray(environment)
        || !Object.hasOwn(environment, 'jsRegime')
        || !Object.hasOwn(environment, 'jsFlags')
        || !Object.hasOwn(environment, 'cpuThrottle')
        || !Object.hasOwn(environment, 'throttleScope')) {
        throw new Error(
          `${file}: schema v${SCHEMA_VERSION} Web record ${index} is missing its environment regime`,
        );
      }
      if (Object.hasOwn(record, 'jsRegime') || Object.hasOwn(record, 'jsFlags')
        || Object.hasOwn(record, 'cpuThrottle') || Object.hasOwn(record, 'throttleScope')) {
        throw new Error(
          `${file}: schema v${SCHEMA_VERSION} Web record ${index} stores its regime outside environment`,
        );
      }
    }
    if (record.harness !== 'web'
      && (record.jsRegime != null || record.jsFlags != null || record.cpuThrottle != null
        || record.throttleScope != null
        || (record.environment != null && typeof record.environment === 'object'))) {
      throw new Error(`${file}: record ${index} attaches a Web JS regime to ${record.harness}`);
    }
    if (record.suite === 'pipeline' && record.metric === 'outsidePapiTime') {
      throw new Error(`${file}: outsidePapiTime is derived and must not be source-authored`);
    }
    if (record.suite === 'storm' && (
      record.metric === 'contractPass'
      || record.metric === 'coalescingRatio'
      || record.metric.endsWith('PerTick')
    )) {
      throw new Error(`${file}: storm outcomes and per-tick metrics must not be source-authored`);
    }
    const hasRepeatedSource = Array.isArray(record.samples);
    const hasScalarSource = typeof record.value === 'number' && Number.isFinite(record.value);
    const hasLegacyScalar = record.samples == null && record.n === 1
      && typeof record.median === 'number' && Number.isFinite(record.median);
    if (!hasRepeatedSource && !hasScalarSource && !hasLegacyScalar && !(record.dnfCount > 0)) {
      throw new Error(`${file}: record ${index} has no samples, value, legacy scalar, or DNF source`);
    }
    if (record.detailSamples != null
      && (!Array.isArray(record.detailSamples) || record.detailSamples.length !== record.samples?.length)) {
      throw new Error(`${file}: record ${index} detailSamples must align with samples`);
    }
    if (record.failures != null && !Array.isArray(record.failures)) {
      throw new Error(`${file}: record ${index} failures must be an array`);
    }
    if (Array.isArray(record.failures) && record.failures.length > (record.dnfCount ?? 0)) {
      throw new Error(`${file}: record ${index} failures cannot exceed dnfCount`);
    }
    return materializeRecordOutcomes(normalizeRecord(rawRun, record), {
      allowInvalidAccounting: true,
    });
  });
  const records = classifyComparability(
    rawRun,
    deriveStormRecords(derivePipelineResidualRecords(normalizedRecords)),
  );
  const seen = new Set();
  for (const record of records) {
    const key = [record.entry, cellKey(record)].join('|');
    if (seen.has(key)) throw new Error(`${file}: duplicate source record ${key}`);
    seen.add(key);
  }
  return { ...rawRun, records };
};

const readEntryTiers = (root) => {
  const entriesDir = path.join(root, 'entries');
  const tiers = new Map();
  for (const dir of fs.readdirSync(entriesDir)) {
    const manifestPath = path.join(entriesDir, dir, 'entry.json');
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    tiers.set(manifest.id, manifest.tier ?? 'featured');
  }
  return tiers;
};

const comparisonRank = (run, featuredIds) => {
  // Fail-closed DNF records remain visible in an exact snapshot, but cannot
  // make a run look broader or more complete during cohort selection.
  const featuredRecords = run.records.filter((r) =>
    featuredIds.has(r.entry) && isBenchmarkRecord(r) && isRankingEligible(r));
  const entries = new Set(featuredRecords.map((r) => r.entry));
  const cellsByEntry = [...entries].map((entry) => new Set(
    featuredRecords.filter((r) => r.entry === entry).map(cellKey),
  ));
  const sharedCells = cellsByEntry.length
    ? [...cellsByEntry[0]].filter((key) => cellsByEntry.every((cells) => cells.has(key))).length
    : 0;
  const minimumCoverage = cellsByEntry.length
    ? Math.min(...cellsByEntry.map((cells) => cells.size))
    : 0;
  const uniqueRecords = new Set(featuredRecords.map((r) => [r.entry, cellKey(r)].join('|'))).size;
  // Prefer broad featured-framework coverage, then the largest balanced matrix.
  // Duplicate records and static bundle snapshots cannot inflate this rank.
  return [entries.size, sharedCells, minimumCoverage, uniqueRecords];
};

const webBundleReceiptMatchesManifest = (run, record, entry) => {
  if (record.harness !== 'web') return false;
  const sourceId = record.sourceEntry ?? record.entry;
  const runBundles = run.meta.receipt?.entryBundles?.[sourceId];
  const manifestBundles = entry.provenance?.sha256;
  if (runBundles == null || typeof runBundles !== 'object' || Array.isArray(runBundles)
    || manifestBundles == null || typeof manifestBundles !== 'object'
    || Array.isArray(manifestBundles)) return false;
  // Native-only or source-only changes may move a commit without changing the
  // measured Web program. Admit that case only when the complete Web artifact
  // set is byte-identical; one missing, extra, or changed bundle fails closed.
  const expected = Object.entries(manifestBundles)
    .filter(([relative]) => relative.endsWith('.web.bundle'));
  const observed = Object.entries(runBundles)
    .filter(([relative]) => relative.endsWith('.web.bundle'));
  return expected.length > 0
    && observed.length === expected.length
    && expected.every(([relative, sha256]) => runBundles[relative] === sha256);
};

const entryIdentityMatchesManifest = (run, record, entryById) => {
  const entry = entryById.get(record.entry);
  if (!entry) return true;
  const sourceId = record.sourceEntry ?? record.entry;
  const runCommit = run.meta.entryCommits?.[sourceId];
  const manifestCommit = entry.provenance?.commit;
  return Boolean(runCommit && manifestCommit && runCommit === manifestCommit)
    || webBundleReceiptMatchesManifest(run, record, entry);
};

const isPublishableRecord = (run, record) => !(
  record.harness === 'native'
  && record.entry === 'octane'
  && (
    run.meta.machine?.octaneTriggerMode === 'driver'
    || record.boundary === 'native-devtool-driver-handler-to-second-native-frame'
  )
);

const nativeCohortIdentity = (run, environment) => {
  const campaign = run.meta.campaign;
  const machine = run.meta.machine;
  const inputConnectorPackageTrees = run.meta.inputReceipt?.connectorPackageTrees;
  const machineConnectorPackageTrees = machine?.connectorPackageTrees;
  if (
    campaign?.version !== NATIVE_SANDBOX_CAMPAIGN_VERSION
    || !campaign?.id
    || !campaign?.matrixContractSha256
    || !campaign?.inputReceiptSha256
    || !campaign?.connectorPackageTreesSha256
    || !machine?.id
    || !machine?.deviceLeaseId
    || !machine?.deviceCohortId
    || !machine?.harnessConfigId
    || !machine?.connectorPackageTreesSha256
    || !environment
  ) return null;
  let leaseChain;
  let methodRevisionChain = null;
  let deviceCohort;
  try {
    leaseChain = assertNativeLeaseChain(run.meta.leaseChain);
    if (run.meta.methodRevisionChain != null) {
      methodRevisionChain = assertNativeMethodRevisionChain(run.meta.methodRevisionChain);
    }
    deviceCohort = assertNativeDeviceCohort(run.meta.deviceCohort);
    assertNativeDeviceCohort(machine.deviceCohort);
  } catch {
    return null;
  }
  if (connectorPackageTreesError(inputConnectorPackageTrees) !== null) return null;
  if (connectorPackageTreesError(machineConnectorPackageTrees) !== null) return null;
  if (run.meta.matrixContract?.sha256 !== campaign.matrixContractSha256) return null;
  if (run.meta.inputReceipt?.sha256 !== campaign.inputReceiptSha256) return null;
  if (inputConnectorPackageTrees.sha256 !== campaign.connectorPackageTreesSha256) return null;
  if (machine.campaignId !== campaign.id) return null;
  if (machine.matrixContractSha256 !== campaign.matrixContractSha256) return null;
  if (machine.inputReceiptSha256 !== campaign.inputReceiptSha256) return null;
  if (machine.connectorPackageTreesSha256 !== campaign.connectorPackageTreesSha256) return null;
  if (JSON.stringify(machineConnectorPackageTrees) !== JSON.stringify(inputConnectorPackageTrees)) {
    return null;
  }
  if (JSON.stringify(machine.deviceCohort) !== JSON.stringify(deviceCohort)) return null;
  if (machine.deviceCohortId !== deviceCohort.id) return null;
  if (leaseChain.serialSha256 !== deviceCohort.serialSha256) return null;
  const leaseIds = new Set(leaseChain.receipts.map((receipt) => receipt.deviceLeaseId));
  if (!leaseIds.has(machine.deviceLeaseId)) return null;
  const cellLeaseIds = run.meta.cellLeaseIds;
  if (cellLeaseIds === null || typeof cellLeaseIds !== 'object' || Array.isArray(cellLeaseIds)) {
    return null;
  }
  const revisionIds = new Set(methodRevisionChain?.revisions.map(({ id }) => id) ?? []);
  const cellMethodRevisionIds = run.meta.cellMethodRevisionIds;
  if (methodRevisionChain != null
    && (cellMethodRevisionIds === null || typeof cellMethodRevisionIds !== 'object'
      || Array.isArray(cellMethodRevisionIds))) return null;
  if (methodRevisionChain != null
    && JSON.stringify(methodRevisionChain.revisions[0].inputReceipt)
      !== JSON.stringify(run.meta.inputReceipt)) return null;
  const nativeRecords = run.records.filter((candidate) => candidate.harness === 'native');
  if (methodRevisionChain != null
    && Object.keys(cellMethodRevisionIds).length !== nativeRecords.length) return null;
  for (const record of nativeRecords) {
    const key = nativeCellKey(record);
    if (!leaseIds.has(cellLeaseIds[key])) return null;
    if (methodRevisionChain != null && !revisionIds.has(cellMethodRevisionIds[key])) return null;
  }
  const stableIdentity = [
    deviceCohort.id,
    environment,
    machine.harnessConfigId,
    campaign.id,
    campaign.matrixContractSha256,
    campaign.inputReceiptSha256,
    campaign.connectorPackageTreesSha256,
  ].join('|');
  return { stableIdentity, deviceCohort, leaseChain, methodRevisionChain };
};

function mergeLeaseChains(left, right) {
  const leftReceipts = assertNativeLeaseChain(left).receipts;
  const rightReceipts = assertNativeLeaseChain(right).receipts;
  const prefixLength = Math.min(leftReceipts.length, rightReceipts.length);
  for (let index = 0; index < prefixLength; index++) {
    if (JSON.stringify(leftReceipts[index]) !== JSON.stringify(rightReceipts[index])) {
      throw new Error(`forked Native lease chains at receipt ${index}.`);
    }
  }
  return leftReceipts.length >= rightReceipts.length ? left : right;
}

function mergeMethodRevisionChains(left, right) {
  if (left == null) return right;
  if (right == null) return left;
  const leftRevisions = assertNativeMethodRevisionChain(left).revisions;
  const rightRevisions = assertNativeMethodRevisionChain(right).revisions;
  const prefixLength = Math.min(leftRevisions.length, rightRevisions.length);
  for (let index = 0; index < prefixLength; index++) {
    if (JSON.stringify(leftRevisions[index]) !== JSON.stringify(rightRevisions[index])) {
      throw new Error(`forked Native method revision chains at revision ${index}.`);
    }
  }
  return leftRevisions.length >= rightRevisions.length ? left : right;
}

const comparisonView = (run, featuredIds, entryById, harness) => ({
  ...run,
  records: run.records.filter((record) => featuredIds.has(record.entry)
    && isBenchmarkRecord(record)
    // Exact-observation suites have dedicated selectors below. They are
    // descriptive evidence and must never replace or inflate the main
    // table/startup comparison cohort.
    && !['pipeline', 'storm', 'list'].includes(record.suite)
    && record.harness === harness
    && isComparisonVisible(record)
    && isPublishableRecord(run, record)
    && entryIdentityMatchesManifest(run, record, entryById)),
});

const currentPipelineCampaign = (runs, featuredIds, entryById) => {
  let selected = null;
  const entries = [...featuredIds].map((id) => entryById.get(id)).filter(Boolean);
  for (const candidate of runs) {
    const records = candidate.run.records.filter((record) =>
      featuredIds.has(record.entry)
      && record.harness === 'web'
      && record.suite === 'pipeline'
      && isBenchmarkRecord(record)
      && isPublishableRecord(candidate.run, record));
    if (!records.length) continue;
    const coverage = classifyPipelineCoverage({
      entries,
      sourceRecords: records,
      publishedRecords: records,
    });
    try {
      assertPipelineCoverage(coverage);
    } catch {
      continue;
    }
    const score = [candidate.run.meta.generatedAt ?? candidate.file, candidate.file];
    if (!selected || score[0] > selected.score[0]
      || (score[0] === selected.score[0] && score[1] > selected.score[1])) {
      selected = { ...candidate, records, coverage, score };
    }
  }
  return selected;
};

const currentStormCampaigns = (runs, featuredIds, entryById) => {
  const selected = new Map();
  for (const candidate of runs) {
    const records = candidate.run.records.filter((record) =>
      featuredIds.has(record.entry)
      && record.harness === 'web'
      && record.suite === 'storm'
      && isBenchmarkRecord(record)
      && isComparisonVisible(record)
      && isPublishableRecord(candidate.run, record));
    for (const environment of new Set(records.map((record) => record.environment))) {
      const environmentRecords = records.filter((record) => record.environment === environment);
      for (const commitPolicy of new Set(environmentRecords.map((record) =>
        record.commitPolicy ?? null))) {
        const campaignRecords = environmentRecords.filter((record) =>
          (record.commitPolicy ?? null) === commitPolicy);
        const key = `${environment}:${commitPolicy ?? 'none'}`;
        const score = [
          new Set(campaignRecords.map((record) => record.entry)).size,
          new Set(campaignRecords.map(cellKey)).size,
          candidate.run.meta.generatedAt ?? candidate.file,
          candidate.file,
        ];
        const current = selected.get(key);
        if (!current || score[0] > current.score[0]
          || (score[0] === current.score[0] && score[1] > current.score[1])
          || (score[0] === current.score[0] && score[1] === current.score[1]
            && (score[2] > current.score[2]
              || (score[2] === current.score[2] && score[3] > current.score[3])))) {
          selected.set(key, { ...candidate, records: campaignRecords, score });
        }
      }
    }
  }
  return [...selected.values()];
};

const isBetterComparisonRun = (candidate, current, featuredIds) => {
  if (!current) return true;
  const a = comparisonRank(candidate.run, featuredIds);
  const b = comparisonRank(current.run, featuredIds);
  const candidateTime = candidate.run.meta.generatedAt ?? candidate.file;
  const currentTime = current.run.meta.generatedAt ?? current.file;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return candidateTime > currentTime
    || (candidateTime === currentTime && candidate.file > current.file);
};

const selectNativeCohort = (runs, featuredIds, entryById) => {
  const groups = new Map();
  for (const candidate of runs) {
    const records = comparisonView(candidate.run, featuredIds, entryById, 'native').records;
    for (const environment of new Set(records.map((record) => record.environment))) {
      const campaign = candidate.run.meta.campaign;
      const identity = nativeCohortIdentity(candidate.run, environment);
      // Legacy runs predate explicit lease, campaign and immutable input
      // receipts. They stay archived, but cannot supply ranked comparisons.
      if (identity == null) continue;
      const groupKey = identity.stableIdentity;
      const group = groups.get(groupKey) ?? {
        machineId: identity.deviceCohort.id,
        deviceCohortId: identity.deviceCohort.id,
        deviceCohort: identity.deviceCohort,
        environment,
        stableCohortIdentity: identity.stableIdentity,
        leaseChain: identity.leaseChain,
        methodRevisionChain: identity.methodRevisionChain,
        campaign,
        entries: new Map(),
        invalidOverlap: false,
        invalidLeaseChain: false,
        invalidMethodRevisionChain: false,
        sourceFiles: new Set(),
      };
      group.sourceFiles.add(candidate.file);
      try {
        group.leaseChain = mergeLeaseChains(group.leaseChain, identity.leaseChain);
      } catch {
        group.invalidLeaseChain = true;
      }
      try {
        group.methodRevisionChain = mergeMethodRevisionChains(
          group.methodRevisionChain, identity.methodRevisionChain,
        );
      } catch {
        group.invalidMethodRevisionChain = true;
      }
      for (const entry of new Set(records
        .filter((record) => record.environment === environment)
        .map((record) => record.entry))) {
        const entryCohort = group.entries.get(entry) ?? { cells: new Map(), latest: null };
        const candidateTime = candidate.run.meta.generatedAt ?? candidate.file;
        for (const record of records.filter((record) => record.environment === environment
          && record.entry === entry)) {
          const key = cellKey(record);
          const current = entryCohort.cells.get(key);
          if (current != null) {
            group.invalidOverlap = true;
          } else {
            entryCohort.cells.set(key, { ...candidate, record });
          }
        }
        entryCohort.latest = entryCohort.latest == null || candidateTime > entryCohort.latest
          ? candidateTime
          : entryCohort.latest;
        group.entries.set(entry, entryCohort);
      }
      groups.set(groupKey, group);
    }
  }

  const archiveOnlyFiles = new Set();
  let selected = null;
  let selectedRank = null;
  for (const group of groups.values()) {
    if (group.invalidOverlap || group.invalidLeaseChain || group.invalidMethodRevisionChain) {
      for (const file of group.sourceFiles) archiveOnlyFiles.add(file);
      continue;
    }
    const groupRecords = [...group.entries.values()].flatMap((entry) =>
      [...entry.cells.values()].map((source) => source.record));
    try {
      assertNativeCoverage(classifyNativeCoverage({
        entries: [...featuredIds].map((id) => entryById.get(id)).filter(Boolean),
        sourceRecords: groupRecords,
      }));
    } catch {
      continue;
    }
    const entries = [...group.entries.values()];
    const cellsByEntry = entries.map((entry) => new Set(entry.cells.keys()));
    const sharedCells = cellsByEntry.length
      ? [...cellsByEntry[0]].filter((key) => cellsByEntry.every((cells) => cells.has(key))).length
      : 0;
    const minimumCoverage = cellsByEntry.length
      ? Math.min(...cellsByEntry.map((cells) => cells.size))
      : 0;
    const recordCount = entries.reduce((sum, entry) => sum + entry.cells.size, 0);
    const latest = entries.reduce((value, entry) =>
      value == null || entry.latest > value ? entry.latest : value, null);
    const rank = [entries.length, sharedCells, minimumCoverage, recordCount];
    const better = !selectedRank || rank.some((value, index) => value !== selectedRank[index]
      && rank.slice(0, index).every((prefix, prefixIndex) => prefix === selectedRank[prefixIndex])
      && value > selectedRank[index]);
    if (better || (rank.every((value, index) => value === selectedRank?.[index])
      && latest > selected.latest)) {
      selected = {
        ...group,
        latest,
        cohortIdentity: [
          group.stableCohortIdentity,
          group.leaseChain.sha256,
          group.methodRevisionChain?.sha256,
        ].filter(Boolean).join('|'),
      };
      selectedRank = rank;
    }
  }
  return { selected, archiveOnlyFiles };
};

const selectNativeObservations = (
  runs, featuredIds, entryById, nativeCohort, archiveOnlyFiles = new Set(),
) => {
  const cohortEntries = new Set(nativeCohort?.entries.keys() ?? []);
  const observations = [];
  const records = [];
  for (const entryId of featuredIds) {
    if (cohortEntries.has(entryId)) continue;
    let selected = null;
    for (const candidate of runs) {
      if (archiveOnlyFiles.has(candidate.file)) continue;
      const candidateRecords = comparisonView(
        candidate.run,
        featuredIds,
        entryById,
        'native',
      ).records.filter((record) => record.entry === entryId);
      for (const environment of new Set(candidateRecords.map((record) => record.environment))) {
        const environmentRecords = candidateRecords.filter((record) =>
          record.environment === environment);
        if (environmentRecords.length === 0) continue;
        const candidateTime = candidate.run.meta.generatedAt ?? candidate.file;
        if (
          !selected
          || environmentRecords.length > selected.records.length
          || (environmentRecords.length === selected.records.length
            && (candidateTime > selected.time
              || (candidateTime === selected.time && candidate.file > selected.file)))
        ) {
          selected = {
            ...candidate,
            environment,
            records: environmentRecords,
            time: candidateTime,
          };
        }
      }
    }
    if (!selected) continue;
    const annotated = selected.records.map((record) =>
      annotate(selected.run, selected.file, record, 'isolated-observation'));
    observations.push({
      entryId,
      harness: 'native',
      environment: selected.environment,
      generatedAt: selected.run.meta.generatedAt,
      machineId: selected.run.meta.machine.id,
      sourceRunFile: selected.file,
      sourceRecordCount: annotated.length,
    });
    records.push(...annotated);
  }
  return { observations, records };
};

const selectDiagnosticNativeObservations = (records, listSourceRecords, entries) => {
  const diagnosticEntries = entries.filter((entry) => entry.tier === 'lab'
    && entry.id === NATIVE_DIAGNOSTIC_ENTRY_ID
    && entry.harnesses?.length === 1
    && entry.harnesses[0] === 'native');
  const currentCommits = new Map(diagnosticEntries.map((entry) => [
    entry.id, entry.provenance?.commit ?? null,
  ]));
  const matchesCurrentDiagnostic = (record) => currentCommits.has(record.entry)
    && (record.entryCommit == null
      || currentCommits.get(record.entry) == null
      || record.entryCommit === currentCommits.get(record.entry))
    && record.harness === 'native';
  const capacityCandidates = records.filter((record) => matchesCurrentDiagnostic(record)
    && record.suite === NATIVE_CAPACITY_SUITE);
  const selectedListCandidates = listSourceRecords.filter(matchesCurrentDiagnostic);
  const candidates = [...capacityCandidates, ...selectedListCandidates];
  const groups = new Map();
  for (const record of candidates) {
    const key = `${record.entry}|${record.suite}|${record.runFile}`;
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  const selectedGroups = new Map();
  for (const group of groups.values()) {
    const first = group[0];
    const key = `${first.entry}|${first.suite}`;
    const prior = selectedGroups.get(key);
    const order = `${first.runGeneratedAt ?? ''}|${first.runFile ?? ''}`;
    const priorOrder = prior == null
      ? null
      : `${prior[0].runGeneratedAt ?? ''}|${prior[0].runFile ?? ''}`;
    if (prior == null || order > priorOrder) selectedGroups.set(key, group);
  }
  const observations = [];
  const selectedRecords = [];
  for (const group of selectedGroups.values()) {
    const first = group[0];
    observations.push({
      entryId: first.entry,
      harness: 'native',
      environment: first.environment,
      generatedAt: first.runGeneratedAt,
      machineId: first.machineId,
      sourceRunFile: first.runFile,
      sourceRecordCount: group.length,
      kind: first.suite === NATIVE_CAPACITY_SUITE ? 'capacity' : 'list',
    });
    selectedRecords.push(...group);
  }
  return { observations, records: selectedRecords };
};

const annotate = (run, file, record, comparisonKind = 'archive') => ({
  ...record,
  machineId: run.meta.machine.id,
  runFile: file,
  runGeneratedAt: run.meta.generatedAt,
  calibration: run.meta.calibration,
  entryCommit: run.meta.entryCommits?.[record.sourceEntry ?? record.entry] ?? null,
  comparisonKind,
});

// Raw pipeline files deliberately repeat controls beside every source metric
// so each record is independently auditable. The materialized site dataset is
// not another source archive: keep full controls on operationTime, then retain
// only aligned samples/accounting on its segment and residual siblings.
const compactPipelineOutputRecord = (record) => {
  if (record.suite !== 'pipeline') return record;
  if (record.metric === 'operationTime') {
    const compactDetail = (detail) => {
      if (detail == null) return detail;
      const { surfaceNames: _surfaceNames, ...rest } = detail;
      return rest;
    };
    return {
      ...record,
      detail: compactDetail(record.detail),
      detailSamples: record.detailSamples?.map(compactDetail) ?? record.detailSamples,
    };
  }
  const {
    detail: _detail,
    detailSamples: _detailSamples,
    pipelineControl: _pipelineControl,
    ...compact
  } = record;
  return compact;
};

const annotateStatic = (entry, record) => ({
  ...deriveRecord(record),
  machineId: null,
  runFile: null,
  runGeneratedAt: entry.provenance?.builtAt ?? null,
  calibration: null,
  entryCommit: entry.provenance?.commit ?? null,
  comparisonKind: 'derived-static',
});

const historyId = (generatedAt, sourceFiles) => {
  const stamp = generatedAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const hash = crypto.createHash('sha256').update(sourceFiles.join('\n')).digest('hex').slice(0, 8);
  return `${stamp}-${hash}`;
};

const publicHistoryEntry = (run, record) => {
  const sourceEntry = record.sourceEntry ?? record.entry;
  if (sourceEntry === 'octane-main') return 'octane';
  if (record.entry === 'octane' && !HUX1_COMMITS.has(run.meta.entryCommits?.octane)) return 'octane';
  return record.entry;
};

const sourceCommit = (run, record) =>
  run.meta.entryCommits?.[record.sourceEntry ?? record.entry] ?? null;

const exactObservationHistoryFields = (record) => ({
  ...(record.attemptedCount != null ? { attemptedCount: record.attemptedCount } : {}),
  ...(record.acceptedCount != null ? { acceptedCount: record.acceptedCount } : {}),
  ...(record.observationCount != null ? { observationCount: record.observationCount } : {}),
  ...(record.outcomeCounts != null ? { outcomeCounts: record.outcomeCounts } : {}),
  ...(record.reportability != null ? { reportability: record.reportability } : {}),
  ...(record.presentationStatus != null
    ? { presentationStatus: record.presentationStatus } : {}),
  ...(record.measurementStatus != null ? { measurementStatus: record.measurementStatus } : {}),
  ...(record.notMeasuredCount != null ? { notMeasuredCount: record.notMeasuredCount } : {}),
  ...(record.notMeasuredReason != null ? { notMeasuredReason: record.notMeasuredReason } : {}),
  ...(['pipeline', 'storm'].includes(record.suite) ? {
    samples: record.samples,
    ...(record.metric === 'operationTime' ? { detailSamples: record.detailSamples } : {}),
    ...(record.derivedFrom ? { derivedFrom: record.derivedFrom } : {}),
    ...(record.comparabilityReasons?.length
      ? { comparabilityReasons: record.comparabilityReasons } : {}),
    ...(record.comparabilityCohort != null
      ? { comparabilityCohort: record.comparabilityCohort } : {}),
    ...(record.workClassification ? { workClassification: record.workClassification } : {}),
    ...(record.pipelineControl ? { pipelineControl: record.pipelineControl } : {}),
    ...(record.stormControl ? { stormControl: record.stormControl } : {}),
  } : {}),
});

const stormTransportEvidence = (run, record) => {
  if (record.harness !== 'web' || record.metric !== 'latency'
    || !['updateStorm', 'selectStorm'].includes(record.workload)) return null;
  const expectedSequentialCommits = record.workload === 'updateStorm' ? 50 : 30;
  const findMessages = (metric) => run.records.find((candidate) =>
    candidate.entry === record.entry
    && candidate.suite === record.suite
    && candidate.harness === record.harness
    && candidate.environment === record.environment
    && candidate.jsRegime === record.jsRegime
    && candidate.jsFlags === record.jsFlags
    && candidate.cpuThrottle === record.cpuThrottle
    && candidate.throttleScope === record.throttleScope
    && candidate.workload === record.workload
    && candidate.scale === record.scale
    && candidate.metric === metric)?.median ?? null;
  const toMtsMessages = findMessages('wireToMtsMsgs');
  const toBtsMessages = findMessages('wireToBtsMsgs');
  if (toMtsMessages == null || toBtsMessages == null) return {
    comparable: false,
    issue: 'missing-storm-transport-evidence',
    expectedSequentialCommits,
    toMtsMessages,
    toBtsMessages,
  };
  return {
    comparable: toMtsMessages >= expectedSequentialCommits
      && toBtsMessages >= expectedSequentialCommits,
    issue: toMtsMessages >= expectedSequentialCommits && toBtsMessages >= expectedSequentialCommits
      ? null
      : 'incomplete-storm-transport',
    expectedSequentialCommits,
    toMtsMessages,
    toBtsMessages,
  };
};

const historyRecord = (run, file, record, comparisonKind, cohortId) => {
  const presented = materializeRecordOutcomes(record, {
    publicBoundary: true,
    allowInvalidAccounting: true,
  });
  record = presented;
  const sourceEntry = record.sourceEntry ?? record.entry;
  const entry = publicHistoryEntry(run, record);
  const transport = stormTransportEvidence(run, record);
  return {
    suite: record.suite,
    harness: record.harness,
    environment: record.environment,
    jsRegime: record.jsRegime,
    jsFlags: record.jsFlags,
    cpuThrottle: record.cpuThrottle,
    throttleScope: record.throttleScope,
    entry,
    ...(sourceEntry === entry ? {} : { sourceEntry }),
    workload: record.workload,
    scale: record.scale,
    ...(record.contractVersion != null ? { contractVersion: record.contractVersion } : {}),
    ...(record.commitPolicy != null ? { commitPolicy: record.commitPolicy } : {}),
    metric: record.metric,
    boundary: record.boundary,
    unit: record.unit,
    n: record.n,
    median: record.median,
    ci95: record.ci95,
    dnfCount: record.dnfCount,
    detail: ['pipeline', 'storm'].includes(record.suite) && record.metric !== 'operationTime'
      ? null
      : record.detail,
    detailKind: record.detailKind,
    ...(record.failures?.length ? { failures: record.failures } : {}),
    machineId: run.meta.machine.id,
    runFile: file,
    runGeneratedAt: run.meta.generatedAt,
    entryCommit: sourceCommit(run, record),
    comparisonKind,
    cohortId,
    rankEligible: isRankingEligible(record) && (transport?.comparable ?? true),
    ...(record.descriptiveEligible ? { descriptiveEligible: true } : {}),
    ...(record.comparabilityStatus ? { comparabilityStatus: record.comparabilityStatus } : {}),
    ...(transport ? { transport } : {}),
    ...exactObservationHistoryFields(record),
  };
};

const historySourceSummary = ({ file, run }, recordCount, entryIds, rankEligible, reason) => ({
  runFile: file,
  generatedAt: run.meta.generatedAt,
  machineId: run.meta.machine.id,
  harnesses: [...new Set(run.records.map((record) => record.harness))].sort(),
  environments: [...new Set(run.records.map((record) => record.environment))].sort(),
  regimes: [...new Set(run.records.filter((record) => record.harness === 'web')
    .map(webRegimeKey))].sort(),
  entryIds: [...entryIds].sort(),
  entryCommits: Object.fromEntries(Object.entries(run.meta.entryCommits ?? {}).sort()),
  machine: run.meta.machine,
  calibration: run.meta.calibration,
  sourceRecordCount: run.records.length,
  historyRecordCount: recordCount,
  rankEligible,
  reason,
});

const requestsFullWebMatrix = (run) => !['--suite', '--case', '--scale', '--commit'].some((option) =>
  run.meta.argv?.some((argument) => argument === option || argument.startsWith(`${option}=`)));

const identityPointers = (checkpointRecords, entryById) => {
  const pointers = new Map();
  for (const record of checkpointRecords) {
    if (!isBenchmarkRecord(record) || pointers.has(record.entry)) continue;
    const entry = entryById.get(record.entry);
    const sourceEntry = entryById.get(record.sourceEntry ?? record.entry) ?? entry;
    const commit = record.entryCommit ?? null;
    const sourceMatchesCommit = sourceEntry?.provenance?.commit === commit;
    const source = sourceEntry?.provenance?.source ?? null;
    const manifestVersion = sourceEntry?.frameworkVersion ?? null;
    pointers.set(record.entry, {
      entryId: record.entry,
      sourceEntryId: record.sourceEntry ?? record.entry,
      label: entry?.label ?? record.entry,
      framework: entry?.framework ?? null,
      version: sourceMatchesCommit ? manifestVersion : null,
      commit,
      source,
      ref: sourceEntry?.provenance?.ref ?? null,
      href: source && commit ? `${source}/commit/${commit}` : source,
      channel: sourceEntry?.historyChannel ?? null,
      config: sourceMatchesCommit ? (sourceEntry?.config ?? null) : null,
      configuration: sourceMatchesCommit ? (sourceEntry?.configuration ?? null) : null,
    });
  }
  return [...pointers.values()];
};

const completeMatrixRecords = (candidateRecords, entryIds) => {
  const ids = new Set(entryIds);
  const eligible = candidateRecords.filter((record) =>
    ids.has(record.entry) && isRankingEligible(record));
  const cellsByEntry = [...ids].map((entry) => new Set(
    eligible.filter((record) => record.entry === entry).map(cellKey),
  ));
  if (cellsByEntry.length === 0 || cellsByEntry.some((cells) => cells.size === 0)) return [];
  const completeCells = cellsByEntry.slice(1).reduce((common, cells) => new Set(
    [...common].filter((key) => cells.has(key)),
  ), cellsByEntry[0]);
  return eligible.filter((record) => completeCells.has(cellKey(record)));
};

const historyReplayCellKey = (record) => `${record.workload}@${record.scale}`;
const HISTORY_REPLAY_CELLS = TABLE_CASES.flatMap((kase) =>
  kase.scales
    .filter((scale) => scale === 1000 || scale === 10000)
    .map((scale) => `${kase.name}@${scale}`));

const buildHistoryReplays = ({ runs, checkpoints }) => {
  const candidate = runs.find(({ file }) => file === HISTORY_REPLAY_SPEC.runFile);
  if (!candidate) return [];
  const { file, run } = candidate;
  const environment = run.records.find((record) =>
    record.harness === 'web' && record.suite === 'table')?.environment ?? null;
  const replayRecords = run.records.filter((record) =>
    record.harness === 'web'
    && record.suite === 'table'
    && record.metric === 'latency'
    && HISTORY_REPLAY_CELLS.includes(historyReplayCellKey(record)));
  const records = [];
  const replayCheckpoints = [];

  for (const checkpoint of checkpoints) {
    const cohort = checkpoint.harnesses.find((item) => item.harness === 'web');
    if (!cohort) continue;
    const sourceByEntry = Object.fromEntries(cohort.entryIds.map((entryId) => [
      entryId,
      entryId === 'octane'
        ? HISTORY_REPLAY_SPEC.octaneSources[checkpoint.id]
        : entryId,
    ]));
    if (cohort.entryIds.includes('octane') && !sourceByEntry.octane) {
      throw new Error(`history replay has no Octane source for ${checkpoint.id}`);
    }
    const replayCommitMismatch = Object.entries(sourceByEntry).find(([entryId, sourceEntryId]) => {
      const pointer = checkpoint.identityPointers.find((item) => item.entryId === entryId);
      const replayCommit = run.meta.entryCommits?.[sourceEntryId] ?? null;
      return !pointer || pointer.commit !== replayCommit;
    });
    if (replayCommitMismatch) {
      const [entryId, sourceEntryId] = replayCommitMismatch;
      const pointer = checkpoint.identityPointers.find((item) => item.entryId === entryId);
      const replayCommit = run.meta.entryCommits?.[sourceEntryId] ?? null;
      // The rolling current checkpoint can legitimately advance beyond the
      // immutable unified replay. In that case the site falls back to this
      // checkpoint's complete original cohort. Historical checkpoints remain
      // strict: a mismatch there means the replay mapping is wrong.
      if (checkpoint.current) continue;
      throw new Error(
        `history replay commit mismatch for ${checkpoint.id}/${entryId}: `
        + `${replayCommit ?? 'missing'} != ${pointer?.commit ?? 'missing checkpoint identity'}`,
      );
    }
    const activeRecordIndexes = [];
    for (const [entryId, sourceEntryId] of Object.entries(sourceByEntry)) {
      const byCell = new Map(replayRecords
        .filter((record) => record.entry === sourceEntryId)
        .map((record) => [historyReplayCellKey(record), record]));
      const missing = HISTORY_REPLAY_CELLS.filter((key) => {
        const record = byCell.get(key);
        return record == null
          || record.n < HISTORY_REPLAY_SPEC.minimumReps
          || record.dnfCount > 0
          || !Number.isFinite(record.median);
      });
      if (missing.length > 0) {
        throw new Error(
          `history replay ${checkpoint.id}/${entryId} is incomplete: ${missing.join(', ')}`,
        );
      }
      for (const key of HISTORY_REPLAY_CELLS) {
        const record = byCell.get(key);
        const mapped = historyRecord(
          run,
          file,
          record,
          'historical-replay',
          `replay:${HISTORY_REPLAY_SPEC.id}:${checkpoint.id}`,
        );
        mapped.entry = entryId;
        if (sourceEntryId === entryId) delete mapped.sourceEntry;
        else mapped.sourceEntry = sourceEntryId;
        activeRecordIndexes.push(records.push(mapped) - 1);
      }
    }
    replayCheckpoints.push({
      checkpointId: checkpoint.id,
      activeRecordIndexes,
      entryIds: cohort.entryIds,
      sourceByEntry,
    });
  }

  return [{
    id: HISTORY_REPLAY_SPEC.id,
    label: HISTORY_REPLAY_SPEC.label,
    description: 'The exact historical bundles are replayed together on one machine with one '
      + 'current black-box workload contract. Stable React/Vue artifacts are measured once and '
      + 'reused at every checkpoint; every weighted history score therefore uses the same 9/9 cells.',
    runFile: file,
    generatedAt: run.meta.generatedAt,
    machineId: run.meta.machine.id,
    machine: run.meta.machine,
    calibration: run.meta.calibration,
    minimumReps: HISTORY_REPLAY_SPEC.minimumReps,
    cellKeys: HISTORY_REPLAY_CELLS,
    records,
    checkpoints: replayCheckpoints,
  }];
};

const buildHistory = ({
  runs, featuredIds, nativeFeaturedIds, featuredEntries, entries, checkpointSpecs, current,
}) => {
  const records = [];
  const sources = [];
  const checkpoints = [];
  const nativeGroups = new Map();
  const entryById = new Map(entries.map((entry) => [entry.id, entry]));
  const checkpointByWebRun = new Map(
    checkpointSpecs.map((checkpoint) => [checkpoint.webRunFile, checkpoint]),
  );

  for (const candidate of runs) {
    const { file, run } = candidate;
    const checkpointSpec = checkpointByWebRun.get(file) ?? null;
    const checkpointEntryIds = new Set(checkpointSpec?.entryIds ?? featuredIds);
    const excludedCheckpointWorkloads = new Set(checkpointSpec?.excludedWorkloads ?? []);
    const publishable = run.records.filter((record) => isPublishableRecord(run, record));
    const benchmark = publishable.filter(isBenchmarkRecord);
    const web = benchmark.filter((record) => record.harness === 'web');
    const native = benchmark.filter((record) => record.harness === 'native');
    const webPublicCandidates = publishable.filter((record) => record.harness === 'web' && (() => {
      const entry = publicHistoryEntry(run, record);
      return checkpointEntryIds.has(entry) && !excludedCheckpointWorkloads.has(record.workload);
    })());
    const eligibleCellsByEntry = new Map([...checkpointEntryIds].map((entry) => [entry, new Set(
      webPublicCandidates.filter((record) => publicHistoryEntry(run, record) === entry
        && isRankingEligible(record)).map(cellKey),
    )]));
    const completeCheckpointCells = checkpointSpec == null
      ? null
      : [...eligibleCellsByEntry.values()].reduce((common, cells) => new Set(
        [...common].filter((key) => cells.has(key)),
      ));
    const webPublic = completeCheckpointCells == null
      ? webPublicCandidates
      : webPublicCandidates.filter((record) =>
        isRankingEligible(record) && completeCheckpointCells.has(cellKey(record)));
    const webPublicBenchmark = webPublic.filter(isBenchmarkRecord);
    const webEntries = new Set(webPublicBenchmark.map((record) => publicHistoryEntry(run, record))
      .filter((entry) => checkpointEntryIds.has(entry)));
    const webCells = new Map([...checkpointEntryIds].map((entry) => [entry, new Set(
      webPublicBenchmark.filter((record) => publicHistoryEntry(run, record) === entry).map(cellKey),
    )]));
    const matrixCells = new Set([...webEntries].flatMap((entry) => [...webCells.get(entry)]));
    const balancedMatrix = matrixCells.size > 0 && [...webEntries].every((entry) => {
      const cells = webCells.get(entry);
      return cells.size === matrixCells.size && [...matrixCells].every((key) => cells.has(key));
    });
    const webCohort = webEntries.size >= 2
      && webEntries.size === checkpointEntryIds.size
      && requestsFullWebMatrix(run)
      && balancedMatrix
      && matrixCells.size >= (checkpointSpec?.minimumBenchmarkCellCount ?? 1)
      && webPublicBenchmark.every(isRankingEligible);
    const sourceIndex = sources.length;
    const sourceHistoryRecords = [];

    if (checkpointSpec) {
      const cohortId = `web:${run.meta.machine.id}:${file}`;
      sourceHistoryRecords.push(...webPublic.map((record) =>
        historyRecord(run, file, record, webCohort ? 'same-run' : 'isolated-observation',
          cohortId)));
      if (!webCohort) {
        const ineligible = webPublicBenchmark.filter((record) => !isRankingEligible(record));
        throw new Error(
          `configured dataset checkpoint ${checkpointSpec.id} is not a complete balanced Web cohort: `
          + `${webEntries.size}/${checkpointEntryIds.size} entries, ${matrixCells.size} union cells, `
          + `${balancedMatrix ? 'balanced' : 'unbalanced'}, ${ineligible.length} ineligible records, `
          + `minimum ${checkpointSpec.minimumBenchmarkCellCount ?? 1} cells`,
        );
      }
      if (sourceHistoryRecords.length) {
        const generatedAt = run.meta.generatedAt;
        checkpoints.push({
          id: checkpointSpec.id,
          generatedAt,
          label: checkpointSpec.label,
          description: checkpointSpec.description,
          activeRecordIndexes: sourceHistoryRecords.map((_, index) => records.length + index),
          sourceIndexes: [sourceIndex],
          identityPointers: identityPointers(sourceHistoryRecords, entryById),
          harnesses: [{
            harness: 'web',
            environment: webPublic[0].environment,
            ...normalizeWebRegime(webPublic[0]),
            machineId: run.meta.machine.id,
            sourceRunFiles: [file],
            entryIds: [...webEntries].sort(),
            rankEligible: webCohort,
          }],
        });
      }
    }

    for (const environment of new Set(native.map((record) => record.environment))) {
      const identity = nativeCohortIdentity(run, environment);
      if (identity == null) continue;
      const group = nativeGroups.get(identity.stableIdentity) ?? [];
      group.push({ candidate, environment, identity });
      nativeGroups.set(identity.stableIdentity, group);
    }

    records.push(...sourceHistoryRecords);
    const normalizedEntries = new Set(benchmark.map((record) => publicHistoryEntry(run, record)));
    sources.push(historySourceSummary(
      candidate,
      sourceHistoryRecords.length + native.filter((record) =>
        nativeFeaturedIds.has(publicHistoryEntry(run, record))).length,
      normalizedEntries,
      checkpointSpec != null && webCohort,
      webPublic.length === 0
        ? (native.length ? 'native run; evaluated with its exact machine/environment cohort' : 'no featured benchmark observations')
        : checkpointSpec != null && webCohort
          ? `selected dataset checkpoint ${checkpointSpec.id}`
          : webCohort
            ? 'complete Web cohort retained as source evidence; not a selected dataset checkpoint'
          : webEntries.size < 2
            ? 'exact observation only; fewer than two eligible entries'
            : !requestsFullWebMatrix(run)
              ? 'partial Web run; explicit suite, case, or scale selection'
              : 'incomplete Web matrix for this run\'s eligible entry set',
    ));
  }

  for (const candidates of nativeGroups.values()) {
    const ordered = [...candidates].sort((a, b) =>
      a.candidate.run.meta.generatedAt.localeCompare(b.candidate.run.meta.generatedAt)
      || a.candidate.file.localeCompare(b.candidate.file));
    for (const { candidate, environment, identity } of ordered) {
      const sourceIndex = runs.indexOf(candidate);
      const candidateRecords = candidate.run.records.filter((item) => isBenchmarkRecord(item)
        && item.harness === 'native'
        && item.environment === environment
        && isPublishableRecord(candidate.run, item));
      const entryIds = new Set(candidateRecords.map((record) =>
        publicHistoryEntry(candidate.run, record)).filter((entry) => nativeFeaturedIds.has(entry)));
      if (!entryIds.has('octane')) continue;
      const activeRecordIndexes = [];
      for (const record of candidateRecords) {
        const entry = publicHistoryEntry(candidate.run, record);
        if (!nativeFeaturedIds.has(entry)) continue;
        const history = historyRecord(
          candidate.run, candidate.file, record,
          'exact-native-campaign',
          `native:${identity.stableIdentity}`,
        );
        activeRecordIndexes.push(records.push(history) - 1);
      }
      const rankEligible = candidate.run.meta.checkpointComplete === true && entryIds.size >= 2;
      const nativeCoverage = classifyNativeCoverage({
        entries: featuredEntries,
        sourceRecords: candidateRecords,
        publishedRecords: rankEligible ? candidateRecords : [],
        archiveRecords: rankEligible ? [] : candidateRecords,
      });
      if (rankEligible) {
        checkpoints.push({
          id: historyId(candidate.run.meta.generatedAt, [candidate.file]),
          generatedAt: candidate.run.meta.generatedAt,
          label: `Native · ${new Date(candidate.run.meta.generatedAt).toISOString()}`,
          description: `Exact complete Native campaign checkpoint from ${candidate.file}.`,
          activeRecordIndexes,
          sourceIndexes: [sourceIndex],
          identityPointers: identityPointers(
            activeRecordIndexes.map((index) => records[index]), entryById,
          ),
          nativeCoverage,
          harnesses: [{
            harness: 'native',
            environment,
            machineId: identity.deviceCohort.id,
            sourceRunFiles: [candidate.file],
            entryIds: [...entryIds].sort(),
            rankEligible: true,
          }],
        });
      }
      const source = sources[sourceIndex];
      source.rankEligible ||= rankEligible;
      source.reason = source.rankEligible
        ? 'exact complete Native campaign checkpoint'
        : 'exact Native observation only; incomplete checkpoint or no peer entry';
    }
  }

  const currentCohortHistoryRecords = current.comparison.harnesses.flatMap((cohort) => {
    const cohortRecords = current.records.filter((record) => record.harness === cohort.harness
      && ((record.suite === 'bundle-scale'
        && (cohort.harness !== 'web'
          || (cohort.jsRegime === 'jit'
            && cohort.cpuThrottle === 1
            && cohort.throttleScope === 'none'))) || (
        record.environment === cohort.environment
        && (cohort.harness !== 'web'
          || (record.jsRegime === cohort.jsRegime
            && record.jsFlags === cohort.jsFlags
            && record.cpuThrottle === cohort.cpuThrottle
            && record.throttleScope === cohort.throttleScope)))));
    const matrixRecords = completeMatrixRecords(
      cohortRecords.filter((record) => !['pipeline', 'storm'].includes(record.suite)),
      cohort.entryIds,
    );
    const matrixSet = new Set(matrixRecords);
    const descriptiveExactRecords = cohortRecords.filter((record) =>
      !matrixSet.has(record)
      && ['pipeline', 'storm'].includes(record.suite)
      && isComparisonVisible(record));
    const descriptiveStaticRecords = cohortRecords.filter((record) =>
      record.suite === 'bundle-scale' && record.descriptiveEligible === true);
    return [...matrixRecords, ...descriptiveExactRecords, ...descriptiveStaticRecords].map((record) => {
      const sourceEntry = record.sourceEntry ?? record.entry;
      const syntheticRun = {
        meta: {
          machine: { id: record.machineId },
          generatedAt: record.runGeneratedAt,
          entryCommits: { [sourceEntry]: record.entryCommit },
        },
        records: cohortRecords,
      };
      const history = historyRecord(
        syntheticRun,
        record.runFile,
        record,
        record.comparisonKind,
        `current:${cohort.harness}:${cohort.machineId}:`
          + `${cohort.jsRegime ?? 'native'}:${cohort.jsFlags ?? ''}:${cohort.cpuThrottle ?? 0}:`
          + `${cohort.throttleScope ?? 'native'}`,
      );
      return matrixSet.has(record) ? history : {
        ...history,
        rankEligible: false,
        descriptiveEligible: true,
      };
    });
  });
  const currentDiagnosticHistoryRecords = current.nativeObservationRecords
    .filter((record) => record.diagnostic === true
      || record.entry === NATIVE_DIAGNOSTIC_ENTRY_ID)
    .map((record) => historyRecord({
      meta: {
        machine: { id: record.machineId },
        generatedAt: record.runGeneratedAt,
        entryCommits: { [record.sourceEntry ?? record.entry]: record.entryCommit },
      },
      records: current.nativeObservationRecords,
    }, record.runFile, record, 'isolated-observation',
    `current:native-diagnostic:${record.machineId}:${record.runFile}`))
    .map((record) => ({ ...record, rankEligible: false, descriptiveEligible: true }));
  const currentHistoryRecords = [
    ...currentCohortHistoryRecords,
    ...currentDiagnosticHistoryRecords,
  ];
  const currentActiveRecordIndexes = currentHistoryRecords.map(
    (_, index) => records.length + index,
  );
  records.push(...currentHistoryRecords);
  checkpoints.push({
    id: 'current-main',
    generatedAt: current.generatedAt,
    label: 'Current · merged upstream',
    description: 'Current manifests are upstream Octane 9779569e and Huxpro/new-lynx e9f1fb14. '
      + 'Every Web regime publishes both identities: the earlier Hux source commit is accepted only '
      + 'because its complete Web bundle receipt is byte-identical to e9f1fb14. Regimes remain separate '
      + 'from each other and from Native. Complete pipeline and storm campaigns attach as descriptive '
      + 'exact evidence and never enter the weighted matrix.',
    current: true,
    nativeCoverage: current.nativeCoverage,
    pipelineCoverage: current.pipelineCoverage,
    listCoverage: current.listCoverage,
    activeRecordIndexes: currentActiveRecordIndexes,
    identityPointers: identityPointers(currentHistoryRecords, entryById),
    sourceIndexes: [...new Set([...current.records, ...current.nativeObservationRecords]
      .filter(isBenchmarkRecord)
      .map((record) => sources.findIndex((source) => source.runFile === record.runFile))
      .filter((index) => index >= 0))],
    harnesses: current.comparison.harnesses.map((cohort) => ({
      harness: cohort.harness, environment: cohort.environment, machineId: cohort.machineId,
      jsRegime: cohort.jsRegime ?? null, jsFlags: cohort.jsFlags ?? null,
      cpuThrottle: cohort.cpuThrottle ?? null,
      throttleScope: cohort.throttleScope ?? null,
      sourceRunFiles: cohort.sourceRunFiles, entryIds: cohort.entryIds, rankEligible: true,
    })),
  });

  checkpoints.sort((a, b) => a.generatedAt.localeCompare(b.generatedAt) || a.id.localeCompare(b.id));
  return {
    records,
    sources,
    checkpoints,
    replays: buildHistoryReplays({ runs, checkpoints }),
  };
};

const assertCurrentEntryIdentity = (run, entryId, entry, label) => {
  if (!entry) return;
  const record = run.records.find((candidate) => candidate.entry === entryId);
  if (record && entryIdentityMatchesManifest(run, record, new Map([[entryId, entry]]))) return;
  const sourceId = record?.sourceEntry ?? entryId;
  const runCommit = run.meta.entryCommits?.[sourceId];
  const manifestCommit = entry.provenance?.commit;
  throw new Error(
    `${label} ${entryId}: source run commit ${runCommit ?? 'missing'} and Web bundle receipt `
    + `do not match current entry manifest ${manifestCommit ?? 'missing'}; rerun the benchmark`,
  );
};

const scaleNumber = (value, ratio) => value == null ? value : value * ratio;

const calibrateLabRecord = (run, file, record, targetCalibration) => {
  const sourceCalibration = run.meta.calibration;
  const canCalibrate = record.unit === 'ms'
    && sourceCalibration?.probeVersion === targetCalibration?.probeVersion
    && sourceCalibration?.score > 0
    && targetCalibration?.score > 0;
  const ratio = canCalibrate ? sourceCalibration.score / targetCalibration.score : null;
  const annotated = annotate(
    run,
    file,
    record,
    canCalibrate ? 'calibrated-estimate' : 'historical',
  );
  if (!canCalibrate) return { ...annotated, targetCalibration, calibrationRatio: null };
  const scaled = deriveRecord({
    ...annotated,
    value: scaleNumber(record.value, ratio),
    samples: record.samples?.map((value) => scaleNumber(value, ratio)) ?? record.samples,
  });
  return {
    ...scaled,
    sourceMedian: record.median,
    targetCalibration,
    calibrationRatio: ratio,
  };
};

const isBetterLabRun = (candidate, current, entryId) => {
  if (!current) return true;
  const count = new Set(candidate.run.records
    .filter((r) => r.entry === entryId && isBenchmarkRecord(r) && isRankingEligible(r))
    .map(cellKey)).size;
  const currentCount = new Set(current.run.records
    .filter((r) => r.entry === entryId && isBenchmarkRecord(r) && isRankingEligible(r))
    .map(cellKey)).size;
  const time = candidate.run.meta.generatedAt ?? candidate.file;
  const currentTime = current.run.meta.generatedAt ?? current.file;
  return count > currentCount || (count === currentCount && (time > currentTime
    || (time === currentTime && candidate.file > current.file)));
};

export function collectRuns({
  log = console.log,
  root = repoRoot(),
  generatedAt = null,
  entryTiers = null,
  entries = null,
  datasetCheckpoints = DATASET_CHECKPOINT_SPECS,
} = {}) {
  const runsDir = path.join(root, 'results/runs');
  const outPath = path.join(root, 'results/latest.json');
  if (!fs.existsSync(runsDir)) throw new Error(`no runs directory at ${runsDir}`);

  const runFiles = fs.readdirSync(runsDir).filter((f) => f.endsWith('.json')).sort();
  const machines = {};
  const machineRegimes = {};
  const merged = new Map();
  const runs = [];
  const incompleteCheckpointFiles = new Set();
  let comparisonRun = null;
  const comparisonRuns = new Map();
  const prospectiveWebGroups = new Map();
  let latestSourceGeneratedAt = null;
  let runsSeen = 0;
  const resolvedTiers = entryTiers ?? readEntryTiers(root);
  const currentEntries = entries ?? (fs.existsSync(path.join(root, 'entries'))
    ? discoverEntries({ root })
    : []);
  const entryById = new Map(currentEntries.map((entry) => [entry.id, entry]));
  const staticByEntry = new Map(currentEntries.map((entry) => [entry.id, bundleRecords(entry)]));
  const featuredIds = new Set([...resolvedTiers].filter(([, tier]) => tier === 'featured').map(([id]) => id));
  const nativeFeaturedIds = new Set([...featuredIds].filter((id) =>
    entrySupportsHarness(entryById.get(id), 'native')));
  const labIds = [...resolvedTiers].filter(([, tier]) => tier === 'lab').map(([id]) => id);

  for (const file of runFiles) {
    const rawRun = JSON.parse(fs.readFileSync(path.join(runsDir, file), 'utf-8'));
    if (rawRun.schemaVersion !== SCHEMA_VERSION
      && !LEGACY_SCHEMA_VERSIONS.includes(rawRun.schemaVersion)) {
      log(`[collect] skip ${file}: unsupported schemaVersion ${rawRun.schemaVersion}`);
      continue;
    }
    if (rawRun.meta?.checkpoint === true && rawRun.meta?.checkpointComplete !== true) {
      if (rawRun.meta?.campaign?.version !== NATIVE_SANDBOX_CAMPAIGN_VERSION) {
        log(`[collect] skip ${file}: incomplete legacy Native checkpoint`);
        continue;
      }
      incompleteCheckpointFiles.add(file);
    }
    const run = normalizeRun(rawRun, file);
    runs.push({ file, run });
    runsSeen += 1;
    const m = run.meta.machine;
    const runTime = run.meta.generatedAt ?? file;
    const webRegimes = new Set(run.records
      .filter((record) => record.harness === 'web' && isBenchmarkRecord(record))
      .map(webRegimeKey));
    if (webRegimes.size > 1) {
      throw new Error(`${file}: one physical Web run cannot contain multiple JS regimes`);
    }
    const regimeKey = webRegimes.values().next().value ?? 'native';
    latestSourceGeneratedAt = latestSourceGeneratedAt == null || runTime > latestSourceGeneratedAt
      ? runTime
      : latestSourceGeneratedAt;
    if (!machines[m.id] || runTime > machines[m.id].latestRunGeneratedAt
      || (runTime === machines[m.id].latestRunGeneratedAt && file > machines[m.id].latestRunFile)) {
      machines[m.id] = {
        ...m,
        latestCalibration: run.meta.calibration,
        latestRunFile: file,
        latestRunGeneratedAt: run.meta.generatedAt,
      };
    }
    const machineRegimeId = `${m.id}|${regimeKey}`;
    if (!machineRegimes[machineRegimeId]
      || runTime > machineRegimes[machineRegimeId].latestRunGeneratedAt
      || (runTime === machineRegimes[machineRegimeId].latestRunGeneratedAt
        && file > machineRegimes[machineRegimeId].latestRunFile)) {
      machineRegimes[machineRegimeId] = {
        ...m,
        machineRegimeId,
        ...(regimeKey === 'native'
          ? { jsRegime: null, jsFlags: null, cpuThrottle: null, throttleScope: null }
          : normalizeWebRegime(run.records.find((record) => record.harness === 'web'))),
        latestCalibration: run.meta.calibration,
        latestRunFile: file,
        latestRunGeneratedAt: run.meta.generatedAt,
      };
    }
    for (const r of run.records.filter(isBenchmarkRecord)) {
      const key = recordKey(m.id, r);
      const current = merged.get(key);
      const currentTime = current?.runGeneratedAt ?? current?.runFile;
      if (!current || runTime > currentTime || (runTime === currentTime && file > current.runFile)) {
        merged.set(key, annotate(run, file, r));
      }
    }
    const view = comparisonView(run, featuredIds, entryById, 'web');
    for (const candidateRegime of new Set(view.records.map(webRegimeKey))) {
      const regimeView = {
        ...view,
        records: view.records.filter((record) => webRegimeKey(record) === candidateRegime),
      };
      const candidate = { file, run: regimeView };
      if (rawRun.schemaVersion === SCHEMA_VERSION || rawRun.schemaVersion === 3) {
        // Split checkpoints may be combined only inside the same prospective
        // control receipt. A machine/regime match alone does not make two runs
        // attributable or even comparable.
        const cohortKey = regimeView.meta.receipt?.comparabilityCohort
          ?? regimeView.records[0]?.comparabilityCohort
          ?? 'unverified';
        const groupId = `${m.id}|${candidateRegime}|${cohortKey}`;
        const group = prospectiveWebGroups.get(groupId) ?? {
          machineId: m.id,
          regimeKey: candidateRegime,
          cohortKey,
          cells: new Map(),
          latest: candidate,
        };
        if (runTime > (group.latest.run.meta.generatedAt ?? group.latest.file)
          || (runTime === (group.latest.run.meta.generatedAt ?? group.latest.file)
            && file > group.latest.file)) group.latest = candidate;
        for (const record of regimeView.records) {
          const key = `${record.entry}|${cellKey(record)}`;
          const current = group.cells.get(key);
          const currentTime = current?.run.meta.generatedAt ?? current?.file;
          if (!current || runTime > currentTime || (runTime === currentTime && file > current.file)) {
            group.cells.set(key, { file, run, record });
          }
        }
        prospectiveWebGroups.set(groupId, group);
        continue;
      }
      const current = comparisonRuns.get(candidateRegime) ?? null;
      if (regimeView.records.length > 0
        && isBetterComparisonRun(candidate, current, featuredIds)) {
        comparisonRuns.set(candidateRegime, candidate);
      }
    }
  }

  for (const group of prospectiveWebGroups.values()) {
    const sources = [...group.cells.values()];
    const candidate = {
      file: group.latest.file,
      run: { ...group.latest.run, records: sources.map(({ record }) => record) },
      sources,
      machineRegimeId: `${group.machineId}|${group.regimeKey}`,
    };
    const current = comparisonRuns.get(group.regimeKey) ?? null;
    if (candidate.run.records.length > 0
      && isBetterComparisonRun(candidate, current, featuredIds)) {
      comparisonRuns.set(group.regimeKey, candidate);
    }
  }

  comparisonRun = comparisonRuns.get(DEFAULT_WEB_REGIME_KEY)
    ?? [...comparisonRuns.values()].sort((left, right) =>
      String(right.run.meta.generatedAt).localeCompare(String(left.run.meta.generatedAt)))[0]
    ?? null;
  if (!comparisonRun) throw new Error(`no supported Web runs at ${runsDir}`);
  if (comparisonRank(comparisonRun.run, featuredIds)[0] === 0) {
    throw new Error(`no featured benchmark records in schema v${SCHEMA_VERSION} runs at ${runsDir}`);
  }
  const selectedWebComparisons = [...comparisonRuns.entries()]
    .sort(([left], [right]) => {
      if (left === DEFAULT_WEB_REGIME_KEY) return -1;
      if (right === DEFAULT_WEB_REGIME_KEY) return 1;
      return left.localeCompare(right, undefined, { numeric: true });
    })
    .map(([regimeKey, candidate]) => ({ regimeKey, ...candidate }));
  const webComparisonSources = selectedWebComparisons.map((candidate) => {
    const recordSources = (candidate.sources ?? candidate.run.records.map((record) => ({
      file: candidate.file,
      run: candidate.run,
      record,
    }))).filter(({ record }) => featuredIds.has(record.entry) && isBenchmarkRecord(record));
    for (const source of recordSources) {
      assertCurrentEntryIdentity(
        source.run,
        source.record.entry,
        entryById.get(source.record.entry),
        'comparison',
      );
    }
    return { ...candidate, records: recordSources.map(({ record }) => record), recordSources };
  });
  const comparisonSourceRecords = webComparisonSources.flatMap(({ records }) => records);
  const comparisonStaticRecords = [...featuredIds].flatMap((entryId) => {
    const entry = entryById.get(entryId);
    return entry ? (staticByEntry.get(entryId) ?? []).map((record) => annotateStatic(entry, record)) : [];
  });
  const pipelineCampaign = currentPipelineCampaign(runs, featuredIds, entryById);
  const pipelineSourceRecords = pipelineCampaign == null ? [] : pipelineCampaign.records.map(
    (record) => compactPipelineOutputRecord(
      annotate(pipelineCampaign.run, pipelineCampaign.file, record, 'same-run'),
    ),
  );
  const pipelineCoverage = pipelineCampaign?.coverage ?? classifyPipelineCoverage({
    entries: [...featuredIds].map((id) => entryById.get(id)).filter(Boolean),
  });
  const stormCampaigns = currentStormCampaigns(
    runs,
    featuredIds,
    entryById,
  );
  const stormSourceRecords = stormCampaigns.flatMap((candidate) =>
    candidate.records.map((record) => annotate(
      candidate.run,
      candidate.file,
      record,
      'same-run',
    )));
  const exactSourceRecords = [...pipelineSourceRecords, ...stormSourceRecords];
  const comparisonRecords = [
    ...webComparisonSources.flatMap((source) => {
      const sourceFiles = new Set(source.recordSources.map(({ file }) => file));
      const comparisonKind = sourceFiles.size === 1 ? 'same-run' : 'same-machine-regime';
      return source.recordSources.map((recordSource) =>
        annotate(recordSource.run, recordSource.file, recordSource.record, comparisonKind));
    }),
    ...exactSourceRecords,
    ...comparisonStaticRecords,
  ];
  const { selected: nativeCohort, archiveOnlyFiles: nativeArchiveOnlyFiles } =
    selectNativeCohort(runs, nativeFeaturedIds, entryById);
  const selectedNativeFiles = new Set(nativeCohort == null ? []
    : [...nativeCohort.entries.values()].flatMap((entry) =>
      [...entry.cells.values()].map((source) => source.file)));
  const retainedRuns = runs.filter(({ file }) =>
    !incompleteCheckpointFiles.has(file) || selectedNativeFiles.has(file));
  const retainedRunFiles = new Set(retainedRuns.map(({ file }) => file));
  const nativeSourceRecords = nativeCohort
    ? [...nativeCohort.entries.values()].flatMap((entry) => [...entry.cells.values()].map((source) =>
      ({
        ...annotate(source.run, source.file, source.record, 'same-device-cohort'),
        machineId: nativeCohort.deviceCohortId,
        sourceMachineId: source.run.meta.machine.id,
        deviceLeaseId: source.run.meta.cellLeaseIds[nativeCellKey(source.record)],
        methodRevisionId: source.run.meta.cellMethodRevisionIds?.[nativeCellKey(source.record)]
          ?? nativeCohort.methodRevisionChain?.revisions[0]?.id
          ?? null,
      })))
    : [];
  const nativeCoverage = classifyNativeCoverage({
    entries: [...nativeFeaturedIds].map((id) => entryById.get(id)).filter(Boolean),
    sourceRecords: nativeSourceRecords,
    publishedRecords: nativeSourceRecords,
    archiveRecords: [...merged.values()].filter((record) => record.harness === 'native'
      && retainedRunFiles.has(record.runFile)),
  });
  if (nativeCohort) assertNativeCoverage(nativeCoverage);
  const listSourceRecords = selectListCampaignRecords(
    [...merged.values()].filter((record) => retainedRunFiles.has(record.runFile)),
    currentEntries,
  );
  const listCoverage = buildListCoverage({
    entries: currentEntries,
    sourceRecords: listSourceRecords,
  });
  assertListCoverage(listCoverage);
  const listDerivedRecords = deriveListRecords(listSourceRecords);
  if (nativeCohort) {
    const sources = [...nativeCohort.entries.values()].flatMap((entry) =>
      [...entry.cells.values()]);
    const latestSource = sources.sort((left, right) =>
      String(left.run.meta.generatedAt).localeCompare(String(right.run.meta.generatedAt))).at(-1);
    machines[nativeCohort.deviceCohortId] = {
      ...(latestSource?.run.meta.machine ?? {}),
      id: nativeCohort.deviceCohortId,
      deviceCohort: nativeCohort.deviceCohort,
      deviceCohortId: nativeCohort.deviceCohortId,
      leaseChain: nativeCohort.leaseChain,
      methodRevisionChain: nativeCohort.methodRevisionChain,
      perLeaseMachineIds: [...new Set(sources.map((source) => source.run.meta.machine.id))].sort(),
    };
  }
  comparisonRecords.push(...nativeSourceRecords);
  const nativeObservations = selectNativeObservations(
    retainedRuns,
    nativeFeaturedIds,
    entryById,
    nativeCohort,
    nativeArchiveOnlyFiles,
  );
  const diagnosticNativeObservations = selectDiagnosticNativeObservations(
    [...merged.values()].filter((record) => retainedRunFiles.has(record.runFile)),
    listSourceRecords,
    currentEntries,
  );
  nativeObservations.observations.push(...diagnosticNativeObservations.observations);
  nativeObservations.records.push(...diagnosticNativeObservations.records);
  const nativeComparison = nativeCohort ? {
    harness: 'native',
    environment: nativeCohort.environment,
    generatedAt: nativeCohort.latest,
    machineId: nativeCohort.machineId,
    calibration: null,
    sourceRunFiles: [...new Set([...nativeCohort.entries.values()].flatMap((entry) =>
      [...entry.cells.values()].map((source) => source.file)))].sort(),
    entryIds: [...nativeCohort.entries.keys()].sort(),
    sourceRecordCount: nativeSourceRecords.length,
    recordCount: nativeSourceRecords.length,
    cohortIdentity: nativeCohort.cohortIdentity,
    deviceCohort: nativeCohort.deviceCohort,
    deviceCohortId: nativeCohort.deviceCohortId,
    leaseChain: nativeCohort.leaseChain,
    methodRevisionChain: nativeCohort.methodRevisionChain,
    campaign: nativeCohort.campaign,
    coverage: nativeCoverage.summary,
  } : null;
  const comparison = {
    runFile: comparisonRun.file,
    generatedAt: comparisonRun.run.meta.generatedAt,
    machineId: comparisonRun.run.meta.machine.id,
    calibration: comparisonRun.run.meta.calibration,
    entryIds: [...new Set(comparisonSourceRecords.map((r) => r.entry))].sort(),
    sourceRecordCount: comparisonSourceRecords.length,
    recordCount: comparisonRecords.length,
    harnesses: [
      ...webComparisonSources.map((source) => {
        const regime = normalizeWebRegime(source.records[0] ?? { harness: 'web' });
        const exactForRegime = exactSourceRecords.filter((record) =>
          record.machineId === source.run.meta.machine.id
          && webRegimeKey(record) === source.regimeKey);
        return {
        harness: 'web',
        environment: source.records[0]?.environment ?? null,
        ...regime,
        generatedAt: source.run.meta.generatedAt,
        machineId: source.run.meta.machine.id,
        machineRegimeId: `${source.run.meta.machine.id}|${source.regimeKey}`,
        calibration: source.run.meta.calibration,
        sourceRunFiles: [...new Set([
          ...source.recordSources.map(({ file }) => file),
          ...exactForRegime.map(({ runFile }) => runFile),
        ])].sort(),
        entryIds: [...new Set(source.records.map((r) => r.entry))].sort(),
        sourceRecordCount: source.records.length,
        recordCount: source.records.length + exactForRegime.length + comparisonStaticRecords.length,
        };
      }),
      ...(nativeComparison ? [nativeComparison] : []),
    ],
  };
  const labEstimates = [];
  const labComparisonRecords = [];
  const comparisonCohort = comparisonRun.run.meta.receipt?.comparabilityCohort ?? null;
  for (const entryId of labIds) {
    let source = null;
    for (const candidate of runs) {
      const candidateCohort = candidate.run.meta.receipt?.comparabilityCohort ?? null;
      if (candidateCohort !== comparisonCohort) continue;
      if (!candidate.run.records.some((r) =>
        r.entry === entryId && isBenchmarkRecord(r) && isRankingEligible(r))) continue;
      if (isBetterLabRun(candidate, source, entryId)) source = candidate;
    }
    if (!source) continue;
    const records = source.run.records.filter((r) =>
      r.entry === entryId && isBenchmarkRecord(r) && isRankingEligible(r));
    assertCurrentEntryIdentity(source.run, entryId, entryById.get(entryId), 'Lab comparison');
    const sourceCalibration = source.run.meta.calibration;
    const targetCalibration = comparisonRun.run.meta.calibration;
    const compatibleCalibration = sourceCalibration?.probeVersion === targetCalibration?.probeVersion
      && sourceCalibration?.score > 0
      && targetCalibration?.score > 0;
    const calibrationRatio = compatibleCalibration
      ? source.run.meta.calibration.score / comparisonRun.run.meta.calibration.score
      : null;
    labEstimates.push({
      entryId,
      sourceRunFile: source.file,
      sourceGeneratedAt: source.run.meta.generatedAt,
      sourceMachineId: source.run.meta.machine.id,
      sourceCalibration: source.run.meta.calibration,
      targetCalibration: comparisonRun.run.meta.calibration,
      calibrationRatio,
      sourceRecordCount: records.length,
      recordCount: records.length + (staticByEntry.get(entryId)?.length ?? 0),
    });
    labComparisonRecords.push(...records.map((r) =>
      calibrateLabRecord(source.run, source.file, r, comparisonRun.run.meta.calibration)));
    const entry = entryById.get(entryId);
    if (entry) {
      labComparisonRecords.push(...(staticByEntry.get(entryId) ?? []).map((record) =>
        annotateStatic(entry, record)));
    }
  }
  comparison.labEstimates = labEstimates;

  const archiveStaticRecords = currentEntries.flatMap((entry) =>
    (staticByEntry.get(entry.id) ?? []).map((record) => annotateStatic(entry, record)));

  const out = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: generatedAt ?? latestSourceGeneratedAt,
    sources: {
      runFiles: retainedRuns.map(({ file }) => file),
      entryIds: currentEntries.map((entry) => entry.id),
    },
    machines,
    machineRegimes,
    records: [...merged.values()].filter((record) => retainedRunFiles.has(record.runFile))
      .map(compactPipelineOutputRecord)
      .map((record) => materializeRecordOutcomes(record, {
        publicBoundary: true,
        allowInvalidAccounting: true,
      }))
      .concat(archiveStaticRecords),
    comparison,
    comparisonRecords: comparisonRecords.map((record) =>
      materializeRecordOutcomes(record, {
        publicBoundary: true,
        allowInvalidAccounting: true,
      })),
    labComparisonRecords,
    nativeObservations: nativeObservations.observations,
    nativeObservationRecords: nativeObservations.records.map((record) =>
      materializeRecordOutcomes(record, {
        publicBoundary: true,
        allowInvalidAccounting: true,
      })),
    nativeCoverage,
    pipelineCoverage,
    listCoverage,
    listDerivedRecords,
  };
  out.history = buildHistory({
    runs: retainedRuns,
    featuredIds,
    nativeFeaturedIds,
    featuredEntries: [...nativeFeaturedIds].map((id) => entryById.get(id)).filter(Boolean),
    entries: currentEntries,
    checkpointSpecs: datasetCheckpoints,
    current: {
      generatedAt: out.generatedAt,
      records: comparisonRecords,
      comparison,
      machines,
      nativeObservations: out.nativeObservations,
      nativeObservationRecords: out.nativeObservationRecords,
      nativeCoverage: out.nativeCoverage,
      pipelineCoverage: out.pipelineCoverage,
      listCoverage: out.listCoverage,
    },
  });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 1));
  log(`[collect] ${runsSeen} runs → ${out.records.length} merged records; comparison=${comparison.runFile} (${comparison.entryIds.length} web entries, ${nativeComparison?.entryIds.length ?? 0} native entries, ${comparison.recordCount} records) + ${nativeObservations.observations.length} isolated Native observations + ${labEstimates.length} calibrated Lab entries → ${path.relative(root, outPath)}`);
  return out;
}
