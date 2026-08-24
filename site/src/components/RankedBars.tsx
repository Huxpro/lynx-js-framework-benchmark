// Per-suite card: operation chips, ranked bars (absolute for one op, geomean
// ×-vs-fastest for "overall"), and the exact-number table (the relief channel).
// Visual language follows octanejs.dev/benchmarks; implementation is ours.
import { type ReactNode, useEffect, useMemo, useState } from 'react';

import { useBenchmarkData } from '../data-context';
import {
  BenchRecord,
  ENTRIES,
  entryColor,
  fmtMs,
  fmtX,
  shortLabel,
} from '../data';
import { completeEntryScores } from '../derive.mjs';
import { useTooltip } from '../hooks';
import { coverageCellLabel } from './NativeCoverage';

interface OpSpec {
  key: string; // workload@scale
  label: string;
  workload: string;
  scale: number;
}

function failureSummary(record: BenchRecord | undefined): string {
  if (!record || record.dnfCount < 1) return 'not run';
  const failure = record.failures?.[0];
  if (!failure) return `${record.dnfCount} DNF`;
  const reason = failure.category ?? failure.phase ?? 'failed';
  const timeout = failure.timeoutMs ? ` after ${(failure.timeoutMs / 1000).toFixed(0)}s` : '';
  return `${record.dnfCount} DNF: ${reason}${timeout}`;
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
  scoreWeights,
  overallLabel = 'overall',
  overallCaption,
}: {
  title: string;
  description: ReactNode;
  suite: string;
  metric?: string;
  ops: OpSpec[];
  harness: string;
  theme: 'light' | 'dark';
  selected: Set<string>;
  unitFmt?: (v: number | null) => string;
  scoreWeights?: Record<string, number>;
  overallLabel?: string;
  overallCaption?: string;
}) {
  const { select, snapshot } = useBenchmarkData();
  const firstOp = ops[0]?.key ?? 'overall';
  const [op, setOp] = useState<'overall' | string>(
    harness === 'native' ? firstOp : 'overall',
  );
  const { setTip, onMove, tipNode } = useTooltip();
  const activeOp = op === 'overall' || ops.some((spec) => spec.key === op) ? op : 'overall';
  useEffect(() => {
    setOp(harness === 'native' ? firstOp : 'overall');
  }, [firstOp, harness]);
  useEffect(() => {
    if (op !== 'overall' && !ops.some((spec) => spec.key === op)) setOp('overall');
  }, [op, ops]);

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
  }, [suite, harness, metric, ops, select]);
  const coverageByCell = useMemo(() => new Map(snapshot.nativeCoverage.cells.map((cell) => [
    [cell.entry, cell.suite, cell.workload, cell.scale, cell.metric].join('|'),
    cell,
  ])), [snapshot.nativeCoverage]);
  const missingCoverage = (id: string, spec: OpSpec) => harness !== 'native'
    ? null
    : coverageByCell.get([id, suite, spec.workload, spec.scale, metric].join('|'));

  const view = useMemo(() => {
    const ids = ENTRIES.map((e) => e.id).filter((id) => selected.has(id));
    if (activeOp === 'overall') {
      // Score only entries with the complete operation matrix. This keeps every
      // geomean on the same denominator when a run contains a DNF/missing cell.
      const score = completeEntryScores(ids, ops.map((spec) => ({
        key: spec.key,
        values: Object.fromEntries(ids.map((id) => [id, byOp.get(spec.key)?.get(id)?.median])),
      })), scoreWeights == null ? undefined : ops.map((spec) => scoreWeights[spec.key]));
      const rows = score.scores
        .filter((row): row is { id: string; value: number } => row.value != null)
        .map((row) => ({ ...row, dnf: false }));
      rows.sort((a, b) => a.value - b.value);
      return {
        rows,
        missing: score.missing.map((id) => {
          const statuses = ops.map((spec) => missingCoverage(id, spec))
            .filter((cell) => cell != null);
          const firstGap = statuses.find((cell) => !['measured', 'measured-with-dnf'].includes(cell.status));
          return { id, record: undefined, coverage: firstGap };
        }),
        fmt: fmtX,
        scoreOps: score.cellCount,
        caption: overallCaption
          ?? `equal-weight geometric mean of the complete ${score.cellCount}-op matrix × vs each operation's fastest entry — 1× is the per-operation oracle, so the best aggregate can exceed 1×`,
      };
    }
    const spec = ops.find((o) => o.key === activeOp)!;
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
    const missing = rows.filter((r) => r.value == null).map((r) => ({
      id: r.id,
      record: inner.get(r.id),
      coverage: missingCoverage(r.id, spec),
    }));
    return { rows: present, missing, fmt: unitFmt, scoreOps: 1, caption: `median ${spec.label} — lower is better` };
  }, [activeOp, byOp, selected, ops, unitFmt, scoreWeights, overallCaption]);

  const scaleMax = Math.max(1e-9, ...view.rows.map((r) => r.value as number)) * 1.08;
  const refValue = activeOp === 'overall' ? 1 : null;
  if (ops.length === 0) return null;

  return (
    <figure className="card" role="group" aria-label={title} style={{ margin: '1rem 0' }} onMouseMove={onMove}>
      <figcaption>
        <div className="card-title">{title}</div>
        <div className="card-desc">{description}</div>
      </figcaption>
      <div className="chips" role="group" aria-label="Operation">
        <button className="chip" aria-pressed={activeOp === 'overall'} onClick={() => setOp('overall')}>{overallLabel}</button>
        {ops.map((o) => (
          <button key={o.key} className="chip" aria-pressed={activeOp === o.key} onClick={() => setOp(o.key)}>
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
                const rec = activeOp === 'overall' ? null : byOp.get(activeOp)?.get(r.id);
                setTip({
                  head: shortLabel(r.id),
                  lines: activeOp === 'overall'
                    ? [`${fmtX(r.value as number)} vs the per-operation fastest values (${view.scoreOps} complete ops)`]
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
        {view.missing.map(({ id, record, coverage }) => (
          <div key={id} className="bar-row" title={record?.failures?.[0]?.message}>
            <div className="bar-label">{shortLabel(id)}</div>
            <div className="bar-dnf">— {coverage
              ? coverageCellLabel(coverage)
              : activeOp === 'overall' ? 'incomplete matrix' : failureSummary(record)}</div>
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
                  const coverage = missingCoverage(e.id, o);
                  return (
                    <td key={e.id} title={r?.failures?.[0]?.message}>
                      {r?.median != null
                        ? unitFmt(r.median)
                        : coverage ? coverageCellLabel(coverage)
                          : (r?.dnfCount ?? 0) > 0 ? 'DNF' : '—'}
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
