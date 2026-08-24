// "Every case at a glance": rows = workload@scale, columns = entries, cell =
// × vs baseline (selectable entry) or vs the row's fastest. Log-scaled
// diverging tint saturating at 4× either way; the numeral stays legible.
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';

import { useBenchmarkData } from '../data-context';
import { BenchRecord, ENTRIES, entryColor, fmtX, shortLabel } from '../data';
import { completeEntryScores, rebaseEntryScores } from '../derive.mjs';
import { useTooltip } from '../hooks';
import { useI18n } from '../i18n';
import { Legend } from './Legend';
import type { ScoreModeSpec } from './RankedBars';

function tintFor(v: number): string {
  const t = Math.max(-1, Math.min(1, Math.log(v) / Math.log(4)));
  const a = (Math.abs(t) * 0.5).toFixed(3);
  const rgbVar = t < 0 ? 'var(--heat-fast)' : 'var(--heat-slow)';
  return `rgba(${rgbVar}, ${a})`;
}

interface RowSpec {
  key: string;
  label: string;
  suite: string;
  workload: string;
  scale: number;
  metric: string;
}

const scoreInputKey = (row: RowSpec) => row.suite === 'table' && row.metric === 'latency'
  ? `${row.workload}@${row.scale}`
  : row.key;

export function HeatGrid({
  rows,
  scoreModes,
  harness,
  theme,
  selected,
  onToggle,
}: {
  rows: RowSpec[];
  scoreModes: ScoreModeSpec[];
  harness: string;
  theme: 'light' | 'dark';
  selected: Set<string>;
  onToggle: (id: string) => void;
}) {
  const { text } = useI18n();
  const { select } = useBenchmarkData();
  const ids = ENTRIES.map((e) => e.id).filter((id) => selected.has(id));
  const [mode, setMode] = useState<'fastest' | string>('fastest');
  const [previewScore, setPreviewScore] = useState<string | null>(null);
  const [pinnedScore, setPinnedScore] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const activeMode = mode === 'fastest' || selected.has(mode) ? mode : 'fastest';
  const activeScore = previewScore ?? pinnedScore;
  const { setTip, onMove, place, tipNode } = useTooltip();
  useEffect(() => {
    if (mode !== 'fastest' && !selected.has(mode)) setMode('fastest');
  }, [mode, selected]);

  const grid = useMemo(() => {
    return rows.map((spec) => {
      const recs = new Map<string, BenchRecord>();
      for (const r of select({
        suite: spec.suite, harness, workload: spec.workload, scale: spec.scale, metric: spec.metric,
      })) recs.set(r.entry, r);
      const values = ids.map((id) => recs.get(id)?.median ?? null);
      const present = values.filter((v): v is number => v != null && v > 0);
      const fastest = present.length ? Math.min(...present) : null;
      const fastestId = fastest != null ? ids[values.indexOf(fastest)] : null;
      return { spec, values, fastest, fastestId, recs };
    });
  }, [rows, harness, ids.join(','), select]);

  const interactionScoreRows = useMemo(() => {
    const byKey = new Map(grid.map((row) => [scoreInputKey(row.spec), row]));
    return scoreModes.filter((scoreMode) => scoreMode.ops.length > 0).map((scoreMode) => {
      const cells = scoreMode.ops.map((op) => {
        const row = byKey.get(op.key);
        return {
          key: op.key,
          values: Object.fromEntries(ids.map((id, index) => [id, row?.values[index]])),
        };
      });
      const weights = scoreMode.scoreWeights == null ? undefined : scoreMode.ops.map((op) => {
        const weight = scoreMode.scoreWeights?.[op.key];
        if (weight == null) throw new Error(`Missing score weight for ${op.key}`);
        return weight;
      });
      const score = completeEntryScores(
        ids,
        cells,
        weights,
      );
      return {
        ...scoreMode,
        group: 'interaction' as const,
        groupLabel: text('Interaction', '交互'),
        cellCount: score.cellCount,
        rowKeys: new Set(scoreMode.ops.map((op) => op.key)),
        values: new Map(score.scores.map(({ id, value }) => [id, value])),
      };
    });
  }, [grid, ids.join(','), scoreModes, text]);
  const startupScoreRow = useMemo(() => {
    const startupRows = grid.filter((row) => row.spec.suite === 'startup'
      && row.spec.metric === 'fcp');
    if (startupRows.length === 0) return null;
    const score = completeEntryScores(ids, startupRows.map((row) => ({
      key: scoreInputKey(row.spec),
      values: Object.fromEntries(ids.map((id, index) => [id, row.values[index]])),
    })));
    return {
      key: 'startup-fcp',
      label: text('FCP overall', 'FCP 综合'),
      group: 'startup' as const,
      groupLabel: text('Startup', '启动'),
      cellCount: score.cellCount,
      rowKeys: new Set(startupRows.map((row) => scoreInputKey(row.spec))),
      values: new Map(score.scores.map(({ id, value }) => [id, value])),
      equation: {
        head: text('Startup FCP geometric mean', '启动 FCP 几何平均'),
        lines: [
          text('rₛ = FCP median at scale s ÷ fastest FCP median at scale s', 'rₛ = 规模 s 的 FCP 中位数 ÷ 该规模最快 FCP 中位数'),
          'score = exp(Σ ln(rₛ) ÷ N)',
          text('N = startup scales complete for every selected entry', 'N = 所有已选条目均完整的启动规模数'),
          text('Local/cached startup only; production network transfer is excluded', '仅限本地/缓存启动；不包含生产网络传输'),
        ],
      },
    };
  }, [grid, ids.join(','), text]);
  const conclusionRows = [
    ...(startupScoreRow == null ? [] : [startupScoreRow]),
    ...interactionScoreRows,
  ];
  const conclusionKey = conclusionRows.map((row) => row.key).join('|');
  const activeScoreRow = conclusionRows.find((row) => row.key === activeScore) ?? null;

  useEffect(() => {
    const keys = new Set(conclusionRows.map((row) => row.key));
    if (previewScore != null && !keys.has(previewScore)) setPreviewScore(null);
    if (pinnedScore != null && !keys.has(pinnedScore)) setPinnedScore(null);
  }, [conclusionKey, pinnedScore, previewScore]);

  useEffect(() => {
    if (pinnedScore == null) return;
    const clearOutside = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element
        && rootRef.current?.contains(target)
        && target.closest('.score-summary-row')) return;
      setPinnedScore(null);
    };
    const clearEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPinnedScore(null);
    };
    document.addEventListener('pointerdown', clearOutside);
    document.addEventListener('keydown', clearEscape);
    return () => {
      document.removeEventListener('pointerdown', clearOutside);
      document.removeEventListener('keydown', clearEscape);
    };
  }, [pinnedScore]);

  return (
    <div className="card" ref={rootRef} onMouseMove={onMove}>
      <div className="controls-row glance-heading">
        <div className="card-title">{text('All cases at a glance', '全部 case 一览')}</div>
        <div className="seg" role="group" aria-label={text('Baseline', '基线')}>
          <button aria-pressed={activeMode === 'fastest'} onClick={() => setMode('fastest')}>{text('vs fastest', '对比最快项')}</button>
          {ENTRIES.filter((e) => selected.has(e.id)).map((e) => (
            <button key={e.id} aria-pressed={activeMode === e.id} onClick={() => setMode(e.id)}>
              {text('vs', '对比')} {shortLabel(e.id)}
            </button>
          ))}
        </div>
      </div>
      <Legend harness={harness} theme={theme} selected={selected} onToggle={onToggle} />
      <div className="heat-scroll">
        <table className="heat">
          <thead>
            <tr>
              <th />
              {ids.map((id) => (
                <th key={id} className="colhead">
                  <span className="swatch" style={{
                    display: 'inline-block', width: 9, height: 9, borderRadius: 3,
                    background: entryColor(id, theme), marginRight: 5,
                  }} />
                  {shortLabel(id)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.map((row) => (
              <tr
                key={row.spec.key}
                className={activeScoreRow == null
                  ? undefined
                  : activeScoreRow.rowKeys.has(scoreInputKey(row.spec))
                    ? 'is-score-source'
                    : 'is-score-muted'}
              >
                <th className="rowhead">{row.spec.label}</th>
                {ids.map((id, i) => {
                  const v = row.values[i];
                  const base = activeMode === 'fastest' ? row.fastest : row.recs.get(activeMode)?.median ?? null;
                  if (v == null || base == null || base <= 0) {
                    return <td key={id} className="null" aria-label={text('no data', '无数据')}>—</td>;
                  }
                  const ratio = v / base;
                  const isRef = activeMode !== 'fastest' && id === activeMode;
                  const isFastest = activeMode === 'fastest' && id === row.fastestId;
                  return (
                    <td
                      key={id}
                      className={isRef ? 'ref' : `data${isFastest ? ' fastest' : ''}`}
                      style={isRef ? undefined : { background: tintFor(ratio) }}
                      onMouseEnter={(e) => {
                        setTip({
                          head: `${shortLabel(id)} · ${row.spec.label}`,
                          lines: [
                            text(
                              `${fmtX(ratio)} vs ${activeMode === 'fastest' ? `fastest (${shortLabel(row.fastestId!)})` : shortLabel(activeMode)}`,
                              `${fmtX(ratio)}，对比${activeMode === 'fastest' ? `最快项（${shortLabel(row.fastestId!)}）` : shortLabel(activeMode)}`,
                            ),
                            text(
                              `median ${row.recs.get(id)?.median?.toFixed(1)}ms, n=${row.recs.get(id)?.n}`,
                              `中位数 ${row.recs.get(id)?.median?.toFixed(1)}ms，n=${row.recs.get(id)?.n}`,
                            ),
                          ],
                        });
                        onMove(e);
                      }}
                      onMouseLeave={() => setTip(null)}
                    >
                      {fmtX(ratio)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          {conclusionRows.length > 0 && (
            <tfoot>
              {conclusionRows.map((scoreRow, scoreIndex) => {
                const isPinned = pinnedScore === scoreRow.key;
                const displayedValues = rebaseEntryScores(ids, scoreRow.values, activeMode);
                const startsGroup = scoreIndex === 0
                  || conclusionRows[scoreIndex - 1]?.group !== scoreRow.group;
                const inputCount = text(
                  `${scoreRow.cellCount} input rows`,
                  `${scoreRow.cellCount} 个输入行`,
                );
                const baselineEquationLine = activeMode === 'fastest' ? null : text(
                  `Display baseline: formula score ÷ ${shortLabel(activeMode)} formula score; ${shortLabel(activeMode)} = 1.00×`,
                  `显示基线：公式得分 ÷ ${shortLabel(activeMode)} 的公式得分；${shortLabel(activeMode)} = 1.00×`,
                );
                const showEquation = () => {
                  setPreviewScore(scoreRow.key);
                  setTip({
                    ...scoreRow.equation,
                    lines: [
                      inputCount,
                      ...(baselineEquationLine == null ? [] : [baselineEquationLine]),
                      ...scoreRow.equation.lines,
                    ],
                  });
                };
                const clearPreview = () => {
                  setPreviewScore(null);
                  setTip(null);
                };
                return (
                  <Fragment key={scoreRow.key}>
                    {startsGroup && (
                      <tr className="score-summary-divider" aria-hidden="true">
                        <th className="rowhead score-summary-divider-head">
                          <span>{scoreRow.groupLabel}</span>
                        </th>
                        <td colSpan={ids.length} />
                      </tr>
                    )}
                    <tr
                      className={`score-summary-row${startsGroup ? ' score-group-lead' : ''}${activeScore === scoreRow.key ? ' is-active' : ''}`}
                      onPointerEnter={showEquation}
                      onPointerLeave={(event) => {
                        if (!event.currentTarget.contains(document.activeElement)) clearPreview();
                      }}
                      onFocus={showEquation}
                      onBlur={(event) => {
                        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) clearPreview();
                      }}
                    >
                      <th className="rowhead">
                        <button
                          type="button"
                          className="score-summary-trigger"
                          aria-pressed={isPinned}
                          aria-label={`${scoreRow.groupLabel}: ${scoreRow.equation.head}. ${inputCount}. ${baselineEquationLine == null ? '' : `${baselineEquationLine}. `}${scoreRow.equation.lines.join(' ')}`}
                          onClick={() => setPinnedScore((current) => current === scoreRow.key ? null : scoreRow.key)}
                          onFocus={(event) => {
                            const rect = event.currentTarget.getBoundingClientRect();
                            requestAnimationFrame(() => place({
                              clientX: rect.left + rect.width / 2,
                              clientY: rect.bottom,
                            }));
                          }}
                        >
                          <span className="score-summary-label">{scoreRow.label}</span>
                          <span className="score-summary-count" aria-hidden="true">
                            {text(`${scoreRow.cellCount} rows`, `${scoreRow.cellCount} 行`)}
                          </span>
                        </button>
                      </th>
                      {ids.map((id) => {
                        const value = displayedValues.get(id);
                        const isRef = activeMode !== 'fastest' && id === activeMode && value != null;
                        return (
                          <td
                            key={id}
                            className={isRef ? 'ref' : value == null ? 'null' : 'data'}
                            style={value == null ? undefined : isRef ? { fontWeight: 700 } : {
                              background: tintFor(value),
                              fontWeight: 700,
                            }}
                          >
                            {value == null ? '—' : fmtX(value)}
                          </td>
                        );
                      })}
                    </tr>
                  </Fragment>
                );
              })}
            </tfoot>
          )}
        </table>
      </div>
      <div className="note" style={{ marginTop: '0.5rem' }}>
        {conclusionRows.length === 0 ? (
          <>{text(
            'No published conclusion equation is available for this snapshot. Blank cells remain visible, but do not produce an aggregate score.',
            '此快照没有可用的正式结论公式。空白单元仍会展示，但不会生成聚合得分。',
          )}</>
        ) : (
          <>{text(
            `Each case cell is relative to the ${activeMode === 'fastest' ? "row's fastest entry" : `${shortLabel(activeMode)} baseline`}. Conclusions are grouped into startup FCP and three interaction formulas. ${activeMode === 'fastest' ? "They show the published formula values, with every input normalized to its row's fastest selected entry." : `Their complete formula scores are rebased to ${shortLabel(activeMode)}, so that entry is 1.00×.`} Hover or focus a conclusion to trace its inputs; click to pin, then click elsewhere or press Escape to clear. Incomplete entries receive no score.`,
            `每个 case 单元都相对${activeMode === 'fastest' ? '该行最快项' : `${shortLabel(activeMode)} 基线`}显示。结论分为启动 FCP 与三种交互公式。${activeMode === 'fastest' ? '此时显示正式公式值，每项输入都归一化到该行已选条目中的最快项。' : `完整公式得分会换基到 ${shortLabel(activeMode)}，因此该条目显示为 1.00×。`}悬停或聚焦结论可追踪输入；点击可固定，再点击其他区域或按 Escape 即可清除。数据不完整的条目不生成得分。`,
          )}</>
        )}
      </div>
      {tipNode}
    </div>
  );
}
