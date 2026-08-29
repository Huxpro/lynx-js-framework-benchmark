// Preflight calibration: a fixed, versioned CPU probe run in the same headless
// Chromium that will run the benchmarks. The score (iterations/second, higher
// = faster machine) is embedded in every run file so cross-machine numbers can
// be related — as an estimate, never as a same-machine comparison.
//
// The probe approximates render-workload character: object churn, string
// building, JSON round-trips, array reconciliation. Seeded, so the work is
// identical everywhere. PROBE_VERSION must bump when the workload changes;
// scores across versions are incomparable.

export const PROBE_VERSION = 1;

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

export async function runPreflight(browser, { cpuThrottle = 1 } = {}) {
  const page = await browser.newPage();
  try {
    await page.goto('about:blank');
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
