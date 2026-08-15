import { useMemo, useState } from 'react';

import { CostSpace } from './components/CostSpace';
import { Legend } from './components/Legend';
import { HeatGrid } from './components/HeatGrid';
import { MethodPage } from './components/Method';
import { RankedBars } from './components/RankedBars';
import { ScaleTrend, TREND_SPECS } from './components/ScaleTrends';
import { ThreadsPage } from './components/Threads';
import { ENTRIES, FEATURED_IDS, LAB_IDS, select } from './data';
import { useTheme } from './hooks';
import { HEATMAP_SCORE_KEYS, SCORE_PROFILES, scoreCellKey } from './score-policy.mjs';

// Sharable comparison state: ?entries=a,b,c picks an exact set (any
// permutation, incl. lab entries); ?lab=1 reveals the lab tier. This is the
// author-development mechanism — the default URL always shows the featured
// public view.
function initialSelection(): { selected: Set<string>; labMode: boolean } {
  const params = new URLSearchParams(location.search);
  const ids = params.get('entries')?.split(',').map((s) => s.trim())
    .filter((id) => ENTRIES.some((e) => e.id === id));
  const selected = new Set(ids?.length ? ids : FEATURED_IDS);
  const labMode = params.get('lab') === '1'
    || [...selected].some((id) => LAB_IDS.includes(id));
  return { selected, labMode };
}

function syncUrl(selected: Set<string>, labMode: boolean) {
  const params = new URLSearchParams(location.search);
  const isDefault = !labMode
    && selected.size === FEATURED_IDS.length
    && FEATURED_IDS.every((id) => selected.has(id));
  if (isDefault) {
    params.delete('entries');
    params.delete('lab');
  } else {
    params.set('entries', ENTRIES.filter((e) => selected.has(e.id)).map((e) => e.id).join(','));
    if (labMode) params.set('lab', '1');
    else params.delete('lab');
  }
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

export default function App() {
  const [theme, toggleTheme] = useTheme();
  const [page, setPage] = useState<Page>('overview');
  const [harness, setHarness] = useState<string>('web');
  const [init] = useState(initialSelection);
  const [selected, setSelected] = useState<Set<string>>(init.selected);
  const [labMode, setLabMode] = useState<boolean>(init.labMode);

  const toggleEntry = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      syncUrl(next, labMode);
      return next;
    });

  const toggleLab = () => {
    const nextLab = !labMode;
    setLabMode(nextLab);
    if (!nextLab) {
      // leaving lab mode hides + deselects lab entries
      setSelected((prev) => {
        const next = new Set([...prev].filter((id) => !LAB_IDS.includes(id)));
        syncUrl(next, nextLab);
        return next;
      });
    } else {
      syncUrl(selected, nextLab);
    }
  };

  const heatRows = useMemo(() => {
    const rows: {
      key: string;
      label: string;
      suite: string;
      workload: string;
      scale: number;
      metric: string;
      scoreGroup: string;
      scoreGroupLabel: string;
    }[] = [];
    for (const profileKey of HEATMAP_SCORE_KEYS) {
      const profile = SCORE_PROFILES[profileKey];
      for (const scoreCell of profile.cells) {
        rows.push({
          ...scoreCell,
          key: scoreCellKey(scoreCell),
          label: `${scoreCell.workload} @${scaleLabel(scoreCell.scale)}`,
          scoreGroup: profile.key,
          scoreGroupLabel: profile.label,
        });
      }
    }
    return rows;
  }, [harness]);

  const profileOps = (
    profileKey: keyof typeof SCORE_PROFILES,
    showScale: boolean,
  ) => SCORE_PROFILES[profileKey].cells
    .map((scoreCell) => ({
      key: scoreCellKey(scoreCell),
      label: scoreCell.suite === 'startup'
        ? `@${scaleLabel(scoreCell.scale)} rows`
        : `${scoreCell.workload}${showScale ? ` @${scaleLabel(scoreCell.scale)}` : ''}`,
      workload: scoreCell.workload,
      scale: scoreCell.scale,
    }));

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
        {LAB_IDS.length > 0 && (
          <button
            className="theme-toggle"
            aria-pressed={labMode}
            onClick={toggleLab}
            title="Lab: framework-author variants (versions, PRs, flag permutations). Selections are sharable via the URL."
            style={labMode ? { background: 'var(--surface-2)', color: 'var(--text-primary)' } : undefined}
          >
            ⚗ Lab
          </button>
        )}
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
            The same table app, one instrument. Headless Chromium running Lynx for Web; medians,
            lower is better. Pick entries, hover anything, open any card's data table for exact
            numbers.{labMode && ' Lab entries are historical calibration-only estimates marked ≈ calibrated; non-time fields remain historical. Your selection is sharable via the URL.'}
          </p>
          <Legend theme={theme} selected={selected} onToggle={toggleEntry} labMode={labMode} />
          <HeatGrid rows={heatRows} harness={harness} theme={theme} selected={selected} />
          <RankedBars
            title="interactive overall"
            description="all 11 normal table-operation × scale cells in one primary score; every cell has equal log weight, so clear @10k contributes 1/11."
            suite="table"
            ops={profileOps('interactive', true)}
            harness={harness}
            theme={theme}
            selected={selected}
            scoreLabel="overall"
          />
          <RankedBars
            title="interactive @1k"
            description={(
              <>
                <a href="https://github.com/krausest/js-framework-benchmark" target="_blank" rel="noreferrer">
                  krausest-style
                </a>{' '}
                table ops on 1,000 rows: tap → all mutations visible in the composed DOM.
              </>
            )}
            suite="table"
            ops={profileOps('interactive1k', false)}
            harness={harness}
            theme={theme}
            selected={selected}
            scoreLabel="@1k score"
          />
          <RankedBars
            title="interactive @10k"
            description="scale diagnostic for the four operations measured at 10,000 rows. Clear is 1/4 here, but only 1/11 in interactive overall."
            suite="table"
            ops={profileOps('interactive10k', false)}
            harness={harness}
            theme={theme}
            selected={selected}
            scoreLabel="@10k score"
          />
          <RankedBars
            title="storms"
            description="one tap, many sequential render cycles (50 update / 30 select ticks through a MessageChannel pump). Throughput of the full state→render→wire→apply loop."
            suite="table"
            ops={profileOps('storms', true)}
            harness={harness}
            theme={theme}
            selected={selected}
            scoreLabel="storm score"
          />
          <RankedBars
            title="startup (first contentful paint)"
            description="view attach → first table content, with the first screen pre-rendering N rows. IFR-capable configs paint from the main thread before hydration."
            suite="startup"
            metric="fcp"
            ops={profileOps('startup', true)}
            harness={harness}
            theme={theme}
            selected={selected}
            scoreLabel="startup score"
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
          <Legend theme={theme} selected={selected} onToggle={toggleEntry} labMode={labMode} />
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
          <Legend theme={theme} selected={selected} onToggle={toggleEntry} labMode={labMode} />
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
        <code>results/latest.json</code> materialized cache, regenerated from source before every build.
      </footer>
    </div>
  );
}
