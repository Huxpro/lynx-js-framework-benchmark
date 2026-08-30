import * as Plot from '@observablehq/plot';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useBenchmarkData } from '../data-context';
import { ENTRIES, entryColor, filterRecords, oneFrom, shortLabel } from '../data';
import { useElementWidth } from '../hooks';
import { useI18n } from '../i18n';
import {
  paretoFrontier,
  paretoLine,
  paretoRegimeKey,
  paretoRegimeRecords,
} from '../pareto.mjs';
import { CardCaption } from './ResponsiveCopy';

type SizeMode = 'total' | 'mts';

interface ParetoPoint {
  entry: string;
  label: string;
  bytes: number;
  fcp: number;
  ci95: number | null;
  ciLow: number;
  ciHigh: number;
  artifactPath: string;
  artifactSha256: string;
  fcpRunFile: string;
  fcpBoundary: string;
  regimeKey: string;
}

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
  const { snapshot } = useBenchmarkData();
  const records = snapshot.records;
  const ref = useRef<HTMLDivElement>(null);
  const plotWidth = useElementWidth(ref);
  const scales = useMemo(() => [...new Set(paretoRegimeRecords(filterRecords(records, {
    suite: 'startup', harness, workload: 'startup', metric: 'fcp',
  }), harness).map((record) => record.scale))].sort((left, right) => left - right), [harness, records]);
  const [scale, setScale] = useState(10000);
  const [sizeMode, setSizeMode] = useState<SizeMode>('total');
  const activeScale = scales.includes(scale)
    ? scale
    : (scales.find((value) => value === 10000) ?? scales[0]);
  const scaleIndex = Math.max(0, scales.indexOf(activeScale ?? -1));
  const sizeMetric = sizeMode === 'total' ? 'totalArtifactGzip' : 'mtsSectionGzip';

  const { data, unavailable } = useMemo(() => {
    const points: ParetoPoint[] = [];
    const missing: string[] = [];
    for (const entry of ENTRIES) {
      if (!selected.has(entry.id) || activeScale == null) continue;
      const fcpMatches = paretoRegimeRecords(filterRecords(records, {
        suite: 'startup', harness, entry: entry.id,
        workload: 'startup', scale: activeScale, metric: 'fcp',
      }), harness);
      if (fcpMatches.length > 1) {
        throw new Error(`ambiguous Pareto FCP in ${paretoRegimeKey(fcpMatches[0])}: ${entry.id}@${activeScale}`);
      }
      const fcp = fcpMatches[0] ?? null;
      if (fcp?.median == null) continue;
      const size = oneFrom(records, {
        suite: 'bundle-scale', harness, entry: entry.id,
        workload: 'startup-bundle', scale: activeScale, metric: sizeMetric,
      });
      if (size?.median == null || size.artifact == null) {
        missing.push(shortLabel(entry.id));
        continue;
      }
      const ci95 = fcp.ci95 ?? null;
      points.push({
        entry: entry.id,
        label: shortLabel(entry.id),
        bytes: size.median,
        fcp: fcp.median,
        ci95,
        ciLow: Math.max(0, fcp.median - (ci95 ?? 0)),
        ciHigh: fcp.median + (ci95 ?? 0),
        artifactPath: size.artifact.path,
        artifactSha256: size.artifact.sha256,
        fcpRunFile: fcp.runFile ?? 'derived checkpoint',
        fcpBoundary: fcp.boundary,
        regimeKey: paretoRegimeKey(fcp),
      });
    }
    return { data: points, unavailable: missing };
  }, [activeScale, harness, records, selected, sizeMetric]);

  const frontier = useMemo(() => paretoFrontier(data) as ParetoPoint[], [data]);
  const frontierEntries = useMemo(
    () => new Set(frontier.map(({ entry }) => entry)),
    [frontier],
  );
  const line = useMemo(() => paretoLine(data) as ParetoPoint[], [data]);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (!data.length) {
      node.replaceChildren();
      return;
    }
    const ids = ENTRIES.map((entry) => entry.id).filter((id) => selected.has(id));
    const fg = theme === 'dark' ? '#b5b4ab' : '#5f5e57';
    const frontierStroke = theme === 'dark' ? '#f39a71' : '#bd4921';
    const errorBars = data.filter(({ ci95 }) => ci95 != null);
    const plot = Plot.plot({
      width: Math.max(420, plotWidth || node.clientWidth || 600),
      height: 380,
      marginLeft: 62,
      marginBottom: 48,
      style: { background: 'transparent', color: fg, fontSize: '12px' },
      x: {
        label: sizeMode === 'total'
          ? text('total artifact (gzip) →', '完整 artifact（gzip）→')
          : text('readable MTS section (gzip) →', '可解析 MTS section（gzip）→'),
        grid: true,
        domain: [0, Math.max(...data.map(({ bytes }) => bytes)) * 1.15],
        tickFormat: (value: number) => `${Math.round(value / 1024)}k`,
      },
      y: {
        label: text(`↑ FCP @${(activeScale ?? 0).toLocaleString()} rows (ms)`, `↑ FCP @${(activeScale ?? 0).toLocaleString()} 行（ms）`),
        grid: true,
        domain: [0, Math.max(...data.map(({ ciHigh }) => ciHigh)) * 1.12],
      },
      color: { domain: ids, range: ids.map((id) => entryColor(id, theme)) },
      marks: [
        Plot.line(line, {
          x: 'bytes', y: 'fcp', stroke: frontierStroke, strokeWidth: 2,
        }),
        Plot.ruleX(errorBars, {
          x: 'bytes', y1: 'ciLow', y2: 'ciHigh', stroke: 'entry', strokeWidth: 1.5,
        }),
        Plot.dot(data, {
          x: 'bytes', y: 'fcp', fill: 'entry', r: 7,
          stroke: 'var(--surface-1)', strokeWidth: 2,
        }),
        Plot.dot(frontier, {
          x: 'bytes', y: 'fcp', fill: 'none', r: 10,
          stroke: frontierStroke, strokeWidth: 1.5,
        }),
        Plot.text(data, {
          x: 'bytes', y: 'fcp', text: 'label', fill: 'entry', dy: -16, fontWeight: 650,
        }),
        Plot.tip(data, Plot.pointer({
          x: 'bytes', y: 'fcp',
          title: (point: ParetoPoint) => [
            point.label,
            `${(point.bytes / 1024).toFixed(1)} kB gzip`,
            `${point.fcp.toFixed(1)} ms FCP${point.ci95 == null ? '' : ` ± ${point.ci95.toFixed(1)} ms`}`,
            frontierEntries.has(point.entry) ? 'Pareto frontier' : 'dominated',
            point.artifactPath,
            `artifact ${point.artifactSha256.slice(0, 12)}`,
            `FCP ${point.fcpBoundary}`,
            point.fcpRunFile,
          ].join('\n'),
        })),
      ],
    });
    node.replaceChildren(plot);
    return () => plot.remove();
  }, [activeScale, data, frontier, frontierEntries, line, plotWidth, selected, sizeMode, text, theme]);

  const modeLabel = sizeMode === 'total'
    ? text('total artifact', '完整 artifact')
    : text('MTS section', 'MTS section');

  return (
    <figure className="card staging-pareto" role="group" aria-label={text('Staging Pareto', 'Staging Pareto')}>
      <figcaption>
        <CardCaption title={text('staging Pareto — what did those bytes buy?', 'Staging Pareto——这些字节换来了什么？')}>
          {text(
            'Exact scale-matched artifact gzip against local/cached startup FCP from one regime only (Web JIT 1× by default). The x-axis is a separate static shipping cost; production network transfer is not inside FCP. The rust line joins the lower-left non-dominated frontier; vertical rules are the existing 95% time confidence intervals. This is a trade-space, never a score.',
            '将同一规模的 artifact gzip 与单一 regime 的本地/缓存启动 FCP 精确配对（Web 默认 JIT 1×），禁止跨 lane 混合前沿。横轴是独立的静态交付成本；生产网络传输不计入 FCP。铁锈色折线连接左下方非支配前沿；竖线沿用现有时间 95% 置信区间。这是权衡空间，不是得分。',
          )}
        </CardCaption>
      </figcaption>
      <div className="pareto-controls">
        <div className="seg" role="group" aria-label={text('Bundle cost axis', 'Bundle 成本轴')}>
          {(['total', 'mts'] as SizeMode[]).map((mode) => (
            <button key={mode} aria-pressed={sizeMode === mode} onClick={() => setSizeMode(mode)}>
              {mode === 'total' ? text('total artifact', '完整 artifact') : text('MTS section', 'MTS section')}
            </button>
          ))}
        </div>
        {scales.length > 0 && (
          <label className="pareto-scale">
            <span>{text('startup scale', '启动规模')} <strong>@{(activeScale ?? 0).toLocaleString()}</strong></span>
            <input
              type="range"
              min={0}
              max={Math.max(0, scales.length - 1)}
              step={1}
              value={scaleIndex}
              aria-label={text('Startup row scale', '启动行数规模')}
              aria-valuetext={`${(activeScale ?? 0).toLocaleString()} rows`}
              onChange={(event) => setScale(scales[Number(event.currentTarget.value)])}
            />
            <span className="pareto-scale-marks" aria-hidden="true">
              {scales.map((value) => <span key={value}>{value === 0 ? '0' : `${value / 1000}k`}</span>)}
            </span>
          </label>
        )}
      </div>
      <div className="pareto-key" aria-label={text('Pareto chart key', 'Pareto 图例')}>
        <span className="pareto-key-frontier">{text('non-dominated frontier', '非支配前沿')}</span>
        <span>{text('vertical rule = FCP 95% CI', '竖线 = FCP 95% CI')}</span>
        <span>{harness === 'web' ? 'Web · JIT · 1×' : 'Native'}</span>
        <span>{harness === 'web' ? 'main.web.bundle' : 'main.lynx.bundle'}</span>
      </div>
      {unavailable.length > 0 && (
        <div className="pareto-unavailable" role="note">
          <strong>{modeLabel} {text('unavailable', '不可用')}:</strong>{' '}{unavailable.join(' · ')}
          {sizeMode === 'mts' && <span>{text(
            ' Binary artifacts are not relabelled as MTS sections.',
            ' 二进制 artifact 不会被改名冒充 MTS section。',
          )}</span>}
        </div>
      )}
      {data.length === 0
        ? <div className="empty-state">{text(
          'No exact scale + artifact + FCP join exists for this checkpoint and axis.',
          '此 checkpoint 与坐标轴没有精确匹配的 scale + artifact + FCP 数据。',
        )}</div>
        : <div className="plot-figure" ref={ref} />}
    </figure>
  );
}
