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
        toBtsBytesPerTick: value('wireToBtsBytesPerTick'),
        toMtsBytesPerTick: value('wireToMtsBytesPerTick'),
        declaredInterval: detail?.tickIntervalMs ?? null,
        maxActualInterval: intervals.length ? Math.max(...intervals) : null,
      }];
    }),
  }));
  if (policyRows.every((policy) => policy.rows.length === 0)) return null;

  return (
    <section className="card storm-coalescing" id="lab-storm" aria-labelledby="storm-coalescing-title">
      <CardCaption title={<span id="storm-coalescing-title">{text('Storm commit semantics', 'Storm 提交语义')}</span>}>
        {text(
          'Committed frames / issued ticks from one median-nearest sample. Coalescing is neutral; only DNF is an error.',
          '同一个中位数近邻样本中的提交帧 / 已发 tick。合并是中性观测；只有 DNF 是错误。',
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
                ? text('observes whether each tick becomes a frame', '观察每个 tick 是否形成一帧')
                : text('observes the terminal state; coalescing expected', '观察终态；预期允许合并')}</span>
            </header>
            <div className="storm-table-wrap">
              <table className="storm-table">
                <thead><tr>
                  <th>{text('Entry', '条目')}</th>
                  <th>{text('Observation', '观测')}</th>
                  <th>{text('Latency', '延迟')}</th>
                  <th>MTS→BTS / tick</th>
                  <th>BTS→MTS / tick</th>
                  <th>{text('Input cadence', '输入节奏')}</th>
                </tr></thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.entry.id} data-outcome={row.dnf ? 'dnf' : 'observed'}>
                      <th><i style={{ background: entryColor(row.entry.id, theme) }} />{shortLabel(row.entry.id)}</th>
                      {row.dnf ? (
                        <td colSpan={5}><strong>DNF</strong> · {row.failure}</td>
                      ) : (
                        <>
                          <td><strong>{row.frames == null || row.ticks == null
                            ? text('observed', '已观测')
                            : row.frames < row.ticks
                              ? text(`coalesced to ${row.frames}/${row.ticks} frames`, `合并后 ${row.frames}/${row.ticks} 帧`)
                              : text(`${row.frames}/${row.ticks} frames observed`, `观测到 ${row.frames}/${row.ticks} 帧`)}</strong>{' '}
                            <small>{row.ratio == null ? '—' : `${(row.ratio * 100).toFixed(0)}%`}</small></td>
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
