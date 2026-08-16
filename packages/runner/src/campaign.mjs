const LEG_INDEX = new Map([
  ['A1', 0],
  ['B1', 1],
  ['B2', 2],
  ['A2', 3],
]);
const PHASES = new Set(['table', 'startup', 'heap']);

function nonEmpty(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

export function campaignArgsPresent(args) {
  return [
    'campaign-id',
    'comparison-id',
    'phase',
    'leg',
    'sequence-index',
  ].filter((key) => Object.hasOwn(args, key));
}

export function resolveCampaign({
  args,
  labRoot,
  entries,
  verifiedLabEntries,
  harness,
  matrix,
  runLabel,
}) {
  const present = campaignArgsPresent(args);
  if (present.length === 0) return null;
  if (present.length !== 5) {
    throw new Error('formal campaign arguments are all-or-none');
  }
  if (!labRoot || !verifiedLabEntries) {
    throw new Error('formal campaigns require --lab-root and receipted entries');
  }
  if (entries.length !== 1) {
    throw new Error('formal campaigns require exactly one entry');
  }
  nonEmpty(runLabel, 'formal campaign run label');
  const id = nonEmpty(args['campaign-id'], '--campaign-id');
  const comparisonId = nonEmpty(args['comparison-id'], '--comparison-id');
  const phase = nonEmpty(args.phase, '--phase');
  if (!PHASES.has(phase)) throw new Error(`unknown campaign phase: ${phase}`);
  const leg = nonEmpty(args.leg, '--leg');
  if (!LEG_INDEX.has(leg)) throw new Error(`unknown campaign leg: ${leg}`);
  const sequenceIndex = Number(args['sequence-index']);
  if (!Number.isSafeInteger(sequenceIndex) || sequenceIndex < 0) {
    throw new Error('--sequence-index must be a non-negative safe integer');
  }
  if (sequenceIndex !== LEG_INDEX.get(leg)) {
    throw new Error(`${leg} requires sequence index ${LEG_INDEX.get(leg)}`);
  }
  if (harness === 'native' && phase === 'heap') {
    throw new Error('Native heap campaigns are not supported');
  }
  const expectedSuites = phase === 'startup' ? ['startup'] : ['table'];
  if (JSON.stringify(matrix.suites) !== JSON.stringify(expectedSuites)) {
    throw new Error(
      `campaign phase ${phase} requires --suite ${expectedSuites.join(',')}`,
    );
  }
  const entry = entries[0];
  const verified = verifiedLabEntries.get(entry.id);
  if (!verified) throw new Error(`unverified campaign entry: ${entry.id}`);
  const variant = verified.receipt.variant;
  if (variant !== 'vapor' && variant !== 'ifr') {
    throw new Error(`invalid receipt variant: ${variant}`);
  }
  return {
    schemaVersion: 1,
    id,
    comparisonId,
    variant,
    phase,
    leg,
    sequenceIndex,
  };
}

export function resolvedCampaignMatrix(matrix, harness, phase) {
  const table = [];
  const startup = [];
  if (phase === 'table') {
    for (const candidate of matrix.cases) {
      for (const scale of candidate.scales.filter((value) =>
        matrix.scales.includes(value))) {
        table.push({
          workload: candidate.name,
          scale,
          reps: harness === 'web' && candidate.freshPage
            ? matrix.stormReps
            : matrix.reps,
        });
      }
    }
  } else if (phase === 'heap') {
    table.push({ workload: 'memory', scale: 10000, reps: 1 });
  } else {
    for (const scale of matrix.startupScales) {
      startup.push({ workload: 'startup', scale, reps: matrix.startupReps });
    }
  }
  return {
    schemaVersion: 1,
    harness,
    table,
    startup,
  };
}

export function validateCampaignMetadata(meta, label = 'run metadata') {
  const campaign = meta?.campaign;
  const resolvedMatrix = meta?.resolvedMatrix;
  const formalFields = [
    meta?.runLabel,
    meta?.startedAt,
    meta?.finishedAt,
    campaign,
    resolvedMatrix,
  ];
  const present = formalFields.filter((value) => value != null).length;
  if (present === 0) return null;
  if (present !== formalFields.length) {
    throw new Error(`${label} formal campaign metadata is partial`);
  }
  if (meta.generatedAt !== meta.finishedAt) {
    throw new Error(`${label} generatedAt must equal finishedAt`);
  }
  if (!LEG_INDEX.has(campaign.leg)
    || campaign.sequenceIndex !== LEG_INDEX.get(campaign.leg)) {
    throw new Error(`${label} campaign leg/index mismatch`);
  }
  if (!PHASES.has(campaign.phase)) {
    throw new Error(`${label} campaign phase is invalid`);
  }
  if (campaign.schemaVersion !== 1 || resolvedMatrix.schemaVersion !== 1) {
    throw new Error(`${label} formal schema version is invalid`);
  }
  return { campaign, resolvedMatrix };
}
