import { useMemo, useState } from 'react';

import { CostSpace } from './components/CostSpace';
import { Legend } from './components/Legend';
import { HeatGrid } from './components/HeatGrid';
import { HistoryRanking } from './components/HistoryRanking';
import { MethodPage } from './components/Method';
import { NativeCoverage } from './components/NativeCoverage';
import { NativeObservations } from './components/NativeObservations';
import { RankedBars } from './components/RankedBars';
import { ScaleTrend, trendSpecsForHarness } from './components/ScaleTrends';
import { ThreadsPage } from './components/Threads';
import { TimelineSlider } from './components/TimelineSlider';
import { BenchmarkDataProvider, useBenchmarkData } from './data-context';
import {
  ENTRIES,
  ENTRY_BY_ID,
  FEATURED_IDS,
  TIMELINE_SNAPSHOTS,
  entrySupportsHarness,
} from './data';
import { useTheme } from './hooks';

// Sharable comparison state: ?entries=a,b,c picks an exact featured set.
function initialSelection(): Set<string> {
  const params = new URLSearchParams(location.search);
  const ids = params.get('entries')?.split(',').map((s) => s.trim())
    .filter((id) => FEATURED_IDS.includes(id));
  return new Set(ids?.length ? ids : FEATURED_IDS);
}

function syncUrl(selected: Set<string>) {
  const params = new URLSearchParams(location.search);
  const isDefault = selected.size === FEATURED_IDS.length
    && FEATURED_IDS.every((id) => selected.has(id));
  if (isDefault) {
    params.delete('entries');
  } else {
    params.set('entries', ENTRIES.filter((e) => selected.has(e.id)).map((e) => e.id).join(','));
  }
  params.delete('lab');
  const qs = params.toString();
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
}

type Page = 'overview' | 'scale' | 'threads' | 'method';

const PAGES: { key: Page; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'scale', label: 'Scale' },
  { key: 'threads', label: 'Threads' },
  { key: 'method', label: 'Method' },
];

const scaleLabel = (s: number) => (s >= 1000 ? `${s / 1000}k` : String(s));

function initialSnapshotIndex(): number {
  const id = new URLSearchParams(location.search).get('snapshot');
  const index = TIMELINE_SNAPSHOTS.findIndex((snapshot) => snapshot.id === id);
  if (index >= 0) return index;
  const current = TIMELINE_SNAPSHOTS.findIndex((snapshot) => snapshot.id === 'current-main');
  return current >= 0 ? current : TIMELINE_SNAPSHOTS.length - 1;
}

function AppContent({
  snapshotIndex,
  onSnapshotChange,
}: {
  snapshotIndex: number;
  onSnapshotChange: (index: number) => void;
}) {
  const [theme, toggleTheme] = useTheme();
  const { select, snapshot, workloadScales } = useBenchmarkData();
  const [page, setPage] = useState<Page>('overview');
  const [harness, setHarness] = useState<string>(() =>
    new URLSearchParams(location.search).get('harness') === 'native' ? 'native' : 'web');
  const [selected, setSelected] = useState<Set<string>>(initialSelection);
  const activeSelected = useMemo(() => new Set([...selected].filter((id) => {
    const entry = ENTRY_BY_ID.get(id);
    return entry != null && entrySupportsHarness(entry, harness);
  })), [harness, selected]);
  const changeHarness = (next: string) => {
    setHarness(next);
    const params = new URLSearchParams(location.search);
    if (next === 'web') params.delete('harness');
    else params.set('harness', next);
    const query = params.toString();
    history.replaceState(null, '', query ? `?${query}` : location.pathname);
  };

  const toggleEntry = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      syncUrl(next);
      return next;
    });

  const heatRows = useMemo(() => {
    const rows: { key: string; label: string; suite: string; workload: string; scale: number; metric: string }[] = [];
    if (harness === 'native') {
      const seen = new Set<string>();
      for (const cell of snapshot.nativeCoverage.cells) {
        const key = `${cell.suite}:${cell.workload}:${cell.scale}:${cell.metric}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const startupBoundary = {
          fcp: 'FCP',
          settled: 'settled',
          octaneCommitAck: 'commit ACK',
          octaneSecondFrame: 'second frame',
        }[cell.metric] ?? cell.metric;
        const label = cell.suite === 'startup'
          ? `startup ${startupBoundary} @${scaleLabel(cell.scale)}`
          : `${cell.workload} @${scaleLabel(cell.scale)}`;
        rows.push({
          key,
          label,
          suite: cell.suite,
          workload: cell.workload,
          scale: cell.scale,
          metric: cell.metric,
        });
      }
      return rows;
    }
    for (const w of ['create', 'append1k', 'update10th', 'select', 'swap', 'remove', 'clear', 'updateStorm', 'selectStorm']) {
      for (const s of workloadScales({ suite: 'table', harness, workload: w, metric: 'latency' })) {
        if (select({ suite: 'table', harness, workload: w, scale: s, metric: 'latency' }).length >= 2) {
          rows.push({ key: `${w}@${s}`, label: `${w} @${scaleLabel(s)}`, suite: 'table', workload: w, scale: s, metric: 'latency' });
        }
      }
    }
    for (const s of workloadScales({ suite: 'startup', harness, workload: 'startup', metric: 'fcp' })) {
      if (select({ suite: 'startup', harness, workload: 'startup', scale: s, metric: 'fcp' }).length >= 2) {
        rows.push({ key: `startup@${s}`, label: `startup @${scaleLabel(s)}`, suite: 'startup', workload: 'startup', scale: s, metric: 'fcp' });
      }
    }
    return rows;
  }, [harness, select, snapshot.nativeCoverage.cells, workloadScales]);

  const tableOps = (scales: number[]) =>
    ['create', 'append1k', 'update10th', 'select', 'swap', 'remove', 'clear'].flatMap((w) =>
      workloadScales({ suite: 'table', harness, workload: w, metric: 'latency' })
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
            <button key={h} aria-pressed={harness === h} onClick={() => changeHarness(h)}>
              {h === 'web' ? 'Lynx for Web' : 'Native engine'}
            </button>
          ))}
        </div>
        <button className="theme-toggle" onClick={toggleTheme} aria-label="Toggle theme">
          {theme === 'dark' ? '☀' : '☾'}
        </button>
      </header>
      <TimelineSlider
        snapshots={TIMELINE_SNAPSHOTS}
        index={snapshotIndex}
        onChange={onSnapshotChange}
      />

      {harness === 'native' && !nativeHasData ? (
        <>
          <h1>How fast is each framework on Lynx?</h1>
          <p className="subtitle">
            No complete Native comparison cohort is publishable for this snapshot. The at-a-glance
            matrix keeps every contracted cell visible without turning archived observations into
            rankings.
          </p>
          <Legend harness={harness} theme={theme} selected={activeSelected} onToggle={toggleEntry} />
          <HeatGrid rows={heatRows} harness={harness} theme={theme} selected={activeSelected} />
          <div className="empty-state">
            <p><b>No publishable Native comparison cohort for this snapshot.</b></p>
            <p style={{ maxWidth: '62ch', margin: '0.5rem auto' }}>
              Any archive-only observations follow. The appendix at the end distinguishes work
              that was never scheduled from evidenced DNF, proven unsupported capability,
              incompatible archived runs, and derivation defects.
            </p>
          </div>
          <NativeObservations theme={theme} />
          <NativeCoverage />
        </>
      ) : page === 'overview' ? (
        <>
          <h1>How fast is each framework on Lynx?</h1>
          <p className="subtitle">
            The same table app, one instrument. {harness === 'web'
              ? 'Headless Chromium running Lynx for Web; input is measured to the composed-DOM result.'
              : 'Lynx Native Engine on an Android 10 Sandbox device; input-handler time is measured to the second native frame.'}{' '}
            Medians, lower is better. DNF is shown explicitly. Pick entries, hover anything, open
            any card's data table for exact numbers.
          </p>
          <Legend harness={harness} theme={theme} selected={activeSelected} onToggle={toggleEntry} />
          <HeatGrid rows={heatRows} harness={harness} theme={theme} selected={activeSelected} />
          {harness === 'native' && <NativeObservations theme={theme} />}
          <RankedBars
            title="interactive @1k"
            description={harness === 'web'
              ? 'krausest-style table ops on 1,000 rows: tap → all mutations visible in the composed DOM.'
              : 'krausest-style table ops on 1,000 rows: native input handler → second native animation frame.'}
            suite="table"
            ops={tableOps([1000])}
            harness={harness}
            theme={theme}
            selected={activeSelected}
          />
          <RankedBars
            title="interactive @10k"
            description={harness === 'web'
              ? 'the same ops at 10,000 rows — where wire cost and reconciliation strategy separate.'
              : 'the same native operations at 10,000 rows; input/session timeouts remain visible as DNF.'}
            suite="table"
            ops={tableOps([10000])}
            harness={harness}
            theme={theme}
            selected={activeSelected}
          />
          <RankedBars
            title="storms"
            description={harness === 'web'
              ? 'one tap, many sequential render cycles (50 update / 30 select ticks through a MessageChannel pump). Throughput of the full state→render→wire→apply loop.'
              : 'one tap, many sequential Native task/transport commits (50 update / 30 select ticks), each acknowledged before the next tick.'}
            suite="table"
            ops={['updateStorm', 'selectStorm'].flatMap((w) =>
              workloadScales({ suite: 'table', harness, workload: w, metric: 'latency' })
                .map((s) => ({ key: `${w}@${s}`, label: `${w} @${scaleLabel(s)}`, workload: w, scale: s })))}
            harness={harness}
            theme={theme}
            selected={activeSelected}
          />
          <RankedBars
            title="startup (first contentful paint)"
            description={harness === 'web'
              ? 'view attach → first table content, with the first screen pre-rendering N rows. IFR-capable configs paint from the main thread before hydration.'
              : 'native pipeline open → first contentful paint. Entries without a pipeline performance entry are absent rather than replaced by another boundary.'}
            suite="startup"
            metric="fcp"
            ops={workloadScales({ suite: 'startup', harness, workload: 'startup', metric: 'fcp' }).map((s) => ({
              key: `startup@${s}`, label: `@${scaleLabel(s)} rows`, workload: 'startup', scale: s,
            }))}
            harness={harness}
            theme={theme}
            selected={activeSelected}
          />
          {harness === 'native' && ['octaneCommitAck', 'octaneSecondFrame'].map((metric) => {
            const metricRecords = select({ suite: 'startup', harness, workload: 'startup', metric });
            if (metricRecords.length === 0) return null;
            const isAck = metric === 'octaneCommitAck';
            return (
              <RankedBars
                key={metric}
                title={isAck ? 'Octane startup (transport commit ACK)' : 'Octane startup (second post-ACK frame)'}
                description={isAck
                  ? 'Open request → acknowledgement of Octane’s initial root transport commit. Octane-only Native metric; not FCP.'
                  : 'Open request → second Native frame after Octane’s initial transport acknowledgement. Octane-only Native metric; not FCP.'}
                suite="startup"
                metric={metric}
                ops={workloadScales({ suite: 'startup', harness, workload: 'startup', metric }).map((s) => ({
                  key: `startup@${s}`, label: `@${scaleLabel(s)} rows`, workload: 'startup', scale: s,
                }))}
                harness={harness}
                theme={theme}
                selected={activeSelected}
              />
            );
          })}
          {harness === 'native' && <NativeCoverage />}
        </>
      ) : page === 'scale' ? (
        <>
          <h1>How does cost grow with scale?</h1>
          <p className="subtitle">
            The unified-matrix lineage: each case across row scales, linear for absolute gaps and
            log–log for shape. α is the fitted scaling exponent (1 = linear in N; below 1 = amortizing;
            0 ≈ scale-independent).
          </p>
          <Legend harness={harness} theme={theme} selected={activeSelected} onToggle={toggleEntry} />
          {harness === 'web' && <CostSpace harness={harness} theme={theme} selected={activeSelected} />}
          {trendSpecsForHarness(harness).map((spec) => (
            <ScaleTrend key={spec.title} spec={spec} harness={harness} theme={theme} selected={activeSelected} />
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
          <Legend harness={harness} theme={theme} selected={activeSelected} onToggle={toggleEntry} />
          <ThreadsPage harness={harness} theme={theme} selected={activeSelected} />
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

      <HistoryRanking
        harness={harness}
        onHarnessChange={changeHarness}
        theme={theme}
        snapshotIndex={snapshotIndex}
        onSnapshotChange={onSnapshotChange}
      />

      <footer className="note" style={{ marginTop: '3rem', borderTop: '1px solid var(--border)', paddingTop: '1rem' }}>
        <a href="https://github.com/Huxpro/lynx-js-framework-benchmark" target="_blank" rel="noreferrer">
          github.com/Huxpro/lynx-js-framework-benchmark
        </a>
        {' '}· reproduce with <code>pnpm bench run</code> · results are the checked-in{' '}
        <code>results/latest.json</code> materialized cache, regenerated from source before every build.
      </footer>
    </div>
  );
}

export default function App() {
  const [snapshotIndex, setSnapshotIndex] = useState(initialSnapshotIndex);
  const snapshot = TIMELINE_SNAPSHOTS[snapshotIndex];
  const changeSnapshot = (index: number) => {
    setSnapshotIndex(index);
    const params = new URLSearchParams(location.search);
    const candidate = TIMELINE_SNAPSHOTS[index];
    if (candidate.id === 'current-main') params.delete('snapshot');
    else params.set('snapshot', candidate.id);
    const query = params.toString();
    history.replaceState(null, '', query ? `?${query}` : location.pathname);
  };
  return (
    <BenchmarkDataProvider snapshot={snapshot}>
      <AppContent snapshotIndex={snapshotIndex} onSnapshotChange={changeSnapshot} />
    </BenchmarkDataProvider>
  );
}
