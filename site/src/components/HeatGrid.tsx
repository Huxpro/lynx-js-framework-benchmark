// "Every case at a glance": rows = workload@scale, columns = entries, cell =
// × vs baseline (selectable entry) or vs the row's fastest. Log-scaled
// diverging tint saturating at 4× either way; the numeral stays legible.
import { useMemo, useState } from 'react';

import { BenchRecord, ENTRIES, entryColor, fmtX, select, shortLabel } from '../data';
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
  const { setTip, onMove, tipNode } = useTooltip();

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

  const geo = useMemo(() => {
    const acc = new Map<string, number[]>(ids.map((id) => [id, []]));
    for (const row of grid) {
      const base = mode === 'fastest'
        ? row.fastest
        : row.recs.get(mode)?.median ?? null;
      if (base == null || base <= 0) continue;
      ids.forEach((id, i) => {
        const v = row.values[i];
        if (v != null && v > 0) acc.get(id)!.push(v / base);
      });
    }
    return new Map(ids.map((id) => {
      const vals = acc.get(id)!;
      if (!vals.length) return [id, null] as const;
      return [id, Math.exp(vals.reduce((a, v) => a + Math.log(v), 0) / vals.length)] as const;
    }));
  }, [grid, mode, ids.join(',')]);

  return (
    <div className="card" onMouseMove={onMove}>
      <div className="controls-row">
        <div className="card-title">All cases at a glance</div>
        <div className="seg" role="group" aria-label="Baseline">
          <button aria-pressed={mode === 'fastest'} onClick={() => setMode('fastest')}>vs fastest</button>
          {ENTRIES.filter((e) => selected.has(e.id)).map((e) => (
            <button key={e.id} aria-pressed={mode === e.id} onClick={() => setMode(e.id)}>
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
                  const base = mode === 'fastest' ? row.fastest : row.recs.get(mode)?.median ?? null;
                  if (v == null || base == null || base <= 0) {
                    return <td key={id} className="null" aria-label="no data">—</td>;
                  }
                  const ratio = v / base;
                  const isRef = mode !== 'fastest' && id === mode;
                  const isFastest = mode === 'fastest' && id === row.fastestId;
                  return (
                    <td
                      key={id}
                      className={isRef ? 'ref' : `data${isFastest ? ' fastest' : ''}`}
                      style={isRef ? undefined : { background: tintFor(ratio) }}
                      onMouseEnter={(e) => {
                        setTip({
                          head: `${shortLabel(id)} · ${row.spec.label}`,
                          lines: [
                            `${fmtX(ratio)} vs ${mode === 'fastest' ? `fastest (${shortLabel(row.fastestId!)})` : shortLabel(mode)}`,
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
            <tr>
              <th className="rowhead" style={{ borderTop: '2px solid var(--border)' }}>geomean</th>
              {ids.map((id) => {
                const g = geo.get(id);
                const isRef = mode !== 'fastest' && id === mode;
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
        Each cell is that entry's median relative to the {mode === 'fastest' ? "row's fastest entry" : `${shortLabel(mode)} baseline`},
        per case. Green is faster, red is slower; tint saturates at 4× either way. Hover for exact numbers;
        per-case cards below carry the full data tables.
      </div>
      {tipNode}
    </div>
  );
}
