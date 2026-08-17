import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { executeNativeAbbaPlan } from './native-abba.mjs';

const LEGS = ['A1', 'B1', 'B2', 'A2'];

function plan() {
  return LEGS.map((leg, index) => ({
    leg,
    sequenceIndex: index,
    comparisonId: 'comparison',
    phase: 'table',
    variant: 'vapor',
    campaignId: `campaign-${leg.toLowerCase()}`,
    runLabel: `comparison-${leg.toLowerCase()}`,
    entry: leg.startsWith('A') ? 'a' : 'b',
  }));
}

function raw(step, cohort) {
  const finishedAt = new Date(Date.UTC(2026, 7, 16, 0, step.sequenceIndex, 1)).toISOString();
  return {
    schemaVersion: 2,
    meta: {
      runLabel: step.runLabel,
      startedAt: new Date(Date.parse(finishedAt) - 1000).toISOString(),
      finishedAt,
      generatedAt: finishedAt,
      campaign: {
        schemaVersion: 1,
        id: step.campaignId,
        comparisonId: step.comparisonId,
        variant: step.variant,
        phase: step.phase,
        leg: step.leg,
        sequenceIndex: step.sequenceIndex,
      },
      resolvedMatrix: {
        schemaVersion: 1,
        harness: 'native',
        table: [{ workload: 'create', scale: 1000, reps: 1 }],
        startup: [],
      },
      nativeCohort: { fingerprint: cohort },
      machine: { id: 'device' },
    },
    records: [{
      suite: 'table',
      harness: 'native',
      environment: 'native-test',
      entry: step.entry,
      workload: 'create',
      scale: 1000,
      metric: 'latency',
      boundary: 'native-input-handler-to-second-native-frame',
      unit: 'ms',
      value: null,
      samples: [1],
      attempts: [{ index: 0, value: 1, dnf: false, errorKind: null }],
      detailSamples: null,
      detail: null,
      dnfCount: 0,
    }],
  };
}

test('Native ABBA uses one cohort lease, atomically completes, and disposes once', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-abba-'));
  try {
    let disposed = 0;
    const lease = {
      cohortFingerprint: 'cohort',
      async dispose() { disposed++; },
    };
    const calls = [];
    const manifest = await executeNativeAbbaPlan({
      plan: plan(),
      root,
      manifestPath: path.join(root, 'manifest.json'),
      lease,
      verifyInputs: async (step) => calls.push(`verify:${step.leg}`),
      runLeg: async (step) => {
        calls.push(`run:${step.leg}`);
        const file = path.join(root, `${step.leg}.json`);
        fs.writeFileSync(file, JSON.stringify(raw(step, 'cohort')));
        return file;
      },
    });
    assert.equal(manifest.status, 'complete');
    assert.equal(disposed, 1);
    assert.deepEqual(calls.filter((call) => call.startsWith('run:')), [
      'run:A1', 'run:B1', 'run:B2', 'run:A2',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Native ABBA preserves incomplete manifest and rejects cohort drift', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-abba-drift-'));
  try {
    let disposed = 0;
    await assert.rejects(
      () => executeNativeAbbaPlan({
        plan: plan(),
        root,
        manifestPath: path.join(root, 'manifest.json'),
        lease: {
          cohortFingerprint: 'cohort',
          async dispose() { disposed++; },
        },
        verifyInputs: async () => {},
        runLeg: async (step) => {
          const file = path.join(root, `${step.leg}.json`);
          fs.writeFileSync(
            file,
            JSON.stringify(raw(step, step.leg === 'B1' ? 'changed' : 'cohort')),
          );
          return file;
        },
      }),
      /changed Native cohort/,
    );
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'))).status, 'incomplete');
    assert.equal(disposed, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
