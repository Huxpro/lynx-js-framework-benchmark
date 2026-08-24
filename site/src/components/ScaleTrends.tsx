// Scale-growth charts (the unified-matrix lineage): metric vs rows-N per
// entry, linear (absolute gaps, zero baseline) and log-log (shape/exponent)
// views, with fitted scaling exponents α from least-squares on log-log.
import * as Plot from '@observablehq/plot';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useBenchmarkData } from '../data-context';
import { ENTRIES, entryColor, shortLabel } from '../data';
import { slopeFit } from '../derive.mjs';
import { useElementWidth } from '../hooks';
import { useI18n } from '../i18n';
import { ResponsiveCopy } from './ResponsiveCopy';

interface TrendSpec {
  title: string;
  desc: string;
  suite: string;
  workload: string;
  metric: string;
  unit: 'ms' | 'bytes';
}

const TREND_ZH: Record<string, { title: string; desc: string }> = {
  'startup — first contentful paint vs rows': {
    title: '启动——首次内容绘制与行数',
    desc: 'view attach → 首个包含表格内容的帧，bundle 首屏预渲染 N 行。这里体现 IFR 的差异：主线程首帧与后台 hydration。',
  },
  'startup — settled vs rows': {
    title: '启动——稳定时间与行数',
    desc: 'view attach → composed DOM 停止变化（静默 400ms）。展示不同规模下的完整 hydration 成本。',
  },
  'create — latency vs rows': {
    title: '创建——延迟与行数',
    desc: '点击 → N 行全部进入 DOM。经典的创建规模曲线。',
  },
  'update storm — latency vs rows': {
    title: '连续更新——延迟与行数',
    desc: '一次点击触发 50 个连续更新 tick；每个 tick 都完成一次 render→wire→apply 循环，把逐次更新成本放大到帧下限之上。',
  },
  'select storm — latency vs rows': {
    title: '连续选择——延迟与行数',
    desc: '连续移动选择 30 次。对于与变更量成正比的 wire，每个 tick 都是 O(1)，不随 N 改变。',
  },
  'create — BTS→MTS wire bytes vs rows': {
    title: '创建——BTS→MTS wire 字节与行数',
    desc: '从 BTS 发往 MTS、用于构建 N 行的序列化渲染 payload。这里只统计单向流量，不是 wire 总量；线程视图会分别展示 BTS→MTS、MTS→BTS 及双向总量。',
  },
  'Octane startup — transport commit ACK vs rows': {
    title: 'Octane 启动——transport 提交 ACK 与行数',
    desc: 'Open request → 初始根渲染后 Octane transport 的确认。这个独立 Native 指标不是 FCP，也不会与 pipeline FCP 排名。',
  },
  'Octane startup — second post-ACK frame vs rows': {
    title: 'Octane 启动——ACK 后第二帧与行数',
    desc: 'Open request → Octane 确认初始 transport 提交后的第二个 Native 动画帧。它仍是独立渲染器指标，不是 FCP。',
  },
};

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
  const { locale, text } = useI18n();
  const { select, selectNativeObservations } = useBenchmarkData();
  const copy = locale === 'zh-CN' ? TREND_ZH[spec.title] : null;
  const [scaleMode, setScaleMode] = useState<'linear' | 'log'>('linear');
  const ref = useRef<HTMLDivElement>(null);
  const plotWidth = useElementWidth(ref);

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
      width: Math.max(420, plotWidth || node.clientWidth || 640),
      height: 340,
      marginLeft: 56,
      marginRight: 110,
      style: { background: 'transparent', color: fg, fontSize: '12px' },
      x: {
        label: text('rows', '行数'),
        type: scaleMode === 'log' ? 'log' : 'linear',
        tickFormat: (d: number) => (d >= 1000 ? `${d / 1000}k` : String(d)),
      },
      y: {
        label: spec.unit === 'ms' ? text('ms (median)', 'ms（中位数）') : text('bytes', '字节'),
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
            `${d.label}\n${text(`${d.scale.toLocaleString()} rows`, `${d.scale.toLocaleString()} 行`)}\n${spec.unit === 'ms' ? `${d.value.toFixed(1)} ms` : `${(d.value / 1024).toFixed(1)} kB`}`,
        })),
      ],
    });
    node.replaceChildren(plot);
    return () => plot.remove();
  }, [data, scaleMode, theme, selected, spec, plotWidth, text]);

  return (
    <figure className="card" role="group" aria-label={copy?.title ?? spec.title}>
      <figcaption>
        <div className="card-title">{copy?.title ?? spec.title}</div>
        <ResponsiveCopy className="card-desc">{copy?.desc ?? spec.desc}</ResponsiveCopy>
      </figcaption>
      <div className="controls-row">
        <div className="seg" role="group" aria-label={text('Axis scale', '坐标轴尺度')}>
          <button aria-pressed={scaleMode === 'linear'} onClick={() => setScaleMode('linear')}>{text('linear', '线性')}</button>
          <button aria-pressed={scaleMode === 'log'} onClick={() => setScaleMode('log')}>log–log</button>
        </div>
        <span className="note">
          {alphas.filter((a) => a.alpha != null).map((a) => `${shortLabel(a.entry)} α=${a.alpha!.toFixed(2)}`).join(' · ')}
        </span>
      </div>
      {data.length === 0
        ? <div className="empty-state">{text('No data for this trend yet — run more scales with', '此趋势暂无数据——运行更多规模：')} <code>lynx-bench run --scale …</code></div>
        : <div className="plot-figure" ref={ref} />}
      <details className="data-table">
        <summary>{text('Data table', '数据表')}</summary>
        <table>
          <thead>
            <tr>
              <th>{text('rows', '行数')}</th>
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
