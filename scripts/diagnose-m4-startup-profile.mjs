#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

import { READY_TEXT } from '../packages/shared/src/workloads.mjs';

import { launchBrowser } from '../packages/runner/src/browser.mjs';
import { CdpClient, attachToPageAndWorkers, profileCpuMs } from '../packages/runner/src/cdp.mjs';
import { bundleFor, discoverEntries, repoRoot } from '../packages/runner/src/entries.mjs';
import { machineFingerprint } from '../packages/runner/src/machine.mjs';
import { startServer } from '../packages/runner/src/server.mjs';

const args = process.argv.slice(2);
const option = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const outputArg = option('--output');
const entryIds = option('--entries', 'octane-m4-final,reactlynx-m4-default').split(',');
const pairs = Number(option('--pairs', '5'));
if (outputArg == null || !Number.isSafeInteger(pairs) || pairs < 1) {
  throw new Error(
    'usage: diagnose-m4-startup-profile --output <file.json> [--entries a,b] [--pairs N]',
  );
}

const root = repoRoot();
const entries = discoverEntries({ root, only: entryIds });
const bundleRoots = Object.fromEntries(entries.map((entry) => [entry.id, entry.distDir]));
const output = path.resolve(root, outputArg);

function summarizeProfile(profile) {
  const frames = new Map(profile.nodes.map((node) => [node.id, node.callFrame ?? {}]));
  const selfMicros = new Map();
  for (let index = 0; index < (profile.samples?.length ?? 0); index++) {
    const frame = frames.get(profile.samples[index]) ?? {};
    const key = JSON.stringify({
      url: frame.url ?? '',
      functionName: frame.functionName ?? '',
      lineNumber: frame.lineNumber ?? -1,
      columnNumber: frame.columnNumber ?? -1,
    });
    selfMicros.set(key, (selfMicros.get(key) ?? 0) + (profile.timeDeltas[index] ?? 0));
  }
  return [...selfMicros]
    .map(([key, micros]) => ({ ...JSON.parse(key), selfMs: micros / 1000 }))
    .sort((a, b) => b.selfMs - a.selfMs);
}

async function profileEntry({ browser, cdp, origin, entry, order, pair }) {
  const bundle = bundleFor(entry, { rows: 0 });
  if (bundle == null) throw new Error(`${entry.id} has no rows-0 Web bundle.`);
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  try {
    await page.goto(`${origin}/`, { waitUntil: 'load' });
    const attached = await attachToPageAndWorkers(cdp, origin);
    await cdp.send('Profiler.enable', {}, attached.pageSession);
    await cdp.send('Profiler.setSamplingInterval', { interval: 200 }, attached.pageSession);
    await cdp.send('Profiler.start', {}, attached.pageSession);
    const observed = await page.evaluate(
      ({ url, readyText }) => {
        globalThis.__x.createView(url, 800, 640);
        return globalThis.__x.fcp({ readyText, timeoutMs: 120000 });
      },
      { url: `/bundles/${entry.id}/${bundle.rel}`, readyText: READY_TEXT },
    );
    const { profile } = await cdp.send('Profiler.stop', {}, attached.pageSession);
    return {
      pair,
      order,
      entry: entry.id,
      bundle: bundle.rel,
      observed,
      cpuMs: profileCpuMs(profile),
      topSelf: summarizeProfile(profile).slice(0, 80),
      profile,
    };
  } finally {
    await page.close();
  }
}

const launched = await launchBrowser();
const server = await startServer({ bundleRoots });
const cdp = await CdpClient.connect(launched.cdpPort);
const runs = [];
try {
  for (let pair = 1; pair <= pairs; pair++) {
    for (const order of ['AB', 'BA']) {
      const ordered = order === 'AB' ? entries : [...entries].reverse();
      for (const entry of ordered) {
        const run = await profileEntry({
          browser: launched.browser,
          cdp,
          origin: server.origin,
          entry,
          order,
          pair,
        });
        runs.push(run);
        console.log(
          `[profile] pair=${pair} order=${order} entry=${entry.id} fcp=${run.observed.fcp.toFixed(2)}ms cpu=${run.cpuMs.toFixed(2)}ms`,
        );
      }
    }
  }
} finally {
  cdp.close();
  await server.close();
  await launched.closeBrowser();
}

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify({
  schemaVersion: 1,
  kind: 'm4-web-startup-cpu-profile',
  generatedAt: new Date().toISOString(),
  machine: machineFingerprint(),
  entries: entryIds,
  pairs,
  policy: {
    rows: 0,
    order: 'paired AB/BA',
    outliersRemoved: false,
    endpoint: 'view-attach-to-ready-title',
    profilerSamplingIntervalMicros: 200,
  },
  runs,
}, null, 2)}\n`);
console.log(`[profile] wrote ${path.relative(root, output)}`);
