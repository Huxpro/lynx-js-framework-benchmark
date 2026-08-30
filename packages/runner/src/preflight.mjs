// Preflight calibration: a fixed, versioned CPU probe run in the same headless
// Chromium that will run the benchmarks. The score (iterations/second, higher
// = faster machine) is embedded in every run file so cross-machine numbers can
// be related — as an estimate, never as a same-machine comparison.
//
// The probe approximates render-workload character: object churn, string
// building, JSON round-trips, array reconciliation. Seeded, so the work is
// identical everywhere. PROBE_VERSION must bump when the workload changes;
// scores across versions are incomparable.

import { launchBrowser } from './browser.mjs';

export const PROBE_VERSION = 1;

export function assertWebHarnessCapabilities(
  { webAssembly },
) {
  if (webAssembly) return;
  throw new Error(
    'Web harness capability check failed: @lynx-js/web-core requires WebAssembly, '
    + 'but this Chromium does not expose it.',
  );
}

export const OPTIMIZATION_STATUS = Object.freeze({
  neverOptimize: 1 << 1,
  optimized: 1 << 4,
  turboFanned: 1 << 5,
  interpreted: 1 << 6,
  maglevved: 1 << 15,
});

export const INTERPRETER_FLAG_PROBE_JS = `(() => {
  const hot = (x) => {
    let sum = 0;
    for (let i = 0; i < 100; i++) sum = (sum + i + x) | 0;
    return sum;
  };
  for (let i = 0; i < 200000; i++) hot(i);
  const status = (new Function('fn', 'return %GetOptimizationStatus(fn)'))(hot);
  const wasm = new WebAssembly.Module(new Uint8Array([0,97,115,109,1,0,0,0]));
  return { status, wasmInstantiated: wasm instanceof WebAssembly.Module };
})()`;

export function assertInterpreterFlagProbe({ jit, interp }) {
  const compiledMask = OPTIMIZATION_STATUS.optimized
    | OPTIMIZATION_STATUS.turboFanned
    | OPTIMIZATION_STATUS.maglevved;
  if ((jit.status & compiledMask) === 0) {
    throw new Error(`interpreter flag preflight is inconclusive: JIT control status=${jit.status}`);
  }
  if ((interp.status & OPTIMIZATION_STATUS.neverOptimize) === 0
    || (interp.status & OPTIMIZATION_STATUS.interpreted) === 0
    || (interp.status & compiledMask) !== 0) {
    throw new Error(
      `interpreter flags were ignored: expected never-optimized Ignition, status=${interp.status}`,
    );
  }
  if (!interp.wasmInstantiated) {
    throw new Error('interpreter flag preflight failed: WebAssembly no longer instantiates');
  }
}

async function optimizationStatusProbe(jit) {
  const { browser, closeBrowser } = await launchBrowser({
    jit,
    allowNativesSyntax: true,
  });
  try {
    const page = await browser.newPage();
    try {
      await page.goto('about:blank');
      return await page.evaluate(INTERPRETER_FLAG_PROBE_JS);
    } finally {
      await page.close();
    }
  } finally {
    await closeBrowser();
  }
}

export async function verifyInterpreterFlags() {
  const result = {
    method: 'GetOptimizationStatus-hot-function-v1',
    jit: await optimizationStatusProbe('jit'),
    interp: await optimizationStatusProbe('interp'),
  };
  assertInterpreterFlagProbe(result);
  return result;
}

export function assertProcessThrottleProbe({ control, throttled, cpuThrottle, mechanism }) {
  if (mechanism?.scope !== 'process-cgroup'
    || !['cgroup-v2', 'cgroup-v1-cgexec'].includes(mechanism?.backend)
    || mechanism?.inheritance !== 'launch-cgroup') {
    throw new Error('whole-process CPU throttle did not produce an inherited-cgroup mechanism receipt');
  }
  const observedSlowdown = control.score / throttled.score;
  const minimumSlowdown = cpuThrottle - 0.5;
  const maximumSlowdown = cpuThrottle + 0.5;
  if (!Number.isFinite(observedSlowdown)
    || observedSlowdown < minimumSlowdown
    || observedSlowdown > maximumSlowdown) {
    throw new Error(
      `whole-process CPU throttle preflight failed: expected about ${cpuThrottle}x, `
      + `observed ${observedSlowdown.toFixed(2)}x`,
    );
  }
  return {
    method: 'same-interpreter-probe-ratio-v1',
    control,
    throttled,
    expectedSlowdown: cpuThrottle,
    acceptedRange: [minimumSlowdown, maximumSlowdown],
    verifiedSlowdown: Math.round(observedSlowdown * 100) / 100,
    observedSlowdown: Math.round(observedSlowdown * 100) / 100,
    mechanism,
  };
}

export async function calibrateProcessThrottle({
  jit,
  cpuThrottle,
  control,
  requireWebHarness = true,
  maxAttempts = 6,
}) {
  const calibrationTargetRange = [cpuThrottle - 0.2, cpuThrottle + 0.2];
  let quotaPercent = 100 / cpuThrottle;
  const attempts = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const launched = await launchBrowser({
      jit,
      cpuThrottle,
      throttleScope: 'process-cgroup',
      processQuotaPercent: quotaPercent,
    });
    try {
      const probe = await runPreflight(launched.browser, {
        requireWebHarness,
        jsRegime: jit,
      });
      const observedSlowdown = control.score / probe.score;
      attempts.push({
        attempt,
        quotaPercent: launched.processThrottle.quotaPercent,
        observedSlowdown: Math.round(observedSlowdown * 100) / 100,
      });
      try {
        const verification = assertProcessThrottleProbe({
          control,
          throttled: probe,
          cpuThrottle,
          mechanism: launched.processThrottle,
        });
        if (observedSlowdown >= calibrationTargetRange[0]
          && observedSlowdown <= calibrationTargetRange[1]) {
          return {
            probe,
            browser: {
              name: 'chromium',
              version: launched.browserVersion,
              executablePath: launched.executablePath,
            },
            processThrottle: launched.processThrottle,
            processThrottleVerification: {
              ...verification,
              calibrationTargetRange,
              calibrationAttempts: attempts,
            },
            processQuotaPercent: launched.processThrottle.quotaPercent,
          };
        }
      } catch (error) {
        if (!String(error.message).includes('preflight failed') || attempt === maxAttempts) throw error;
      }
      quotaPercent = Math.round(Math.min(
        100,
        Math.max(1, quotaPercent * observedSlowdown / cpuThrottle),
      ) * 100) / 100;
    } finally {
      await launched.closeBrowser();
    }
  }
  throw new Error('whole-process CPU throttle calibration exhausted without a verified window');
}

export const PROBE_JS = `(() => {
  let seed = 7 >>> 0;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const WORDS = ['alpha','beta','gamma','delta','epsilon','zeta','eta','theta'];
  const makeRows = (n, gen) => {
    const rows = [];
    for (let i = 0; i < n; i++) {
      rows.push({ id: i, label: WORDS[(gen() * 8) | 0] + ' ' + WORDS[(gen() * 8) | 0] + ' ' + i, sel: false });
    }
    return rows;
  };
  const iterate = () => {
    const rows = makeRows(800, rand);
    for (let i = 0; i < rows.length; i += 10) rows[i] = { ...rows[i], label: rows[i].label + ' !!!' };
    const ser = JSON.stringify(rows);
    const back = JSON.parse(ser);
    let acc = 0;
    for (const r of back) acc += r.label.length;
    const reversed = back.slice().reverse();
    reversed.sort((a, b) => (a.id % 7) - (b.id % 7) || a.id - b.id);
    return acc + reversed[0].id + ser.length;
  };
  // warmup
  for (let i = 0; i < 20; i++) iterate();
  const t0 = performance.now();
  let n = 0;
  let sink = 0;
  while (performance.now() - t0 < 1000) { sink += iterate(); n += 1; }
  const elapsed = performance.now() - t0;
  return { score: (n / elapsed) * 1000, iterations: n, elapsedMs: elapsed, sink };
})()`;

export async function runPreflight(
  browser,
  { cpuThrottle = 1, requireWebHarness = false, jsRegime = 'jit' } = {},
) {
  const page = await browser.newPage();
  try {
    await page.goto('about:blank');
    if (requireWebHarness) {
      assertWebHarnessCapabilities({
        webAssembly: await page.evaluate(() => typeof WebAssembly === 'object'),
      });
    }
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuThrottle });
    const result = await page.evaluate(PROBE_JS);
    return {
      probeVersion: PROBE_VERSION,
      score: Math.round(result.score * 10) / 10,
      iterations: result.iterations,
    };
  } finally {
    await page.close();
  }
}
