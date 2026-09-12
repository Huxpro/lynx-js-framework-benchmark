import { performance } from 'node:perf_hooks';

import { makeRecord } from '@lynx-bench/shared/schema';
import {
  LIST_CASES,
  LIST_CONFIG,
  LIST_SOURCE_METRIC_CONTRACTS,
  LIST_WORKLOAD_CONTRACT_VERSION,
} from '../../shared/src/list-workloads.mjs';

import { launchBrowser } from './browser.mjs';
import { listFixtureStatus } from './list-coverage.mjs';
import { analyzeListFling, analyzeListRecycle } from './list-observation.mjs';
import { assertProcessThrottleProbe, runProcessThrottleProbe } from './preflight.mjs';
import { startServer } from './server.mjs';

const PROCESS_CGROUP_READINESS_BARRIER = Object.freeze({
  method: 'wire-idle-v1',
  idleMs: 500,
  timeoutMs: 30000,
});

const wireSnapshot = (page) => page.evaluate(() => globalThis.__LYNX_WIRE_SNAPSHOT__());

function wireDelta(before, after) {
  const side = (left, right) => ({
    messages: right.messages - left.messages,
    bytes: right.bytes - left.bytes,
  });
  return { toBts: side(before.toBts, after.toBts), toMts: side(before.toMts, after.toMts) };
}

function emitListRecord({
  entry,
  workload,
  scale,
  metric,
  samples,
  dnfCount,
  failures,
  jsRegime,
  cpuThrottle,
  throttleScope,
  verifiedSlowdown,
}) {
  const contract = LIST_SOURCE_METRIC_CONTRACTS[metric];
  return makeRecord({
    suite: 'list',
    harness: 'web',
    entry: entry.id,
    workload,
    scale,
    metric,
    boundary: contract.boundary,
    unit: contract.unit,
    contractVersion: LIST_WORKLOAD_CONTRACT_VERSION,
    samples,
    dnfCount,
    failures,
    attemptedCount: samples.length + dnfCount,
    acceptedCount: samples.length,
    jsRegime,
    cpuThrottle,
    throttleScope,
    verifiedSlowdown,
  });
}

async function runFixedVelocityWheel(page, { velocityPxPerSecond, durationMs }) {
  const frameMs = 1000 / 60;
  const frameCount = Math.round(durationMs / frameMs);
  const delta = (velocityPxPerSecond * frameMs) / 1000;
  const startedAt = performance.now();
  for (let frame = 0; frame < frameCount; frame++) {
    await page.mouse.wheel(0, delta);
    const delayMs = Math.max(0, startedAt + (frame + 1) * frameMs - performance.now());
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

export async function runListSuite({
  entry,
  cases = LIST_CASES,
  reps = LIST_CONFIG.recycle.repetitions,
  browser,
  origin,
  log = () => {},
  jsRegime = 'jit',
  cpuThrottle = 1,
  throttleScope = 'none',
  verifiedSlowdown = null,
}) {
  const records = [];
  for (const kase of cases) {
    for (const scale of kase.scales) {
      const fixture = listFixtureStatus(entry, 'web', scale);
      if (!fixture.supported) {
        log(`  [skip] ${entry.id} ${kase.name}@${scale}: ${fixture.reason}`);
        continue;
      }
      const bundleUrl = `/entries/${entry.id}/${fixture.bundle}`;
      const observations = Object.fromEntries(kase.sourceMetrics.map((metric) => [metric, []]));
      const failures = [];
      let dnfCount = 0;
      for (let rep = 0; rep < reps; rep++) {
        const page = await browser.newPage({ viewport: LIST_CONFIG.viewport });
        try {
          await page.goto(`${origin}/list`, { waitUntil: 'load' });
          const initial = await page.evaluate(
            async ({ url, viewport }) => {
              globalThis.__x.createView(url, viewport.widthPx, viewport.heightPx);
              return globalThis.__x.waitListFirstContent();
            },
            { url: bundleUrl, viewport: LIST_CONFIG.viewport },
          );
          if (kase.name === 'list-startup') {
            observations.firstVisibleContentMs.push(initial.firstVisibleContentMs);
            continue;
          }
          const before = await wireSnapshot(page);
          const armed = page.evaluate(({ durationMs }) => globalThis.__x.armListMotion({ durationMs }), {
            durationMs: kase.name === 'list-fling' ? LIST_CONFIG.fling.durationMs : 0,
          });
          await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
          if (kase.name === 'list-recycle') {
            await page.mouse.wheel(0, LIST_CONFIG.recycle.distancePx);
          } else {
            await runFixedVelocityWheel(page, LIST_CONFIG.fling);
          }
          const capture = await armed;
          const wire = wireDelta(before, await wireSnapshot(page));
          if (kase.name === 'list-recycle') {
            const measured = analyzeListRecycle(initial, capture.frames);
            observations.operationTimeMs.push(measured.operationTimeMs);
            observations.recycledCells.push(measured.recycledCells);
            observations.wireToMtsBytes.push(wire.toMts.bytes);
            observations.wireToBtsBytes.push(wire.toBts.bytes);
          } else {
            const measured = analyzeListFling(initial, capture.frames);
            observations.elapsedMs.push(measured.elapsedMs);
            observations.materializedCells.push(measured.materializedCells);
            observations.blankFrames.push(measured.blankFrames);
            observations.materializationTimesMs.push(...measured.materializationTimesMs);
          }
        } catch (error) {
          dnfCount++;
          failures.push({ category: 'list-capture-failure', rep, message: String(error) });
          log(`  [dnf] ${entry.id} ${kase.name}@${scale} rep${rep}: ${String(error).slice(0, 160)}`);
        } finally {
          await page.close();
        }
      }
      for (const metric of kase.sourceMetrics) {
        records.push(emitListRecord({
          entry,
          workload: kase.name,
          scale,
          metric,
          samples: observations[metric],
          dnfCount,
          failures,
          jsRegime,
          cpuThrottle,
          throttleScope,
          verifiedSlowdown,
        }));
      }
      log(`  ${entry.id} ${kase.name}@${scale}: n=${reps - dnfCount} dnf=${dnfCount}`);
    }
  }
  return records;
}

export async function runWebListHarness({
  entries,
  cases = LIST_CASES,
  reps = LIST_CONFIG.recycle.repetitions,
  log = console.log,
  jit = 'jit',
  cpuThrottle = 1,
  throttleScope = 'none',
  processThrottleControl = null,
  processQuotaPercent = null,
}) {
  const entryRoots = Object.fromEntries(entries.map((entry) => [entry.id, entry.dir]));
  const server = await startServer({ bundleRoots: {}, entryRoots });
  const {
    browser, executablePath, browserVersion, processThrottle, closeBrowser,
  } = await launchBrowser({ jit, cpuThrottle, throttleScope, processQuotaPercent });
  const processThrottleReceipt = processThrottle == null
    ? null
    : { ...processThrottle, readinessBarrier: PROCESS_CGROUP_READINESS_BARRIER };
  const records = [];
  const processThrottleEntryVerifications = [];
  try {
    for (const entry of entries) {
      log(`[entry:list] ${entry.id} (${entry.label})`);
      const processThrottleVerification = throttleScope === 'process-cgroup'
        ? assertProcessThrottleProbe({
          control: processThrottleControl,
          throttled: await runProcessThrottleProbe(browser, {
            requireWebHarness: true,
            jsRegime: jit,
          }),
          cpuThrottle,
          mechanism: processThrottleReceipt,
        })
        : null;
      const verifiedSlowdown = processThrottleVerification?.verifiedSlowdown ?? null;
      if (processThrottleVerification != null) {
        processThrottleEntryVerifications.push({ entry: entry.id, ...processThrottleVerification });
      }
      records.push(...await runListSuite({
        entry,
        cases,
        reps,
        browser,
        origin: server.origin,
        log,
        jsRegime: jit,
        cpuThrottle,
        throttleScope,
        verifiedSlowdown,
      }));
    }
  } finally {
    await closeBrowser();
    await server.close();
  }
  return {
    records: records.map((record) => ({
      ...record,
      environment: { ...record.environment, throttleScope },
    })),
    executablePath,
    browserVersion,
    processThrottle: processThrottleReceipt,
    processThrottleEntryVerifications,
    verifiedSlowdownByEntry: Object.fromEntries(
      processThrottleEntryVerifications.map(({ entry, verifiedSlowdown }) => [entry, verifiedSlowdown]),
    ),
  };
}
