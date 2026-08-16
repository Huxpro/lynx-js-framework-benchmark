import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { analyzeAbbaManifest } from '../../packages/runner/src/abba-analysis.mjs';
import {
  createAbbaPlan,
  executeAbbaPlan,
  findRawFile,
} from './vue-vapor-abba.mjs';

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function verified(variant, fingerprint) {
  return {
    fingerprint,
    receipt: { variant },
  };
}

function rawRun(step) {
  const finished = new Date(Date.UTC(2026, 7, 16, 0, step.sequenceIndex, 1));
  const started = new Date(finished.getTime() - 1000);
  return {
    schemaVersion: 2,
    meta: {
      runLabel: step.runLabel,
      startedAt: started.toISOString(),
      finishedAt: finished.toISOString(),
      generatedAt: finished.toISOString(),
      campaign: {
        schemaVersion: 1,
        id: step.campaignId,
        comparisonId: step.comparisonId,
        variant: 'vapor',
        phase: step.phase,
        leg: step.leg,
        sequenceIndex: step.sequenceIndex,
      },
      resolvedMatrix: {
        schemaVersion: 1,
        harness: 'web',
        table: [{ workload: 'create', scale: 1000, reps: 1 }],
        startup: [],
      },
      machine: { id: 'machine' },
    },
    records: [{
      suite: 'table',
      harness: 'web',
      environment: 'lynx-for-web',
      entry: step.entry,
      workload: 'create',
      scale: 1000,
      metric: 'latency',
      boundary: 'pointerdown-to-dom-predicate',
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

test('ABBA helper emits four isolated single-entry commands without conclusions', () => {
  const plan = createAbbaPlan({
    a: 'vue-vapor-a',
    b: 'vue-vapor-b',
    labRoot: path.join(process.cwd(), '.tmp/vue-vapor-lab'),
    phase: 'startup',
    runArgs: ['--suite', 'startup', '--scale', '10000', '--startup-reps', '7'],
  });
  assert.deepEqual(plan.map(({ entry }) => entry), [
    'vue-vapor-a',
    'vue-vapor-b',
    'vue-vapor-b',
    'vue-vapor-a',
  ]);
  assert.deepEqual(plan.map(({ arm, ordinal }) => `${arm}${ordinal}`), [
    'A1',
    'B1',
    'B2',
    'A2',
  ]);
  for (const step of plan) {
    assert.equal(step.argv.filter((argument) => argument === '--entry').length, 1);
    assert.equal(step.argv.includes('--lab-root'), true);
    assert.equal(step.argv.includes('--harness'), true);
  }
  assert.throws(
    () => createAbbaPlan({
      a: 'vue-vapor-a',
      b: 'vue-vapor-b',
      labRoot: '/tmp/lab',
      phase: 'startup',
      runArgs: ['--entry', 'other'],
    }),
    /controlled by the ABBA helper/,
  );
  assert.throws(
    () => createAbbaPlan({
      a: 'vue-vapor-a,vue-vapor-b',
      b: 'vue-vapor-c',
      labRoot: path.join(process.cwd(), '.tmp/vue-vapor-lab'),
      phase: 'startup',
    }),
    /--a must match/,
  );
});

test('ABBA execute re-verifies each pinned entry before and after every spawn', () => {
  const labRoot = fs.mkdtempSync(path.join(process.cwd(), '.tmp', 'abba-reverify-'));
  const plan = createAbbaPlan({
    a: 'vue-vapor-a',
    b: 'vue-vapor-b',
    labRoot,
    phase: 'table',
    runArgs: ['--suite', 'table', '--case', 'create', '--scale', '1000', '--reps', '1'],
  });
  const pinned = new Map([
    ['vue-vapor-a', 'fingerprint-a'],
    ['vue-vapor-b', 'fingerprint-b'],
  ]);
  let spawnCount = 0;
  let replaced = false;
  try {
    assert.throws(
      () => executeAbbaPlan({
      plan,
      labRoot,
      pinned,
      verified: new Map([
        ['vue-vapor-a', verified('vapor', 'fingerprint-a')],
        ['vue-vapor-b', verified('vapor', 'fingerprint-b')],
      ]),
      manifestPath: path.join(labRoot, 'manifest.json'),
      verifyEntry: (entryDir, expected) => {
        const entry = path.basename(entryDir);
        const actual = replaced && entry === 'vue-vapor-a'
          ? 'replaced-a'
          : pinned.get(entry);
        if (actual !== expected) throw new Error(`${entry} changed after it was pinned`);
        return { fingerprint: actual };
      },
      spawn: () => {
        spawnCount++;
        replaced = true;
        return { status: 0 };
      },
      findRaw: (_root, step) => ({
        file: path.join(labRoot, `${step.leg}.json`),
        run: rawRun(step),
      }),
      log: () => {},
      }),
      /changed after it was pinned/,
    );
    assert.equal(spawnCount, 1);
  } finally {
    fs.rmSync(labRoot, { recursive: true, force: true });
  }
});

test('executor writes incomplete first, appends exact raw legs, and completes atomically', () => {
  const labRoot = fs.mkdtempSync(path.join(process.cwd(), '.tmp', 'abba-exec-'));
  try {
    fs.mkdirSync(path.join(labRoot, 'entries/vue-vapor-a'), { recursive: true });
    fs.mkdirSync(path.join(labRoot, 'entries/vue-vapor-b'), { recursive: true });
    const plan = createAbbaPlan({
      a: 'vue-vapor-a',
      b: 'vue-vapor-b',
      labRoot,
      phase: 'table',
      comparisonId: 'comparison',
      campaignId: 'campaign',
      runArgs: ['--suite', 'table', '--case', 'create', '--scale', '1000', '--reps', '1'],
    });
    const pinned = new Map([
      ['vue-vapor-a', 'fingerprint-a'],
      ['vue-vapor-b', 'fingerprint-b'],
    ]);
    const verifiedEntries = new Map([
      ['vue-vapor-a', verified('vapor', 'fingerprint-a')],
      ['vue-vapor-b', verified('vapor', 'fingerprint-b')],
    ]);
    const manifestPath = path.join(labRoot, 'manifest.json');
    const statuses = [];
    const result = executeAbbaPlan({
      plan,
      labRoot,
      pinned,
      verified: verifiedEntries,
      manifestPath,
      verifyEntry: (_dir, fingerprint) => ({ fingerprint }),
      verifyBenchmark: () => {},
      spawn: (_node, argv) => {
        statuses.push(JSON.parse(fs.readFileSync(manifestPath)).status);
        const step = plan.find(({ argv: expected }) => expected === argv);
        const run = rawRun(step);
        const file = path.join(labRoot, `${step.leg}.json`);
        fs.writeFileSync(file, JSON.stringify(run));
        return { status: 0 };
      },
      findRaw: (_root, step) => ({
        file: path.join(labRoot, `${step.leg}.json`),
        run: JSON.parse(fs.readFileSync(path.join(labRoot, `${step.leg}.json`))),
      }),
      log: () => {},
    });
    assert.deepEqual(statuses, ['incomplete', 'incomplete', 'incomplete', 'incomplete']);
    assert.equal(result.manifest.status, 'complete');
    assert.deepEqual(Object.keys(result.manifest.legs), ['A1', 'B1', 'B2', 'A2']);
    for (const leg of ['A1', 'B1', 'B2', 'A2']) {
      const descriptor = result.manifest.legs[leg];
      const bytes = fs.readFileSync(path.join(labRoot, descriptor.path));
      assert.equal(descriptor.sha256, sha256(bytes));
    }
  } finally {
    fs.rmSync(labRoot, { recursive: true, force: true });
  }
});

test('crash preserves incomplete manifest and resume skips the exact completed prefix', () => {
  const labRoot = fs.mkdtempSync(path.join(process.cwd(), '.tmp', 'abba-resume-'));
  try {
    const plan = createAbbaPlan({
      a: 'vue-vapor-a',
      b: 'vue-vapor-b',
      labRoot,
      phase: 'table',
      comparisonId: 'comparison',
      campaignId: 'campaign',
      runArgs: ['--suite', 'table', '--case', 'create', '--scale', '1000', '--reps', '1'],
    });
    const pinned = new Map([
      ['vue-vapor-a', 'fingerprint-a'],
      ['vue-vapor-b', 'fingerprint-b'],
    ]);
    const verifiedEntries = new Map([
      ['vue-vapor-a', verified('vapor', 'fingerprint-a')],
      ['vue-vapor-b', verified('vapor', 'fingerprint-b')],
    ]);
    const manifestPath = path.join(labRoot, 'manifest.json');
    let calls = 0;
    assert.throws(
      () => executeAbbaPlan({
        plan,
        labRoot,
        pinned,
        verified: verifiedEntries,
        manifestPath,
        verifyEntry: (_dir, fingerprint) => ({ fingerprint }),
        spawn: (_node, argv) => {
          calls++;
          if (calls === 2) return { status: 9 };
          const step = plan.find(({ argv: expected }) => expected === argv);
          fs.writeFileSync(path.join(labRoot, `${step.leg}.json`), JSON.stringify(rawRun(step)));
          return { status: 0 };
        },
        findRaw: (_root, step) => ({
          file: path.join(labRoot, `${step.leg}.json`),
          run: rawRun(step),
        }),
        log: () => {},
      }),
      /B1 exited with status 9/,
    );
    const incomplete = JSON.parse(fs.readFileSync(manifestPath));
    assert.equal(incomplete.status, 'incomplete');
    assert.deepEqual(Object.keys(incomplete.legs), ['A1']);

    let resumedSpawns = 0;
    const complete = executeAbbaPlan({
      plan,
      labRoot,
      pinned,
      verified: verifiedEntries,
      manifestPath,
      resume: true,
      verifyEntry: (_dir, fingerprint) => ({ fingerprint }),
      spawn: (_node, argv) => {
        resumedSpawns++;
        const step = plan.find(({ argv: expected }) => expected === argv);
        fs.writeFileSync(path.join(labRoot, `${step.leg}.json`), JSON.stringify(rawRun(step)));
        return { status: 0 };
      },
      findRaw: (_root, step) => ({
        file: path.join(labRoot, `${step.leg}.json`),
        run: rawRun(step),
      }),
      log: () => {},
    });
    assert.equal(resumedSpawns, 3);
    assert.equal(complete.manifest.status, 'complete');
  } finally {
    fs.rmSync(labRoot, { recursive: true, force: true });
  }
});

test('resume rejects tampered raw, changed plans, and non-prefix recorded legs', () => {
  const labRoot = fs.mkdtempSync(path.join(process.cwd(), '.tmp', 'abba-resume-gates-'));
  try {
    const makePlan = (comparisonId = 'comparison') => createAbbaPlan({
      a: 'vue-vapor-a',
      b: 'vue-vapor-b',
      labRoot,
      phase: 'table',
      comparisonId,
      campaignId: 'campaign',
      runArgs: ['--suite', 'table', '--case', 'create', '--scale', '1000', '--reps', '1'],
    });
    const plan = makePlan();
    const verifiedEntries = new Map([
      ['vue-vapor-a', verified('vapor', 'fingerprint-a')],
      ['vue-vapor-b', verified('vapor', 'fingerprint-b')],
    ]);
    const pinned = new Map([
      ['vue-vapor-a', 'fingerprint-a'],
      ['vue-vapor-b', 'fingerprint-b'],
    ]);
    const manifestPath = path.join(labRoot, 'manifest.json');
    const a1 = rawRun(plan[0]);
    const a1File = path.join(labRoot, 'A1.json');
    const a1Bytes = Buffer.from(JSON.stringify(a1));
    fs.writeFileSync(a1File, a1Bytes);
    const baseManifest = {
      schemaVersion: 1,
      status: 'incomplete',
      comparisonId: 'comparison',
      plan: {
        schemaVersion: 1,
        comparisonId: 'comparison',
        id: 'comparison-table',
        variant: 'vapor',
        harness: 'web',
        phase: 'table',
        legs: Object.fromEntries(plan.map((step) => [step.leg, {
          entry: step.entry,
          campaignId: step.campaignId,
          runLabel: step.runLabel,
          sequenceIndex: step.sequenceIndex,
          argv: step.argv,
        }])),
      },
      legs: {
        A1: {
          path: 'A1.json',
          sha256: sha256(a1Bytes),
          runLabel: plan[0].runLabel,
          campaignId: plan[0].campaignId,
        },
      },
    };
    fs.writeFileSync(manifestPath, `${JSON.stringify(baseManifest, null, 2)}\n`);
    fs.appendFileSync(a1File, 'tamper');
    assert.throws(
      () => executeAbbaPlan({
        plan,
        labRoot,
        pinned,
        verified: verifiedEntries,
        manifestPath,
        resume: true,
        verifyEntry: (_dir, fingerprint) => ({ fingerprint }),
        log: () => {},
      }),
      /recorded raw hash mismatch/,
    );

    fs.writeFileSync(a1File, a1Bytes);
    assert.throws(
      () => executeAbbaPlan({
        plan: makePlan('changed-comparison'),
        labRoot,
        pinned,
        verified: verifiedEntries,
        manifestPath,
        resume: true,
        verifyEntry: (_dir, fingerprint) => ({ fingerprint }),
        log: () => {},
      }),
      /plan does not match/,
    );

    const nonPrefix = structuredClone(baseManifest);
    delete nonPrefix.legs.A1;
    nonPrefix.legs.B1 = {
      path: 'A1.json',
      sha256: sha256(a1Bytes),
      runLabel: plan[1].runLabel,
      campaignId: plan[1].campaignId,
    };
    fs.writeFileSync(manifestPath, `${JSON.stringify(nonPrefix, null, 2)}\n`);
    assert.throws(
      () => executeAbbaPlan({
        plan,
        labRoot,
        pinned,
        verified: verifiedEntries,
        manifestPath,
        resume: true,
        verifyEntry: (_dir, fingerprint) => ({ fingerprint }),
        log: () => {},
      }),
      /contiguous completed prefix/,
    );
  } finally {
    fs.rmSync(labRoot, { recursive: true, force: true });
  }
});

test('completed executor manifest has analyzer-compatible pinned sequence shape', () => {
  const labRoot = fs.mkdtempSync(path.join(process.cwd(), '.tmp', 'abba-integration-'));
  try {
    const plan = createAbbaPlan({
      a: 'vue-vapor-a',
      b: 'vue-vapor-b',
      labRoot,
      phase: 'table',
      comparisonId: 'comparison',
      campaignId: 'campaign',
      runArgs: ['--suite', 'table', '--case', 'create', '--scale', '1000', '--reps', '1'],
    });
    const pinned = new Map([
      ['vue-vapor-a', 'fingerprint-a'],
      ['vue-vapor-b', 'fingerprint-b'],
    ]);
    const verifiedEntries = new Map([
      ['vue-vapor-a', verified('vapor', 'fingerprint-a')],
      ['vue-vapor-b', verified('vapor', 'fingerprint-b')],
    ]);
    const result = executeAbbaPlan({
      plan,
      labRoot,
      pinned,
      verified: verifiedEntries,
      manifestPath: path.join(labRoot, 'manifest.json'),
      verifyEntry: (_dir, fingerprint) => ({ fingerprint }),
      spawn: (_node, argv) => {
        const step = plan.find(({ argv: expected }) => expected === argv);
        fs.writeFileSync(path.join(labRoot, `${step.leg}.json`), JSON.stringify(rawRun(step)));
        return { status: 0 };
      },
      findRaw: (_root, step) => ({
        file: path.join(labRoot, `${step.leg}.json`),
        run: rawRun(step),
      }),
      log: () => {},
    });
    const sequence = result.manifest.sequences[0];
    assert.equal(sequence.id, 'comparison-table');
    assert.equal(sequence.variant, 'vapor');
    assert.deepEqual(Object.keys(sequence.legs), ['A1', 'B1', 'B2', 'A2']);
    assert.throws(
      () => analyzeAbbaManifest(result.manifest, { root: labRoot }),
      /missing entry artifact/,
    );
  } finally {
    fs.rmSync(labRoot, { recursive: true, force: true });
  }
});

test('raw discovery requires one exact campaign id, leg, and run label match', () => {
  const labRoot = fs.mkdtempSync(path.join(process.cwd(), '.tmp', 'abba-unique-'));
  try {
    const plan = createAbbaPlan({
      a: 'vue-vapor-a',
      b: 'vue-vapor-b',
      labRoot,
      phase: 'table',
      comparisonId: 'comparison',
      campaignId: 'campaign',
      runArgs: ['--suite', 'table', '--case', 'create', '--scale', '1000', '--reps', '1'],
    });
    const runs = path.join(labRoot, 'results/runs');
    fs.mkdirSync(runs, { recursive: true });
    fs.writeFileSync(path.join(runs, 'one.json'), JSON.stringify(rawRun(plan[0])));
    assert.equal(path.basename(findRawFile(labRoot, plan[0]).file), 'one.json');
    fs.writeFileSync(path.join(runs, 'two.json'), JSON.stringify(rawRun(plan[0])));
    assert.throws(
      () => findRawFile(labRoot, plan[0]),
      /requires exactly one raw campaign match; found 2/,
    );
  } finally {
    fs.rmSync(labRoot, { recursive: true, force: true });
  }
});

test('heap blocks can pin distinct sequence IDs under one comparison', () => {
  const root = path.join(process.cwd(), '.tmp/vue-vapor-lab');
  const first = createAbbaPlan({
    a: 'vue-vapor-a',
    b: 'vue-vapor-b',
    labRoot: root,
    phase: 'heap',
    comparisonId: 'comparison',
    sequenceId: 'comparison-vapor-heap-1',
  });
  const second = createAbbaPlan({
    a: 'vue-vapor-a',
    b: 'vue-vapor-b',
    labRoot: root,
    phase: 'heap',
    comparisonId: 'comparison',
    sequenceId: 'comparison-vapor-heap-2',
  });
  assert.equal(first[0].sequenceId, 'comparison-vapor-heap-1');
  assert.equal(second[0].sequenceId, 'comparison-vapor-heap-2');
  assert.notEqual(first[0].sequenceId, second[0].sequenceId);
});
