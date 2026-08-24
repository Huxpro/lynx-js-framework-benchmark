// "Every case at a glance": rows = workload@scale, columns = entries, cell =
// × vs baseline (selectable entry) or vs the row's fastest. Log-scaled
// diverging tint saturating at 4× either way; the numeral stays legible.
import { useEffect, useMemo, useState } from 'react';

import { useBenchmarkData } from '../data-context';
import { BenchRecord, ENTRIES, entryColor, fmtX, shortLabel } from '../data';
import { completeEntryScores } from '../derive.mjs';
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
  const activeMode = mode === 'fastest' || selected.has(mode) ? mode : 'fastest';
  const activeScore = previewScore ?? pinnedScore;
  const { setTip, onMove, place, tipNode } = useTooltip();
  useEffect(() => {
    if (mode !== 'fastest' && !selected.has(mode)) setMode('fastest');
  }, [mode, selected]);
  useEffect(() => {
    const keys = new Set(scoreModes.map((scoreMode) => scoreMode.key));
    if (previewScore != null && !keys.has(previewScore)) setPreviewScore(null);
    if (pinnedScore != null && !keys.has(pinnedScore)) setPinnedScore(null);
  }, [pinnedScore, previewScore, scoreModes]);

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

  const scoreRows = useMemo(() => {
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
        cellCount: score.cellCount,
        rowKeys: new Set(scoreMode.ops.map((op) => op.key)),
        values: new Map(score.scores.map(({ id, value }) => [id, value])),
      };
    });
  }, [grid, ids.join(','), scoreModes]);
  const activeScoreRow = scoreRows.find((row) => row.key === activeScore) ?? null;

  return (
    <div className="card" onMouseMove={onMove}>
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
          {scoreRows.length > 0 && (
            <tfoot>
              {scoreRows.map((scoreRow, scoreIndex) => {
                const isPinned = pinnedScore === scoreRow.key;
                const showEquation = () => {
                  setPreviewScore(scoreRow.key);
                  setTip(scoreRow.equation);
                };
                const clearPreview = () => {
                  setPreviewScore(null);
                  setTip(null);
                };
                return (
                  <tr
                    key={scoreRow.key}
                    className={`score-summary-row${activeScore === scoreRow.key ? ' is-active' : ''}`}
                    onPointerEnter={showEquation}
                    onPointerLeave={(event) => {
                      if (!event.currentTarget.contains(document.activeElement)) clearPreview();
                    }}
                    onFocus={showEquation}
                    onBlur={(event) => {
                      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) clearPreview();
                    }}
                  >
                    <th className="rowhead" style={scoreIndex === 0 ? { borderTop: '2px solid var(--border)' } : undefined}>
                      <button
                        type="button"
                        className="score-summary-trigger"
                        aria-pressed={isPinned}
                        aria-label={`${scoreRow.equation.head}. ${scoreRow.equation.lines.join(' ')}`}
                        onClick={() => setPinnedScore((current) => current === scoreRow.key ? null : scoreRow.key)}
                        onFocus={(event) => {
                          const rect = event.currentTarget.getBoundingClientRect();
                          requestAnimationFrame(() => place({
                            clientX: rect.left + rect.width / 2,
                            clientY: rect.bottom,
                          }));
                        }}
                      >
                        {scoreRow.label}
                        <span aria-hidden="true">{text(`${scoreRow.cellCount} rows`, `${scoreRow.cellCount} 行`)}</span>
                      </button>
                    </th>
                    {ids.map((id) => {
                      const value = scoreRow.values.get(id);
                      return (
                        <td
                          key={id}
                          className="data"
                          style={{
                            ...(scoreIndex === 0 ? { borderTop: '2px solid var(--border)' } : {}),
                            ...(value == null ? {} : { background: tintFor(value) }),
                            fontWeight: 700,
                          }}
                        >
                          {value == null ? '—' : fmtX(value)}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tfoot>
          )}
        </table>
      </div>
      <div className="note" style={{ marginTop: '0.5rem' }}>
        {scoreRows.length === 0 ? (
          <>{text(
            'No published interaction equation is available for this snapshot. Blank cells remain visible, but do not produce an aggregate score.',
            '此快照没有可用的正式交互公式。空白单元仍会展示，但不会生成聚合得分。',
          )}</>
        ) : (
          <>{text(
            `Each case cell is relative to the ${activeMode === 'fastest' ? "row's fastest entry" : `${shortLabel(activeMode)} baseline`}. The three score rows mirror the published interaction equations below and always normalize each input to its row's fastest selected entry. Hover or focus a score row to trace its inputs; click to keep them highlighted. Incomplete entries receive no score.`,
            `每个 case 单元都相对${activeMode === 'fastest' ? '该行最快项' : `${shortLabel(activeMode)} 基线`}显示。底部三行得分与下方正式交互公式完全一致，并始终把每项输入归一化到该行已选条目中的最快项。悬停或聚焦得分行可追踪输入，点击可固定高亮；数据不完整的条目不生成得分。`,
          )}</>
        )}
      </div>
      {tipNode}
    </div>
  );
}
