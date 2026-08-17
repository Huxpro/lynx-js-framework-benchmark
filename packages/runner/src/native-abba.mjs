import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { validateFormalRun } from './run-files.mjs';

const LEGS = ['A1', 'B1', 'B2', 'A2'];
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function atomic(file, value) {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  fs.renameSync(temporary, file);
}

function verifyRecorded(root, leg, recorded, expectedCohort) {
  const file = path.resolve(root, recorded.path);
  const bytes = fs.readFileSync(file);
  if (sha256(bytes) !== recorded.sha256) throw new Error(`${leg} raw hash mismatch`);
  const run = JSON.parse(bytes);
  validateFormalRun(run, `${leg} Native raw`);
  if (run.meta.nativeCohort?.fingerprint !== expectedCohort) {
    throw new Error(`${leg} Native cohort mismatch`);
  }
  return run;
}

export async function executeNativeAbbaPlan({
  plan,
  root,
  manifestPath,
  lease,
  runLeg,
  verifyInputs,
  resume = false,
  log = () => {},
}) {
  if (!Array.isArray(plan) || plan.length !== 4
    || plan.map(({ leg }) => leg).join(',') !== LEGS.join(',')) {
    throw new Error('Native ABBA plan must be exact A1/B1/B2/A2');
  }
  if (!lease || typeof lease.dispose !== 'function'
    || typeof lease.cohortFingerprint !== 'string') {
    throw new Error('Native ABBA requires one leased device cohort');
  }
  const snapshot = {
    schemaVersion: 1,
    comparisonId: plan[0].comparisonId,
    id: `${plan[0].comparisonId}-${plan[0].phase}-native`,
    variant: plan[0].variant,
    harness: 'native',
    phase: plan[0].phase,
    cohortFingerprint: lease.cohortFingerprint,
    legs: Object.fromEntries(plan.map((step) => [step.leg, step])),
  };
  let manifest;
  if (resume) {
    manifest = JSON.parse(fs.readFileSync(manifestPath));
    if (manifest.status !== 'incomplete') throw new Error('Native resume requires incomplete manifest');
    if (JSON.stringify(manifest.plan) !== JSON.stringify(snapshot)) {
      throw new Error('Native resume plan or cohort changed');
    }
  } else {
    if (fs.existsSync(manifestPath)) throw new Error('Native manifest already exists');
    manifest = {
      schemaVersion: 1,
      status: 'incomplete',
      comparisonId: snapshot.comparisonId,
      plan: snapshot,
      legs: {},
    };
    atomic(manifestPath, manifest);
  }

  let primaryError = null;
  try {
    let missing = false;
    for (const leg of LEGS) {
      if (!manifest.legs[leg]) missing = true;
      else if (missing) throw new Error('Native resume legs must form a contiguous prefix');
    }
    for (const step of plan) {
      await verifyInputs(step, lease);
      if (manifest.legs[step.leg]) {
        verifyRecorded(root, step.leg, manifest.legs[step.leg], lease.cohortFingerprint);
        await verifyInputs(step, lease);
        log(`[native-abba] resume skip ${step.leg}`);
        continue;
      }
      const file = await runLeg(step, lease);
      const bytes = fs.readFileSync(file);
      const run = JSON.parse(bytes);
      validateFormalRun(run, `${step.leg} Native raw`);
      if (run.meta.nativeCohort?.fingerprint !== lease.cohortFingerprint) {
        throw new Error(`${step.leg} changed Native cohort`);
      }
      await verifyInputs(step, lease);
      manifest.legs[step.leg] = {
        path: path.relative(root, file).split(path.sep).join('/'),
        sha256: sha256(bytes),
        runLabel: run.meta.runLabel,
        campaignId: run.meta.campaign.id,
      };
      atomic(manifestPath, manifest);
    }
    manifest.status = 'complete';
    manifest.sequences = [{
      id: snapshot.id,
      variant: snapshot.variant,
      harness: 'native',
      phase: snapshot.phase,
      legs: Object.fromEntries(LEGS.map((leg) => [leg, manifest.legs[leg]])),
    }];
    atomic(manifestPath, manifest);
    return manifest;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await lease.dispose();
    } catch (cleanupError) {
      if (primaryError) {
        throw new AggregateError(
          [primaryError, cleanupError],
          'Native ABBA failed and lease cleanup also failed',
          { cause: primaryError },
        );
      }
      throw cleanupError;
    }
  }
}
