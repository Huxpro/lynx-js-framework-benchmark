// "Every case at a glance": rows = workload@scale, columns = entries, cell =
// × vs baseline (selectable entry) or vs the row's fastest. Log-scaled
// diverging tint saturating at 4× either way; the numeral stays legible.
import { useEffect, useMemo, useState } from 'react';

import { useBenchmarkData } from '../data-context';
import { BenchRecord, ENTRIES, entryColor, fmtX, shortLabel } from '../data';
import { completeRowGeomeans } from '../derive.mjs';
import { useTooltip } from '../hooks';
import { useI18n } from '../i18n';
import { Legend } from './Legend';

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

export function HeatGrid({
  rows,
  harness,
  theme,
  selected,
  onToggle,
}: {
  rows: RowSpec[];
  harness: string;
  theme: 'light' | 'dark';
  selected: Set<string>;
  onToggle: (id: string) => void;
}) {
  const { text } = useI18n();
  const { select } = useBenchmarkData();
  const ids = ENTRIES.map((e) => e.id).filter((id) => selected.has(id));
  const [mode, setMode] = useState<'fastest' | string>('fastest');
  const activeMode = mode === 'fastest' || selected.has(mode) ? mode : 'fastest';
  const { setTip, onMove, tipNode } = useTooltip();
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

  const geo = useMemo(() => {
    return completeRowGeomeans(ids, grid.map((row) => ({
      key: row.spec.key,
      values: Object.fromEntries(ids.map((id, index) => [id, row.values[index]])),
    })), activeMode === 'fastest' ? null : activeMode);
  }, [grid, activeMode, ids.join(',')]);

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
              <tr key={row.spec.key}>
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
          <tfoot>
            <tr>
              <th className="rowhead" style={{ borderTop: '2px solid var(--border)' }}>{text('geomean', '几何平均')}</th>
              {ids.map((id) => {
                const g = geo.values.get(id);
                const isRef = activeMode !== 'fastest' && id === activeMode;
                return (
                  <td
                    key={id}
                    className={isRef ? 'ref' : 'data'}
                    style={{
                      borderTop: '2px solid var(--border)',
                      ...(isRef || g == null ? {} : { background: tintFor(g) }),
                      fontWeight: 700,
                    }}
                  >
                    {g == null ? '—' : fmtX(g)}
                  </td>
                );
              })}
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="note" style={{ marginTop: '0.5rem' }}>
        {geo.rowCount === 0 ? (
          <>{text(
            'No row has complete data for every selected entry in this snapshot. Blank cells remain visible, but are excluded from ratios, geomeans, and rankings.',
            '此快照中没有任何一行对所有已选条目都具备完整数据。空白单元仍会展示，但不参与比率、几何平均和排名。',
          )}</>
        ) : (
          <>{text(
            `Each cell is that entry's median relative to the ${activeMode === 'fastest' ? "row's fastest entry" : `${shortLabel(activeMode)} baseline`}, per case. Green is faster, red is slower; tint saturates at 4× either way. Hover for exact numbers; the geomean is recomputed over ${geo.rowCount} rows with complete data for every selected entry. Per-case cards below carry the full data tables.`,
            `每个单元都是该条目中位数相对${activeMode === 'fastest' ? '该行最快项' : `${shortLabel(activeMode)} 基线`}的比值，逐 case 计算。绿色更快，红色更慢；双向色深都在 4× 饱和。悬停可查看精确值；几何平均会基于 ${geo.rowCount} 行对所有已选条目都完整的数据重新计算。下方逐 case 卡片包含完整数据表。`,
          )}</>
        )}
      </div>
      {tipNode}
    </div>
  );
}
