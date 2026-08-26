import { useMemo, useState } from 'react';

import { useBenchmarkData } from '../data-context';
import { ENTRIES, entryColor, fmtMs, shortLabel } from '../data';
import { localizedWorkload, useI18n } from '../i18n';
import { CardCaption } from './ResponsiveCopy';

const SEGMENTS = [
  ['create', 'papiCreateTime', 'papiCreateCalls'],
  ['props', 'papiPropsTime', 'papiPropsCalls'],
  ['events', 'papiEventsTime', 'papiEventsCalls'],
  ['topology', 'papiTopologyTime', 'papiTopologyCalls'],
  ['read', 'papiReadTime', 'papiReadCalls'],
  ['flush', 'papiFlushTime', 'papiFlushCalls'],
] as const;

const scaleLabel = (scale: number) => scale >= 1000 ? `${scale / 1000}k` : String(scale);

export function PipelineAttribution({
  theme,
  selected,
}: {
  theme: 'light' | 'dark';
  selected: Set<string>;
}) {
  const { locale, text } = useI18n();
  const { one, records } = useBenchmarkData();
  const cells = useMemo(() => {
    const keys = new Map<string, { workload: string; scale: number }>();
    for (const record of records) {
      if (
        record.suite !== 'pipeline'
        || record.harness !== 'web'
        || record.metric !== 'operationTime'
        || !selected.has(record.entry)
        || !Array.isArray(record.samples)
        || record.samples.length === 0
      ) continue;
      keys.set(`${record.workload}@${record.scale}`, {
        workload: record.workload,
        scale: record.scale,
      });
    }
    return [...keys.values()].sort((left, right) =>
      left.workload.localeCompare(right.workload) || left.scale - right.scale);
  }, [records, selected]);
  const [requestedCell, setRequestedCell] = useState<string | null>(null);
  const active = cells.find((cell) => `${cell.workload}@${cell.scale}` === requestedCell)
    ?? cells[0];
  if (!active) return null;

  const rows = ENTRIES.filter((entry) => selected.has(entry.id)).flatMap((entry) => {
    const operation = one({
      suite: 'pipeline', harness: 'web', entry: entry.id,
      workload: active.workload, scale: active.scale, metric: 'operationTime',
    });
    if (!operation?.samples?.length || operation.median == null) return [];
    let sampleIndex = 0;
    for (let index = 1; index < operation.samples.length; index++) {
      if (Math.abs(operation.samples[index] - operation.median)
        < Math.abs(operation.samples[sampleIndex] - operation.median)) sampleIndex = index;
    }
    const operationMs = operation.samples[sampleIndex];
    const segmentValues = SEGMENTS.map(([name, timeMetric, callsMetric]) => ({
      name,
      time: one({
        suite: 'pipeline', harness: 'web', entry: entry.id,
        workload: active.workload, scale: active.scale, metric: timeMetric,
      })?.samples?.[sampleIndex] ?? null,
      calls: one({
        suite: 'pipeline', harness: 'web', entry: entry.id,
        workload: active.workload, scale: active.scale, metric: callsMetric,
      })?.samples?.[sampleIndex] ?? null,
    }));
    const outside = one({
      suite: 'pipeline', harness: 'web', entry: entry.id,
      workload: active.workload, scale: active.scale, metric: 'outsidePapiTime',
    })?.samples?.[sampleIndex] ?? null;
    const control = operation.detailSamples?.[sampleIndex] ?? operation.detail;
    if (outside == null || segmentValues.some((segment) => segment.time == null)) return [];
    return [{ entry, operationMs, outside, segments: segmentValues, control }];
  }).sort((left, right) => left.operationMs - right.operationMs);
  if (!rows.length) return null;
  const maxOperation = Math.max(...rows.map((row) => row.operationMs));

  return (
    <section className="card pipeline-attribution" aria-labelledby="pipeline-attribution-title">
      <CardCaption title={<span id="pipeline-attribution-title">{text('Element pipeline attribution', '元素流水线归因')}</span>}>
        {text(
          'A separate instrumented run: the bar uses one real sample nearest that entry’s operation median, so its synchronous PAPI segments and outside-PAPI residual add back to the same pointerdown→predicate observation. Flush is synchronous host work, not full browser layout/paint.',
          '独立的插桩运行：每条 bar 使用最接近该条目操作中位数的同一个真实样本，因此同步 PAPI 分段与 PAPI 外残差可还原同一次 pointerdown→predicate 观察。Flush 表示同步 host 工作，不等于完整浏览器布局/绘制。',
        )}
      </CardCaption>
      <div className="chips pipeline-cell-rail" aria-label={text('Pipeline workload', '流水线 workload')}>
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
      <div className="pipeline-rows">
        {rows.map((row) => (
          <div className="pipeline-row" key={row.entry.id}>
            <div className="pipeline-row-head">
              <span className="pipeline-entry-mark" style={{ background: entryColor(row.entry.id, theme) }} />
              <b>{shortLabel(row.entry.id)}</b>
              <span>{fmtMs(row.operationMs)}</span>
              <span>{text(
                `${row.control?.committedRows ?? '?'} rows committed`,
                `提交 ${row.control?.committedRows ?? '?'} 行`,
              )}</span>
            </div>
            <div className="pipeline-track" aria-label={`${shortLabel(row.entry.id)} ${fmtMs(row.operationMs)}`}>
              <div className="pipeline-stack" style={{ width: `${(row.operationMs / maxOperation) * 100}%` }}>
                {row.segments.map((segment) => segment.time != null && segment.time > 0 ? (
                  <span
                    key={segment.name}
                    className={`pipeline-segment is-${segment.name}`}
                    style={{ width: `${(segment.time / row.operationMs) * 100}%` }}
                    title={`${segment.name}: ${fmtMs(segment.time)} · ${segment.calls ?? 0} calls`}
                  />
                ) : null)}
                <span
                  className="pipeline-segment is-outside"
                  style={{ width: `${(row.outside / row.operationMs) * 100}%` }}
                  title={`${text('outside synchronous PAPI', '同步 PAPI 外')}: ${fmtMs(row.outside)}`}
                />
              </div>
            </div>
            <div className="pipeline-call-grid">
              {row.segments.map((segment) => (
                <span key={segment.name}><i className={`is-${segment.name}`} />{segment.name} <b>{segment.calls ?? 0}</b></span>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="legend pipeline-legend">
        {SEGMENTS.map(([name]) => <span className="item" key={name}><span className={`swatch is-${name}`} />{name}</span>)}
        <span className="item"><span className="swatch is-outside" />{text('outside synchronous PAPI', '同步 PAPI 外')}</span>
      </div>
    </section>
  );
}
