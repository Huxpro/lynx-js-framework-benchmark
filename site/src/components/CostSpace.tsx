// Cost-space scatter (ifr-bench lineage): what you ship (bundle gzip) vs what
// you get (startup FCP at scale). Lower-left dominates; an entry that pays
// bytes without buying startup drifts right.
import * as Plot from '@observablehq/plot';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useBenchmarkData } from '../data-context';
import { ENTRIES, entryColor, shortLabel } from '../data';

export function CostSpace({
  harness,
  theme,
  selected,
}: {
  harness: string;
  theme: 'light' | 'dark';
  selected: Set<string>;
}) {
  const { one, workloadScales } = useBenchmarkData();
  const ref = useRef<HTMLDivElement>(null);
  const scales = useMemo(
    () => workloadScales({ suite: 'startup', harness, workload: 'startup', metric: 'fcp' })
      .filter((value) => value > 0),
    [harness, workloadScales],
  );
  const [scale, setScale] = useState(10000);
  const activeScale = scales.includes(scale) ? scale : (scales.find((value) => value === 10000) ?? scales[0]);

  const data = useMemo(() => {
    const out: { entry: string; label: string; gzip: number; fcp: number }[] = [];
    for (const e of ENTRIES) {
      if (!selected.has(e.id)) continue;
      const gzip = one({ suite: 'bundle', entry: e.id, metric: 'bundleWebGzip' })?.median;
      const fcp = activeScale == null ? null
        : one({ suite: 'startup', harness, entry: e.id, workload: 'startup', scale: activeScale, metric: 'fcp' })?.median;
      if (gzip != null && fcp != null) {
        out.push({ entry: e.id, label: shortLabel(e.id), gzip, fcp });
      }
    }
    return out;
  }, [harness, selected, activeScale, one]);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (!data.length) {
      node.replaceChildren();
      return;
    }
    const ids = ENTRIES.map((e) => e.id).filter((id) => selected.has(id));
    const fg = theme === 'dark' ? '#b5b4ab' : '#5f5e57';
    const plot = Plot.plot({
      width: Math.min(640, Math.max(420, node.clientWidth || 600)),
      height: 360,
      marginLeft: 56,
      marginBottom: 44,
      style: { background: 'transparent', color: fg, fontSize: '12px' },
      x: {
        label: 'web bundle (gzip) →',
        grid: true,
        domain: [0, Math.max(...data.map((d) => d.gzip)) * 1.15],
        tickFormat: (d: number) => `${Math.round(d / 1024)}k`,
      },
      y: {
        label: `↑ FCP @${(activeScale ?? 0) / 1000}k rows (ms)`,
        grid: true,
        domain: [0, Math.max(...data.map((d) => d.fcp)) * 1.15],
      },
      color: { domain: ids, range: ids.map((id) => entryColor(id, theme)) },
      marks: [
        Plot.dot(data, { x: 'gzip', y: 'fcp', fill: 'entry', r: 7, stroke: 'var(--surface-1)', strokeWidth: 2 }),
        Plot.text(data, { x: 'gzip', y: 'fcp', text: 'label', fill: 'entry', dy: -14, fontWeight: 600 }),
        Plot.tip(data, Plot.pointer({
          x: 'gzip', y: 'fcp',
          title: (d: { label: string; gzip: number; fcp: number }) =>
            `${d.label}\n${(d.gzip / 1024).toFixed(1)} kB gzip\n${d.fcp.toFixed(0)} ms FCP`,
        })),
      ],
    });
    node.replaceChildren(plot);
    return () => plot.remove();
  }, [data, theme, selected, activeScale]);

  return (
    <figure className="card" role="group" aria-label="Cost space">
      <figcaption>
        <div className="card-title">cost space — what you ship vs what you get</div>
        <div className="card-desc">
          Web bundle size (gzip) against startup FCP at N pre-rendered rows. The lower-left
          corner dominates: less code, faster first paint. Paying bytes that don't buy startup
          moves an entry right without moving it down.
        </div>
      </figcaption>
      <div className="controls-row">
        <div className="seg" role="group" aria-label="Rows">
          {scales.map((s) => (
            <button key={s} aria-pressed={activeScale === s} onClick={() => setScale(s)}>@{s / 1000}k</button>
          ))}
        </div>
      </div>
      {data.length === 0
        ? <div className="empty-state">No startup + bundle data yet.</div>
        : <div className="plot-figure" ref={ref} />}
    </figure>
  );
}
