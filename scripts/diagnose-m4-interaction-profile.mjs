#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

import { launchBrowser } from "../packages/runner/src/browser.mjs";
import {
  CdpClient,
  attachToPageAndWorkers,
  profileCpuMs,
} from "../packages/runner/src/cdp.mjs";
import { machineFingerprint } from "../packages/runner/src/machine.mjs";
import { startServer } from "../packages/runner/src/server.mjs";

const args = process.argv.slice(2);
const option = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const outputArg = option("--output");
const pairs = Number(option("--pairs", "5"));
const targetsArg = option("--targets");
const workload = option("--workload", "remove");
if (
  outputArg == null ||
  targetsArg == null ||
  !Number.isSafeInteger(pairs) ||
  pairs < 1 ||
  !["remove", "select"].includes(workload)
) {
  throw new Error(
    "usage: diagnose-m4-interaction-profile --output <file.json> --targets <id=dist,id=dist> [--pairs N] [--workload remove|select]",
  );
}

const targets = targetsArg.split(",").map((target) => {
  const separator = target.indexOf("=");
  if (separator <= 0)
    throw new Error(`invalid target ${JSON.stringify(target)}`);
  const id = target.slice(0, separator);
  const dist = path.resolve(target.slice(separator + 1));
  const bundle = fs.existsSync(path.join(dist, "rows-0/main.web.bundle"))
    ? "rows-0/main.web.bundle"
    : "main.web.bundle";
  if (!fs.existsSync(path.join(dist, bundle))) {
    throw new Error(`missing Web bundle below ${dist}`);
  }
  return { id, dist, bundle };
});
if (
  targets.length !== 2 ||
  new Set(targets.map((target) => target.id)).size !== 2
) {
  throw new Error("--targets must name exactly two distinct entries");
}

const output = path.resolve(outputArg);
const bundleRoots = Object.fromEntries(
  targets.map((target) => [target.id, target.dist]),
);

function summarizeProfile(profile) {
  const frames = new Map(
    profile.nodes.map((node) => [node.id, node.callFrame ?? {}]),
  );
  const selfMicros = new Map();
  for (let index = 0; index < (profile.samples?.length ?? 0); index++) {
    const frame = frames.get(profile.samples[index]) ?? {};
    const key = JSON.stringify({
      url: frame.url ?? "",
      functionName: frame.functionName ?? "",
      lineNumber: frame.lineNumber ?? -1,
      columnNumber: frame.columnNumber ?? -1,
    });
    selfMicros.set(
      key,
      (selfMicros.get(key) ?? 0) + (profile.timeDeltas[index] ?? 0),
    );
  }
  return [...selfMicros]
    .map(([key, micros]) => ({ ...JSON.parse(key), selfMs: micros / 1000 }))
    .sort((left, right) => right.selfMs - left.selfMs);
}

async function evalX(page, expression) {
  return page.evaluate(
    `(() => { const x = globalThis.__x; return (${expression}); })()`,
  );
}

async function clickAt(page, rectangle, label) {
  if (rectangle == null) throw new Error(`no click geometry for ${label}`);
  await page.mouse.click(rectangle.x, rectangle.y);
}

async function clickButton(page, label) {
  await clickAt(
    page,
    await evalX(page, `x.buttonRect(${JSON.stringify(label)})`),
    `button ${label}`,
  );
}

async function clickCell(page, rowIndex, className) {
  await clickAt(
    page,
    await evalX(page, `x.cellRect(${rowIndex}, ${JSON.stringify(className)})`),
    `cell ${rowIndex}.${className}`,
  );
}

async function settle(page, milliseconds = 30) {
  await page.evaluate((delay) => globalThis.__x.settle(delay), milliseconds);
}

async function createRows(page) {
  await clickButton(page, "Create 1,000 rows");
  await page.evaluate(() =>
    globalThis.__x.until({ type: "rowCount", value: 1000 }, 120000),
  );
}

async function clearRows(page) {
  await clickButton(page, "Clear");
  await page.evaluate(() =>
    globalThis.__x.until({ type: "rowCount", value: 0 }, 120000),
  );
}

async function profileTarget({ browser, cdp, origin, target, pair, order }) {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  try {
    await page.goto(`${origin}/`, { waitUntil: "load" });
    const attached = await attachToPageAndWorkers(cdp, origin);
    await page.evaluate(
      (url) => globalThis.__x.createView(url, 800, 640),
      `/bundles/${target.id}/${target.bundle}`,
    );
    await page.waitForFunction(
      () => globalThis.__x.findText("Benchmark on Lynx"),
      null,
      { timeout: 120000, polling: 16 },
    );
    await settle(page);
    for (let warmup = 0; warmup < 2; warmup++) {
      await createRows(page);
      await clearRows(page);
    }
    await createRows(page);
    if (workload === "select") {
      await clickCell(page, 5, "col-label");
      await page.evaluate(() =>
        globalThis.__x.until({ type: "dangerAt", index: 5 }, 120000),
      );
    }
    await settle(page);
    await page.evaluate(() => globalThis.gc?.());

    const registry = await page.evaluate(
      () => globalThis.__LYNX_WIRE__.workers,
    );
    const background = [...attached.workers.values()].find((worker) => {
      const registered = registry.find(
        (entry) => entry.blobUrl === worker.url || entry.url === worker.url,
      );
      return registered?.name === "lynx-bg";
    });
    if (background == null)
      throw new Error(`${target.id} has no lynx-bg worker target`);
    const sessions = [
      { key: "mts", sessionId: attached.pageSession },
      { key: "bts", sessionId: background.sessionId },
    ];
    for (const session of sessions) {
      await cdp.send("Profiler.enable", {}, session.sessionId);
      await cdp.send(
        "Profiler.setSamplingInterval",
        { interval: 100 },
        session.sessionId,
      );
      await cdp.send("Profiler.start", {}, session.sessionId);
    }

    const armed = page.evaluate(
      ({ selectedWorkload }) =>
        globalThis.__x.arm(
          selectedWorkload === "select"
            ? { type: "dangerAt", index: 1 }
            : { type: "rowCount", value: 999 },
          120000,
        ),
      { selectedWorkload: workload },
    );
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(resolve)),
    );
    if (workload === "select") {
      await clickCell(page, 1, "col-label");
    } else {
      await clickCell(page, 2, "col-remove");
    }
    const observed = await armed;
    const profiles = {};
    for (const session of sessions) {
      const { profile } = await cdp.send(
        "Profiler.stop",
        {},
        session.sessionId,
      );
      profiles[session.key] = {
        cpuMs: profileCpuMs(profile),
        topSelf: summarizeProfile(profile).slice(0, 120),
        profile,
      };
    }
    return { pair, order, target: target.id, observed, profiles };
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
    for (const order of ["AB", "BA"]) {
      const ordered = order === "AB" ? targets : [...targets].reverse();
      for (const target of ordered) {
        const run = await profileTarget({
          browser: launched.browser,
          cdp,
          origin: server.origin,
          target,
          pair,
          order,
        });
        runs.push(run);
        console.log(
          `[profile] pair=${pair} order=${order} target=${target.id} ` +
            `latency=${run.observed.ms.toFixed(2)}ms ` +
            `bts=${run.profiles.bts.cpuMs.toFixed(2)}ms ` +
            `mts=${run.profiles.mts.cpuMs.toFixed(2)}ms`,
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
fs.writeFileSync(
  output,
  `${JSON.stringify(
    {
      schemaVersion: 1,
      kind: "m4-web-interaction-cpu-profile",
      generatedAt: new Date().toISOString(),
      machine: machineFingerprint(),
      targets: targets.map(({ id, dist, bundle }) => ({ id, dist, bundle })),
      pairs,
      policy: {
        workload: `${workload}@1000`,
        ...(workload === "select"
          ? { preselectedRow: 5, selectedRow: 1 }
          : { removedRow: 2 }),
        order: "paired AB/BA",
        outliersRemoved: false,
        warmup: "two create/clear cycles on a fresh page per sample",
        endpoint:
          workload === "select"
            ? "pointer-click-to-first-rAF-with-row-1-selected"
            : "pointer-click-to-first-rAF-with-999-rows",
        profilerSamplingIntervalMicros: 100,
      },
      runs,
    },
    null,
    2,
  )}\n`,
);
console.log(`[profile] wrote ${output}`);
