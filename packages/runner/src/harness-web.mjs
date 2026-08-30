// The headless-web harness: drives every entry through the shared workload
// contract in headless Chromium and collects, per operation:
//   latency  — in-page pointerdown → first rAF where the DOM predicate holds
//   wire     — BTS↔MTS messages/bytes in both directions, per rpc endpoint
//   btsCpu / mtsCpu — sampled JS CPU per realm via the CDP sidecar
// plus fcp/settled (+ startup wire/cpu) for the startup suite.
import { summarize } from '@lynx-bench/shared/stats';
import { makeRecord, BOUNDARIES } from '@lynx-bench/shared/schema';
import {
  TABLE_CASES,
  STARTUP_CASES,
  CREATE_BUTTON,
  READY_TEXT,
  STORM_SELECT_TICKS,
  STORM_UPDATE_TICKS,
} from '@lynx-bench/shared/workloads';

import { launchBrowser } from './browser.mjs';
import { startServer } from './server.mjs';
import { CdpClient, attachToPageAndWorkers, RealmProfiler } from './cdp.mjs';
import { bundleFor } from './entries.mjs';
import { assertProcessThrottleProbe, runProcessThrottleProbe } from './preflight.mjs';
import { derivePipelineSample, emitPipelineRecords } from './pipeline-attribution.mjs';
import {
  deriveStormSample,
  emitStormRecords,
  stormContractPass,
  stormContractReceipt,
} from './storm-contract.mjs';

const SETTLE_MS = 30;

async function evalX(page, expr) {
  return page.evaluate(`(() => { const x = globalThis.__x; return (${expr}); })()`);
}

async function clickAt(page, rect, label) {
  if (!rect) throw new Error(`no click geometry for ${label}`);
  await page.mouse.click(rect.x, rect.y);
}

async function clickButton(page, label) {
  const rect = await evalX(page, `x.buttonRect(${JSON.stringify(label)})`);
  await clickAt(page, rect, `button ${label}`);
}

async function clickCell(page, rowIndex, cls) {
  const rect = await evalX(page, `x.cellRect(${rowIndex}, ${JSON.stringify(cls)})`);
  await clickAt(page, rect, `cell ${rowIndex}.${cls}`);
}

async function untilPredicate(page, spec, timeoutMs = 120000) {
  await page.evaluate(
    ({ spec, timeoutMs }) => globalThis.__x.until(spec, timeoutMs),
    { spec, timeoutMs },
  );
}

async function settle(page, extraMs = SETTLE_MS) {
  await page.evaluate((ms) => globalThis.__x.settle(ms), extraMs);
}

async function wireSnapshot(page) {
  return page.evaluate(() => globalThis.__LYNX_WIRE_SNAPSHOT__());
}

function wireDelta(before, after) {
  const side = (a, b) => {
    const names = new Set([...Object.keys(a.byName), ...Object.keys(b.byName)]);
    const byName = {};
    for (const n of names) {
      const d = {
        messages: (b.byName[n]?.messages ?? 0) - (a.byName[n]?.messages ?? 0),
        bytes: (b.byName[n]?.bytes ?? 0) - (a.byName[n]?.bytes ?? 0),
      };
      if (d.messages || d.bytes) byName[n] = d;
    }
    return {
      messages: b.messages - a.messages,
      bytes: b.bytes - a.bytes,
      byName,
    };
  };
  return { toBts: side(before.toBts, after.toBts), toMts: side(before.toMts, after.toMts) };
}

export function stormCommitGuard(kase, wire) {
  const expected = kase.name === 'updateStorm'
    ? STORM_UPDATE_TICKS
    : kase.name === 'selectStorm'
      ? STORM_SELECT_TICKS
      : null;
  if (expected == null) return null;
  const observed = {
    toMtsMessages: wire.toMts.messages,
    toBtsMessages: wire.toBts.messages,
  };
  if (observed.toMtsMessages >= expected && observed.toBtsMessages >= expected) return null;
  return {
    category: 'incomplete-storm-transport',
    phase: 'table',
    expectedSequentialCommits: expected,
    evidence: observed,
    message: `${kase.name} completed its final predicate with only `
      + `${observed.toMtsMessages} BTS→MTS / ${observed.toBtsMessages} MTS→BTS messages; `
      + `expected at least ${expected} in each direction.`,
  };
}

async function gc(page) {
  await page.evaluate(() => globalThis.gc?.());
}

/** Map CDP worker targets to realm keys using the page's worker registry. */
async function profilerFor(page, attach) {
  const registry = await page.evaluate(() => globalThis.__LYNX_WIRE__.workers);
  const sessions = [{ key: 'mts', sessionId: attach.pageSession }];
  for (const w of attach.workers.values()) {
    const reg = registry.find((r) => r.blobUrl === w.url || r.url === w.url);
    if (reg?.name === 'lynx-bg') sessions.push({ key: 'bts', sessionId: w.sessionId });
  }
  return new RealmProfiler(attach.client ?? attach._client, sessions);
}

async function openBenchPage({
  browser,
  origin,
  bundleUrl,
  cdp,
  cpuThrottle = 1,
  viewW = 800,
  viewH = 640,
  harnessPath = '/',
}) {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  page.on('pageerror', (err) => console.error('  [pageerror]', String(err).slice(0, 200)));
  await page.goto(`${origin}${harnessPath}`, { waitUntil: 'load' });
  const attach = await attachToPageAndWorkers(cdp, origin, { cpuThrottle });
  attach.client = cdp;
  await page.evaluate(
    ({ url, w, h }) => globalThis.__x.createView(url, w, h),
    { url: bundleUrl, w: viewW, h: viewH },
  );
  return { page, attach };
}

async function waitReady(page, timeoutMs = 120000) {
  await page.waitForFunction(
    (needle) => globalThis.__x.findText(needle),
    READY_TEXT,
    { timeout: timeoutMs, polling: 16 },
  );
  await settle(page);
}

/** Establish a case's pre-state (untimed). */
async function ensurePre(page, kase, scale) {
  if (kase.pre === 'empty') {
    const count = await evalX(page, 'x.rowCount()');
    if (count > 0) {
      await clickButton(page, 'Clear');
      await untilPredicate(page, { type: 'rowCount', value: 0 });
    }
    await settle(page);
    return;
  }
  // rows / rows+preselect
  const count = await evalX(page, 'x.rowCount()');
  if (count !== scale) {
    await clickButton(page, CREATE_BUTTON[scale]);
    await untilPredicate(page, { type: 'rowCount', value: scale }, 240000);
  }
  if (kase.pre === 'rows+preselect') {
    const already = await evalX(page, 'x.dangerAt(5)');
    if (!already) {
      await clickCell(page, 5, 'col-label');
      await untilPredicate(page, { type: 'dangerAt', index: 5 });
    }
  }
  await settle(page);
}

/** Compute the predicate spec for special (state-dependent) predicates. */
async function resolvePredicate(page, kase, scale) {
  if (kase.predicate === 'label0-suffixed') {
    const label = await evalX(page, 'x.labelAt(0)');
    return { type: 'labelAt', index: 0, equals: `${label} !!!` };
  }
  if (kase.predicate === 'swap-1-998') {
    const label = await evalX(page, 'x.labelAt(998)');
    return { type: 'labelAt', index: 1, equals: label };
  }
  if (kase.predicate === 'replace-first-id') {
    const lastId = await evalX(page, `x.idAt(${scale - 1})`);
    return { type: 'idAt', index: 0, equals: String(Number(lastId) + 1) };
  }
  return kase.predicate(scale);
}

/** Cases that mutate state irreversibly get their pre-state rebuilt each sample. */
const RESET_EACH_SAMPLE = new Set([
  'create',
  'append1k',
  'remove',
  'clear',
]);

async function measurePipelineOnce({ page, kase, spec, scale, timeoutMs }) {
  const armed = page.evaluate(
    ({ spec: predicate, timeout }) => globalThis.__x.armPipeline(predicate, timeout),
    { spec, timeout: timeoutMs },
  );
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  if (kase.trigger.button) {
    await clickButton(page, kase.trigger.button(scale));
  } else {
    await clickCell(page, kase.trigger.cell.rowIndex, kase.trigger.cell.cls);
  }
  const { ms, pipeline } = await armed;
  const committedRows = await evalX(page, 'x.rowCount()');
  return derivePipelineSample({
    operationMs: ms,
    capture: pipeline,
    requestedRows: scale,
    committedRows,
  });
}

const waitMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function stormClickTargets(page, kase) {
  if (kase.action.kind === 'button') {
    const rect = await evalX(page, `x.buttonRect(${JSON.stringify(kase.action.label)})`);
    if (!rect) throw new Error(`no storm button geometry for ${kase.action.label}`);
    return [rect];
  }
  if (kase.action.kind === 'alternating-cells') {
    const targets = [];
    for (const rowIndex of kase.action.rowIndices) {
      const rect = await evalX(page, `x.cellRect(${rowIndex}, ${JSON.stringify(kase.action.cls)})`);
      if (!rect) throw new Error(`no storm cell geometry for row ${rowIndex}`);
      targets.push(rect);
    }
    return targets;
  }
  throw new Error(`unknown storm action ${kase.action.kind}`);
}

async function measureStormOnce({ page, profiler, kase }) {
  const targets = await stormClickTargets(page, kase);
  const baseline = kase.observation.kind === 'label-suffix'
    ? await evalX(page, `x.labelAt(${kase.observation.rowIndex})`)
    : null;
  const config = { ...stormContractReceipt(kase), baseline };
  const wireBefore = await wireSnapshot(page);
  await profiler.start();
  const armed = page.evaluate(
    ({ stormConfig, timeoutMs }) => globalThis.__x.armStorm(stormConfig, timeoutMs),
    { stormConfig: config, timeoutMs: kase.timeoutMs },
  );
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  const scheduleStart = performance.now();
  let capture;
  let cpu;
  try {
    try {
      for (let tick = 0; tick < kase.ticks; tick++) {
        if (tick > 0) {
          const remaining = tick * kase.tickIntervalMs - (performance.now() - scheduleStart);
          if (remaining > 0) await waitMs(remaining);
        }
        await clickAt(page, targets[tick % targets.length], `storm tick ${tick + 1}`);
      }
      capture = await armed;
    } catch (error) {
      await page.evaluate(() => globalThis.__x.abortStorm());
      capture = await armed;
      capture.driverError = String(error);
    }
  } finally {
    cpu = await profiler.stop();
  }
  const wire = wireDelta(wireBefore, await wireSnapshot(page));
  return { capture, cpu, wire };
}

async function measureOnce({ page, profiler, kase, spec, timeoutMs }) {
  const wireBefore = await wireSnapshot(page);
  await profiler.start();
  const armed = page.evaluate(
    ({ spec, timeoutMs }) => globalThis.__x.arm(spec, timeoutMs),
    { spec, timeoutMs },
  );
  // Give the armed pointerdown listener a beat to install before clicking.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
  if (kase.trigger.button) {
    await clickButton(page, kase.trigger.button(kase._scale));
  } else {
    await clickCell(page, kase.trigger.cell.rowIndex, kase.trigger.cell.cls);
  }
  const { ms } = await armed;
  const cpu = await profiler.stop();
  const wire = wireDelta(wireBefore, await wireSnapshot(page));
  return { ms, cpu, wire };
}

export async function runTableSuite({
  entry,
  cases,
  scales,
  reps,
  stormReps,
  browser,
  origin,
  cdp,
  log,
  includeMemory = true,
  jsRegime = 'jit',
  cpuThrottle = 1,
  throttleScope = 'none',
  verifiedSlowdown = null,
  cdpCpuThrottle = cpuThrottle,
}) {
  const records = [];
  const bundle = bundleFor(entry, { rows: 0 });
  if (!bundle) {
    log(`  [skip] ${entry.id}: no rows-0 web bundle`);
    return records;
  }
  const bundleUrl = `/bundles/${entry.id}/${bundle.rel}`;

  // Warm page shared by non-storm cases.
  const { page, attach } = await openBenchPage({
    browser, origin, bundleUrl, cdp, cpuThrottle: cdpCpuThrottle,
  });
  await waitReady(page);
  const profiler = await profilerFor(page, attach);

  // Warmup: two create/clear cycles.
  for (let i = 0; i < 2; i++) {
    await clickButton(page, CREATE_BUTTON[1000]);
    await untilPredicate(page, { type: 'rowCount', value: 1000 });
    await clickButton(page, 'Clear');
    await untilPredicate(page, { type: 'rowCount', value: 0 });
  }
  await settle(page);

  for (const kase of cases) {
    if (kase.freshPage) continue; // storms handled below
    for (const scale of kase.scales.filter((s) => scales.includes(s))) {
      kase._scale = scale;
      const samples = { latency: [], btsCpu: [], mtsCpu: [], wire: [] };
      let dnfCount = 0;
      for (let rep = 0; rep < reps; rep++) {
        if (rep === 0 || RESET_EACH_SAMPLE.has(kase.name)) {
          if (RESET_EACH_SAMPLE.has(kase.name) && kase.pre !== 'empty') {
            // rebuild rows:N from scratch
            await clickButton(page, 'Clear');
            await untilPredicate(page, { type: 'rowCount', value: 0 });
          }
          await ensurePre(page, kase, scale);
        } else if (kase.name === 'select') {
          // restore steady-state: move selection away from row 1 (untimed)
          await clickCell(page, 5, 'col-label');
          await untilPredicate(page, { type: 'dangerAt', index: 5 });
          await settle(page);
        }
        await gc(page);
        const spec = await resolvePredicate(page, kase, scale);
        try {
          const s = await measureOnce({
            page,
            profiler,
            kase,
            spec,
            timeoutMs: kase.timeoutMs ?? 120000,
          });
          samples.latency.push(s.ms);
          if (s.cpu.bts != null) samples.btsCpu.push(s.cpu.bts);
          if (s.cpu.mts != null) samples.mtsCpu.push(s.cpu.mts);
          samples.wire.push(s.wire);
        } catch (e) {
          if (String(e).includes('timeout')) {
            dnfCount += 1;
            log(`  [dnf] ${entry.id} ${kase.name}@${scale} rep${rep}: ${String(e).slice(0, 120)}`);
          } else {
            throw e;
          }
        }
        await settle(page);
      }
      records.push(...emitOpRecords({
        entry, kase, scale, samples, dnfCount, attemptedCount: reps,
        jsRegime, cpuThrottle, throttleScope, verifiedSlowdown,
      }));
      log(`  ${entry.id} ${kase.name}@${scale}: ${fmtSummary(samples)}${dnfCount ? ` dnf=${dnfCount}` : ''}`);
    }
  }

  // Do not measure memory on the warm page above: its heaps include allocation
  // history from every preceding workload. Use one fresh page for the 10k
  // scenario and collect garbage in each CDP realm before reading its heap.
  await page.close();
  let memoryPage = null;
  try {
    if (!includeMemory) return await runStormCases({
      entry, cases, scales, stormReps, browser, origin, cdp, log, records, bundleUrl,
      jsRegime, cpuThrottle, throttleScope, verifiedSlowdown, cdpCpuThrottle,
    });
    const fresh = await openBenchPage({
      browser, origin, bundleUrl, cdp, cpuThrottle: cdpCpuThrottle,
    });
    memoryPage = fresh.page;
    await waitReady(memoryPage);
    await clickButton(memoryPage, CREATE_BUTTON[10000]);
    await untilPredicate(memoryPage, { type: 'rowCount', value: 10000 }, 240000);
    await settle(memoryPage, 200);
    const registry = await memoryPage.evaluate(() => globalThis.__LYNX_WIRE__.workers);
    const sessions = [{ key: 'heapMts', sessionId: fresh.attach.pageSession }];
    for (const w of fresh.attach.workers.values()) {
      const reg = registry.find((r) => r.blobUrl === w.url || r.url === w.url);
      if (reg?.name === 'lynx-bg') sessions.push({ key: 'heapBts', sessionId: w.sessionId });
    }
    for (const s of sessions) {
      await cdp.send('HeapProfiler.collectGarbage', {}, s.sessionId);
      const { usedSize } = await cdp.send('Runtime.getHeapUsage', {}, s.sessionId);
      records.push(makeRecord({
        suite: 'table',
        entry: entry.id,
        workload: 'memory',
        scale: 10000,
        metric: s.key,
        boundary: 'gc-heap-with-10k-rows',
        unit: 'bytes',
        value: usedSize,
        jsRegime, cpuThrottle, throttleScope, verifiedSlowdown,
      }));
    }
    await clickButton(memoryPage, 'Clear');
    await untilPredicate(memoryPage, { type: 'rowCount', value: 0 }, 240000);
    await settle(memoryPage, 200);
    for (const s of sessions) {
      await cdp.send('HeapProfiler.collectGarbage', {}, s.sessionId);
      const { usedSize } = await cdp.send('Runtime.getHeapUsage', {}, s.sessionId);
      records.push(makeRecord({
        suite: 'table',
        entry: entry.id,
        workload: 'memoryAfterClear',
        scale: 10000,
        metric: `${s.key}AfterClear`,
        boundary: 'gc-heap-after-clearing-10k-rows',
        unit: 'bytes',
        value: usedSize,
        jsRegime, cpuThrottle, throttleScope, verifiedSlowdown,
      }));
    }
    log(
      `  ${entry.id} memory@10k+afterClear: ${sessions.map((s) => s.key).join('+')} captured`,
    );
  } catch (e) {
    log(`  [warn] ${entry.id} memory snapshot failed: ${String(e).slice(0, 120)}`);
  } finally {
    await memoryPage?.close();
  }

  return runStormCases({
    entry, cases, scales, stormReps, browser, origin, cdp, log, records, bundleUrl,
    jsRegime, cpuThrottle, throttleScope, verifiedSlowdown, cdpCpuThrottle,
  });
}

export async function runPipelineSuite({
  entry,
  cases,
  scales,
  reps,
  browser,
  origin,
  cdp,
  log,
}) {
  const records = [];
  const bundle = bundleFor(entry, { rows: 0 });
  if (!bundle) {
    log(`  [unsupported] ${entry.id} pipeline: no rows-0 web bundle`);
    return records;
  }
  const bundleUrl = `/bundles/${entry.id}/${bundle.rel}`;
  const { page } = await openBenchPage({
    browser,
    origin,
    bundleUrl,
    cdp,
    harnessPath: '/pipeline',
  });
  try {
    await waitReady(page);

    // Match the table suite's steady-state warmup, but keep every warmup call
    // outside an active PAPI capture.
    for (let i = 0; i < 2; i++) {
      await clickButton(page, CREATE_BUTTON[1000]);
      await untilPredicate(page, { type: 'rowCount', value: 1000 });
      await clickButton(page, 'Clear');
      await untilPredicate(page, { type: 'rowCount', value: 0 });
    }
    await settle(page);

    for (const kase of cases) {
      if (kase.freshPage) continue;
      for (const scale of kase.scales.filter((candidate) => scales.includes(candidate))) {
        const samples = [];
        const failures = [];
        let dnfCount = 0;
        for (let rep = 0; rep < reps; rep++) {
          if (rep === 0 || RESET_EACH_SAMPLE.has(kase.name)) {
            if (RESET_EACH_SAMPLE.has(kase.name) && kase.pre !== 'empty') {
              await clickButton(page, 'Clear');
              await untilPredicate(page, { type: 'rowCount', value: 0 });
            }
            await ensurePre(page, kase, scale);
          } else if (kase.name === 'select') {
            await clickCell(page, 5, 'col-label');
            await untilPredicate(page, { type: 'dangerAt', index: 5 });
            await settle(page);
          }
          await gc(page);
          const spec = await resolvePredicate(page, kase, scale);
          try {
            samples.push(await measurePipelineOnce({
              page,
              kase,
              spec,
              scale,
              timeoutMs: kase.timeoutMs ?? 120000,
            }));
          } catch (error) {
            if (!String(error).includes('timeout')) throw error;
            dnfCount += 1;
            failures.push({
              rep,
              category: 'pipeline-predicate-timeout',
              phase: 'pipeline',
              message: String(error),
            });
            log(`  [dnf] ${entry.id} pipeline ${kase.name}@${scale} rep${rep}`);
          }
          await settle(page);
        }
        records.push(...emitPipelineRecords({
          entry,
          kase,
          scale,
          samples,
          dnfCount,
          failures,
          attemptedCount: reps,
        }));
        const operation = summarize(samples.map((sample) => sample.operationMs));
        log(
          `  ${entry.id} pipeline ${kase.name}@${scale}: `
          + `${operation ? `${operation.median.toFixed(1)}ms` : 'DNF'} `
          + `(n=${operation?.n ?? 0}${dnfCount ? `, dnf=${dnfCount}` : ''})`,
        );
      }
    }
  } finally {
    await page.close();
  }
  return records;
}

export async function runStormSuite({
  entry,
  cases,
  scales,
  reps,
  browser,
  origin,
  cdp,
  log,
}) {
  const records = [];
  const bundle = bundleFor(entry, { rows: 0 });
  if (!bundle) {
    log(`  [unsupported] ${entry.id} storm: no rows-0 web bundle`);
    return records;
  }
  const bundleUrl = `/bundles/${entry.id}/${bundle.rel}`;
  for (const kase of cases) {
    for (const scale of kase.scales.filter((candidate) => scales.includes(candidate))) {
      const samples = [];
      const failures = [];
      let dnfCount = 0;
      for (let rep = 0; rep < reps; rep++) {
        const fresh = await openBenchPage({
          browser,
          origin,
          bundleUrl,
          cdp,
          harnessPath: '/storm',
        });
        let measured = null;
        try {
          await waitReady(fresh.page);
          await ensurePre(fresh.page, kase, scale);
          await gc(fresh.page);
          const profiler = await profilerFor(fresh.page, fresh.attach);
          measured = await measureStormOnce({ page: fresh.page, profiler, kase });
          if (measured.capture?.driverError) {
            dnfCount += 1;
            failures.push({
              rep,
              category: 'storm-input-driver-failure',
              phase: 'storm',
              evidence: measured,
              message: measured.capture.driverError,
            });
            continue;
          }
          if (measured.capture?.timedOut) {
            dnfCount += 1;
            failures.push({
              rep,
              category: 'storm-terminal-timeout',
              phase: 'storm',
              timeoutMs: kase.timeoutMs,
              evidence: measured,
              message: `storm terminal state timed out after ${kase.timeoutMs}ms`,
            });
            continue;
          }
          samples.push(deriveStormSample({ kase, ...measured }));
        } catch (error) {
          dnfCount += 1;
          failures.push({
            rep,
            category: 'storm-driver-or-capture-failure',
            phase: 'storm',
            message: String(error),
            ...(measured ? { evidence: measured } : {}),
          });
        } finally {
          await fresh.page.close();
        }
      }
      records.push(...emitStormRecords({
        entry,
        kase,
        scale,
        samples,
        dnfCount,
        failures,
        attemptedCount: reps,
      }));
      const passed = samples.filter((sample) => stormContractPass(sample.control)).length;
      const summary = summarize(samples.map((sample) => sample.operationMs));
      log(
        `  ${entry.id} storm ${kase.name}/${kase.commitPolicy}@${scale}: `
        + `${summary ? `${summary.median.toFixed(1)}ms` : 'DNF'} `
        + `(pass=${passed}/${samples.length}${dnfCount ? `, dnf=${dnfCount}` : ''})`,
      );
    }
  }
  return records;
}

async function runStormCases({
  entry, cases, scales, stormReps, browser, origin, cdp, log, records, bundleUrl,
  jsRegime, cpuThrottle, throttleScope, verifiedSlowdown, cdpCpuThrottle = cpuThrottle,
}) {
  // Storm cases: fresh page per rep.
  for (const kase of cases) {
    if (!kase.freshPage) continue;
    for (const scale of kase.scales.filter((s) => scales.includes(s))) {
      kase._scale = scale;
      const samples = { latency: [], btsCpu: [], mtsCpu: [], wire: [] };
      let dnfCount = 0;
      const failures = [];
      for (let rep = 0; rep < stormReps; rep++) {
        const fresh = await openBenchPage({
          browser, origin, bundleUrl, cdp, cpuThrottle: cdpCpuThrottle,
        });
        try {
          await waitReady(fresh.page);
          const freshProfiler = await profilerFor(fresh.page, fresh.attach);
          await ensurePre(fresh.page, kase, scale);
          await gc(fresh.page);
          const spec = await resolvePredicate(fresh.page, kase, scale);
          const s = await measureOnce({
            page: fresh.page,
            profiler: freshProfiler,
            kase,
            spec,
            timeoutMs: kase.timeoutMs ?? 240000,
          });
          const incomplete = stormCommitGuard(kase, s.wire);
          if (incomplete) {
            dnfCount += 1;
            failures.push({
              rep,
              ...incomplete,
              evidence: {
                ...incomplete.evidence,
                latencyMs: s.ms,
                btsCpuMs: s.cpu.bts ?? null,
                mtsCpuMs: s.cpu.mts ?? null,
                wire: s.wire,
              },
            });
            log(`  [dnf] ${entry.id} ${kase.name}@${scale} rep${rep}: ${incomplete.message}`);
            continue;
          }
          samples.latency.push(s.ms);
          if (s.cpu.bts != null) samples.btsCpu.push(s.cpu.bts);
          if (s.cpu.mts != null) samples.mtsCpu.push(s.cpu.mts);
          samples.wire.push(s.wire);
        } catch (e) {
          if (String(e).includes('timeout')) {
            dnfCount += 1;
            log(`  [dnf] ${entry.id} ${kase.name}@${scale} rep${rep}`);
          } else {
            throw e;
          }
        } finally {
          await fresh.page.close();
        }
      }
      records.push(...emitOpRecords({
        entry, kase, scale, samples, dnfCount, failures, attemptedCount: stormReps,
        jsRegime, cpuThrottle, throttleScope, verifiedSlowdown,
      }));
      log(`  ${entry.id} ${kase.name}@${scale}: ${fmtSummary(samples)}${dnfCount ? ` dnf=${dnfCount}` : ''}`);
    }
  }

  return records;
}

function fmtSummary(samples) {
  const s = summarize(samples.latency);
  return s ? `${s.median.toFixed(1)}ms ±${(s.ci95 ?? 0).toFixed(1)} (n=${s.n})` : 'no samples';
}

function emitOpRecords({
  entry, kase, scale, samples, dnfCount, failures = [], attemptedCount,
  jsRegime = 'jit', cpuThrottle = 1, throttleScope = 'none', verifiedSlowdown = null,
}) {
  const records = [];
  const base = {
    suite: 'table', entry: entry.id, workload: kase.name, scale,
    jsRegime, cpuThrottle, throttleScope, verifiedSlowdown,
  };
  records.push(makeRecord({
    ...base,
    metric: 'latency',
    boundary: BOUNDARIES.latency,
    unit: 'ms',
    samples: samples.latency,
    dnfCount,
    failures,
    attemptedCount,
    acceptedCount: samples.latency.length,
  }));
  for (const [key, metric, boundary] of [
    ['btsCpu', 'btsCpu', BOUNDARIES.btsCpu],
    ['mtsCpu', 'mtsCpu', BOUNDARIES.mtsCpu],
  ]) {
    if (samples[key].length) {
      records.push(makeRecord({
        ...base,
        metric,
        boundary,
        unit: 'ms',
        samples: samples[key],
        attemptedCount,
        acceptedCount: samples[key].length,
      }));
    }
  }
  if (samples.wire.length) {
    for (const [metric, pickSide, pickField] of [
      ['wireToBtsBytes', 'toBts', 'bytes'],
      ['wireToBtsMsgs', 'toBts', 'messages'],
      ['wireToMtsBytes', 'toMts', 'bytes'],
      ['wireToMtsMsgs', 'toMts', 'messages'],
    ]) {
      const vals = samples.wire.map((w) => w[pickSide][pickField]);
      records.push(makeRecord({
        ...base,
        metric,
        boundary: BOUNDARIES.wire,
        unit: metric.endsWith('Bytes') ? 'bytes' : 'count',
        samples: vals,
        attemptedCount,
        acceptedCount: vals.length,
        // Keep every endpoint observation as source. makeRecord derives the
        // display detail from the sample nearest the total median, so changing
        // or adding a sample cannot leave an old "last sample" visualization.
        detailSamples: metric === 'wireToMtsBytes'
          ? samples.wire.map((wire) => ({ byName: wire.toMts.byName }))
          : metric === 'wireToBtsBytes'
            ? samples.wire.map((wire) => ({ byName: wire.toBts.byName }))
            : null,
      }));
    }
  }
  return records;
}

export async function runStartupSuite({
  entry, scales, reps, browser, origin, cdp, log, jsRegime = 'jit', cpuThrottle = 1,
  throttleScope = 'none', verifiedSlowdown = null,
  cdpCpuThrottle = cpuThrottle,
}) {
  const records = [];
  const kase = STARTUP_CASES[0];
  for (const scale of kase.scales.filter((s) => scales.includes(s))) {
    const bundle = bundleFor(entry, { rows: scale });
    if (!bundle) {
      log(`  [skip] ${entry.id} startup@${scale}: no rows-${scale} bundle`);
      continue;
    }
    const bundleUrl = `/bundles/${entry.id}/${bundle.rel}`;
    const samples = { fcp: [], settled: [], btsCpu: [], mtsCpu: [], wireToMts: [], wireToBts: [] };
    let dnfCount = 0;
    for (let rep = 0; rep < reps; rep++) {
      const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
      try {
        await page.goto(`${origin}/`, { waitUntil: 'load' });
        const attach = await attachToPageAndWorkers(cdp, origin, {
          cpuThrottle: cdpCpuThrottle,
        });
        attach.client = cdp;
        // Profile from before view attach; the bg worker session joins on boot.
        const pageProfiler = new RealmProfiler(cdp, [{ key: 'mts', sessionId: attach.pageSession }]);
        await pageProfiler.start();
        const fcpPromise = page.evaluate(
          ({ url, minContent, readyText, timeoutMs }) => {
            globalThis.__x.createView(url, 800, 640);
            return globalThis.__x.fcp({ minContent, readyText, timeoutMs });
          },
          {
            url: bundleUrl,
            minContent: kase.minContent,
            // A zero-row boot has no table content; its first frame is the title.
            readyText: scale === 0 ? READY_TEXT : null,
            timeoutMs: kase.timeoutMs,
          },
        );
        const result = await fcpPromise;
        const cpu = await pageProfiler.stop();
        const wire = await wireSnapshot(page);
        if (result.dnf || result.fcp == null) {
          dnfCount += 1;
          log(`  [dnf] ${entry.id} startup@${scale} rep${rep} (count=${result.finalCount})`);
        } else {
          samples.fcp.push(result.fcp);
          if (result.settled != null) samples.settled.push(result.settled);
          if (cpu.mts != null) samples.mtsCpu.push(cpu.mts);
          samples.wireToMts.push(wire.toMts.bytes);
          samples.wireToBts.push(wire.toBts.bytes);
        }
      } finally {
        await page.close();
      }
    }
    const base = {
      suite: 'startup', entry: entry.id, workload: 'startup', scale,
      jsRegime, cpuThrottle, throttleScope, verifiedSlowdown,
    };
    records.push(makeRecord({
      ...base,
      metric: 'fcp',
      boundary: BOUNDARIES.fcp,
      unit: 'ms',
      samples: samples.fcp,
      dnfCount,
      attemptedCount: reps,
      acceptedCount: samples.fcp.length,
    }));
    records.push(makeRecord({
      ...base,
      metric: 'settled',
      boundary: BOUNDARIES.settled,
      unit: 'ms',
      samples: samples.settled,
      dnfCount,
      attemptedCount: reps,
      acceptedCount: samples.settled.length,
    }));
    if (samples.mtsCpu.length) {
      records.push(makeRecord({
        ...base,
        metric: 'mtsCpu',
        boundary: BOUNDARIES.mtsCpu,
        unit: 'ms',
        samples: samples.mtsCpu,
        attemptedCount: reps,
        acceptedCount: samples.mtsCpu.length,
      }));
    }
    for (const [metric, key] of [
      ['wireToMtsBytes', 'wireToMts'],
      ['wireToBtsBytes', 'wireToBts'],
    ]) {
      if (samples[key].length) {
        records.push(makeRecord({
          ...base,
          metric,
          boundary: BOUNDARIES.wire,
          unit: 'bytes',
          samples: samples[key],
          attemptedCount: reps,
          acceptedCount: samples[key].length,
        }));
      }
    }
    const fs = summarize(samples.fcp);
    log(`  ${entry.id} startup@${scale}: fcp ${fs ? fs.median.toFixed(1) + 'ms' : 'DNF'} (n=${fs?.n ?? 0}${dnfCount ? `, dnf=${dnfCount}` : ''})`);
  }
  return records;
}

export async function runWebHarness({
  entries,
  cases,
  stormCases = [],
  suites,
  scales,
  startupScales = null,
  reps = 7,
  stormReps = 3,
  startupReps = 5,
  log = console.log,
  includeMemory = true,
  jit = 'jit',
  cpuThrottle = 1,
  throttleScope = 'none',
  processThrottleControl = null,
  processQuotaPercent = null,
}) {
  const bundleRoots = {};
  for (const e of entries) bundleRoots[e.id] = e.distDir;
  const server = await startServer({ bundleRoots });
  const {
    browser, cdpPort, executablePath, browserVersion, processThrottle, closeBrowser,
  } = await launchBrowser({ jit, cpuThrottle, throttleScope, processQuotaPercent });
  const cdp = await CdpClient.connect(cdpPort);
  const records = [];
  const processThrottleEntryVerifications = [];
  const cdpCpuThrottle = throttleScope === 'page-cdp' ? cpuThrottle : 1;
  try {
    for (const entry of entries) {
      log(`[entry] ${entry.id} (${entry.label})`);
      const processThrottleVerification = throttleScope === 'process-cgroup'
        ? assertProcessThrottleProbe({
          control: processThrottleControl,
          throttled: await runProcessThrottleProbe(browser, {
            requireWebHarness: true, jsRegime: jit,
          }),
          cpuThrottle,
          mechanism: processThrottle,
        })
        : null;
      const verifiedSlowdown = processThrottleVerification?.verifiedSlowdown ?? null;
      if (processThrottleVerification != null) {
        processThrottleEntryVerifications.push({ entry: entry.id, ...processThrottleVerification });
        log(
          `  [verify:process-cgroup] ${entry.id}: ${verifiedSlowdown.toFixed(2)}x `
          + `(accepted ${processThrottleVerification.acceptedRange.join('–')}x)`,
        );
      }
      if (suites.includes('table')) {
        records.push(...await runTableSuite({
          entry, cases, scales, reps, stormReps,
          browser, origin: server.origin, cdp, log, includeMemory,
          jsRegime: jit, cpuThrottle, throttleScope, verifiedSlowdown, cdpCpuThrottle,
        }));
      }
      if (suites.includes('pipeline')) {
        records.push(...await runPipelineSuite({
          entry,
          cases,
          scales,
          reps,
          browser,
          origin: server.origin,
          cdp,
          log,
        }));
      }
      if (suites.includes('storm')) {
        records.push(...await runStormSuite({
          entry,
          cases: stormCases,
          scales,
          reps: stormReps,
          browser,
          origin: server.origin,
          cdp,
          log,
        }));
      }
      if (suites.includes('startup')) {
        records.push(...await runStartupSuite({
          entry,
          scales: startupScales
            ?? [0, ...scales, 30000].filter((v, i, a) => a.indexOf(v) === i),
          reps: startupReps,
          browser, origin: server.origin, cdp, log,
          jsRegime: jit, cpuThrottle, throttleScope, verifiedSlowdown, cdpCpuThrottle,
        }));
      }
    }
  } finally {
    cdp.close();
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
    processThrottle,
    processThrottleEntryVerifications,
    verifiedSlowdownByEntry: Object.fromEntries(
      processThrottleEntryVerifications.map(({ entry, verifiedSlowdown }) => [entry, verifiedSlowdown]),
    ),
  };
}
