// Cost-space scatter (ifr-bench lineage): what you ship (bundle gzip) vs what
// you get (startup FCP at scale). Lower-left dominates; an entry that pays
// bytes without buying startup drifts right.
import * as Plot from '@observablehq/plot';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useBenchmarkData } from '../data-context';
import { ENTRIES, entryColor, shortLabel } from '../data';
import { useElementWidth } from '../hooks';
import { useI18n } from '../i18n';
import { ResponsiveCopy } from './ResponsiveCopy';

export function CostSpace({
  harness,
  theme,
  selected,
}: {
  harness: string;
  theme: 'light' | 'dark';
  selected: Set<string>;
}) {
  const { text } = useI18n();
  const { one, workloadScales } = useBenchmarkData();
  const ref = useRef<HTMLDivElement>(null);
  const plotWidth = useElementWidth(ref);
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
      const gzip = one({ suite: 'bundle', harness, entry: e.id, metric: 'bundleWebGzip' })?.median;
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
      width: Math.max(420, plotWidth || node.clientWidth || 600),
      height: 360,
      marginLeft: 56,
      marginBottom: 44,
      style: { background: 'transparent', color: fg, fontSize: '12px' },
      x: {
        label: text('bundle (gzip) →', 'bundle（gzip）→'),
        grid: true,
        domain: [0, Math.max(...data.map((d) => d.gzip)) * 1.15],
        tickFormat: (d: number) => `${Math.round(d / 1024)}k`,
      },
      y: {
        label: text(`↑ FCP @${(activeScale ?? 0) / 1000}k rows (ms)`, `↑ FCP @${(activeScale ?? 0) / 1000}k 行（ms）`),
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
  }, [data, theme, selected, activeScale, plotWidth, text]);

  return (
    <figure className="card" role="group" aria-label={text('Cost space', '成本空间')}>
      <figcaption>
        <div className="card-title">{text('cost space — what you ship vs what you get', '成本空间——交付体积与启动表现')}</div>
        <ResponsiveCopy className="card-desc">
          {text(
            "This environment's bundle size (gzip) against local/cached startup FCP at N pre-rendered rows. The x-axis is a separate shipping-cost proxy: production network transfer is not inside FCP. The lower-left corner dominates—less code to parse/evaluate/create, faster first paint.",
            '对比此环境的 bundle 体积（gzip）与预渲染 N 行时的本地/缓存启动 FCP。横轴是独立的交付成本代理：FCP 不包含生产网络传输。左下角占优——需要解析、求值和创建的代码更少，首次绘制更快。',
          )}
        </ResponsiveCopy>
      </figcaption>
      <div className="controls-row">
        <div className="seg" role="group" aria-label={text('Rows', '行数')}>
          {scales.map((s) => (
            <button key={s} aria-pressed={activeScale === s} onClick={() => setScale(s)}>@{s / 1000}k</button>
          ))}
        </div>
      </div>
      {data.length === 0
        ? <div className="empty-state">{text('No startup + bundle data yet.', '暂无启动与 bundle 联合数据。')}</div>
        : <div className="plot-figure" ref={ref} />}
    </figure>
  );
}
