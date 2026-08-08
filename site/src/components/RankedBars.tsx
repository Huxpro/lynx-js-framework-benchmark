// Per-suite card: operation chips, ranked bars (absolute for one op, geomean
// ×-vs-fastest for "overall"), and the exact-number table (the relief channel).
// Visual language follows octanejs.dev/benchmarks; implementation is ours.
import { useMemo, useState } from 'react';

import {
  BenchRecord,
  ENTRIES,
  entryColor,
  fmtMs,
  fmtX,
  select,
  shortLabel,
} from '../data';
import { useTooltip } from '../hooks';

interface OpSpec {
  key: string; // workload@scale
  label: string;
  workload: string;
  scale: number;
}

function geomean(vals: number[]): number | null {
  const clean = vals.filter((v) => Number.isFinite(v) && v > 0);
  if (!clean.length) return null;
  return Math.exp(clean.reduce((a, v) => a + Math.log(v), 0) / clean.length);
}

export function RankedBars({
  title,
  description,
  suite,
  metric = 'latency',
  ops,
  harness,
  theme,
  selected,
  unitFmt = fmtMs,
}: {
  title: string;
  description: string;
  suite: string;
  metric?: string;
  ops: OpSpec[];
  harness: string;
  theme: 'light' | 'dark';
  selected: Set<string>;
  unitFmt?: (v: number | null) => string;
}) {
  const [op, setOp] = useState<'overall' | string>('overall');
  const { setTip, onMove, tipNode } = useTooltip();

  const byOp = useMemo(() => {
    const m = new Map<string, Map<string, BenchRecord>>();
    for (const spec of ops) {
      const inner = new Map<string, BenchRecord>();
      for (const r of select({ suite, harness, workload: spec.workload, scale: spec.scale, metric })) {
        inner.set(r.entry, r);
      }
      m.set(spec.key, inner);
    }
    return m;
  }, [suite, harness, metric, ops]);

  const view = useMemo(() => {
    const ids = ENTRIES.map((e) => e.id).filter((id) => selected.has(id));
    if (op === 'overall') {
      // per op: ratio vs fastest entry present; overall: geomean of ratios.
      const ratios = new Map<string, number[]>(ids.map((id) => [id, []]));
      for (const spec of ops) {
        const inner = byOp.get(spec.key)!;
        const present = ids
          .map((id) => [id, inner.get(id)?.median] as const)
          .filter(([, v]) => v != null && (v as number) > 0);
        if (present.length < 2) continue;
        const fastest = Math.min(...present.map(([, v]) => v as number));
        for (const [id, v] of present) ratios.get(id)!.push((v as number) / fastest);
      }
      const rows = ids
        .map((id) => ({ id, value: geomean(ratios.get(id)!), dnf: false }))
        .filter((r) => r.value != null) as { id: string; value: number; dnf: boolean }[];
      rows.sort((a, b) => a.value - b.value);
      const missing = ids.filter((id) => !rows.some((r) => r.id === id));
      return { rows, missing, fmt: fmtX, caption: 'geometric mean of per-op × vs the fastest entry — lower is better, 1× = fastest' };
    }
    const spec = ops.find((o) => o.key === op)!;
    const inner = byOp.get(spec.key)!;
    const rows = ENTRIES.map((e) => e.id)
      .filter((id) => selected.has(id))
      .map((id) => {
        const r = inner.get(id);
        return {
          id,
          value: r?.median ?? null,
          ci95: r?.ci95 ?? null,
          n: r?.n ?? 0,
          dnf: (r?.dnfCount ?? 0) > 0 && r?.median == null,
        };
      });
    const present = rows.filter((r) => r.value != null) as { id: string; value: number; ci95: number | null; n: number; dnf: boolean }[];
    present.sort((a, b) => a.value - b.value);
    const missing = rows.filter((r) => r.value == null).map((r) => r.id);
    return { rows: present, missing, fmt: unitFmt, caption: `median ${spec.label} — lower is better` };
  }, [op, byOp, selected, ops, unitFmt]);

  const scaleMax = Math.max(1e-9, ...view.rows.map((r) => r.value as number)) * 1.08;
  const refValue = op === 'overall' ? 1 : null;

  return (
    <figure className="card" role="group" aria-label={title} style={{ margin: '1rem 0' }} onMouseMove={onMove}>
      <figcaption>
        <div className="card-title">{title}</div>
        <div className="card-desc">{description}</div>
      </figcaption>
      <div className="chips" role="group" aria-label="Operation">
        <button className="chip" aria-pressed={op === 'overall'} onClick={() => setOp('overall')}>overall</button>
        {ops.map((o) => (
          <button key={o.key} className="chip" aria-pressed={op === o.key} onClick={() => setOp(o.key)}>
            {o.label}
          </button>
        ))}
      </div>
      <div className="bars" aria-hidden="true" style={{ position: 'relative' }}>
        {view.rows.map((r) => {
          const frac = (r.value as number) / scaleMax;
          const inside = frac > 0.68;
          return (
            <div
              key={r.id}
              className="bar-row"
              onMouseEnter={(e) => {
                const rec = op === 'overall' ? null : byOp.get(op)?.get(r.id);
                setTip({
                  head: shortLabel(r.id),
                  lines: op === 'overall'
                    ? [`${fmtX(r.value as number)} vs fastest (geomean across ${ops.length} ops)`]
                    : [
                      `${unitFmt(r.value as number)} median${rec?.ci95 != null ? ` ± ${unitFmt(rec.ci95)}` : ''}`,
                      `n = ${rec?.n ?? '?'}${rec?.dnfCount ? `, ${rec.dnfCount} DNF` : ''}`,
                    ],
                });
                onMove(e);
              }}
              onMouseLeave={() => setTip(null)}
            >
              <div className="bar-label">{shortLabel(r.id)}</div>
              <div className="bar-track">
                {refValue != null && (
                  <div className="refline" style={{ left: `${(refValue / scaleMax) * 100}%` }} />
                )}
                <div
                  className="bar-fill"
                  style={{ width: `${frac * 100}%`, background: entryColor(r.id, theme) }}
                />
                <span className={`bar-value${inside ? ' inside' : ''}`} style={{ left: `${frac * 100}%` }}>
                  {view.fmt(r.value as number)}
                </span>
              </div>
            </div>
          );
        })}
        {view.missing.map((id) => (
          <div key={id} className="bar-row">
            <div className="bar-label">{shortLabel(id)}</div>
            <div className="bar-dnf">— no data{op !== 'overall' ? ' (DNF or not run)' : ''}</div>
          </div>
        ))}
      </div>
      <div className="note">{view.caption}</div>
      <details className="data-table">
        <summary>Data table (median, all ops)</summary>
        <table>
          <thead>
            <tr>
              <th>op</th>
              {ENTRIES.filter((e) => selected.has(e.id)).map((e) => <th key={e.id}>{e.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {ops.map((o) => (
              <tr key={o.key}>
                <td>{o.label}</td>
                {ENTRIES.filter((e) => selected.has(e.id)).map((e) => {
                  const r = byOp.get(o.key)?.get(e.id);
                  return (
                    <td key={e.id}>
                      {r?.median != null ? unitFmt(r.median) : (r?.dnfCount ?? 0) > 0 ? 'DNF' : '—'}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
      {tipNode}
    </figure>
  );
}
