#!/usr/bin/env node
// lynx-bench CLI.
//
//   lynx-bench run [--entry a,b] [--case create,select] [--scale 1000,10000]
//                  [--suite table,startup,pipeline,storm] [--commit every-tick|final-state]
//                  [--reps N] [--quick] [--label x]
//                  [--harness web|native]
//                  [--native-capacity] [--capacity-thresholds]
//                  [--jit jit|interp] [--cpu-throttle N]
//                  [--throttle-scope none|process-cgroup]
//   lynx-bench preflight
//   lynx-bench collect
//   lynx-bench list
//   lynx-bench list-coverage
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  STORM_CASES,
  STORM_COMMIT_POLICIES,
  TABLE_CASES,
} from '@lynx-bench/shared/workloads';
import { SCHEMA_VERSION } from '@lynx-bench/shared/schema';
import { LIST_CASES } from '../../shared/src/list-workloads.mjs';

import { discoverEntries, entrySupportsHarness, repoRoot } from './entries.mjs';
import { runWebHarness } from './harness-web.mjs';
import { loadNativeAdapter, runNativeHarness } from './harness-native.mjs';
import { attachWebBundleEnvironment, bundleRecords } from './bundles.mjs';
import { collectRuns } from './collect.mjs';
import { machineFingerprint } from './machine.mjs';
import {
  calibrateProcessThrottle,
  runPreflight,
  runProcessThrottleProbe,
  verifyInterpreterFlags,
} from './preflight.mjs';
import { jsFlagsForRegime, launchBrowser } from './browser.mjs';
import { runReceipt } from './provenance.mjs';
import { stringifyResult } from './result-json.mjs';
import { NATIVE_TABLE_CASES } from './run-matrix.mjs';
import { shouldCollectAfterRun } from './run-policy.mjs';
import { resolveThrottleScope } from './web-regime-policy.mjs';
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
import {
  assertNativeCapacityInputsUnchanged,
  assertNativeInputsUnchanged,
  snapshotNativeCapacityInputs,
  snapshotNativeInputs,
} from './native-inputs.mjs';
import { assertListCoverage, buildListCoverage } from './list-coverage.mjs';
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
import {
  NATIVE_CAPACITY_CAMPAIGN_VERSION,
  NATIVE_CAPACITY_ENTRY_ID,
  resolveNativeCapacitySuite,
  runNativeCapacitySuite,
} from './native-capacity-suite.mjs';

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

async function runNativeCapacityCommand(args, entries) {
  const resolved = resolveNativeCapacitySuite({
    requested: true,
    includeThresholds: args['capacity-thresholds'] === true,
    entries,
    reps: args.reps,
    suite: args.suite,
    cases: args.case,
    scale: args.scale,
    startupScale: args['startup-scale'],
    startupReps: args['startup-reps'],
    stormReps: args['storm-reps'],
    commit: args.commit,
    quick: args.quick,
    resume: args.resume,
  });
  if (typeof args.adapter !== 'string' || args.adapter.length === 0) {
    throw new Error('Native capacity run requires --adapter <module.mjs>.');
  }

  const root = repoRoot();
  const connectorPackageTrees = resolveConnectorPackageTrees({
    fromPath: path.resolve(args.adapter),
  });
  assertConnectorPackageTrees(connectorPackageTrees);
  const inputs = snapshotNativeCapacityInputs({
    entry: resolved.entry,
    contract: resolved.contract,
    runtimePolicy: NATIVE_SANDBOX_POLICY,
    adapterPath: args.adapter,
    connectorPackageTrees,
    root,
  });
  const leaseReceiptInput = args['lease-receipt']
    ?? process.env.LYNX_SANDBOX_LEASE_RECEIPT;
  if (leaseReceiptInput == null) {
    throw new Error(
      'Native capacity run requires --lease-receipt <json-or-file> with issueId, expiredAt, and serial.',
    );
  }
  const leaseReceipt = parseNativeLeaseReceipt(leaseReceiptInput, {
    serial: process.env.LYNX_SANDBOX_SERIAL,
  });
  const campaignPayload = {
    version: NATIVE_CAPACITY_CAMPAIGN_VERSION,
    label: typeof args['campaign-id'] === 'string' ? args['campaign-id'] : args.label ?? null,
    capacityContractSha256: resolved.contract.sha256,
    inputReceiptSha256: inputs.receipt.sha256,
    connectorPackageTreesSha256: connectorPackageTrees.sha256,
    runtimePolicy: NATIVE_SANDBOX_POLICY,
  };
  const campaign = { ...campaignPayload, id: sha256Json(campaignPayload).slice(0, 16) };
  const adapter = await loadNativeAdapter(args.adapter, {
    log: (line) => console.log(line),
    campaignIdentity: {
      campaignId: campaign.id,
      matrixContractSha256: resolved.contract.sha256,
      inputReceiptSha256: inputs.receipt.sha256,
      connectorPackageTrees,
      connectorPackageTreesSha256: connectorPackageTrees.sha256,
      leaseReceipt,
    },
  });
  let records;
  try {
    records = await runNativeCapacitySuite({
      adapter,
      entry: resolved.entry,
      contract: resolved.contract,
      bundles: inputs.bundles,
      log: (line) => console.log(line),
    });
  } finally {
    await adapter.dispose();
  }
  assertNativeCapacityInputsUnchanged(inputs);

  const machine = adapter.machine ?? machineFingerprint();
  const now = new Date();
  const label = args.label ? `-${args.label}` : '';
  const run = {
    schemaVersion: SCHEMA_VERSION,
    meta: {
      generatedAt: now.toISOString(),
      machine,
      calibration: null,
      harness: 'native',
      adapter: path.resolve(args.adapter),
      argv: process.argv.slice(2),
      checkpoint: false,
      checkpointComplete: true,
      diagnostic: true,
      rankingEligible: false,
      campaign,
      capacityContract: resolved.contract,
      runtimePolicy: NATIVE_SANDBOX_POLICY,
      leaseChain: appendNativeLeaseReceipt(null, leaseReceipt),
      inputReceipt: inputs.receipt,
      entryCommits: { [resolved.entry.id]: resolved.entry.provenance.commit },
    },
    records,
  };
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = path.join(
    root,
    'results/runs',
    `${stamp}-${machine.id}-native-capacity${label}.json`,
  );
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, stringifyResult(run));
  console.log(`[run:native-capacity] ${records.length} records → ${path.relative(root, outPath)}`);
}

async function cmdRun(args) {
  const harness = args.harness ?? 'web';
  if (harness !== 'web' && harness !== 'native') throw new Error(`unknown harness: ${harness}`);
  if (args['native-capacity'] != null && args['native-capacity'] !== true) {
    throw new Error('--native-capacity is a boolean flag and does not accept a value.');
  }
  if (args['capacity-thresholds'] != null && args['capacity-thresholds'] !== true) {
    throw new Error('--capacity-thresholds is a boolean flag and does not accept a value.');
  }
  const nativeCapacity = args['native-capacity'] === true;
  if (args['capacity-thresholds'] === true && !nativeCapacity) {
    throw new Error('--capacity-thresholds requires --native-capacity.');
  }
  if (nativeCapacity && harness !== 'native') {
    throw new Error('--native-capacity requires --harness native.');
  }
  if (nativeCapacity) {
    const requestedEntries = list(args.entry);
    if (requestedEntries?.length !== 1 || requestedEntries[0] !== NATIVE_CAPACITY_ENTRY_ID) {
      throw new Error(
        `--native-capacity requires --entry ${NATIVE_CAPACITY_ENTRY_ID}.`,
      );
    }
  }
  const jit = args.jit ?? 'jit';
  const cpuThrottle = args['cpu-throttle'] == null ? 1 : Number(args['cpu-throttle']);
  if (jit !== 'jit' && jit !== 'interp') throw new Error(`unknown jit regime: ${jit}`);
  if (!Number.isFinite(cpuThrottle) || cpuThrottle < 1) {
    throw new Error(`--cpu-throttle must be a finite number >= 1; received ${args['cpu-throttle']}`);
  }
  const throttleScope = resolveThrottleScope(args, cpuThrottle);
  if (harness === 'native'
    && (args.jit != null || args['cpu-throttle'] != null || args['throttle-scope'] != null)) {
    throw new Error(
      '--jit, --cpu-throttle, and --throttle-scope are Web-only; Native cohort policy is unchanged.',
    );
  }

  let entries = discoverEntries({ only: list(args.entry) });
  if (harness === 'native' && args.entry == null) {
    entries = entries.filter((entry) => (entry.tier ?? 'featured') !== 'lab'
      && entrySupportsHarness(entry, 'native'));
  }
  if (entries.length === 0) throw new Error('no entries matched');
  const caseNames = list(args.case);
  const cases = caseNames
    ? TABLE_CASES.filter((c) => caseNames.includes(c.name))
    : TABLE_CASES;
  const commitPolicies = list(args.commit) ?? STORM_COMMIT_POLICIES;
  const unknownPolicies = commitPolicies.filter((policy) =>
    !STORM_COMMIT_POLICIES.includes(policy));
  if (unknownPolicies.length) {
    throw new Error(`unknown storm commit policy/policies: ${unknownPolicies.join(', ')}`);
  }
  const stormCases = STORM_CASES.filter((kase) =>
    (caseNames == null || caseNames.includes(kase.name))
    && commitPolicies.includes(kase.commitPolicy));
  if (caseNames) {
    const knownCases = new Set([...TABLE_CASES, ...STORM_CASES].map((kase) => kase.name));
    const unknownCases = caseNames.filter((name) => !knownCases.has(name));
    if (unknownCases.length) throw new Error(`unknown case(s): ${unknownCases.join(', ')}`);
  }
  const suites = list(args.suite)
    ?? (harness === 'web' ? ['table', 'startup', 'pipeline', 'storm'] : ['table', 'startup']);
  const unknownSuites = suites.filter((suite) =>
    !['table', 'startup', 'pipeline', 'storm'].includes(suite));
  if (unknownSuites.length) throw new Error(`unknown suite(s): ${unknownSuites.join(', ')}`);

  if (harness === 'native') {
    if (nativeCapacity) {
      await runNativeCapacityCommand(args, entries);
      return;
    }
    if (suites.includes('pipeline') || suites.includes('storm')) {
      throw new Error(
        'The pipeline and storm suites are Web-only; use the standard Native table/startup matrix.',
      );
    }
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
      .filter((entry) => (entry.tier ?? 'featured') !== 'lab'
        && entrySupportsHarness(entry, 'native'))
      .map((entry) => entry.id)
      .sort();
    const selectedIds = entries.map((entry) => entry.id).sort();
    if (
      nativeSuites.length !== 2
      || !nativeSuites.includes('table')
      || !nativeSuites.includes('startup')
      || nativeCases.length !== NATIVE_TABLE_CASES.length
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
    let methodRevisionChain = null;
    let cellMethodRevisionIds = {};
    let activeMethodRevisionId = null;
    let persistedCampaign = campaign;
    let persistedInputReceipt = inputs.receipt;
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
        methodRevisionReason: typeof args['method-revision'] === 'string'
          ? args['method-revision']
          : null,
        methodRevisionInputReceiptSha256:
          typeof args['method-revision-input-sha256'] === 'string'
            ? args['method-revision-input-sha256']
            : null,
      });
      priorRecords = resumed.records;
      priorDeviceCohort = resumed.priorDeviceCohort;
      cellLeaseIds = resumed.cellLeaseIds;
      leaseChain = resumed.leaseChain;
      persistedCampaign = resumed.campaign;
      persistedInputReceipt = resumed.campaignInputReceipt;
      methodRevisionChain = resumed.methodRevisionChain;
      cellMethodRevisionIds = resumed.cellMethodRevisionIds;
      activeMethodRevisionId = resumed.activeMethodRevisionId;
    }
    const priorIndex = nativeRecordIndex(priorRecords, matrixContract);
    console.log(`[run:native] entries: ${entries.map((e) => e.id).join(', ')}`);
    console.log(
      `[run:native] contract=${matrixContract.expectedCellCount} cells `
      + `scales=${scales.join(',')} startup=${startupScales.join(',')} `
      + `campaign=${persistedCampaign.id}`
      + (activeMethodRevisionId == null ? '' : ` method=${activeMethodRevisionId}`),
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
        if (activeMethodRevisionId != null) {
          const existingRevisionId = cellMethodRevisionIds[key];
          if (existingRevisionId != null && existingRevisionId !== activeMethodRevisionId) {
            throw new Error(`Native cell ${key} already belongs to method ${existingRevisionId}.`);
          }
          cellMethodRevisionIds[key] = activeMethodRevisionId;
        }
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
          ...(methodRevisionChain == null ? {} : { methodRevisionChain, cellMethodRevisionIds }),
          campaign: persistedCampaign,
          resolvedMatrix,
          matrixContract,
          inputReceipt: persistedInputReceipt,
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
        campaignId: persistedCampaign.id,
        matrixContractSha256: matrixContract.sha256,
        inputReceiptSha256: persistedInputReceipt.sha256,
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
    if (shouldCollectAfterRun(args)) collectRuns();
    return;
  }
  const quick = Boolean(args.quick);
  const scales = numList(args.scale)
    ?? (quick ? [1000] : [1000, 10000]);
  const startupScales = numList(args['startup-scale'])
    ?? [0, ...scales, 30000].filter((value, index, values) => values.indexOf(value) === index);
  const reps = args.reps ? Number(args.reps) : quick ? 3 : 7;
  const stormReps = args['storm-reps'] ? Number(args['storm-reps']) : quick ? 1 : 3;
  const startupReps = args['startup-reps'] ? Number(args['startup-reps']) : quick ? 2 : 5;

  console.log(`[run] entries: ${entries.map((e) => e.id).join(', ')}`);
  console.log(
    `[run] suites: ${suites.join(', ')}; cases: ${cases.map((c) => c.name).join(', ')}; `
    + `storm: ${stormCases.map((c) => `${c.name}/${c.commitPolicy}`).join(', ')}; `
    + `scales: ${scales.join(', ')}; reps=${reps}; stormReps=${stormReps}`,
  );

  // Only the one-off verifier gets --allow-natives-syntax. Measured processes never do.
  const flagVerification = jit === 'interp' ? await verifyInterpreterFlags() : null;
  if (flagVerification != null) {
    console.log(
      `[preflight:interp] JIT status=${flagVerification.jit.status}; `
      + `interp status=${flagVerification.interp.status}; Wasm=ok`,
    );
  }

  // Preflight in the same browser configuration that will measure.
  const preflight = await (async () => {
    if (throttleScope === 'process-cgroup') {
      const control = await launchBrowser({ jit });
      let controlProbe;
      try {
        controlProbe = await runProcessThrottleProbe(control.browser, {
          requireWebHarness: true,
          jsRegime: jit,
        });
      } finally {
        await control.closeBrowser();
      }
      return calibrateProcessThrottle({
        jit, cpuThrottle, control: controlProbe, requireWebHarness: true,
      });
    }
    const launched = await launchBrowser({ jit, cpuThrottle, throttleScope });
    try {
      const probe = await runPreflight(launched.browser, {
        cpuThrottle: throttleScope === 'page-cdp' ? cpuThrottle : 1,
        requireWebHarness: true,
        jsRegime: jit,
      });
      return {
        probe,
        browser: {
          name: 'chromium',
          version: launched.browserVersion,
          executablePath: launched.executablePath,
        },
        processThrottle: launched.processThrottle,
        processThrottleVerification: null,
        processQuotaPercent: null,
      };
    } finally {
      await launched.closeBrowser();
    }
  })();
  const { probe } = preflight;
  const jsFlags = jsFlagsForRegime(jit);
  console.log(`[preflight] score=${probe.score} (probe v${probe.probeVersion})`);
  const receipt = runReceipt({
    entries, reps, stormReps, startupReps,
    execution: {
      harness: 'web', browser: preflight.browser, jsRegime: jit, jsFlags, cpuThrottle,
      throttleScope,
      ...(preflight.processQuotaPercent == null
        ? {}
        : { processQuotaPercent: preflight.processQuotaPercent }),
    },
  });

  const {
    records, executablePath, browserVersion, processThrottle,
    processThrottleEntryVerifications, verifiedSlowdownByEntry,
  } = await runWebHarness({
    entries, cases, stormCases, suites, scales, startupScales, reps, stormReps, startupReps,
    jit, cpuThrottle, throttleScope,
    processThrottleControl: preflight.processThrottleVerification?.control ?? null,
    processQuotaPercent: preflight.processQuotaPercent,
  });
  if (browserVersion !== preflight.browser.version
    || executablePath !== preflight.browser.executablePath) {
    throw new Error('browser identity changed between preflight and benchmark execution');
  }
  if ((processThrottle?.backend ?? null) !== (preflight.processThrottle?.backend ?? null)) {
    throw new Error('whole-process throttle backend changed between preflight and benchmark execution');
  }
  if ((processThrottle?.quotaPercent ?? null) !== (preflight.processThrottle?.quotaPercent ?? null)) {
    throw new Error('whole-process throttle quota changed between preflight and benchmark execution');
  }
  for (const entry of entries) records.push(...bundleRecords(entry).map((record) =>
    attachWebBundleEnvironment(record, {
      jsRegime: jit, jsFlags, cpuThrottle, throttleScope,
      ...(verifiedSlowdownByEntry[entry.id] == null
        ? {}
        : { verifiedSlowdown: verifiedSlowdownByEntry[entry.id] }),
    })));

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
      browser: { name: 'chromium', version: browserVersion, executablePath },
      environment: { jsRegime: jit, jsFlags, cpuThrottle, throttleScope },
      ...(flagVerification == null ? {} : { flagVerification }),
      ...(preflight.processThrottleVerification == null
        ? {}
        : { processThrottleVerification: preflight.processThrottleVerification }),
      ...(processThrottle == null ? {} : { processThrottle }),
      ...(processThrottleEntryVerifications.length === 0
        ? {}
        : { processThrottleEntryVerifications }),
      argv: process.argv.slice(2),
      entryCommits: Object.fromEntries(
        entries.map((e) => [e.id, e.provenance?.commit ?? null]),
      ),
      receipt,
    },
    records,
  };
  const root = repoRoot();
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = path.join(root, 'results/runs', `${stamp}-${machine.id}${label}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, stringifyResult(run));
  console.log(`[run] ${records.length} records → ${path.relative(root, outPath)}`);
  // The run file is the source; latest.json is only a materialized view. Keep
  // it synchronized immediately unless the caller explicitly asked to defer
  // materialization (useful while completing a split regime campaign).
  if (shouldCollectAfterRun(args)) collectRuns();
}

async function cmdPreflight(args) {
  const jit = args.jit ?? 'jit';
  const cpuThrottle = args['cpu-throttle'] == null ? 1 : Number(args['cpu-throttle']);
  if (jit !== 'jit' && jit !== 'interp') throw new Error(`unknown jit regime: ${jit}`);
  if (!Number.isFinite(cpuThrottle) || cpuThrottle < 1) {
    throw new Error(`--cpu-throttle must be a finite number >= 1; received ${args['cpu-throttle']}`);
  }
  const throttleScope = resolveThrottleScope(args, cpuThrottle);
  const flagVerification = jit === 'interp' ? await verifyInterpreterFlags() : null;
  if (throttleScope === 'process-cgroup') {
    const control = await launchBrowser({ jit });
    let controlProbe;
    try {
      controlProbe = await runProcessThrottleProbe(control.browser, { requireWebHarness: true });
    } finally {
      await control.closeBrowser();
    }
    const calibrated = await calibrateProcessThrottle({
      jit, cpuThrottle, control: controlProbe, requireWebHarness: true,
    });
    const jsFlags = jsFlagsForRegime(jit);
    console.log(JSON.stringify({
      machine: machineFingerprint(),
      environment: { jsRegime: jit, jsFlags, cpuThrottle, throttleScope },
      calibration: calibrated.probe,
      ...(flagVerification == null ? {} : { flagVerification }),
      processThrottleVerification: calibrated.processThrottleVerification,
      processThrottle: calibrated.processThrottle,
    }, null, 2));
    return;
  }
  const launched = await launchBrowser({ jit, cpuThrottle, throttleScope });
  try {
    const probe = await runPreflight(launched.browser, {
      cpuThrottle: throttleScope === 'page-cdp' ? cpuThrottle : 1,
      requireWebHarness: true,
    });
    const jsFlags = jsFlagsForRegime(jit);
    const machine = machineFingerprint();
    console.log(JSON.stringify({
      machine,
      environment: { jsRegime: jit, jsFlags, cpuThrottle, throttleScope },
      calibration: probe,
      ...(flagVerification == null ? {} : { flagVerification }),
    }, null, 2));
  } finally {
    await launched.closeBrowser();
  }
}

function cmdList() {
  const entries = discoverEntries();
  for (const e of entries) {
    const scales = fs.existsSync(e.distDir)
      ? fs.readdirSync(e.distDir).filter((d) => d.startsWith('rows-')).map((d) => d.slice(5)).join(',')
      : 'no dist';
    const listFixture = e.listFixture == null ? 'unsupported' : e.listFixture.protocol ?? 'invalid';
    console.log(`${e.id.padEnd(18)} ${e.label.padEnd(28)} [${e.tags?.join(',') ?? ''}] rows: ${scales}; list: ${listFixture}`);
  }
  console.log(
    '\ncases: ' + TABLE_CASES.map((c) => c.name).join(', ')
    + ', updateStorm, selectStorm, startup, pipeline, '
    + LIST_CASES.map((kase) => kase.name).join(', ')
    + '; storm policies: '
    + STORM_COMMIT_POLICIES.join(', '),
  );
}

function cmdListCoverage() {
  const coverage = assertListCoverage(buildListCoverage({ entries: discoverEntries() }));
  console.log(JSON.stringify(coverage, null, 2));
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0] ?? 'run';
try {
  if (cmd === 'run') await cmdRun(args);
  else if (cmd === 'preflight') await cmdPreflight(args);
  else if (cmd === 'collect') collectRuns();
  else if (cmd === 'list') cmdList();
  else if (cmd === 'list-coverage') cmdListCoverage();
  else {
    console.error(`unknown command: ${cmd}`);
    process.exit(2);
  }
} catch (e) {
  console.error(String(e?.stack ?? e));
  process.exit(1);
}
