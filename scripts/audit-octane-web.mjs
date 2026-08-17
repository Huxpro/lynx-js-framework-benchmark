#!/usr/bin/env node
// Controlled forensic replay of immutable historical Octane Web bundles.
//
// The bundles are addressed by Git blob object, verified by SHA-256, and then
// driven through the current Web harness in forward and reverse order. This
// separates bundle/app behavior from harness, browser, machine, and runtime
// changes without rebuilding a historical checkout.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TABLE_CASES } from '../packages/shared/src/workloads.mjs';
import { launchBrowser } from '../packages/runner/src/browser.mjs';
import { runWebHarness } from '../packages/runner/src/harness-web.mjs';
import { machineFingerprint } from '../packages/runner/src/machine.mjs';
import { runPreflight } from '../packages/runner/src/preflight.mjs';
import { runReceipt } from '../packages/runner/src/provenance.mjs';
import { stringifyResult } from '../packages/runner/src/result-json.mjs';

const BUNDLES = [
  {
    id: 'clean-6079a680',
    label: 'clean 6079a680',
    gitBlob: '56b3ab1df92ca22846fcbd1fe9e7fc72a98a1b90',
    sha256: '86b9538a05f7689e7583735077f8e8152b81d1393c7142b97f65a4ef671f13f9',
    appCommit: '6079a68048ef12e2e694655439a2794fe9787826',
    benchmarkRepoCommit: 'a1df1f8d621bd563967a3a155b2af035627ec4b9',
    patched: false,
  },
  {
    id: 'clean-63eb7888',
    label: 'clean 63eb7888',
    gitBlob: '2ddb327bb2db9d494d557e6a13e9a3eaaefa8b7b',
    sha256: 'b33dbb58bdee4bb2ee97dec435b1bdfc258d4c9d19cde980154f02d5ec69885e',
    appCommit: '63eb788817ff91b841b5f0fd24321ae16e7f4396',
    benchmarkRepoCommit: '4e1bd005eac19cba1818038e843fcd95a61d0bf2',
    patched: false,
  },
  {
    id: 'patched-63eb7888',
    label: 'patched 63eb7888',
    gitBlob: '793a864e68b267d84150028d13b651105cbf77f0',
    sha256: 'b7277540e5a346aaddae1b69aaf4fb8e33e39d1ecddb9f60e5a2f72229a27048',
    appCommit: '63eb788817ff91b841b5f0fd24321ae16e7f4396',
    benchmarkRepoCommit: 'bb0f1d2f6aa4b418448c0ce9838f5e12d77e7be1',
    patched: true,
  },
  {
    id: 'patched-0fc84da0',
    label: 'patched 0fc84da0',
    gitBlob: '2a5aff51cb98b85a1fc1f78559c1092eb6a8a576',
    sha256: '3e4d5bc3c0a38e1a0303738b78fb5ce6889b0b0a88fcedde365d992f01d9ffe7',
    appCommit: '0fc84da02fd05403ac5e36d2aff631b31168d5ac',
    benchmarkRepoCommit: 'b350ff915bc0e1ca43c46492d355536c99d1634b',
    patched: true,
  },
];

const REPS = 12;
const STORM_REPS = 3;
const SCALE = 1000;
const CASE_NAMES = ['update10th', 'select', 'updateStorm', 'selectStorm'];
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function extractBundles(repositoryRoot, temporaryRoot) {
  return BUNDLES.map((spec) => {
    const bundle = execFileSync('git', ['cat-file', 'blob', spec.gitBlob], {
      cwd: repositoryRoot,
      encoding: 'buffer',
      maxBuffer: 16 * 1024 * 1024,
    });
    const observed = sha256(bundle);
    if (observed !== spec.sha256) {
      throw new Error(`${spec.id}: expected ${spec.sha256}, got ${observed}`);
    }
    const distDir = path.join(temporaryRoot, spec.id, 'dist');
    const bundlePath = path.join(distDir, 'rows-0', 'main.web.bundle');
    fs.mkdirSync(path.dirname(bundlePath), { recursive: true });
    fs.writeFileSync(bundlePath, bundle);
    return {
      ...spec,
      dir: path.join(temporaryRoot, spec.id),
      distDir,
      provenance: { commit: spec.appCommit, patched: spec.patched },
    };
  });
}

async function preflight() {
  const { browser, executablePath, browserVersion } = await launchBrowser();
  try {
    return {
      calibration: await runPreflight(browser),
      browser: { name: 'chromium', version: browserVersion, executablePath },
    };
  } finally {
    await browser.close();
  }
}

async function runOrder({ entries, name, root }) {
  console.log(`[audit:${name}] ${entries.map((entry) => entry.id).join(' -> ')}`);
  const before = await preflight();
  const startedAt = new Date().toISOString();
  const logs = [];
  const measured = await runWebHarness({
    entries,
    cases: TABLE_CASES.filter((candidate) => CASE_NAMES.includes(candidate.name)),
    suites: ['table'],
    scales: [SCALE],
    reps: REPS,
    stormReps: STORM_REPS,
    startupReps: 0,
    includeMemory: false,
    log: (line) => {
      logs.push(line);
      console.log(line);
    },
  });
  if (measured.browserVersion !== before.browser.version) {
    throw new Error(`browser changed between preflight and replay: ${before.browser.version} -> ${measured.browserVersion}`);
  }
  const endedAt = new Date().toISOString();
  return {
    name,
    entryOrder: entries.map((entry) => entry.id),
    startedAt,
    endedAt,
    calibration: before.calibration,
    browser: before.browser,
    receipt: {
      ...runReceipt({
      root,
      entries: [],
      reps: REPS,
      stormReps: STORM_REPS,
      startupReps: 0,
      execution: { harness: 'web', browser: before.browser },
      }),
      entryBundles: Object.fromEntries(entries.map((entry) => [entry.id, {
        'rows-0/main.web.bundle': entry.sha256,
      }])),
    },
    records: measured.records,
    logs,
  };
}

const outputArg = process.argv[2];
if (!outputArg) {
  throw new Error('usage: node scripts/audit-octane-web.mjs <output.json>');
}
const repositoryRoot = path.resolve(new URL('..', import.meta.url).pathname);
const output = path.resolve(repositoryRoot, outputArg);
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'octane-web-audit-'));
try {
  const entries = extractBundles(repositoryRoot, temporaryRoot);
  const sessionId = crypto.randomUUID();
  const generatedAt = new Date().toISOString();
  const orders = [];
  orders.push(await runOrder({ entries, name: 'forward', root: repositoryRoot }));
  orders.push(await runOrder({ entries: [...entries].reverse(), name: 'reverse', root: repositoryRoot }));
  const audit = {
    schemaVersion: 1,
    kind: 'octane-web-immutable-bundle-replay',
    sessionId,
    generatedAt,
    machine: machineFingerprint(),
    contract: {
      harness: 'current-web',
      suite: 'table',
      cases: CASE_NAMES,
      scale: SCALE,
      repetitions: { ordinary: REPS, storm: STORM_REPS },
      orderPolicy: 'forward-then-reverse',
      outlierPolicy: 'none-removed',
      incompleteStormPolicy: 'fail-closed-with-raw-attempt-evidence',
    },
    bundles: BUNDLES,
    orders,
  };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, stringifyResult(audit));
  console.log(`[audit] session ${sessionId} -> ${path.relative(repositoryRoot, output)}`);
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
