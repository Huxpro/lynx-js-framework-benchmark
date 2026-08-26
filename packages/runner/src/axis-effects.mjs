// Derived-only axis attribution for Huxpro/octane#204.
//
// Points may be compared descriptively elsewhere. This module only admits an
// effect when one manifest declares an ablation inside one codebase, the pair
// differs on exactly the declared coordinate, provenance controls the build
// difference, and one physical run contains the same record matrix for both
// entries. Failed and coupled pairs stay visible, but cannot become effects.

import fs from 'node:fs';
import path from 'node:path';

import {
  AXIS_ORDER,
  changedAxes,
  coordinateValue,
  validateCoordinates,
} from '@lynx-bench/shared/coordinates';
import { BOUNDARIES, deriveRecord } from '@lynx-bench/shared/schema';
import { PAPI_SEGMENTS } from '@lynx-bench/shared/pipeline';

export const AXIS_EFFECT_VIEW_VERSION = 'axis-effect-view-v1';

const stableJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value != null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

const finiteObservations = (record) => {
  if (Array.isArray(record?.samples)) return record.samples.filter(Number.isFinite);
  if (Number.isFinite(record?.value)) return [record.value];
  if (record?.samples == null && record?.n === 1 && Number.isFinite(record?.median)) {
    return [record.median];
  }
  return [];
};

const matrixKey = (record) => [
  record.suite,
  record.harness,
  record.environment,
  record.workload,
  record.scale,
  record.metric,
  record.boundary,
  record.unit,
].join('|');

function pipelineRecordControl(record) {
  const values = finiteObservations(record);
  if (values.length === 0) return { controlled: false, reason: 'pipeline-has-no-observation' };
  if (!Array.isArray(record.detailSamples) || record.detailSamples.length !== values.length) {
    return { controlled: false, reason: 'pipeline-control-sample-count-mismatch' };
  }
  const identities = [];
  for (const detail of record.detailSamples) {
    if (!Number.isInteger(detail?.requestedRows)
      || !Number.isInteger(detail?.committedRows)
      || detail.requestedRows !== record.scale
      || detail.callMultiset == null
      || typeof detail.callMultiset !== 'object'
      || !Array.isArray(detail.surfaceNames)
      || !detail.surfaceNames.includes('__FlushElementTree')) {
      return { controlled: false, reason: 'pipeline-control-sample-invalid' };
    }
    identities.push(stableJson({
      requestedRows: detail.requestedRows,
      committedRows: detail.committedRows,
      callMultiset: detail.callMultiset,
      surfaceNames: detail.surfaceNames,
    }));
  }
  if (new Set(identities).size !== 1) {
    return { controlled: false, reason: 'pipeline-call-or-tree-control-varies-across-samples' };
  }
  return {
    controlled: true,
    requestedRows: record.detailSamples[0].requestedRows,
    committedRows: record.detailSamples[0].committedRows,
  };
}

function pipelinePairControl(records) {
  const operations = records.filter((record) =>
    record.suite === 'pipeline' && record.metric === 'operationTime');
  if (operations.length === 0) return { controlled: true };
  const byMatrix = new Map();
  for (const operation of operations) {
    const control = pipelineRecordControl(operation);
    if (!control.controlled) return control;
    const key = matrixKey(operation);
    const group = byMatrix.get(key) ?? [];
    group.push(control);
    byMatrix.set(key, group);
  }
  for (const controls of byMatrix.values()) {
    if (new Set(controls.map((control) => control.requestedRows)).size !== 1) {
      return { controlled: false, reason: 'pipeline-requested-tree-mismatch-between-entries' };
    }
    if (new Set(controls.map((control) => control.committedRows)).size !== 1) {
      return { controlled: false, reason: 'pipeline-committed-tree-mismatch-between-entries' };
    }
  }
  return { controlled: true };
}

const buildParameters = (entry) => entry?.provenance?.buildParameters ?? {};

const differentObjectKeys = (left, right) => [...new Set([
  ...Object.keys(left),
  ...Object.keys(right),
])].filter((key) => stableJson(left[key]) !== stableJson(right[key])).sort();

const evidenceExists = (evidence, root) => {
  if (typeof evidence !== 'string' || evidence.length === 0) return false;
  if (/^https?:\/\//.test(evidence)) return true;
  return root != null && fs.existsSync(path.resolve(root, evidence));
};

function provenanceControl(entry, against, declaration, root) {
  const proof = declaration?.provenance;
  if (proof?.kind !== 'same-build-matrix') {
    return { controlled: false, reason: 'provenance-proof-kind-must-be-same-build-matrix' };
  }
  if (!evidenceExists(proof.evidence, root)) {
    return { controlled: false, reason: 'provenance-evidence-missing' };
  }
  for (const field of ['source', 'ref', 'commit', 'patched', 'patchFile', 'buildCommand']) {
    if (stableJson(entry.provenance?.[field]) !== stableJson(against.provenance?.[field])) {
      return { controlled: false, reason: `provenance-${field}-differs` };
    }
  }
  const actualVarying = differentObjectKeys(buildParameters(against), buildParameters(entry));
  const declaredVarying = [...(proof.varyingBuildParameters ?? [])].sort();
  if (actualVarying.length === 0) {
    return { controlled: false, reason: 'provenance-build-parameters-do-not-differ' };
  }
  if (stableJson(actualVarying) !== stableJson(declaredVarying)) {
    return {
      controlled: false,
      reason: 'provenance-varying-build-parameters-mismatch',
      actualVarying,
      declaredVarying,
    };
  }
  return {
    controlled: true,
    kind: proof.kind,
    evidence: proof.evidence,
    varyingBuildParameters: actualVarying,
    againstBuildParameters: buildParameters(against),
    entryBuildParameters: buildParameters(entry),
  };
}

function manifestControl(entry, entryById, root) {
  const declaration = entry.ablation;
  const against = entryById.get(declaration?.against);
  const reasons = [];
  if (!declaration || typeof declaration !== 'object') reasons.push('ablation-declaration-invalid');
  if (!against) reasons.push('against-entry-missing');
  if (!AXIS_ORDER.includes(declaration?.axis)) reasons.push('axis-invalid');
  const coupled = Array.isArray(declaration?.coupled) ? declaration.coupled : [];
  if (coupled.some((axis) => !AXIS_ORDER.includes(axis) || axis === declaration?.axis)
    || new Set(coupled).size !== coupled.length) reasons.push('coupled-axes-invalid');
  if (!against || reasons.includes('axis-invalid')) {
    return { status: 'invalid', reasons, against, changed: [], coupled, provenance: null };
  }
  try {
    validateCoordinates(entry.coordinates, entry.id);
    validateCoordinates(against.coordinates, against.id);
  } catch (error) {
    reasons.push(error.message);
  }
  if (!entry.coordinates || !against.coordinates) reasons.push('coordinates-unclassified');
  const changed = changedAxes(against.coordinates, entry.coordinates);
  const declaredChanged = [declaration.axis, ...coupled]
    .filter((axis) => AXIS_ORDER.includes(axis))
    .sort((left, right) => AXIS_ORDER.indexOf(left) - AXIS_ORDER.indexOf(right));
  if (stableJson(changed) !== stableJson(declaredChanged)) {
    reasons.push('coordinate-delta-is-not-declared-axis-set');
  }
  const actualDelta = entry.coordinates && against.coordinates
    ? `${coordinateValue(against.coordinates, declaration.axis)}→${coordinateValue(entry.coordinates, declaration.axis)}`
    : null;
  if (declaration.delta !== actualDelta) reasons.push('delta-label-does-not-match-coordinates');
  if (entry.framework !== against.framework
    || entry.provenance?.source !== against.provenance?.source) {
    reasons.push('cross-codebase-pair-cannot-yield-axis-effect');
  }
  if (!entry.fixture || entry.fixture !== against.fixture) reasons.push('fixture-mismatch');
  const provenance = provenanceControl(entry, against, declaration, root);
  if (!provenance.controlled) reasons.push(provenance.reason);
  if (reasons.length) {
    return { status: 'invalid', reasons: [...new Set(reasons)], against, changed, coupled, provenance };
  }
  return {
    status: coupled.length ? 'coupled' : 'validated',
    reasons: [],
    against,
    changed,
    coupled,
    provenance,
  };
}

function runControl(runSource, entry, against) {
  const records = runSource.run.records.filter((record) =>
    record.entry === entry.id || record.entry === against.id);
  const byEntry = (id) => records.filter((record) => record.entry === id
    && record.rankingEligible !== false);
  const candidate = byEntry(entry.id);
  const baseline = byEntry(against.id);
  if (candidate.length === 0 || baseline.length === 0) {
    return { status: 'invalid', reason: 'pair-not-present-in-one-run' };
  }
  const candidateKeys = candidate.map(matrixKey).sort();
  const baselineKeys = baseline.map(matrixKey).sort();
  if (stableJson(candidateKeys) !== stableJson(baselineKeys)) {
    return { status: 'invalid', reason: 'record-matrix-mismatch' };
  }
  const pipeline = pipelinePairControl(records);
  if (!pipeline.controlled) return { status: 'invalid', reason: pipeline.reason };
  const expectedCommits = [entry, against].filter((item) =>
    runSource.run.meta.entryCommits?.[item.id] != null);
  if (expectedCommits.some((item) =>
    runSource.run.meta.entryCommits[item.id] !== item.provenance?.commit)) {
    return { status: 'invalid', reason: 'run-entry-commit-mismatch' };
  }
  const cells = candidateKeys.length;
  const minimumReps = Math.min(...candidate.concat(baseline).map((record) =>
    finiteObservations(record).length));
  return {
    status: 'controlled',
    sourceRunFile: runSource.file,
    generatedAt: runSource.run.meta.generatedAt,
    machineId: runSource.run.meta.machine.id,
    harnesses: [...new Set(candidate.map((record) => record.harness))].sort(),
    scales: [...new Set(candidate.map((record) => record.scale))].sort((a, b) => a - b),
    cells,
    minimumReps,
    candidate,
    baseline,
  };
}

function betterRun(candidate, current) {
  if (!current) return true;
  if (candidate.cells !== current.cells) return candidate.cells > current.cells;
  if (candidate.minimumReps !== current.minimumReps) return candidate.minimumReps > current.minimumReps;
  if (candidate.generatedAt !== current.generatedAt) return candidate.generatedAt > current.generatedAt;
  return candidate.sourceRunFile > current.sourceRunFile;
}

function selectControlledRun(runs, entry, against) {
  let selected = null;
  const rejected = [];
  for (const runSource of runs) {
    const control = runControl(runSource, entry, against);
    if (control.status !== 'controlled') {
      if (runSource.run.records.some((record) => record.entry === entry.id || record.entry === against.id)) {
        rejected.push({ sourceRunFile: runSource.file, reason: control.reason });
      }
      continue;
    }
    if (betterRun(control, selected)) selected = control;
  }
  return { selected, rejected };
}

const pipelineTimeMetric = (segment) =>
  `papi${segment[0].toUpperCase()}${segment.slice(1)}Time`;

/**
 * Read compact, immutable campaign observations used only by the Lab axis
 * view. These files keep raw per-repetition values; records and residuals are
 * rebuilt here and never enter the repository's ranking/history run stream.
 */
export function loadAxisObservationRuns({ root }) {
  const dir = path.join(root, 'results/axis-runs');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((file) => file.endsWith('.json')).sort().map((file) => {
    const source = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    if (source.schemaVersion !== 'axis-observation-v1') {
      throw new Error(`${file}: unsupported axis observation schema ${source.schemaVersion}`);
    }
    if (!source.meta?.reportable) throw new Error(`${file}: axis observation is not reportable`);
    if (!Number.isInteger(source.scale) || source.scale < 0) {
      throw new Error(`${file}: invalid axis observation scale`);
    }
    const records = [];
    const entryCommits = {};
    for (const [entryId, cell] of Object.entries(source.cells ?? {})) {
      const operationSamples = cell.operationSamples;
      if (!Array.isArray(operationSamples) || operationSamples.length === 0
        || operationSamples.some((value) => !Number.isFinite(value) || value < 0)) {
        throw new Error(`${file}: ${entryId} has invalid operation samples`);
      }
      const detailSamples = operationSamples.map(() => cell.control);
      const base = {
        suite: 'pipeline',
        harness: 'web',
        environment: `lynx-for-web@${source.meta.webCore}`,
        entry: entryId,
        workload: 'startup',
        scale: source.scale,
        unit: 'ms',
        dnfCount: 0,
        failures: [],
        detailSamples,
        axisObservationSource: source.sourceArtifact,
      };
      records.push(deriveRecord({
        ...base,
        metric: 'operationTime',
        boundary: 'view-attach-to-first-content-with-element-papi-attribution',
        samples: operationSamples,
      }));
      const operationControl = pipelineRecordControl(records.at(-1));
      if (!operationControl.controlled) {
        throw new Error(`${file}: ${entryId} ${operationControl.reason}`);
      }
      const segmentRecords = PAPI_SEGMENTS.map((segment) => {
        const samples = cell.segmentSamples?.[segment];
        if (!Array.isArray(samples) || samples.length !== operationSamples.length
          || samples.some((value) => !Number.isFinite(value) || value < 0)) {
          throw new Error(`${file}: ${entryId} has invalid ${segment} samples`);
        }
        return deriveRecord({
          ...base,
          metric: pipelineTimeMetric(segment),
          boundary: BOUNDARIES.papiSelfTime,
          samples,
        });
      });
      records.push(...segmentRecords);
      const residualSamples = operationSamples.map((operationMs, index) => {
        const papiMs = segmentRecords.reduce((sum, record) => sum + record.samples[index], 0);
        if (papiMs > operationMs + 0.05) {
          throw new Error(`${file}: ${entryId} PAPI time exceeds operation at sample ${index}`);
        }
        return Math.max(0, operationMs - papiMs);
      });
      records.push(deriveRecord({
        ...base,
        metric: 'outsidePapiTime',
        boundary: BOUNDARIES.pipelineResidual,
        samples: residualSamples,
        derivedFrom: {
          kind: 'aligned-sample-subtraction',
          metrics: ['operationTime', ...PAPI_SEGMENTS.map(pipelineTimeMetric)],
        },
      }));
      entryCommits[entryId] = source.bundleCommit;
    }
    return {
      file: `axis-runs/${file}`,
      run: {
        meta: {
          ...source.meta,
          entryCommits,
          sourceArtifact: source.sourceArtifact,
          fixture: source.fixture,
        },
        records,
      },
    };
  });
}

function effectForRecords(candidate, baseline) {
  const candidateValues = finiteObservations(candidate);
  const baselineValues = finiteObservations(baseline);
  if (!Number.isFinite(candidate.median) || !Number.isFinite(baseline.median)
    || candidateValues.length === 0 || baselineValues.length === 0) return null;
  const medianDelta = candidate.median - baseline.median;
  const ci95HalfWidth = Number.isFinite(candidate.ci95) && Number.isFinite(baseline.ci95)
    ? candidate.ci95 + baseline.ci95
    : null;
  const rangesDisjoint = Number.isFinite(candidate.min) && Number.isFinite(candidate.max)
    && Number.isFinite(baseline.min) && Number.isFinite(baseline.max)
    ? candidate.min > baseline.max || baseline.min > candidate.max
    : null;
  return {
    suite: candidate.suite,
    harness: candidate.harness,
    environment: candidate.environment,
    workload: candidate.workload,
    scale: candidate.scale,
    metric: candidate.metric,
    boundary: candidate.boundary,
    unit: candidate.unit,
    against: {
      median: baseline.median,
      ci95: baseline.ci95,
      min: baseline.min,
      max: baseline.max,
      n: baselineValues.length,
    },
    entry: {
      median: candidate.median,
      ci95: candidate.ci95,
      min: candidate.min,
      max: candidate.max,
      n: candidateValues.length,
    },
    medianDelta,
    relativeDelta: baseline.median === 0 ? null : medianDelta / baseline.median,
    ci95: ci95HalfWidth == null ? null : {
      low: medianDelta - ci95HalfWidth,
      high: medianDelta + ci95HalfWidth,
      method: 'conservative-sum-of-source-ci95-half-widths',
    },
    rangesDisjoint,
    direction: medianDelta === 0 ? 'zero' : medianDelta > 0 ? 'positive' : 'negative',
  };
}

function effectsFromRun(control) {
  const baselineByKey = new Map(control.baseline.map((record) => [matrixKey(record), record]));
  return control.candidate.map((candidate) =>
    effectForRecords(candidate, baselineByKey.get(matrixKey(candidate)))).filter(Boolean);
}

function consistencyKey(effect) {
  return [
    effect.suite,
    effect.harness,
    effect.environment,
    effect.workload,
    effect.scale,
    effect.metric,
    effect.boundary,
    effect.unit,
  ].join('|');
}

function directionConsistency(pairs) {
  const groups = new Map();
  for (const pair of pairs.filter((candidate) => candidate.attributable)) {
    for (const effect of pair.effects) {
      const key = consistencyKey(effect);
      const group = groups.get(key) ?? {
        key,
        suite: effect.suite,
        harness: effect.harness,
        environment: effect.environment,
        workload: effect.workload,
        scale: effect.scale,
        metric: effect.metric,
        boundary: effect.boundary,
        unit: effect.unit,
        positive: 0,
        negative: 0,
        zero: 0,
      };
      group[effect.direction] += 1;
      groups.set(key, group);
    }
  }
  return [...groups.values()].map((group) => ({
    ...group,
    pairCount: group.positive + group.negative + group.zero,
    consistent: group.positive === 0 || group.negative === 0,
  })).sort((left, right) => left.key.localeCompare(right.key));
}

function findCeilings(entries, entryById) {
  const ceilings = new Map();
  const diagnostics = [];
  for (const ceiling of entries.filter((entry) => entry.ceilingFor != null)) {
    const target = entryById.get(ceiling.ceilingFor);
    const reasons = [];
    if (!target) reasons.push('ceiling-target-missing');
    if ((ceiling.tier ?? 'featured') !== 'lab') reasons.push('ceiling-must-be-lab');
    if (target && stableJson(ceiling.coordinates) !== stableJson(target.coordinates)) {
      reasons.push('ceiling-coordinate-mismatch');
    }
    if (target && ceiling.fixture !== target.fixture) reasons.push('ceiling-fixture-mismatch');
    if (target && (ceiling.framework !== target.framework
      || ceiling.provenance?.source !== target.provenance?.source)) {
      reasons.push('ceiling-codebase-mismatch');
    }
    diagnostics.push({ ceiling: ceiling.id, for: ceiling.ceilingFor, valid: reasons.length === 0, reasons });
    if (reasons.length === 0) ceilings.set(ceiling.ceilingFor, ceiling);
  }
  return { ceilings, diagnostics };
}

function decomposeWithCeilings(pair, runs, ceilingByEntry) {
  const againstCeiling = ceilingByEntry.get(pair.against);
  const entryCeiling = ceilingByEntry.get(pair.entry);
  const residue = {};
  for (const [side, point, ceiling] of [
    ['against', pair.against, againstCeiling],
    ['entry', pair.entry, entryCeiling],
  ]) {
    if (!ceiling) continue;
    const control = selectControlledRun(runs, pair.entryObjects.get(point), ceiling).selected;
    if (control) residue[side] = {
      ceilingEntry: ceiling.id,
      sourceRunFile: control.sourceRunFile,
      effects: effectsFromRun(control),
    };
  }
  let axisEffect = null;
  if (pair.attributable && againstCeiling && entryCeiling) {
    const control = selectControlledRun(runs, entryCeiling, againstCeiling).selected;
    if (control) axisEffect = {
      againstCeiling: againstCeiling.id,
      entryCeiling: entryCeiling.id,
      sourceRunFile: control.sourceRunFile,
      effects: effectsFromRun(control),
    };
  }
  return {
    axisEffect,
    implementationResidue: residue,
    separated: axisEffect != null || Object.keys(residue).length > 0,
  };
}

export function buildAxisEffectView({ entries, runs, root = null }) {
  const entryById = new Map(entries.map((entry) => [entry.id, entry]));
  const { ceilings, diagnostics: ceilingDiagnostics } = findCeilings(entries, entryById);
  const pairs = [];
  for (const entry of entries.filter((candidate) => candidate.ablation != null)) {
    const manifest = manifestControl(entry, entryById, root);
    const pair = {
      id: `${entry.ablation?.against ?? '<missing>'}→${entry.id}`,
      tier: 'lab',
      against: entry.ablation?.against ?? null,
      entry: entry.id,
      axis: entry.ablation?.axis ?? null,
      delta: entry.ablation?.delta ?? null,
      coupled: manifest.coupled,
      coordinates: {
        against: manifest.against?.coordinates ?? null,
        entry: entry.coordinates ?? null,
        context: entry.coordinates == null || manifest.against?.coordinates == null
          ? null
          : Object.fromEntries(AXIS_ORDER.filter((axis) =>
            axis !== entry.ablation.axis && !manifest.coupled.includes(axis)).map((axis) => [
            axis,
            coordinateValue(entry.coordinates, axis),
          ])),
      },
      validation: {
        status: manifest.status,
        reasons: manifest.reasons,
        changedAxes: manifest.changed,
        provenance: manifest.provenance,
        run: null,
        rejectedRuns: [],
      },
      attributable: false,
      effects: [],
      descriptiveEffects: [],
      ceiling: { axisEffect: null, implementationResidue: {}, separated: false },
    };
    if (manifest.status === 'validated' || manifest.status === 'coupled') {
      const run = selectControlledRun(runs, entry, manifest.against);
      pair.validation.run = run.selected == null ? null : {
        sourceRunFile: run.selected.sourceRunFile,
        generatedAt: run.selected.generatedAt,
        machineId: run.selected.machineId,
        harnesses: run.selected.harnesses,
        scales: run.selected.scales,
        cells: run.selected.cells,
        minimumReps: run.selected.minimumReps,
      };
      pair.validation.rejectedRuns = run.rejected;
      if (!run.selected) {
        pair.validation.status = 'invalid';
        pair.validation.reasons.push('no-controlled-same-run-matrix');
      } else {
        pair.descriptiveEffects = effectsFromRun(run.selected);
        if (manifest.status === 'validated') {
          pair.attributable = true;
          pair.effects = pair.descriptiveEffects;
        }
      }
    }
    Object.defineProperty(pair, 'entryObjects', {
      enumerable: false,
      value: entryById,
    });
    pair.ceiling = decomposeWithCeilings(pair, runs, ceilings);
    pairs.push(pair);
  }
  const axes = AXIS_ORDER.map((axis) => {
    const axisPairs = pairs.filter((pair) => pair.axis === axis);
    const pipelineEffects = axisPairs.flatMap((pair) => pair.effects)
      .filter((effect) => effect.suite === 'pipeline');
    return {
      axis,
      pairCount: axisPairs.length,
      attributablePairCount: axisPairs.filter((pair) => pair.attributable).length,
      pairs: axisPairs,
      directionConsistency: directionConsistency(axisPairs),
      instrument: axis === 'staging' ? {
        issue: 'https://github.com/Huxpro/octane/issues/200',
        status: pipelineEffects.length > 0 ? 'observed' : 'pending',
        effectCount: pipelineEffects.length,
      } : null,
    };
  });
  return {
    version: AXIS_EFFECT_VIEW_VERSION,
    tier: 'lab',
    derivedOnly: true,
    policy: {
      crossFrameworkPointsAreDescriptiveOnly: true,
      uncontrolledPairsAreAttributable: false,
      coupledPairsAreAttributable: false,
      model: 'effect-tables-only',
      interactionFitting: false,
      localCoordinateContextRequired: true,
      ceilingAndImplementationResidueSeparated: true,
    },
    classifiedEntryIds: entries.filter((entry) => entry.coordinates != null)
      .map((entry) => entry.id).sort(),
    unclassifiedEntryIds: entries.filter((entry) => entry.coordinates == null)
      .map((entry) => entry.id).sort(),
    ceilingDiagnostics,
    pairs,
    axes,
  };
}
