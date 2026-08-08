import { useMemo, useState } from 'react';

import { CostSpace } from './components/CostSpace';
import { Legend } from './components/Legend';
import { HeatGrid } from './components/HeatGrid';
import { MethodPage } from './components/Method';
import { RankedBars } from './components/RankedBars';
import { ScaleTrend, TREND_SPECS } from './components/ScaleTrends';
import { ThreadsPage } from './components/Threads';
import { ENTRIES, HARNESSES, select, workloadScales } from './data';
import { useTheme } from './hooks';

type Page = 'overview' | 'scale' | 'threads' | 'method';

const PAGES: { key: Page; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'scale', label: 'Scale' },
  { key: 'threads', label: 'Threads' },
  { key: 'method', label: 'Method' },
];

const scaleLabel = (s: number) => (s >= 1000 ? `${s / 1000}k` : String(s));

export default function App() {
  const [theme, toggleTheme] = useTheme();
  const [page, setPage] = useState<Page>('overview');
  const [harness, setHarness] = useState<string>('web');
  const [selected, setSelected] = useState<Set<string>>(new Set(ENTRIES.map((e) => e.id)));

  const toggleEntry = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const heatRows = useMemo(() => {
    const rows: { key: string; label: string; suite: string; workload: string; scale: number; metric: string }[] = [];
    for (const w of ['create', 'append1k', 'update10th', 'select', 'swap', 'remove', 'clear', 'updateStorm', 'selectStorm']) {
      for (const s of workloadScales('table', w)) {
        if (select({ suite: 'table', harness, workload: w, scale: s, metric: 'latency' }).length >= 2) {
          rows.push({ key: `${w}@${s}`, label: `${w} @${scaleLabel(s)}`, suite: 'table', workload: w, scale: s, metric: 'latency' });
        }
      }
    }
    for (const s of workloadScales('startup', 'startup')) {
      if (select({ suite: 'startup', harness, workload: 'startup', scale: s, metric: 'fcp' }).length >= 2) {
        rows.push({ key: `startup@${s}`, label: `startup @${scaleLabel(s)}`, suite: 'startup', workload: 'startup', scale: s, metric: 'fcp' });
      }
    }
    return rows;
  }, [harness]);

  const tableOps = (scales: number[]) =>
    ['create', 'append1k', 'update10th', 'select', 'swap', 'remove', 'clear'].flatMap((w) =>
      workloadScales('table', w)
        .filter((s) => scales.includes(s))
        .map((s) => ({ key: `${w}@${s}`, label: `${w}${scales.length > 1 ? ` @${scaleLabel(s)}` : ''}`, workload: w, scale: s })));

  const nativeHasData = select({ harness: 'native' }).length > 0;

  return (
    <div className="page">
      <header className="site-header">
        <div className="site-title"><span className="lynx">Lynx</span> JS Framework Benchmark</div>
        <nav className="site-nav" aria-label="Pages">
          {PAGES.map((p) => (
            <button key={p.key} aria-current={page === p.key} onClick={() => setPage(p.key)}>{p.label}</button>
          ))}
        </nav>
        <div className="harness-switch" role="group" aria-label="Harness">
          {['web', 'native'].map((h) => (
            <button key={h} aria-pressed={harness === h} onClick={() => setHarness(h)}>
              {h === 'web' ? 'Lynx for Web' : 'Native engine'}
            </button>
          ))}
        </div>
        <button className="theme-toggle" onClick={toggleTheme} aria-label="Toggle theme">
          {theme === 'dark' ? '☀' : '☾'}
        </button>
      </header>

      {harness === 'native' && !nativeHasData ? (
        <div className="empty-state">
          <p><b>Native engine harness: capability preserved, no data yet.</b></p>
          <p style={{ maxWidth: '58ch', margin: '0.5rem auto' }}>
            Every entry ships <code>main.lynx.bundle</code> and the result schema carries{' '}
            <code>harness: "native"</code> end to end. Wiring a device adapter (see{' '}
            <code>packages/runner/src/harness-native.mjs</code>) makes this page light up — native and
            web numbers are never mixed in one chart.
          </p>
        </div>
      ) : page === 'overview' ? (
        <>
          <h1>How fast is each framework on Lynx?</h1>
          <p className="subtitle">
            The same table app, {ENTRIES.length} framework configurations, one instrument. Headless
            Chromium running Lynx for Web; medians, lower is better. Pick entries, hover anything,
            open any card's data table for exact numbers.
          </p>
          <Legend theme={theme} selected={selected} onToggle={toggleEntry} />
          <HeatGrid rows={heatRows} harness={harness} theme={theme} selected={selected} />
          <RankedBars
            title="interactive @1k"
            description="krausest-style table ops on 1,000 rows: tap → all mutations visible in the composed DOM."
            suite="table"
            ops={tableOps([1000])}
            harness={harness}
            theme={theme}
            selected={selected}
          />
          <RankedBars
            title="interactive @10k"
            description="the same ops at 10,000 rows — where wire cost and reconciliation strategy separate."
            suite="table"
            ops={tableOps([10000])}
            harness={harness}
            theme={theme}
            selected={selected}
          />
          <RankedBars
            title="storms"
            description="one tap, many sequential render cycles (50 update / 30 select ticks through a MessageChannel pump). Throughput of the full state→render→wire→apply loop."
            suite="table"
            ops={['updateStorm', 'selectStorm'].flatMap((w) =>
              workloadScales('table', w).map((s) => ({ key: `${w}@${s}`, label: `${w} @${scaleLabel(s)}`, workload: w, scale: s })))}
            harness={harness}
            theme={theme}
            selected={selected}
          />
          <RankedBars
            title="startup (first contentful paint)"
            description="view attach → first table content, with the first screen pre-rendering N rows. IFR-capable configs paint from the main thread before hydration."
            suite="startup"
            metric="fcp"
            ops={workloadScales('startup', 'startup').map((s) => ({
              key: `startup@${s}`, label: `@${scaleLabel(s)} rows`, workload: 'startup', scale: s,
            }))}
            harness={harness}
            theme={theme}
            selected={selected}
          />
        </>
      ) : page === 'scale' ? (
        <>
          <h1>How does cost grow with scale?</h1>
          <p className="subtitle">
            The unified-matrix lineage: each case across row scales, linear for absolute gaps and
            log–log for shape. α is the fitted scaling exponent (1 = linear in N; below 1 = amortizing;
            0 ≈ scale-independent).
          </p>
          <Legend theme={theme} selected={selected} onToggle={toggleEntry} />
          <CostSpace harness={harness} theme={theme} selected={selected} />
          {TREND_SPECS.map((spec) => (
            <ScaleTrend key={spec.title} spec={spec} harness={harness} theme={theme} selected={selected} />
          ))}
        </>
      ) : page === 'threads' ? (
        <>
          <h1>The dual-thread equation</h1>
          <p className="subtitle">
            Lynx runs frameworks on a background thread (BTS) and applies UI on the main thread
            (MTS); everything between them crosses a serialized wire. Total time hides this —
            here it's split apart: per-realm CPU, bytes and messages in each direction, and which
            rpc endpoints carried them.
          </p>
          <Legend theme={theme} selected={selected} onToggle={toggleEntry} />
          <ThreadsPage harness={harness} theme={theme} selected={selected} />
        </>
      ) : (
        <>
          <h1>Method</h1>
          <p className="subtitle">
            What is measured, how neutrality is enforced, and where these numbers may and may not
            be compared.
          </p>
          <MethodPage />
        </>
      )}

      <footer className="note" style={{ marginTop: '3rem', borderTop: '1px solid var(--border)', paddingTop: '1rem' }}>
        <a href="https://github.com/Huxpro/lynx-js-framework-benchmark" target="_blank" rel="noreferrer">
          github.com/Huxpro/lynx-js-framework-benchmark
        </a>
        {' '}· reproduce with <code>pnpm bench run</code> · results are the checked-in{' '}
        <code>results/latest.json</code> — the site cannot drift from the numbers.
      </footer>
    </div>
  );
}
