import * as Plot from '@observablehq/plot';
import { useEffect, useMemo, useRef } from 'react';

import { useBenchmarkData } from '../data-context';
import { ENTRIES, entryColor, fmtX, shortLabel } from '../data';
import { completeEntryScores } from '../derive.mjs';
import { useElementWidth, useTooltip } from '../hooks';
import { localizedWorkload, useI18n } from '../i18n';
import { INTERACTION_SCORE_SCALES, INTERACTION_WORKLOADS } from '../interaction-score';

interface CompositePoint {
  entry: string;
  label: string;
  scale: number;
  value: number;
}

export function InteractionScaleComposite({
  harness,
  theme,
  selected,
}: {
  harness: string;
  theme: 'light' | 'dark';
  selected: Set<string>;
}) {
  const { locale, text } = useI18n();
  const { select, workloadScales } = useBenchmarkData();
  const ref = useRef<HTMLDivElement>(null);
  const plotWidth = useElementWidth(ref);
  const { setTip, onMove, place, tipNode } = useTooltip();
  const ids = useMemo(
    () => ENTRIES.map((entry) => entry.id).filter((id) => selected.has(id)),
    [selected],
  );
  const scales = useMemo(() => INTERACTION_SCORE_SCALES.filter((scale) =>
    INTERACTION_WORKLOADS.some((workload) => workloadScales({
      suite: 'table', harness, workload, metric: 'latency',
    }).includes(scale))), [harness, workloadScales]);

  // A scale curve is only meaningful if every point uses the same operation
  // set. Restrict the formula to operations complete for every selected entry
  // at every plotted scale instead of silently changing its denominator.
  const commonWorkloads = useMemo(() => INTERACTION_WORKLOADS.filter((workload) =>
    scales.every((scale) => {
      const records = select({ suite: 'table', harness, workload, scale, metric: 'latency' });
      return ids.every((id) => records.some((record) =>
        record.entry === id && record.median != null && record.median > 0));
    })), [harness, ids, scales, select]);

  const data = useMemo<CompositePoint[]>(() => {
    if (ids.length < 2 || scales.length < 2 || commonWorkloads.length < 2) return [];
    return scales.flatMap((scale) => {
      const cells = commonWorkloads.map((workload) => {
        const records = select({ suite: 'table', harness, workload, scale, metric: 'latency' });
        return {
          key: `${workload}@${scale}`,
          values: Object.fromEntries(ids.map((id) => [
            id,
            records.find((record) => record.entry === id)?.median,
          ])),
        };
      });
      const scores = completeEntryScores(ids, cells);
      if (scores.missing.length > 0) return [];
      return scores.scores.flatMap(({ id, value }) => value == null ? [] : [{
        entry: id,
        label: shortLabel(id),
        scale,
        value,
      }]);
    });
  }, [commonWorkloads, harness, ids, scales, select]);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (data.length === 0) {
      node.replaceChildren();
      return;
    }
    const fg = theme === 'dark' ? '#b5b4ab' : '#5f5e57';
    const background = theme === 'dark' ? '#1d1f26' : '#ffffff';
    const max = Math.max(...data.map((point) => point.value));
    const width = Math.max(320, plotWidth || node.clientWidth || 760);
    const compact = width < 620;
    const plot = Plot.plot({
      width,
      height: compact ? 320 : 350,
      marginLeft: compact ? 48 : 56,
      marginRight: compact ? 16 : 120,
      marginBottom: 48,
      style: { background: 'transparent', color: fg, fontSize: '12px' },
      x: {
        label: text('rows →', '行数 →'),
        type: 'point',
        domain: scales,
        tickFormat: (scale: number) => scale >= 1000 ? `${scale / 1000}k` : String(scale),
        grid: true,
        padding: 0.45,
      },
      y: {
        label: text('relative composite × (lower is better)', '相对复合值 ×（越低越好）'),
        domain: [1, Math.max(1.02, max * 1.06)],
        grid: true,
        tickFormat: (value: number) => `${value.toFixed(2)}×`,
      },
      color: {
        domain: ids,
        range: ids.map((id) => entryColor(id, theme)),
      },
      marks: [
        Plot.ruleY([1], { stroke: fg, strokeOpacity: 0.35, strokeDasharray: '3,3' }),
        Plot.line(data, {
          x: 'scale', y: 'value', z: 'entry', stroke: 'entry', strokeWidth: 2,
          className: 'scale-composite-series scale-composite-line',
        }),
        Plot.dot(data, {
          x: 'scale', y: 'value', stroke: 'entry', fill: background, r: 4, strokeWidth: 2,
          className: 'scale-composite-series scale-composite-point',
        }),
        Plot.text(data, Plot.selectLast({
          x: 'scale', y: 'value', z: 'entry', text: (point: CompositePoint) => compact ? fmtX(point.value) : `${point.label}  ${fmtX(point.value)}`,
          fill: 'entry', dx: compact ? -7 : 8, textAnchor: compact ? 'end' : 'start', fontWeight: 650, fontSize: 11,
          className: 'scale-composite-series scale-composite-label',
        })),
        Plot.tip(data, Plot.pointer({
          x: 'scale', y: 'value',
          title: (point: CompositePoint) => [
            point.label,
            text(`${point.scale.toLocaleString()} rows  ·  ${fmtX(point.value)}`, `${point.scale.toLocaleString()} 行  ·  ${fmtX(point.value)}`),
            text(`${commonWorkloads.length} complete operations  ·  equal-weight geometric mean`, `${commonWorkloads.length} 项完整操作  ·  等权几何平均`),
          ].join('\n'),
          fill: theme === 'dark' ? '#252831' : '#fffdf8',
          stroke: theme === 'dark' ? '#5b5e68' : '#bbb8ad',
          strokeWidth: 1,
          fontSize: 12,
          lineWidth: 31,
          textPadding: 11,
          pointerSize: 8,
          pathFilter: 'drop-shadow(0 8px 20px rgba(0,0,0,0.24))',
        })),
      ],
    });
    node.replaceChildren(plot);

    const entryByColor = new Map(ids.map((id) => [entryColor(id, theme).toLowerCase(), id]));
    const marks = [...plot.querySelectorAll<SVGElement>(
      '.scale-composite-series path, .scale-composite-series circle, .scale-composite-series text',
    )];
    const entryForMark = (mark: SVGElement) => {
      const stroke = mark.getAttribute('stroke')?.toLowerCase();
      const fill = mark.getAttribute('fill')?.toLowerCase();
      return (stroke && entryByColor.get(stroke)) || (fill && entryByColor.get(fill)) || null;
    };
    const focus = (entry: string | null) => {
      for (const mark of marks) {
        const markEntry = entryForMark(mark);
        mark.classList.toggle('is-series-muted', Boolean(entry && markEntry && markEntry !== entry));
        mark.classList.toggle('is-series-focus', Boolean(entry && markEntry === entry));
      }
    };
    const controller = new AbortController();
    for (const mark of marks) {
      const entry = entryForMark(mark);
      if (entry) mark.addEventListener('pointerenter', () => focus(entry), { signal: controller.signal });
    }
    plot.addEventListener('pointerleave', () => focus(null), { signal: controller.signal });
    return () => {
      controller.abort();
      plot.remove();
    };
  }, [commonWorkloads.length, data, ids, plotWidth, scales, text, theme]);

  const equation = {
    head: text('Scale-comparable interaction composite', '可跨规模比较的交互复合值'),
    lines: [
      text('r(op, scale) = median ÷ fastest median at that scale', 'r(op, scale) = 中位数 ÷ 该规模下最快中位数'),
      `score(scale) = exp(Σ ln(r) ÷ ${commonWorkloads.length})`,
      text(`${commonWorkloads.length} identical operations required at every plotted scale`, `每个绘制规模都必须具备相同的 ${commonWorkloads.length} 项操作`),
      text('Not the upstream weighted score, which mixes fixed 1k and 10k cases', '这不是上游加权得分；后者固定混合 1k 与 10k case'),
    ],
  };

  return (
    <figure className="card interaction-scale-composite" role="group" aria-label={text('Interaction composite by scale', '按规模展示交互复合值')}>
      <figcaption>
        <div className="card-title">{text('interaction composite — relative score vs rows', '交互复合值——相对得分与行数')}</div>
        <div className="card-desc">
          {text(
            "The same complete operation set at every scale, normalized per operation to that scale's fastest entry and combined with an equal-weight geometric mean. This shows whether relative competitiveness changes with N; it is intentionally distinct from the upstream score, whose fixed formula mixes 1k cases with create 10k.",
            '每个规模都使用同一组完整操作；逐操作相对该规模最快项归一化，再等权取几何平均。它展示相对竞争力是否随 N 改变；这与上游得分有意区分，因为上游固定公式混合了 1k case 和 create 10k。',
          )}
        </div>
      </figcaption>
      <div className="controls-row">
        <button
          type="button"
          className="formula-explainer"
          onMouseEnter={(event) => { setTip(equation); onMove(event); }}
          onMouseMove={onMove}
          onMouseLeave={(event) => {
            if (document.activeElement !== event.currentTarget) setTip(null);
          }}
          onFocus={(event) => {
            setTip(equation);
            const rect = event.currentTarget.getBoundingClientRect();
            requestAnimationFrame(() => place({
              clientX: rect.left + rect.width / 2,
              clientY: rect.bottom,
            }));
          }}
          onBlur={() => setTip(null)}
          aria-label={`${equation.head}. ${equation.lines.join(' ')}`}
        >
          {text('equal operations', '操作等权')} <span aria-hidden="true">?</span>
        </button>
        <span className="note">
          {commonWorkloads.length > 0
            ? text(
              `${commonWorkloads.length} shared operation${commonWorkloads.length === 1 ? '' : 's'} · ${scales.length} scales`,
              `${commonWorkloads.length} 项共享操作 · ${scales.length} 个规模`,
            )
            : text('no complete shared matrix', '无完整共享矩阵')}
        </span>
      </div>
      {data.length === 0
        ? <div className="empty-state">
          {text(
            `A composite requires at least two operations complete for every selected entry at both 1k and 10k. This cohort has ${commonWorkloads.length}; no aggregate is drawn.`,
            `复合值要求至少两项操作在 1k 和 10k 下都对所有已选条目完整。此 cohort 只有 ${commonWorkloads.length} 项，因此不绘制聚合结果。`,
          )}
        </div>
        : <div className="plot-figure" ref={ref} />}
      {data.length > 0 && <details className="data-table">
        <summary>{text('Data table', '数据表')} · {commonWorkloads.map((workload) => localizedWorkload(workload, locale)).join(', ') || text('no shared operations', '无共享操作')}</summary>
        <table>
          <thead>
            <tr>
              <th>{text('rows', '行数')}</th>
              {ENTRIES.filter((entry) => ids.includes(entry.id)).map((entry) => <th key={entry.id}>{entry.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {scales.map((scale) => (
              <tr key={scale}>
                <td>{scale.toLocaleString()}</td>
                {ENTRIES.filter((entry) => ids.includes(entry.id)).map((entry) => {
                  const point = data.find((candidate) => candidate.entry === entry.id && candidate.scale === scale);
                  return <td key={entry.id}>{point ? fmtX(point.value) : '—'}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </details>}
      {tipNode}
    </figure>
  );
}
