import fs from 'node:fs';
import path from 'node:path';

import { READY_TEXT } from '@lynx-bench/shared/workloads';

import { launchBrowser } from './browser.mjs';
import { bundleFor, entrySupportsHarness, repoRoot } from './entries.mjs';
import { machineFingerprint } from './machine.mjs';
import {
  entryBundleReceipts,
  repositoryReceipt,
  runtimeReceipt,
  workloadReceipt,
} from './provenance.mjs';
import { startServer } from './server.mjs';

const TIMEOUT_MS = 240000;

async function evaluateX(page, expression) {
  return page.evaluate(`(() => { const x = globalThis.__x; return (${expression}); })()`);
}

async function clickButton(page, label) {
  const rect = await evaluateX(page, `x.buttonRect(${JSON.stringify(label)})`);
  if (rect == null) throw new Error(`button ${JSON.stringify(label)} has no click geometry`);
  await page.mouse.click(rect.x, rect.y);
}

async function clickCell(page, rowIndex, className) {
  const rect = await evaluateX(
    page,
    `x.cellRect(${rowIndex}, ${JSON.stringify(className)})`,
  );
  if (rect == null) throw new Error(`cell ${rowIndex}.${className} has no click geometry`);
  await page.mouse.click(rect.x, rect.y);
}

async function until(page, spec) {
  await page.evaluate(
    ({ predicate, timeoutMs }) => globalThis.__x.until(predicate, timeoutMs),
    { predicate: spec, timeoutMs: TIMEOUT_MS },
  );
  await page.evaluate(() => globalThis.__x.settle(30));
}

async function rememberRow(page, key, index) {
  const found = await page.evaluate(({ identityKey, rowIndex }) => {
    const rows = globalThis.__x.findByClass('row');
    globalThis.__M0_ROW_IDENTITIES__ ??= new Map();
    const row = rows[rowIndex];
    if (row == null) return false;
    globalThis.__M0_ROW_IDENTITIES__.set(identityKey, row);
    return true;
  }, { identityKey: key, rowIndex: index });
  if (!found) throw new Error(`cannot remember row ${index} as ${key}`);
}

async function sameRow(page, key, index) {
  return page.evaluate(({ identityKey, rowIndex }) => {
    const remembered = globalThis.__M0_ROW_IDENTITIES__?.get(identityKey);
    return remembered != null && remembered === globalThis.__x.findByClass('row')[rowIndex];
  }, { identityKey: key, rowIndex: index });
}

async function assertSameRow(page, key, index, expected, stage) {
  const actual = await sameRow(page, key, index);
  if (actual !== expected) {
    throw new Error(`${stage}: survivor identity ${key}@${index} expected ${expected}, got ${actual}`);
  }
  return { key, index, expected, actual };
}

async function hostCensus(page) {
  return page.evaluate(() => {
    const counts = {};
    let total = 0;
    const walk = (node) => {
      if (node == null) return;
      if (node.nodeType === 1) {
        total++;
        const tag = String(node.tagName ?? 'unknown').toLowerCase();
        counts[tag] = (counts[tag] ?? 0) + 1;
        if (node.shadowRoot) walk(node.shadowRoot);
      }
      for (const child of node.childNodes ?? []) walk(child);
    };
    walk(document.querySelector('lynx-view'));
    return {
      total,
      byTag: Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))),
      rows: globalThis.__x.rowCount(),
    };
  });
}

async function validateEntry({ browser, origin, entry }) {
  if (!entrySupportsHarness(entry, 'web')) {
    const reason = entry.unsupportedHarnessReasons?.web ?? 'not declared by the entry';
    throw new Error(`${entry.id} does not support Web correctness: ${reason}`);
  }
  const bundle = bundleFor(entry, { rows: 0 });
  if (bundle == null) throw new Error(`${entry.id} has no rows-0 Web bundle`);
  const bundleUrl = `${origin}/bundles/${entry.id}/${bundle.rel.split(path.sep).join('/')}`;
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  const checks = [];
  try {
    await page.goto(origin, { waitUntil: 'load' });
    await page.evaluate((url) => globalThis.__x.createView(url, 800, 640), bundleUrl);
    await page.waitForFunction(
      (text) => globalThis.__x.findText(text),
      READY_TEXT,
      { timeout: TIMEOUT_MS, polling: 16 },
    );
    await until(page, { type: 'rowCount', value: 0 });
    checks.push({ stage: 'startup-adoption', readyText: READY_TEXT, rowCount: 0 });

    await clickButton(page, 'Create 1,000 rows');
    await until(page, { type: 'rowCount', value: 1000 });
    const firstId = await evaluateX(page, 'x.idAt(0)');
    const firstLabel = await evaluateX(page, 'x.labelAt(0)');
    if (firstId !== '1' || typeof firstLabel !== 'string' || firstLabel.length === 0) {
      throw new Error(`create: invalid first row ${JSON.stringify({ firstId, firstLabel })}`);
    }
    const censusAfterCreate = await hostCensus(page);
    await rememberRow(page, 'initial-0', 0);
    await rememberRow(page, 'initial-1', 1);
    checks.push({
      stage: 'create', rowCount: 1000, firstId, firstLabel,
      input: 'playwright-native-pointer', hostCensus: censusAfterCreate,
    });

    await clickCell(page, 1, 'col-label');
    await until(page, { type: 'dangerAt', index: 1 });
    checks.push({
      stage: 'select', selectedIndex: 1,
      identities: [
        await assertSameRow(page, 'initial-0', 0, true, 'select'),
        await assertSameRow(page, 'initial-1', 1, true, 'select'),
      ],
    });

    const labelBeforeUpdate = await evaluateX(page, 'x.labelAt(0)');
    await clickButton(page, 'Update every 10th row');
    await until(page, { type: 'labelAt', index: 0, equals: `${labelBeforeUpdate} !!!` });
    checks.push({
      stage: 'update10th', labelBefore: labelBeforeUpdate, labelAfter: `${labelBeforeUpdate} !!!`,
      identities: [
        await assertSameRow(page, 'initial-0', 0, true, 'update10th'),
        await assertSameRow(page, 'initial-1', 1, true, 'update10th'),
      ],
    });

    const swapLabel1 = await evaluateX(page, 'x.labelAt(1)');
    const swapLabel998 = await evaluateX(page, 'x.labelAt(998)');
    await rememberRow(page, 'swap-1', 1);
    await rememberRow(page, 'swap-998', 998);
    await clickButton(page, 'Swap Rows');
    await until(page, { type: 'labelAt', index: 1, equals: swapLabel998 });
    checks.push({
      stage: 'swap', labels: { before1: swapLabel1, before998: swapLabel998 },
      identities: [
        await assertSameRow(page, 'swap-998', 1, true, 'swap'),
        await assertSameRow(page, 'swap-1', 998, true, 'swap'),
      ],
    });

    await rememberRow(page, 'remove-survivor', 3);
    await clickCell(page, 2, 'col-remove');
    await until(page, { type: 'rowCount', value: 999 });
    checks.push({
      stage: 'remove', rowCount: 999,
      identity: await assertSameRow(page, 'remove-survivor', 2, true, 'remove'),
    });

    await clickButton(page, 'Clear');
    await until(page, { type: 'rowCount', value: 0 });
    checks.push({ stage: 'clear', rowCount: 0 });

    await clickButton(page, 'Create 1,000 rows');
    await until(page, { type: 'rowCount', value: 1000 });
    checks.push({
      stage: 'recreate', rowCount: 1000,
      oldIdentityReplaced: await assertSameRow(page, 'initial-0', 0, false, 'recreate'),
    });

    await rememberRow(page, 'replace-old', 0);
    const lastIdBeforeReplace = Number(await evaluateX(page, 'x.idAt(999)'));
    await clickButton(page, 'Create 1,000 rows');
    await until(page, { type: 'idAt', index: 0, equals: String(lastIdBeforeReplace + 1) });
    checks.push({
      stage: 'replace', rowCount: 1000,
      oldIdentityReplaced: await assertSameRow(page, 'replace-old', 0, false, 'replace'),
    });

    await rememberRow(page, 'append-survivor', 0);
    await clickButton(page, 'Append 1,000 rows');
    await until(page, { type: 'rowCount', value: 2000 });
    checks.push({
      stage: 'append1k', rowCount: 2000,
      identity: await assertSameRow(page, 'append-survivor', 0, true, 'append1k'),
    });

    await clickButton(page, 'Clear');
    await until(page, { type: 'rowCount', value: 0 });
    await clickButton(page, 'Create 1,000 rows');
    await until(page, { type: 'rowCount', value: 1000 });
    const censusAfterFinalRecreate = await hostCensus(page);
    checks.push({ stage: 'final-recreate', hostCensus: censusAfterFinalRecreate });

    const disposed = await page.evaluate(() => {
      const view = document.querySelector('lynx-view');
      view?.remove();
      return view != null && !view.isConnected && document.querySelector('lynx-view') == null;
    });
    if (!disposed) throw new Error('dispose: lynx-view remained connected');
    checks.push({ stage: 'dispose', viewDisconnected: true, pageClosed: true });
    if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join(' | ')}`);
    return { entry: entry.id, bundle: bundle.rel, checks };
  } finally {
    await page.close();
  }
}

export async function runWebCorrectnessPreflight({ entries, output = null }) {
  const root = repoRoot();
  const repository = repositoryReceipt(root);
  if (repository.dirty) {
    throw new Error('Web correctness preflight requires a clean benchmark checkout.');
  }
  const bundleRoots = Object.fromEntries(entries.map((entry) => [entry.id, entry.distDir]));
  const server = await startServer({ bundleRoots });
  const launched = await launchBrowser({ jit: 'jit' });
  const evidence = [];
  try {
    for (const entry of entries) {
      evidence.push(await validateEntry({ browser: launched.browser, origin: server.origin, entry }));
    }
  } finally {
    await launched.closeBrowser();
    await server.close();
  }
  const report = {
    version: 1,
    generatedAt: new Date().toISOString(),
    harness: 'web',
    machine: machineFingerprint(),
    browser: {
      name: 'chromium',
      version: launched.browserVersion,
      executablePath: launched.executablePath,
    },
    receipt: {
      repository,
      runtime: runtimeReceipt(root),
      workload: workloadReceipt(root),
      entryBundles: entryBundleReceipts(entries),
    },
    assertions: [
      'startup-adoption',
      'real-pointer-input',
      'row-count-and-text',
      'survivor-identity',
      'host-structure-census',
      'dispose',
    ],
    entries: evidence,
    pass: true,
  };
  if (output != null) {
    const outputPath = path.resolve(root, output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}
