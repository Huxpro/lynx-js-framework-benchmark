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
} from '@lynx-bench/shared/workloads';

import { launchBrowser } from './browser.mjs';
import { startServer } from './server.mjs';
import { CdpClient, attachToPageAndWorkers, RealmProfiler } from './cdp.mjs';
import { bundleFor } from './entries.mjs';

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

async function openBenchPage({ browser, origin, bundleUrl, cdp, viewW = 800, viewH = 640 }) {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  page.on('pageerror', (err) => console.error('  [pageerror]', String(err).slice(0, 200)));
  await page.goto(`${origin}/`, { waitUntil: 'load' });
  const attach = await attachToPageAndWorkers(cdp, origin);
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
const RESET_EACH_SAMPLE = new Set(['create', 'append1k', 'remove', 'clear']);

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
}) {
  const records = [];
  const bundle = bundleFor(entry, { rows: 0 });
  if (!bundle) {
    log(`  [skip] ${entry.id}: no rows-0 web bundle`);
    return records;
  }
  const bundleUrl = `/bundles/${entry.id}/${bundle.rel}`;

  // Warm page shared by non-storm cases.
  const { page, attach } = await openBenchPage({ browser, origin, bundleUrl, cdp });
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
      records.push(...emitOpRecords({ entry, kase, scale, samples, dnfCount }));
      log(`  ${entry.id} ${kase.name}@${scale}: ${fmtSummary(samples)}${dnfCount ? ` dnf=${dnfCount}` : ''}`);
    }
  }

  // Memory snapshot: GC'd heap per realm holding a 10k-row table (indicative —
  // one scenario, deliberately simple; the unified benchmark's heap markers).
  try {
    await clickButton(page, CREATE_BUTTON[10000]);
    await untilPredicate(page, { type: 'rowCount', value: 10000 }, 240000);
    await settle(page, 200);
    await gc(page);
    const registry = await page.evaluate(() => globalThis.__LYNX_WIRE__.workers);
    const sessions = [{ key: 'heapMts', sessionId: attach.pageSession }];
    for (const w of attach.workers.values()) {
      const reg = registry.find((r) => r.blobUrl === w.url || r.url === w.url);
      if (reg?.name === 'lynx-bg') sessions.push({ key: 'heapBts', sessionId: w.sessionId });
    }
    for (const s of sessions) {
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
      }));
    }
    log(`  ${entry.id} memory@10k: ${sessions.map((s) => s.key).join('+')} captured`);
  } catch (e) {
    log(`  [warn] ${entry.id} memory snapshot failed: ${String(e).slice(0, 120)}`);
  }
  await page.close();

  // Storm cases: fresh page per rep.
  for (const kase of cases) {
    if (!kase.freshPage) continue;
    for (const scale of kase.scales.filter((s) => scales.includes(s))) {
      kase._scale = scale;
      const samples = { latency: [], btsCpu: [], mtsCpu: [], wire: [] };
      let dnfCount = 0;
      for (let rep = 0; rep < stormReps; rep++) {
        const fresh = await openBenchPage({ browser, origin, bundleUrl, cdp });
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
      records.push(...emitOpRecords({ entry, kase, scale, samples, dnfCount }));
      log(`  ${entry.id} ${kase.name}@${scale}: ${fmtSummary(samples)}${dnfCount ? ` dnf=${dnfCount}` : ''}`);
    }
  }

  return records;
}

function fmtSummary(samples) {
  const s = summarize(samples.latency);
  return s ? `${s.median.toFixed(1)}ms ±${(s.ci95 ?? 0).toFixed(1)} (n=${s.n})` : 'no samples';
}

function emitOpRecords({ entry, kase, scale, samples, dnfCount }) {
  const records = [];
  const base = { suite: 'table', entry: entry.id, workload: kase.name, scale };
  const lat = summarize(samples.latency);
  records.push(makeRecord({
    ...base,
    metric: 'latency',
    boundary: BOUNDARIES.latency,
    unit: 'ms',
    stat: lat,
    samples: samples.latency,
    dnfCount,
  }));
  for (const [key, metric, boundary] of [
    ['btsCpu', 'btsCpu', BOUNDARIES.btsCpu],
    ['mtsCpu', 'mtsCpu', BOUNDARIES.mtsCpu],
  ]) {
    const stat = summarize(samples[key]);
    if (stat) {
      records.push(makeRecord({
        ...base,
        metric,
        boundary,
        unit: 'ms',
        stat,
        samples: samples[key],
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
        stat: summarize(vals),
        samples: vals,
        detail: metric === 'wireToMtsBytes'
          ? { byName: samples.wire.at(-1)?.toMts.byName }
          : metric === 'wireToBtsBytes'
            ? { byName: samples.wire.at(-1)?.toBts.byName }
            : null,
      }));
    }
  }
  return records;
}

export async function runStartupSuite({ entry, scales, reps, browser, origin, cdp, log }) {
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
        const attach = await attachToPageAndWorkers(cdp, origin);
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
    const base = { suite: 'startup', entry: entry.id, workload: 'startup', scale };
    records.push(makeRecord({
      ...base,
      metric: 'fcp',
      boundary: BOUNDARIES.fcp,
      unit: 'ms',
      stat: summarize(samples.fcp),
      samples: samples.fcp,
      dnfCount,
    }));
    records.push(makeRecord({
      ...base,
      metric: 'settled',
      boundary: BOUNDARIES.settled,
      unit: 'ms',
      stat: summarize(samples.settled),
      samples: samples.settled,
      dnfCount,
    }));
    if (samples.mtsCpu.length) {
      records.push(makeRecord({
        ...base,
        metric: 'mtsCpu',
        boundary: BOUNDARIES.mtsCpu,
        unit: 'ms',
        stat: summarize(samples.mtsCpu),
        samples: samples.mtsCpu,
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
          stat: summarize(samples[key]),
          samples: samples[key],
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
  suites,
  scales,
  reps = 7,
  stormReps = 3,
  startupReps = 5,
  log = console.log,
}) {
  const bundleRoots = {};
  for (const e of entries) bundleRoots[e.id] = e.distDir;
  const server = await startServer({ bundleRoots });
  const { browser, cdpPort, executablePath } = await launchBrowser();
  const cdp = await CdpClient.connect(cdpPort);
  const records = [];
  try {
    for (const entry of entries) {
      log(`[entry] ${entry.id} (${entry.label})`);
      if (suites.includes('table')) {
        records.push(...await runTableSuite({
          entry, cases, scales, reps, stormReps,
          browser, origin: server.origin, cdp, log,
        }));
      }
      if (suites.includes('startup')) {
        records.push(...await runStartupSuite({
          entry,
          scales: [0, ...scales, 30000].filter((v, i, a) => a.indexOf(v) === i),
          reps: startupReps,
          browser, origin: server.origin, cdp, log,
        }));
      }
    }
  } finally {
    cdp.close();
    await browser.close();
    await server.close();
  }
  return { records, executablePath };
}
