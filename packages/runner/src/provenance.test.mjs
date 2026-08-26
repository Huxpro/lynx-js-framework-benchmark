import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runReceipt } from './provenance.mjs';

const git = (root, args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });

test('run receipt binds Git state, runtime integrity, workload files, bundles, and sampling', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-bench-receipt-'));
  try {
    fs.mkdirSync(path.join(root, 'packages/shared/src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'packages/runner/src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'entries/example/dist/rows-0'), { recursive: true });
    fs.mkdirSync(path.join(root, 'results/runs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'packages/shared/src/workloads.mjs'), 'contract-v1\n');
    fs.writeFileSync(path.join(root, 'packages/shared/src/driver-client.mjs'), 'driver-v1\n');
    fs.writeFileSync(path.join(root, 'packages/shared/src/page-instrument.mjs'), 'predicate-v1\n');
    fs.writeFileSync(path.join(root, 'packages/shared/src/pipeline.mjs'), 'segments-v1\n');
    fs.writeFileSync(path.join(root, 'packages/shared/src/list-workloads.mjs'), 'list-contract-v1\n');
    fs.writeFileSync(path.join(root, 'packages/runner/src/pipeline-attribution.mjs'), 'records-v1\n');
    fs.writeFileSync(path.join(root, 'packages/runner/src/list-coverage.mjs'), 'list-coverage-v1\n');
    fs.writeFileSync(path.join(root, 'packages/runner/src/list-derivation.mjs'), 'list-derived-v1\n');
    fs.writeFileSync(path.join(root, 'packages/runner/src/storm-contract.mjs'), 'storm-v1\n');
    fs.writeFileSync(path.join(root, 'entries/example/dist/rows-0/main.web.bundle'), 'bundle-v1\n');
    fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'

packages:

  '@lynx-js/web-core@0.22.1':
    resolution: {integrity: sha512-core}

  '@lynx-js/web-elements@0.8.11':
    resolution: {integrity: sha512-elements}

  '@lynx-js/web-elements@0.12.5':
    resolution: {integrity: sha512-transitive}

  '@lynx-js/web-worker-rpc@0.22.1':
    resolution: {integrity: sha512-rpc}

  playwright-core@1.62.1:
    resolution: {integrity: sha512-playwright}
`);
    git(root, ['init']);
    git(root, ['add', '.']);
    git(root, ['-c', 'user.name=Receipt Test', '-c', 'user.email=test@example.invalid',
      'commit', '-m', 'fixture']);

    const options = {
      root,
      entries: [{ id: 'example', distDir: path.join(root, 'entries/example/dist') }],
      reps: 7,
      stormReps: 3,
      startupReps: 5,
      execution: { harness: 'web', browser: { version: 'Chromium 1' } },
    };
    const clean = runReceipt(options);
    assert.equal(clean.repository.dirty, false);
    assert.match(clean.repository.commit, /^[0-9a-f]{40}$/);
    assert.deepEqual(clean.runtime.packages, [
      { name: '@lynx-js/web-core', version: '0.22.1', integrity: 'sha512-core' },
      { name: '@lynx-js/web-elements', version: '0.12.5', integrity: 'sha512-transitive' },
      { name: '@lynx-js/web-elements', version: '0.8.11', integrity: 'sha512-elements' },
      { name: '@lynx-js/web-worker-rpc', version: '0.22.1', integrity: 'sha512-rpc' },
      { name: 'playwright-core', version: '1.62.1', integrity: 'sha512-playwright' },
    ]);
    assert.match(clean.entryBundles.example['rows-0/main.web.bundle'], /^[0-9a-f]{64}$/);
    assert.deepEqual(clean.sampling.repetitions, { table: 7, storm: 3, startup: 5 });
    assert.equal(clean.sampling.outliers, 'none-removed');
    assert.match(clean.comparabilityCohort, /^sha256:[0-9a-f]{64}$/);
    assert.notEqual(
      runReceipt({ ...options, reps: 8 }).comparabilityCohort,
      clean.comparabilityCohort,
      'different repetition policies must not share a comparison cohort',
    );

    fs.writeFileSync(path.join(root, 'results/runs/generated.json'), '{}');
    assert.equal(runReceipt(options).repository.dirty, false);

    fs.writeFileSync(path.join(root, 'packages/shared/src/workloads.mjs'), 'contract-v2\n');
    const dirty = runReceipt(options);
    assert.equal(dirty.repository.dirty, true);
    assert.match(dirty.repository.diffSha256, /^[0-9a-f]{64}$/);
    assert.notEqual(dirty.workload.sha256, clean.workload.sha256);
    assert.notEqual(dirty.comparabilityCohort, clean.comparabilityCohort);

    fs.writeFileSync(path.join(root, 'untracked-harness-input.txt'), 'one\n');
    const untrackedOne = runReceipt(options);
    fs.writeFileSync(path.join(root, 'untracked-harness-input.txt'), 'two\n');
    const untrackedTwo = runReceipt(options);
    assert.notEqual(untrackedOne.repository.diffSha256, untrackedTwo.repository.diffSha256);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
