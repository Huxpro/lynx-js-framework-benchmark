import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  canonicalMetricKey,
  deriveRecord,
} from '@lynx-bench/shared/schema';

import { validateCampaignMetadata } from './campaign.mjs';
import { pairedAbbaStatistics, practicalThreshold, confirmedEffect } from './abba-stats.mjs';
import { expectedVueVaporCoverage } from './vue-vapor-coverage.mjs';

const SHA256 = /^[a-f0-9]{64}$/;
const LEGS = ['A1', 'B1', 'B2', 'A2'];

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}

const canonical = (value) => JSON.stringify(canonicalValue(value));

function regularFile(file, label) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file`);
  }
}

function readPinnedJson(root, descriptor, label) {
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
    throw new Error(`${label} descriptor must be an object`);
  }
  if (typeof descriptor.path !== 'string' || descriptor.path.length === 0) {
    throw new Error(`${label} path is required`);
  }
  if (!SHA256.test(descriptor.sha256)) {
    throw new Error(`${label} sha256 must be lowercase SHA256`);
  }
  const file = path.resolve(root, descriptor.path);
  regularFile(file, label);
  const bytes = fs.readFileSync(file);
  if (sha256(bytes) !== descriptor.sha256) {
    throw new Error(`${label} sha256 mismatch`);
  }
  return { file, value: JSON.parse(bytes), sha256: descriptor.sha256 };
}

function exactObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function formalCohort(meta) {
  const {
    loadAverage: _loadAverage,
    deviceClockOffsetMs: _deviceClockOffsetMs,
    deviceClockCalibrationRttMs: _deviceClockCalibrationRttMs,
    ...stableMachine
  } = meta.machine ?? {};
  const nativeCohort = meta.nativeCohort == null ? null : {
    schemaVersion: meta.nativeCohort.schemaVersion,
    environment: meta.nativeCohort.environment,
    adapterFingerprint: meta.nativeCohort.adapterFingerprint,
    benchmarkFingerprint: meta.nativeCohort.benchmarkFingerprint,
  };
  return {
    machine: stableMachine,
    browser: meta.browser ?? null,
    nativeCohort,
    benchmarkWorktree: meta.benchmarkWorktree,
  };
}

function entryArtifact(meta, record) {
  const artifact = meta.entryArtifacts?.[record.entry];
  if (!artifact) throw new Error(`missing entry artifact for ${record.entry}`);
  return artifact;
}

function authorityMetric(record) {
  if (record.suite === 'table' && record.workload !== 'memory') return 'latency';
  if (record.suite === 'startup') return 'fcp';
  return record.metric;
}

function attemptValues(record) {
  return record.attempts.filter(({ dnf }) => !dnf).map(({ value }) => value);
}

function validateRawRun(run, expected, label) {
  if (run.schemaVersion !== 2) throw new Error(`${label} outer schema must be v2`);
  const formal = validateCampaignMetadata(run.meta, label);
  if (!formal) throw new Error(`${label} lacks campaign-v1 metadata`);
  const campaign = formal.campaign;
  for (const [key, value] of Object.entries(expected)) {
    if (campaign[key] !== value) {
      throw new Error(`${label} campaign ${key} mismatch`);
    }
  }
  if (!Array.isArray(run.records) || run.records.length === 0) {
    throw new Error(`${label} records must be non-empty`);
  }
  const records = run.records.map((record, index) => {
    if (record.suite !== 'bundle' && record.workload !== 'memory') {
      if (!Array.isArray(record.attempts)) {
        throw new Error(`${label} record ${index} lacks lossless attempts`);
      }
    }
    const derived = deriveRecord(record);
    if (derived.suite !== 'bundle' && derived.workload !== 'memory') {
      const matrixCells = [
        ...formal.resolvedMatrix.table,
        ...formal.resolvedMatrix.startup,
      ];
      const cell = matrixCells.find((candidate) =>
        candidate.workload === derived.workload && candidate.scale === derived.scale);
      if (!cell || derived.attempts.length !== cell.reps) {
        throw new Error(`${label} record ${index} attempts do not match resolved matrix`);
      }
    }
    return derived;
  });
  const entries = new Set(records.map(({ entry }) => entry));
  if (entries.size !== 1) throw new Error(`${label} must contain exactly one entry`);
  const entry = [...entries][0];
  const artifact = entryArtifact(run.meta, records[0]);
  if (artifact.receiptSha256 == null || artifact.fingerprint == null) {
    throw new Error(`${label} receipt identity is incomplete`);
  }
  return { run, records, campaign, entry, artifact };
}

function compareLegs(legs, label) {
  const first = legs.A1;
  for (const leg of LEGS) {
    const current = legs[leg];
    if (canonical(current.run.meta.resolvedMatrix) !== canonical(first.run.meta.resolvedMatrix)) {
      throw new Error(`${label} resolved matrix mismatch`);
    }
    if (canonical(formalCohort(current.run.meta)) !== canonical(formalCohort(first.run.meta))) {
      throw new Error(`${label} cohort mismatch`);
    }
  }
  for (const [left, right] of [['A1', 'A2'], ['B1', 'B2']]) {
    if (legs[left].entry !== legs[right].entry) {
      throw new Error(`${label} ${left}/${right} entry mismatch`);
    }
    if (canonical(legs[left].artifact) !== canonical(legs[right].artifact)) {
      throw new Error(`${label} ${left}/${right} receipt mismatch`);
    }
  }
  const times = LEGS.map((leg) => Date.parse(legs[leg].run.meta.startedAt));
  if (times.some(Number.isNaN) || !times.every((time, index) => index === 0 || time > times[index - 1])) {
    throw new Error(`${label} legs are not in strict A1/B1/B2/A2 time order`);
  }
}

function recordsByKey(leg) {
  const byKey = new Map();
  for (const record of leg.records) {
    const key = canonicalMetricKey(record, leg.campaign.variant);
    if (byKey.has(key)) throw new Error(`duplicate raw metric key ${key}`);
    byKey.set(key, record);
  }
  return byKey;
}

function analyzeCell(key, records, comparisonId) {
  const authority = authorityMetric(records.A1);
  if (records.A1.suite === 'bundle') {
    const values = Object.fromEntries(LEGS.map((leg) => [leg, records[leg].value]));
    if (values.A1 !== values.A2 || values.B1 !== values.B2) {
      throw new Error(`bundle duplicate drift for ${key}`);
    }
    const threshold = Math.min(Math.abs(values.A1) * 0.01, 1024);
    return {
      kind: 'bundle',
      a: values.A1,
      b: values.B1,
      deltaBytes: values.B1 - values.A1,
      confirmed: Math.abs(values.B1 - values.A1) >= threshold,
    };
  }
  if (records.A1.workload === 'memory') {
    return {
      kind: 'heap',
      a1: [records.A1.value],
      b1: [records.B1.value],
      b2: [records.B2.value],
      a2: [records.A2.value],
      confirmed: false,
    };
  }
  const attempts = Object.fromEntries(LEGS.map((leg) => [leg, records[leg].attempts]));
  const lengths = new Set(LEGS.map((leg) => attempts[leg].length));
  if (lengths.size !== 1) throw new Error(`attempt count mismatch for ${key}`);
  const dnf = LEGS.some((leg) => attempts[leg].some((attempt) => attempt.dnf));
  if (dnf) {
    return {
      kind: 'attempts',
      integrityStatus: 'dnf',
      dnf: Object.fromEntries(LEGS.map((leg) => [
        leg,
        attempts[leg].filter((attempt) => attempt.dnf).map(({ index, errorKind }) => ({
          index,
          errorKind,
        })),
      ])),
      confirmed: false,
    };
  }
  const stats = pairedAbbaStatistics({
    a1: attemptValues(records.A1),
    b1: attemptValues(records.B1),
    b2: attemptValues(records.B2),
    a2: attemptValues(records.A2),
    comparisonId,
    canonicalKey: key,
  });
  const threshold = practicalThreshold(records.A1);
  return {
    kind: 'attempts',
    integrityStatus: 'valid',
    stats,
    practicalThreshold: threshold,
    confirmed: confirmedEffect(stats, threshold),
  };
}

function analyzeSequence(sequence, root, comparisonId) {
  exactObject(sequence, 'sequence');
  const legs = {};
  const files = new Set();
  for (const leg of LEGS) {
    const descriptor = sequence.legs?.[leg];
    const pinned = readPinnedJson(root, descriptor, `${sequence.id} ${leg}`);
    if (files.has(pinned.file)) {
      throw new Error(`${sequence.id} legs must use four distinct raw files`);
    }
    files.add(pinned.file);
    const { value } = pinned;
    legs[leg] = validateRawRun(value, {
      comparisonId,
      id: descriptor.campaignId,
      phase: sequence.phase,
      leg,
      sequenceIndex: LEGS.indexOf(leg),
      variant: sequence.variant,
    }, `${sequence.id} ${leg}`);
    if (value.meta.runLabel !== descriptor.runLabel) {
      throw new Error(`${sequence.id} ${leg} run label mismatch`);
    }
  }
  compareLegs(legs, sequence.id);
  const maps = Object.fromEntries(LEGS.map((leg) => [leg, recordsByKey(legs[leg])]));
  const common = [...maps.A1.keys()].filter((key) => LEGS.every((leg) => maps[leg].has(key)));
  const missingWithinSequence = [...new Set(
    LEGS.flatMap((leg) => [...maps[leg].keys()])
  )].filter((key) => !LEGS.every((leg) => maps[leg].has(key))).sort();
  if (missingWithinSequence.length) {
    throw new Error(`${sequence.id} leg coverage mismatch`);
  }
  const analyzedCells = Object.fromEntries(common.sort().map((key) => [
    key,
    analyzeCell(key, Object.fromEntries(LEGS.map((leg) => [leg, maps[leg].get(key)])), comparisonId),
  ]));
  const groups = new Map();
  for (const key of common) {
    const tuple = JSON.parse(key);
    const groupKey = JSON.stringify(tuple.slice(0, 6));
    const group = groups.get(groupKey) ?? [];
    group.push(key);
    groups.set(groupKey, group);
  }
  for (const keys of groups.values()) {
    const authorityKey = keys.find((key) => {
      const tuple = JSON.parse(key);
      const metric = tuple[6];
      const suite = tuple[1];
      const workload = tuple[4];
      return metric === (suite === 'startup' ? 'fcp' : workload === 'memory' ? metric : 'latency');
    });
    if (!authorityKey) continue;
    if (analyzedCells[authorityKey].integrityStatus === 'dnf') {
      for (const key of keys) {
        analyzedCells[key] = {
          ...analyzedCells[key],
          integrityStatus: 'dnf',
          authorityDnf: authorityKey,
          confirmed: false,
        };
      }
    }
  }
  return {
    id: sequence.id,
    phase: sequence.phase,
    variant: sequence.variant,
    harness: sequence.harness,
    environment: legs.A1.records[0].environment,
    keys: common.sort(),
    cells: analyzedCells,
  };
}

export function analyzeAbbaManifest(manifest, { root = process.cwd() } = {}) {
  exactObject(manifest, 'manifest');
  if (manifest.schemaVersion !== 1 || manifest.status !== 'complete') {
    throw new Error('manifest must be complete schema v1');
  }
  if (typeof manifest.comparisonId !== 'string' || manifest.comparisonId.length === 0) {
    throw new Error('manifest comparisonId is required');
  }
  if (!Array.isArray(manifest.sequences) || manifest.sequences.length === 0) {
    throw new Error('manifest sequences must be non-empty');
  }
  const sequenceIds = manifest.sequences.map(({ id }) => id);
  if (new Set(sequenceIds).size !== sequenceIds.length) {
    throw new Error('manifest sequence IDs must be unique');
  }
  const sequences = manifest.sequences.map((sequence) =>
    analyzeSequence(sequence, root, manifest.comparisonId));
  const environments = {
    webEnvironment: sequences.find(({ harness }) => harness === 'web')?.environment
      ?? 'lynx-for-web',
    nativeEnvironment: sequences.find(({ harness }) => harness === 'native')?.environment,
  };
  const expected = expectedVueVaporCoverage(environments);
  const cells = {};
  for (const sequence of sequences) {
    for (const [key, cell] of Object.entries(sequence.cells)) {
      if (!Object.hasOwn(cells, key)) {
        cells[key] = cell;
        continue;
      }
      const current = cells[key];
      if (cell.kind === 'bundle' && current.kind === 'bundle') {
        if (canonical(cell) !== canonical(current)) {
          throw new Error(`bundle duplicate drift across sequences for ${key}`);
        }
        continue;
      }
      if (cell.kind === 'heap' && current.kind === 'heap') {
        for (const leg of ['a1', 'b1', 'b2', 'a2']) {
          current[leg].push(...cell[leg]);
        }
        continue;
      }
      throw new Error(`duplicate analyzed key ${key}`);
    }
  }
  for (const [key, cell] of Object.entries(cells)) {
    if (cell.kind === 'heap') {
      const aCount = cell.a1.length + cell.a2.length;
      const bCount = cell.b1.length + cell.b2.length;
      if (aCount < 5 || bCount < 5
        || ['a1', 'b1', 'b2', 'a2'].some((leg) =>
          cell[leg].some((value) => !Number.isFinite(value)))) {
        throw new Error(`heap requires at least five observations per arm for ${key}`);
      }
      cell.stats = pairedAbbaStatistics({
        a1: cell.a1,
        b1: cell.b1,
        b2: cell.b2,
        a2: cell.a2,
        comparisonId: manifest.comparisonId,
        canonicalKey: key,
      });
      cell.practicalThreshold = 0.05;
      cell.confirmed = confirmedEffect(cell.stats, cell.practicalThreshold);
    }
  }
  const actualKeys = Object.keys(cells).sort();
  const missingKeys = expected.keys.filter((key) => !Object.hasOwn(cells, key));
  const extraKeys = actualKeys.filter((key) => !expected.keys.includes(key));
  const dnfKeys = actualKeys.filter((key) => cells[key].integrityStatus === 'dnf');
  const integrityStatus = missingKeys.length || extraKeys.length || dnfKeys.length
    ? 'invalid'
    : 'valid';
  const confirmed = actualKeys.filter((key) => cells[key].confirmed);
  return {
    schemaVersion: 1,
    comparisonId: manifest.comparisonId,
    integrityStatus,
    performanceStatus: integrityStatus === 'valid'
      ? (confirmed.length ? 'effects-confirmed' : 'no-confirmed-effect')
      : 'not-evaluated',
    coverage: {
      expected: expected.keys.length,
      actual: actualKeys.length,
      missingKeys,
      extraKeys,
      dnfKeys,
    },
    confirmedKeys: confirmed,
    cells: Object.fromEntries(actualKeys.map((key) => [key, cells[key]])),
  };
}

export function readAndAnalyzeAbbaManifest(manifestPath) {
  const file = path.resolve(manifestPath);
  regularFile(file, 'analysis manifest');
  const manifest = JSON.parse(fs.readFileSync(file));
  return analyzeAbbaManifest(manifest, { root: path.dirname(file) });
}
