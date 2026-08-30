import { useMemo, useState } from 'react';

import { useBenchmarkData } from '../data-context';
import { ENTRIES, entryColor, fmtBytes, fmtMs, shortLabel } from '../data';
import { localizedWorkload, useI18n } from '../i18n';
import { CardCaption } from './ResponsiveCopy';

const POLICIES = ['every-tick', 'final-state'] as const;
const scaleLabel = (scale: number) => scale >= 1000 ? `${scale / 1000}k` : String(scale);
type Entry = (typeof ENTRIES)[number];
type StormRow =
  | { entry: Entry; dnf: true; failure: string }
  | {
    entry: Entry;
    dnf: false;
    operationMs: number;
    ticks: number | null;
    frames: number | null;
    ratio: number | null;
    pass: boolean;
    toBtsBytesPerTick: number | null;
    toMtsBytesPerTick: number | null;
    declaredInterval: number | null;
    maxActualInterval: number | null;
  };

export function StormCoalescing({
  theme,
  selected,
}: {
  theme: 'light' | 'dark';
  selected: Set<string>;
}) {
  const { locale, text } = useI18n();
  const { one, records } = useBenchmarkData();
  const cells = useMemo(() => {
    const unique = new Map<string, { workload: string; scale: number }>();
    for (const record of records) {
      if (
        record.suite !== 'storm'
        || record.metric !== 'operationTime'
        || !selected.has(record.entry)
      ) continue;
      unique.set(`${record.workload}@${record.scale}`, {
        workload: record.workload,
        scale: record.scale,
      });
    }
    return [...unique.values()].sort((left, right) =>
      left.workload.localeCompare(right.workload) || left.scale - right.scale);
  }, [records, selected]);
  const [requestedCell, setRequestedCell] = useState<string | null>(null);
  const active = cells.find((cell) => `${cell.workload}@${cell.scale}` === requestedCell)
    ?? cells[0];
  if (!active) return null;

  const policyRows = POLICIES.map((commitPolicy) => ({
    commitPolicy,
    rows: ENTRIES.filter((entry) => selected.has(entry.id)).flatMap<StormRow>((entry) => {
      const filter = {
        suite: 'storm',
        harness: 'web',
        entry: entry.id,
        workload: active.workload,
        scale: active.scale,
        commitPolicy,
      } as const;
      const operation = one({ ...filter, metric: 'operationTime' });
      if (!operation) return [];
      if (!operation.samples?.length || operation.median == null) {
        return [{ entry, dnf: true as const, failure: operation.failures?.[0]?.category ?? 'DNF' }];
      }
      let sampleIndex = 0;
      for (let index = 1; index < operation.samples.length; index++) {
        if (Math.abs(operation.samples[index] - operation.median)
          < Math.abs(operation.samples[sampleIndex] - operation.median)) sampleIndex = index;
      }
      const value = (metric: string) => one({ ...filter, metric })?.samples?.[sampleIndex] ?? null;
      const detail = operation.detailSamples?.[sampleIndex] ?? operation.detail;
      const offsets = detail?.actualIssueOffsetsMs ?? [];
      const intervals = offsets.slice(1).map((offset, index) => offset - offsets[index]);
      return [{
        entry,
        dnf: false as const,
        operationMs: operation.samples[sampleIndex],
        ticks: value('ticksIssued'),
        frames: value('committedFrames'),
        ratio: value('coalescingRatio'),
        pass: value('contractPass') === 1,
        toBtsBytesPerTick: value('wireToBtsBytesPerTick'),
        toMtsBytesPerTick: value('wireToMtsBytesPerTick'),
        declaredInterval: detail?.tickIntervalMs ?? null,
        maxActualInterval: intervals.length ? Math.max(...intervals) : null,
      }];
    }),
  }));
  if (policyRows.every((policy) => policy.rows.length === 0)) return null;

  return (
    <section className="card storm-coalescing" aria-labelledby="storm-coalescing-title">
      <CardCaption title={<span id="storm-coalescing-title">{text('Storm commit semantics', 'Storm 提交语义')}</span>}>
        {text(
          'A separate shared-driver suite. Each row is one real sample nearest that entry’s latency median: observable committed frames / issued pointer ticks, with wire bytes divided only during collection. A failed every-tick contract is retained evidence, not DNF.',
          '独立的共享 driver suite。每行采用最接近该条目 latency 中位数的同一个真实样本：可观察提交帧 / 已发 pointer tick；wire bytes 仅在 collect 阶段做除法。every-tick contract 失败会保留为证据，不记作 DNF。',
        )}
      </CardCaption>
      <div className="chips storm-cell-rail" aria-label={text('Storm workload', 'Storm workload')}>
        {cells.map((cell) => {
          const key = `${cell.workload}@${cell.scale}`;
          return (
            <button
              type="button"
              className="chip"
              key={key}
              aria-pressed={cell === active}
              onClick={() => setRequestedCell(key)}
            >
              {localizedWorkload(cell.workload, locale)} @{scaleLabel(cell.scale)}
            </button>
          );
        })}
      </div>
      <div className="storm-policy-grid">
        {policyRows.map(({ commitPolicy, rows }) => (
          <section className="storm-policy" key={commitPolicy}>
            <header>
              <b>{commitPolicy}</b>
              <span>{commitPolicy === 'every-tick'
                ? text('one observable frame per tick', '每 tick 一个可观察帧')
                : text('terminal state only; coalescing allowed', '只要求终态；允许合并')}</span>
            </header>
            <div className="storm-table-wrap">
              <table className="storm-table">
                <thead><tr>
                  <th>{text('Entry', '条目')}</th>
                  <th>{text('Outcome', '结果')}</th>
                  <th>{text('Frames / ticks', '帧 / tick')}</th>
                  <th>{text('Latency', '延迟')}</th>
                  <th>MTS→BTS / tick</th>
                  <th>BTS→MTS / tick</th>
                  <th>{text('Input cadence', '输入节奏')}</th>
                </tr></thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.entry.id} data-outcome={row.dnf ? 'dnf' : row.pass ? 'pass' : 'fail'}>
                      <th><i style={{ background: entryColor(row.entry.id, theme) }} />{shortLabel(row.entry.id)}</th>
                      {row.dnf ? (
                        <td colSpan={6}><strong>DNF</strong> · {row.failure}</td>
                      ) : (
                        <>
                          <td><strong>{row.pass ? text('pass', '通过') : text('contract fail', 'contract 失败')}</strong></td>
                          <td>{row.frames}/{row.ticks} <small>{row.ratio == null ? '—' : `${(row.ratio * 100).toFixed(0)}%`}</small></td>
                          <td>{fmtMs(row.operationMs)}</td>
                          <td>{fmtBytes(row.toBtsBytesPerTick)}</td>
                          <td>{fmtBytes(row.toMtsBytesPerTick)}</td>
                          <td>{row.declaredInterval ?? '—'}ms → max {row.maxActualInterval?.toFixed(1) ?? '—'}ms</td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))}
      </div>
    </section>
  );
}
