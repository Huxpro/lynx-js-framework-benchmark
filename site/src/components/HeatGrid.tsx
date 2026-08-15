// "Every case at a glance": rows = workload@scale, columns = entries, cell =
// × vs baseline (selectable entry) or vs the row's fastest. Log-scaled
// diverging tint saturating at 4× either way; the numeral stays legible.
import { useEffect, useMemo, useState } from 'react';

import { BenchRecord, ENTRIES, entryColor, fmtX, select, shortLabel } from '../data';
import { completeEntryScores } from '../derive.mjs';
import { useTooltip } from '../hooks';

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
  scoreGroup: string;
  scoreGroupLabel: string;
}

export function HeatGrid({
  rows,
  harness,
  theme,
  selected,
}: {
  rows: RowSpec[];
  harness: string;
  theme: 'light' | 'dark';
  selected: Set<string>;
}) {
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
  }, [rows, harness, ids.join(',')]);

  const scoreGroups = useMemo(() => {
    const groups = [...new Map(rows.map((row) => [row.scoreGroup, row.scoreGroupLabel])).entries()];
    return groups.map(([key, label]) => ({
      key,
      label,
      score: completeEntryScores(ids, grid
        .filter((row) => row.spec.scoreGroup === key)
        .map((row) => ({
          key: row.spec.key,
          values: Object.fromEntries(ids.map((id, index) => [id, row.values[index]])),
        })), activeMode === 'fastest' ? null : activeMode),
    }));
  }, [grid, activeMode, ids.join(',')]);

  return (
    <div className="card" onMouseMove={onMove}>
      <div className="controls-row">
        <div className="card-title">All cases at a glance</div>
        <div className="seg" role="group" aria-label="Baseline">
          <button aria-pressed={activeMode === 'fastest'} onClick={() => setMode('fastest')}>vs fastest</button>
          {ENTRIES.filter((e) => selected.has(e.id)).map((e) => (
            <button key={e.id} aria-pressed={activeMode === e.id} onClick={() => setMode(e.id)}>
              vs {shortLabel(e.id)}
            </button>
          ))}
        </div>
      </div>
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
                    return <td key={id} className="null" aria-label="no data">—</td>;
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
                            `${fmtX(ratio)} vs ${activeMode === 'fastest' ? `fastest (${shortLabel(row.fastestId!)})` : shortLabel(activeMode)}`,
                            `median ${row.recs.get(id)?.median?.toFixed(1)}ms, n=${row.recs.get(id)?.n}`,
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
            {scoreGroups.map(({ key, label, score }, groupIndex) => (
              <tr key={key}>
                <th className="rowhead" style={groupIndex === 0 ? { borderTop: '2px solid var(--border)' } : undefined}>
                  {label} ({score.cellCount})
                </th>
                {ids.map((id) => {
                  const value = score.scores.find((entry) => entry.id === id)?.value ?? null;
                  const isRef = activeMode !== 'fastest' && id === activeMode;
                  return (
                    <td
                      key={id}
                      className={isRef ? 'ref' : 'data'}
                      style={{
                        ...(groupIndex === 0 ? { borderTop: '2px solid var(--border)' } : {}),
                        ...(isRef || value == null ? {} : { background: tintFor(value) }),
                        fontWeight: 700,
                      }}
                    >
                      {value == null ? '—' : fmtX(value)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tfoot>
        </table>
      </div>
      <div className="note" style={{ marginTop: '0.5rem' }}>
        Each cell is that entry's median relative to the {activeMode === 'fastest' ? "row's fastest entry" : `${shortLabel(activeMode)} baseline`},
        per case. Green is faster, red is slower; tint saturates at 4× either way. Hover for exact numbers;
        footer scores are recomputed independently for interactive, storms, and startup against each
        profile's fixed complete matrix; an incomplete entry shows —. The profiles are never folded
        into one cross-suite global score. Per-case cards below carry the full data tables.
      </div>
      {tipNode}
    </div>
  );
}
