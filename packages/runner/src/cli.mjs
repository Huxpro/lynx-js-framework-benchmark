#!/usr/bin/env node
// lynx-bench CLI.
//
//   lynx-bench run [--entry a,b] [--case create,select] [--scale 1000,10000]
//                  [--suite table,startup] [--reps N] [--quick] [--label x]
//                  [--harness web|native]
//   lynx-bench preflight
//   lynx-bench collect
//   lynx-bench list
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { TABLE_CASES } from '@lynx-bench/shared/workloads';
import { SCHEMA_VERSION } from '@lynx-bench/shared/schema';

import { discoverEntries, repoRoot } from './entries.mjs';
import { runWebHarness } from './harness-web.mjs';
import { runNativeHarness } from './harness-native.mjs';
import { bundleRecords } from './bundles.mjs';
import { collectRuns } from './collect.mjs';
import { machineFingerprint } from './machine.mjs';
import { runPreflight } from './preflight.mjs';
import { launchBrowser } from './browser.mjs';
import { stringifyResult } from './result-json.mjs';
import {
  assertConnectorPackageTrees,
  resolveConnectorPackageTrees,
} from './connector-receipt.mjs';
import {
  assertNativeCoverage,
  buildNativeMatrixContract,
  classifyNativeCoverage,
  nativeCellKey,
} from './native-coverage.mjs';
import { assertNativeInputsUnchanged, snapshotNativeInputs } from './native-inputs.mjs';
import {
  NATIVE_SANDBOX_CAMPAIGN_VERSION,
  NATIVE_SANDBOX_POLICY,
  appendNativeLeaseReceipt,
  deriveNativeLeaseExpirySafety,
  parseNativeLeaseReceipt,
  shouldStopBeforeLeaseExpiry,
} from './native-protocol.mjs';
import {
  assertNativeResumeDeviceCohort,
  mergeNativeRecords,
  nativeRecordIndex,
  validateNativeResumeCheckpoint,
} from './native-resume.mjs';
import {
  NATIVE_STARTUP_SCALES,
  NATIVE_TABLE_SCALES,
  resolveNativeRunMatrix,
} from './run-matrix.mjs';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) args[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) args[a.slice(2)] = argv[++i];
      else args[a.slice(2)] = true;
    } else {
      args._.push(a);
    }
  }
  return args;
}

const list = (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()) : null);
const numList = (v) => list(v)?.map(Number);
const sha256Json = (value) => crypto.createHash('sha256')
  .update(JSON.stringify(value))
  .digest('hex');

async function cmdRun(args) {
  const harness = args.harness ?? 'web';
  if (harness !== 'web' && harness !== 'native') throw new Error(`unknown harness: ${harness}`);

  let entries = discoverEntries({ only: list(args.entry) });
  if (harness === 'native' && args.entry == null) {
    entries = entries.filter((entry) => (entry.tier ?? 'featured') !== 'lab');
  }
  if (entries.length === 0) throw new Error('no entries matched');
  const caseNames = list(args.case);
  const cases = caseNames
    ? TABLE_CASES.filter((c) => caseNames.includes(c.name))
    : TABLE_CASES;
  const suites = list(args.suite) ?? ['table', 'startup'];

  if (harness === 'native') {
    if (typeof args.adapter !== 'string' || args.adapter.length === 0) {
      throw new Error('Native run requires --adapter <module.mjs>.');
    }
    const {
      cases: nativeCases,
      suites: nativeSuites,
      scales,
      startupScales,
      reps,
      startupReps,
    } = resolveNativeRunMatrix(args);
    const root = repoRoot();
    const featuredIds = discoverEntries()
      .filter((entry) => (entry.tier ?? 'featured') !== 'lab')
      .map((entry) => entry.id)
      .sort();
    const selectedIds = entries.map((entry) => entry.id).sort();
    if (
      nativeSuites.length !== 2
      || !nativeSuites.includes('table')
      || !nativeSuites.includes('startup')
      || nativeCases.length !== TABLE_CASES.length
      || scales.length !== NATIVE_TABLE_SCALES.length
      || startupScales.length !== NATIVE_STARTUP_SCALES.length
      || JSON.stringify(selectedIds) !== JSON.stringify(featuredIds)
    ) {
      throw new Error(
        'Native publishable campaigns must run every featured entry and the complete table/startup '
        + 'matrix; use unit tests or a separate diagnostic tool for partial probes.',
      );
    }
    const matrixContract = buildNativeMatrixContract(entries);
    const connectorPackageTrees = resolveConnectorPackageTrees({
      fromPath: path.resolve(args.adapter),
    });
    assertConnectorPackageTrees(connectorPackageTrees);
    const inputs = snapshotNativeInputs({
      entries,
      suites: nativeSuites,
      startupScales,
      adapterPath: args.adapter,
      connectorPackageTrees,
      root,
    });
    const resolvedMatrix = {
      suites: nativeSuites,
      cases: nativeCases.map((kase) => kase.name),
      scales,
      startupScales,
      reps,
      startupReps,
    };
    const leaseExpirySafety = deriveNativeLeaseExpirySafety(
      NATIVE_SANDBOX_POLICY,
      { reps, startupReps },
    );
    const campaignPayload = {
      version: NATIVE_SANDBOX_CAMPAIGN_VERSION,
      label: typeof args['campaign-id'] === 'string' ? args['campaign-id'] : args.label ?? null,
      matrixContractSha256: matrixContract.sha256,
      inputReceiptSha256: inputs.receipt.sha256,
      connectorPackageTreesSha256: connectorPackageTrees.sha256,
      resolvedMatrix,
      runtimePolicy: NATIVE_SANDBOX_POLICY,
      leaseExpirySafety,
    };
    const campaign = { ...campaignPayload, id: sha256Json(campaignPayload).slice(0, 16) };
    const leaseReceiptInput = args['lease-receipt']
      ?? process.env.LYNX_SANDBOX_LEASE_RECEIPT;
    if (leaseReceiptInput == null) {
      throw new Error(
        'Native run requires --lease-receipt <json-or-file> with issueId, expiredAt, and serial.',
      );
    }
    const leaseReceipt = parseNativeLeaseReceipt(leaseReceiptInput, {
      serial: process.env.LYNX_SANDBOX_SERIAL,
    });
    if (args.resume === true) throw new Error('--resume requires an incomplete checkpoint path.');
    const resumePath = typeof args.resume === 'string' ? path.resolve(args.resume) : null;
    let priorRun = null;
    let priorRecords = [];
    let priorDeviceCohort = null;
    let cellLeaseIds = {};
    let leaseChain = appendNativeLeaseReceipt(null, leaseReceipt);
    if (resumePath != null) {
      priorRun = JSON.parse(fs.readFileSync(resumePath, 'utf8'));
      const resumed = validateNativeResumeCheckpoint(priorRun, {
        campaign,
        matrixContract,
        inputReceipt: inputs.receipt,
        connectorPackageTrees,
        entries,
        leaseReceipt,
      });
      priorRecords = resumed.records;
      priorDeviceCohort = resumed.priorDeviceCohort;
      cellLeaseIds = resumed.cellLeaseIds;
      leaseChain = resumed.leaseChain;
    }
    const priorIndex = nativeRecordIndex(priorRecords, matrixContract);
    console.log(`[run:native] entries: ${entries.map((e) => e.id).join(', ')}`);
    console.log(
      `[run:native] contract=${matrixContract.expectedCellCount} cells `
      + `scales=${scales.join(',')} startup=${startupScales.join(',')} campaign=${campaign.id}`,
    );
    const now = new Date();
    const label = args.label ? `-${args.label}` : '';
    let outPath = resumePath;
    const persist = ({ records: newRecords, machine: adapterMachine }, { complete = false } = {}) => {
      const machine = adapterMachine ?? machineFingerprint();
      const deviceCohort = assertNativeResumeDeviceCohort(
        priorDeviceCohort,
        machine.deviceCohort,
      );
      const records = mergeNativeRecords(priorRecords, newRecords, matrixContract);
      for (const record of newRecords) {
        const key = nativeCellKey(record);
        const existingLeaseId = cellLeaseIds[key];
        if (existingLeaseId != null && existingLeaseId !== leaseReceipt.deviceLeaseId) {
          throw new Error(`Native cell ${key} already belongs to lease ${existingLeaseId}.`);
        }
        cellLeaseIds[key] = leaseReceipt.deviceLeaseId;
      }
      if (outPath === null) {
        const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
        outPath = path.join(root, 'results/runs', `${stamp}-${machine.id}-native${label}.json`);
      }
      const nativeCoverage = classifyNativeCoverage({ entries, sourceRecords: records });
      if (complete) assertNativeCoverage(nativeCoverage);
      const run = {
        schemaVersion: SCHEMA_VERSION,
        meta: {
          generatedAt: now.toISOString(),
          machine,
          calibration: null,
          harness: 'native',
          adapter: path.resolve(args.adapter),
          argv: process.argv.slice(2),
          checkpoint: true,
          checkpointComplete: complete,
          deviceCohort,
          leaseChain,
          cellLeaseIds,
          campaign,
          resolvedMatrix,
          matrixContract,
          inputReceipt: inputs.receipt,
          entryCommits: Object.fromEntries(
            entries.map((e) => [e.id, e.provenance?.commit ?? null]),
          ),
        },
        nativeCoverage,
        records,
      };
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      const temporary = `${outPath}.tmp`;
      fs.writeFileSync(temporary, stringifyResult(run));
      fs.renameSync(temporary, outPath);
    };
    const native = await runNativeHarness({
      adapterPath: args.adapter,
      entries,
      cases: nativeCases,
      suites: nativeSuites,
      scales,
      startupScales,
      reps,
      startupReps,
      bundleSnapshots: inputs.snapshots,
      campaignIdentity: {
        campaignId: campaign.id,
        matrixContractSha256: matrixContract.sha256,
        inputReceiptSha256: inputs.receipt.sha256,
        connectorPackageTrees,
        connectorPackageTreesSha256: connectorPackageTrees.sha256,
        leaseReceipt,
      },
      existingCellKeys: new Set(priorIndex.keys()),
      shouldStopBeforeCell: () => shouldStopBeforeLeaseExpiry(leaseReceipt, {
        safetyMs: leaseExpirySafety.effectiveSafetyMs,
      }),
      log: (line) => console.log(line),
      onProgress: persist,
    });
    const records = mergeNativeRecords(priorRecords, native.records, matrixContract);
    assertNativeInputsUnchanged(inputs);
    if (native.stoppedForLeaseExpiry) {
      persist({ records: native.records, machine: native.machine }, { complete: false });
      console.log(
        `[run:native] lease-expiry checkpoint ${records.length}/${matrixContract.expectedCellCount} `
        + `records → ${path.relative(root, outPath)}`,
      );
      return;
    }
    if (records.length !== matrixContract.expectedCellCount) {
      throw new Error(
        `Native campaign returned ${records.length} records; expected ${matrixContract.expectedCellCount}.`,
      );
    }
    persist({ records: native.records, machine: native.machine }, { complete: true });
    console.log(`[run:native] ${records.length} records → ${path.relative(root, outPath)}`);
    if (!args['no-collect']) collectRuns();
    return;
  }
  const quick = Boolean(args.quick);
  const scales = numList(args.scale)
    ?? (quick ? [1000] : [1000, 10000]);
  const reps = args.reps ? Number(args.reps) : quick ? 3 : 7;
  const stormReps = args['storm-reps'] ? Number(args['storm-reps']) : quick ? 1 : 3;
  const startupReps = args['startup-reps'] ? Number(args['startup-reps']) : quick ? 2 : 5;

  console.log(`[run] entries: ${entries.map((e) => e.id).join(', ')}`);
  console.log(`[run] suites: ${suites.join(', ')}; cases: ${cases.map((c) => c.name).join(', ')}; scales: ${scales.join(', ')}; reps=${reps}`);

  // Preflight in the same browser configuration that will measure.
  const probe = await (async () => {
    const { browser } = await launchBrowser();
    try {
      return await runPreflight(browser);
    } finally {
      await browser.close();
    }
  })();
  console.log(`[preflight] score=${probe.score} (probe v${probe.probeVersion})`);

  const { records, executablePath } = await runWebHarness({
    entries, cases, suites, scales, reps, stormReps, startupReps,
  });
  for (const entry of entries) records.push(...bundleRecords(entry));

  const machine = machineFingerprint();
  const now = new Date();
  const label = args.label ? `-${args.label}` : '';
  const run = {
    schemaVersion: SCHEMA_VERSION,
    meta: {
      generatedAt: now.toISOString(),
      machine,
      calibration: probe,
      chromium: executablePath,
      argv: process.argv.slice(2),
      entryCommits: Object.fromEntries(
        entries.map((e) => [e.id, e.provenance?.commit ?? null]),
      ),
    },
    records,
  };
  const root = repoRoot();
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = path.join(root, 'results/runs', `${stamp}-${machine.id}${label}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(run, null, 1));
  console.log(`[run] ${records.length} records → ${path.relative(root, outPath)}`);
  // The run file is the source; latest.json is only a materialized view. Keep
  // it synchronized immediately so no consumer can observe the previous run's
  // derived cohort/statistics between `run` and a later build.
  collectRuns();
}

async function cmdPreflight() {
  const { browser } = await launchBrowser();
  try {
    const probe = await runPreflight(browser);
    const machine = machineFingerprint();
    console.log(JSON.stringify({ machine, calibration: probe }, null, 2));
  } finally {
    await browser.close();
  }
}

function cmdList() {
  const entries = discoverEntries();
  for (const e of entries) {
    const scales = fs.existsSync(e.distDir)
      ? fs.readdirSync(e.distDir).filter((d) => d.startsWith('rows-')).map((d) => d.slice(5)).join(',')
      : 'no dist';
    console.log(`${e.id.padEnd(18)} ${e.label.padEnd(28)} [${e.tags?.join(',') ?? ''}] rows: ${scales}`);
  }
  console.log('\ncases: ' + TABLE_CASES.map((c) => c.name).join(', ') + ', startup');
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0] ?? 'run';
try {
  if (cmd === 'run') await cmdRun(args);
  else if (cmd === 'preflight') await cmdPreflight();
  else if (cmd === 'collect') collectRuns();
  else if (cmd === 'list') cmdList();
  else {
    console.error(`unknown command: ${cmd}`);
    process.exit(2);
  }
} catch (e) {
  console.error(String(e?.stack ?? e));
  process.exit(1);
}
