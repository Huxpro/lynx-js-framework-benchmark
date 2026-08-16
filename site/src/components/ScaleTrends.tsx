// Scale-growth charts (the unified-matrix lineage): metric vs rows-N per
// entry, linear (absolute gaps, zero baseline) and log-log (shape/exponent)
// views, with fitted scaling exponents α from least-squares on log-log.
import * as Plot from '@observablehq/plot';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useBenchmarkData } from '../data-context';
import { ENTRIES, entryColor, shortLabel } from '../data';
import { slopeFit } from '../derive.mjs';

interface TrendSpec {
  title: string;
  desc: string;
  suite: string;
  workload: string;
  metric: string;
  unit: 'ms' | 'bytes';
}

export function ScaleTrend({
  spec,
  harness,
  theme,
  selected,
}: {
  spec: TrendSpec;
  harness: string;
  theme: 'light' | 'dark';
  selected: Set<string>;
}) {
  const { select, selectNativeObservations } = useBenchmarkData();
  const [scaleMode, setScaleMode] = useState<'linear' | 'log'>('linear');
  const ref = useRef<HTMLDivElement>(null);

  const data = useMemo(() => {
    const out: { entry: string; label: string; scale: number; value: number }[] = [];
    for (const e of ENTRIES) {
      if (!selected.has(e.id)) continue;
      const filter = {
        suite: spec.suite,
        harness,
        workload: spec.workload,
        metric: spec.metric,
        entry: e.id,
      };
      const comparisonRecords = select(filter);
      const records = comparisonRecords.length > 0
        ? comparisonRecords
        : spec.metric.startsWith('octane')
          ? selectNativeObservations(filter)
          : [];
      for (const r of records) {
        if (r.median != null && r.scale > 0) {
          out.push({ entry: e.id, label: shortLabel(e.id), scale: r.scale, value: r.median });
        }
      }
    }
    return out.sort((a, b) => a.scale - b.scale);
  }, [spec, harness, selected, select, selectNativeObservations]);

  const alphas = useMemo(() => {
    const out: { entry: string; alpha: number | null }[] = [];
    const ids = [...new Set(data.map((point) => point.entry))];
    const commonScales = [...new Set(data.map((point) => point.scale))]
      .filter((scale) => ids.every((id) => data.some((point) => point.entry === id && point.scale === scale)));
    for (const id of ids) {
      const pts = data.filter((d) => d.entry === id && commonScales.includes(d.scale))
        .map((d) => [d.scale, d.value] as [number, number]);
      if (pts.length >= 2) out.push({ entry: id, alpha: slopeFit(pts) });
    }
    return out;
  }, [data, selected]);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (data.length === 0) {
      node.replaceChildren();
      return;
    }
    const ids = ENTRIES.map((e) => e.id).filter((id) => selected.has(id));
    const fg = theme === 'dark' ? '#b5b4ab' : '#5f5e57';
    const plot = Plot.plot({
      width: Math.min(680, Math.max(420, node.clientWidth || 640)),
      height: 340,
      marginLeft: 56,
      marginRight: 110,
      style: { background: 'transparent', color: fg, fontSize: '12px' },
      x: {
        label: 'rows',
        type: scaleMode === 'log' ? 'log' : 'linear',
        tickFormat: (d: number) => (d >= 1000 ? `${d / 1000}k` : String(d)),
      },
      y: {
        label: spec.unit === 'ms' ? 'ms (median)' : 'bytes',
        type: scaleMode === 'log' ? 'log' : 'linear',
        ...(scaleMode === 'linear' ? { domain: [0, Math.max(...data.map((d) => d.value)) * 1.05] } : {}),
        grid: true,
        tickFormat: spec.unit === 'bytes'
          ? (d: number) => (d >= 1048576 ? `${(d / 1048576).toFixed(1)}M` : d >= 1024 ? `${(d / 1024).toFixed(0)}k` : String(d))
          : undefined,
      },
      color: {
        domain: ids,
        range: ids.map((id) => entryColor(id, theme)),
      },
      marks: [
        Plot.line(data, { x: 'scale', y: 'value', stroke: 'entry', strokeWidth: 2, curve: 'monotone-x' }),
        Plot.dot(data, { x: 'scale', y: 'value', stroke: 'entry', fill: 'var(--surface-1)', r: 4, strokeWidth: 2 }),
        Plot.text(data, Plot.selectLast({
          x: 'scale', y: 'value', z: 'entry', text: 'label', fill: 'entry',
          dx: 8, textAnchor: 'start', fontWeight: 600,
        })),
        Plot.tip(data, Plot.pointer({
          x: 'scale', y: 'value',
          title: (d: { label: string; scale: number; value: number }) =>
            `${d.label}\n${d.scale.toLocaleString()} rows\n${spec.unit === 'ms' ? `${d.value.toFixed(1)} ms` : `${(d.value / 1024).toFixed(1)} kB`}`,
        })),
      ],
    });
    node.replaceChildren(plot);
    return () => plot.remove();
  }, [data, scaleMode, theme, selected, spec]);

  return (
    <figure className="card" role="group" aria-label={spec.title}>
      <figcaption>
        <div className="card-title">{spec.title}</div>
        <div className="card-desc">{spec.desc}</div>
      </figcaption>
      <div className="controls-row">
        <div className="seg" role="group" aria-label="Axis scale">
          <button aria-pressed={scaleMode === 'linear'} onClick={() => setScaleMode('linear')}>linear</button>
          <button aria-pressed={scaleMode === 'log'} onClick={() => setScaleMode('log')}>log–log</button>
        </div>
        <span className="note">
          {alphas.filter((a) => a.alpha != null).map((a) => `${shortLabel(a.entry)} α=${a.alpha!.toFixed(2)}`).join(' · ')}
        </span>
      </div>
      {data.length === 0
        ? <div className="empty-state">No data for this trend yet — run more scales with <code>lynx-bench run --scale …</code></div>
        : <div className="plot-figure" ref={ref} />}
      <details className="data-table">
        <summary>Data table</summary>
        <table>
          <thead>
            <tr>
              <th>rows</th>
              {ENTRIES.filter((e) => selected.has(e.id)).map((e) => <th key={e.id}>{e.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {[...new Set(data.map((d) => d.scale))].sort((a, b) => a - b).map((s) => (
              <tr key={s}>
                <td>{s.toLocaleString()}</td>
                {ENTRIES.filter((e) => selected.has(e.id)).map((e) => {
                  const d = data.find((d) => d.entry === e.id && d.scale === s);
                  return <td key={e.id}>{d ? (spec.unit === 'ms' ? `${d.value.toFixed(1)}` : d.value.toLocaleString()) : '—'}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

const COMMON_TREND_SPECS: TrendSpec[] = [
  {
    title: 'startup — first contentful paint vs rows',
    desc: 'view attach → first frame with table content, on bundles whose first screen pre-renders N rows. The IFR story lives here: main-thread first frame vs background hydration.',
    suite: 'startup', workload: 'startup', metric: 'fcp', unit: 'ms',
  },
  {
    title: 'startup — settled vs rows',
    desc: 'view attach → composed DOM stopped changing (400ms quiesce). The full-hydration cost at scale.',
    suite: 'startup', workload: 'startup', metric: 'settled', unit: 'ms',
  },
  {
    title: 'create — latency vs rows',
    desc: 'tap → all N rows in the DOM. The classic creation curve.',
    suite: 'table', workload: 'create', metric: 'latency', unit: 'ms',
  },
  {
    title: 'update storm — latency vs rows',
    desc: '50 sequential update ticks from one tap; every tick is a full render→wire→apply cycle. Amplifies per-update cost above the frame floor.',
    suite: 'table', workload: 'updateStorm', metric: 'latency', unit: 'ms',
  },
  {
    title: 'select storm — latency vs rows',
    desc: '30 sequential selection moves. On a change-proportional wire this is O(1) per tick regardless of N.',
    suite: 'table', workload: 'selectStorm', metric: 'latency', unit: 'ms',
  },
  {
    title: 'create — BTS→MTS wire bytes vs rows',
    desc: 'serialized render payload sent from BTS to MTS to build N rows. This is one direction only, not total wire traffic; the Threads view shows BTS→MTS and MTS→BTS separately plus their two-direction total.',
    suite: 'table', workload: 'create', metric: 'wireToMtsBytes', unit: 'bytes',
  },
];

const NATIVE_OCTANE_STARTUP_SPECS: TrendSpec[] = [
  {
    title: 'Octane startup — transport commit ACK vs rows',
    desc: 'Open request → Octane transport acknowledgement after the initial root render. This isolated Native metric is not FCP and is never ranked against pipeline FCP.',
    suite: 'startup', workload: 'startup', metric: 'octaneCommitAck', unit: 'ms',
  },
  {
    title: 'Octane startup — second post-ACK frame vs rows',
    desc: 'Open request → second Native animation frame after Octane acknowledges the initial transport commit. This remains an isolated renderer metric, not FCP.',
    suite: 'startup', workload: 'startup', metric: 'octaneSecondFrame', unit: 'ms',
  },
];

export function trendSpecsForHarness(harness: string): TrendSpec[] {
  return harness === 'native'
    ? [...COMMON_TREND_SPECS, ...NATIVE_OCTANE_STARTUP_SPECS]
    : COMMON_TREND_SPECS;
}
