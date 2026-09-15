#!/usr/bin/env node
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { bundleFor, discoverEntries, repoRoot } from '../packages/runner/src/entries.mjs';
import { launchBrowser } from '../packages/runner/src/browser.mjs';
import { startServer } from '../packages/runner/src/server.mjs';
import {
  compactAcknowledgement,
  validateLifecycleCycles,
} from './lifecycle-observation.mjs';

const { values: args } = parseArgs({
  options: {
    entry: { type: 'string' },
    cycles: { type: 'string', default: '20' },
    rows: { type: 'string', default: '1000' },
    output: { type: 'string' },
  },
});
const cycleCount = Number(args.cycles);
const rows = Number(args.rows);
if (
  args.entry == null
  || args.output == null
  || !Number.isSafeInteger(cycleCount)
  || cycleCount < 20
  || !Number.isSafeInteger(rows)
  || rows !== 1000
) {
  throw new Error(
    'usage: audit-lifecycle-web --entry <id> --cycles <at-least-20> '
      + '--rows 1000 --output <audit.json>',
  );
}

const root = repoRoot();
const dirty = execFileSync(
  'git',
  ['status', '--porcelain', '--untracked-files=no'],
  { cwd: root, encoding: 'utf8' },
).trim();
if (dirty !== '') throw new Error(`lifecycle audit requires a clean tracked checkout:\n${dirty}`);
const repositoryCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
}).trim();
const entry = discoverEntries({ only: [args.entry] })[0];
if (!entry.capabilities?.production || entry.capabilities?.sourcePatches) {
  throw new Error('lifecycle audit requires an unpatched production entry.');
}
const bundle = bundleFor(entry, { rows: 0 });
if (bundle == null) throw new Error(`${entry.id} lacks a rows-0 Web bundle.`);
const bundleSha256 = crypto.createHash('sha256').update(fs.readFileSync(bundle.abs)).digest('hex');
if (entry.provenance.sha256?.['rows-0/main.web.bundle'] !== bundleSha256) {
  throw new Error(`${entry.id} bundle does not match its immutable receipt.`);
}

const server = await startServer({ bundleRoots: { [entry.id]: entry.distDir } });
const {
  browser,
  executablePath,
  browserVersion,
  closeBrowser,
} = await launchBrowser({ jit: 'jit' });

async function clickAndAwait(page, label, predicate) {
  const armed = page.evaluate(
    (spec) => globalThis.__x.arm(spec, 120000),
    predicate,
  );
  const rectangle = await page.evaluate(
    (text) => globalThis.__x.buttonRect(text),
    label,
  );
  if (rectangle == null) throw new Error(`${label} button not found.`);
  await page.mouse.click(rectangle.x, rectangle.y);
  await armed;
  await page.evaluate(() => globalThis.__x.settle(100));
}

async function snapshot(worker) {
  const value = await worker.evaluate(() => globalThis.__LYNX_BENCH_SNAPSHOT__?.());
  if (value == null) throw new Error('background benchmark snapshot is unavailable.');
  return value;
}

async function physicalHostElements(page) {
  return page.evaluate(() => {
    let count = 0;
    const walk = (node) => {
      if (node?.nodeType === 1) {
        if (String(node.tagName).startsWith('X-')) count++;
        if (node.shadowRoot) walk(node.shadowRoot);
      }
      for (const child of node?.childNodes ?? []) walk(child);
    };
    walk(document.body);
    return count;
  });
}

const page = await browser.newPage();
const cycles = [];
try {
  await page.addInitScript(() => {
    const state = globalThis.__OCTANE_LIFECYCLE_OBSERVER__ = {
      acknowledgements: [],
      rowEvents: 0,
      captureRowEvent: false,
      lastEvent: null,
      lastEventPort: null,
    };
    state.beginRowCapture = () => {
      state.captureRowEvent = true;
      state.lastEvent = null;
      state.lastEventPort = null;
    };
    const originalPost = MessagePort.prototype.postMessage;
    state.replayLast = () => {
      if (state.lastEvent == null || state.lastEventPort == null) {
        throw new Error('no captured row event is available for stale replay.');
      }
      originalPost.call(state.lastEventPort, state.lastEvent);
    };
    MessagePort.prototype.postMessage = function observedPost(data, ...rest) {
      if (
        state.captureRowEvent
        && data?.name === 'publicComponentEvent'
        && Array.isArray(data.data)
      ) {
        state.captureRowEvent = false;
        state.rowEvents++;
        state.lastEvent = structuredClone(data);
        state.lastEventPort = this;
      }
      if (
        data?.name === 'dispatchCoreContextOnBackground'
        && data.data?.[0]?.type === 'octane-lynx:compiled-program-main-to-background'
      ) {
        state.acknowledgements.push(data.data[0].data);
      }
      return originalPost.call(this, data, ...rest);
    };
  });
  await page.goto(server.origin, { waitUntil: 'load' });
  await page.evaluate(
    (url) => globalThis.__x.createView(url),
    `/bundles/${entry.id}/${bundle.rel}`,
  );
  await page.waitForFunction(() => globalThis.__x.findText('Benchmark on Lynx'), undefined, {
    timeout: 60000,
  });
  await page.waitForTimeout(1500);
  let worker = null;
  for (const candidate of page.workers()) {
    try {
      if (await candidate.evaluate(
        () => typeof globalThis.__LYNX_BENCH_SNAPSHOT__ === 'function',
      )) {
        worker = candidate;
        break;
      }
    } catch {
      // A non-background helper may terminate while workers are enumerated.
    }
  }
  if (worker == null) throw new Error('Lynx background worker was not found.');
  const baselineSnapshot = await snapshot(worker);
  const baselinePhysicalHostElements = await physicalHostElements(page);
  if (baselineSnapshot.rowCount !== 0) throw new Error('lifecycle page did not start empty.');

  for (let index = 0; index < cycleCount; index++) {
    const beforeEvents = await page.evaluate(
      () => globalThis.__OCTANE_LIFECYCLE_OBSERVER__.rowEvents,
    );
    await clickAndAwait(page, 'Create 1,000 rows', { type: 'rowCount', value: rows });
    await page.evaluate(() => globalThis.__OCTANE_LIFECYCLE_OBSERVER__.beginRowCapture());
    const selected = page.evaluate(() => globalThis.__x.arm({
      type: 'dangerAt',
      index: 0,
    }, 120000));
    const cell = await page.evaluate(() => globalThis.__x.cellRect(0, 'col-label'));
    if (cell == null) throw new Error(`cycle ${index + 1} row listener target is missing.`);
    await page.mouse.click(cell.x, cell.y);
    await selected;
    await page.evaluate(() => globalThis.__x.settle(30));
    const afterCreateSnapshot = await snapshot(worker);
    const afterCreatePhysical = await physicalHostElements(page);
    const afterEvents = await page.evaluate(
      () => globalThis.__OCTANE_LIFECYCLE_OBSERVER__.rowEvents,
    );
    const acknowledgementStart = await page.evaluate(
      () => globalThis.__OCTANE_LIFECYCLE_OBSERVER__.acknowledgements.length,
    );
    await clickAndAwait(page, 'Clear', { type: 'rowCount', value: 0 });
    const afterClearSnapshot = await snapshot(worker);
    const afterClearPhysical = await physicalHostElements(page);
    const acknowledgementValues = await page.evaluate(
      (start) => globalThis.__OCTANE_LIFECYCLE_OBSERVER__.acknowledgements.slice(start),
      acknowledgementStart,
    );
    const acknowledgements = acknowledgementValues
      .map(compactAcknowledgement)
      .filter((value) => value != null);
    await page.evaluate(() => globalThis.__OCTANE_LIFECYCLE_OBSERVER__.replayLast());
    await page.waitForTimeout(150);
    const afterStaleReplay = await snapshot(worker);
    cycles.push({
      cycle: index + 1,
      rows,
      afterCreate: {
        rows: afterCreateSnapshot.rowCount,
        selectedId: afterCreateSnapshot.selectedId,
        physicalHostElements: afterCreatePhysical,
      },
      afterClear: {
        rows: afterClearSnapshot.rowCount,
        selectedId: afterClearSnapshot.selectedId,
        physicalHostElements: afterClearPhysical,
      },
      activeListenerDeliveries: afterEvents - beforeEvents,
      staleListenerDeliveriesAccepted:
        afterStaleReplay.rowCount === afterClearSnapshot.rowCount
        && afterStaleReplay.selectedId === afterClearSnapshot.selectedId
          ? 0
          : 1,
      acknowledgements,
    });
  }
  const totals = validateLifecycleCycles(cycles, cycleCount);
  if (totals.physicalHostBaseline !== baselinePhysicalHostElements) {
    throw new Error('post-clear physical host baseline differs from the initial page.');
  }
  const audit = {
    kind: 'm4-final-production-web-lifecycle-audit',
    generatedAt: new Date().toISOString(),
    entry: entry.id,
    decision: { pass: true },
    identities: {
      entryCommit: entry.provenance.commit,
      benchmarkHarnessCommit: repositoryCommit,
      bundle: bundle.rel,
      bundleSha256,
      sourcePatches: entry.capabilities.sourcePatches,
      production: entry.capabilities.production,
      machine: {
        hostname: os.hostname(),
        platform: os.platform(),
        arch: os.arch(),
        cpuModel: os.cpus()[0]?.model ?? null,
      },
      browser: { name: 'chromium', version: browserVersion, executablePath },
    },
    protocol: {
      cycles: cycleCount,
      sequence: 'create 1k -> deliver fresh row listener -> clear -> replay stale listener; next cycle is recreate',
      recordBoundary: 'composed Lynx Web native element census (X-* hosts)',
      listenerBoundary: 'fresh row event must commit; the exact captured token must not mutate BTS state after clear',
      handleBoundary: 'compact clear acknowledgement tuples must contain no member beyond protocol/op/root/version',
      profileInstrumentation: false,
      productionBundleMutated: false,
    },
    baseline: {
      rows: baselineSnapshot.rowCount,
      selectedId: baselineSnapshot.selectedId,
      physicalHostElements: baselinePhysicalHostElements,
    },
    totals,
    cycles,
  };
  const outputPath = path.resolve(args.output);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(audit, null, 2)}\n`);
  process.stderr.write(`[lifecycle] PASS; wrote ${outputPath}\n`);
} finally {
  await page.close();
  await closeBrowser();
  await server.close();
}
