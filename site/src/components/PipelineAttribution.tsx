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
const cellKey = (workload: string, scale: number) => `${workload}@${scale}`;
const fmtShare = (share: number) => `${share < 0.1 ? share.toFixed(2) : share.toFixed(1)}%`;
const fmtSegmentTime = (value: number) => {
  if (value === 0) return '0';
  if (value < 0.01) return `${(value * 1000).toFixed(value < 0.001 ? 2 : 1)}µs`;
  if (value < 1) return `${value.toFixed(3)}ms`;
  return fmtMs(value);
};

export function PipelineAttribution({
  theme,
  selected,
}: {
  theme: 'light' | 'dark';
  selected: Set<string>;
}) {
  const { locale, text } = useI18n();
  const { one, snapshot } = useBenchmarkData();
  const coverage = snapshot.pipelineCoverage;
  const cells = useMemo(() => {
    const unique = new Map<string, { workload: string; scale: number }>();
    for (const cell of coverage.cells) {
      unique.set(cellKey(cell.workload, cell.scale), {
        workload: cell.workload,
        scale: cell.scale,
      });
    }
    return [...unique.values()];
  }, [coverage.cells]);
  const [requestedCell, setRequestedCell] = useState<string | null>(null);
  const active = cells.find((cell) => cellKey(cell.workload, cell.scale) === requestedCell)
    ?? cells[0];
  if (!active) return null;

  const rows = ENTRIES.filter((entry) => selected.has(entry.id)).map((entry) => {
    const coverageCell = coverage.cells.find((cell) =>
      cell.entry === entry.id
      && cell.workload === active.workload
      && cell.scale === active.scale);
    const operation = one({
      suite: 'pipeline', harness: 'web', entry: entry.id,
      workload: active.workload, scale: active.scale, metric: 'operationTime',
    });
    if (!operation?.samples?.length || operation.median == null) {
      return { entry, coverageCell, measured: null };
    }
    let sampleIndex = 0;
    for (let index = 1; index < operation.samples.length; index++) {
      if (Math.abs(operation.samples[index] - operation.median)
        < Math.abs(operation.samples[sampleIndex] - operation.median)) sampleIndex = index;
    }
    const operationMs = operation.samples[sampleIndex];
    const segments = SEGMENTS.map(([name, timeMetric, callsMetric]) => ({
      name,
      time: one({
        suite: 'pipeline', harness: 'web', entry: entry.id,
        workload: active.workload, scale: active.scale, metric: timeMetric,
      })?.samples?.[sampleIndex] ?? 0,
      calls: one({
        suite: 'pipeline', harness: 'web', entry: entry.id,
        workload: active.workload, scale: active.scale, metric: callsMetric,
      })?.samples?.[sampleIndex] ?? 0,
    }));
    const outside = one({
      suite: 'pipeline', harness: 'web', entry: entry.id,
      workload: active.workload, scale: active.scale, metric: 'outsidePapiTime',
    })?.samples?.[sampleIndex] ?? null;
    const control = operation.detailSamples?.[sampleIndex] ?? operation.detail;
    if (outside == null) return { entry, coverageCell, measured: null };
    const papiMs = segments.reduce((sum, segment) => sum + segment.time, 0);
    return {
      entry,
      coverageCell,
      measured: {
        operationMs,
        outside,
        papiMs,
        papiShare: operationMs === 0 ? 0 : (papiMs / operationMs) * 100,
        segments,
        control,
        reps: operation.n,
        dnfCount: operation.dnfCount,
      },
    };
  }).sort((left, right) => {
    if (left.measured == null) return 1;
    if (right.measured == null) return -1;
    return left.measured.operationMs - right.measured.operationMs;
  });
  const maxOperation = Math.max(0, ...rows.flatMap((row) =>
    row.measured == null ? [] : [row.measured.operationMs]));
  const attemptedCells = coverage.expectedCellCount - (coverage.summary.unscheduled ?? 0);
  const measuredCells = (coverage.summary.measured ?? 0)
    + (coverage.summary['measured-with-dnf'] ?? 0);

  return (
    <section className="card pipeline-attribution" aria-labelledby="pipeline-attribution-title">
      <div className="pipeline-heading">
        <CardCaption title={<span id="pipeline-attribution-title">{text('Element pipeline attribution', '元素流水线归因')}</span>}>
          {text(
            'Each row uses the one real sample nearest that entry’s operation median. The first lane preserves pointerdown→predicate wall time; the second magnifies only synchronous ElementPAPI self time so small host segments remain legible. Flush is synchronous web-core host work, not full browser layout or paint.',
            '每行使用最接近该条目操作中位数的同一个真实样本。第一条轨道保留 pointerdown→predicate 墙钟时间；第二条只放大同步 ElementPAPI self time，让很小的 host 分段也可读。Flush 是同步 web-core host 工作，不等于完整浏览器布局或绘制。',
          )}
        </CardCaption>
        <div className="pipeline-coverage-stamp" aria-label={text('Pipeline matrix coverage', '流水线矩阵覆盖')}>
          <strong>{attemptedCells}/{coverage.expectedCellCount}</strong>
          <span>{text('cells attempted', '单元已尝试')}</span>
          <small>{coverage.entryIds.length} × 12 · {measuredCells} {text('measured', '有测量')}</small>
        </div>
      </div>

      <div className="pipeline-cell-rail" aria-label={text('Pipeline workload', '流水线 workload')}>
        {cells.map((cell) => {
          const key = cellKey(cell.workload, cell.scale);
          const statuses = coverage.cells.filter((candidate) =>
            candidate.workload === cell.workload && candidate.scale === cell.scale);
          const ready = statuses.filter((candidate) =>
            candidate.status === 'measured' || candidate.status === 'measured-with-dnf').length;
          return (
            <button
              type="button"
              className="pipeline-cell-choice"
              key={key}
              aria-pressed={key === cellKey(active.workload, active.scale)}
              onClick={() => setRequestedCell(key)}
            >
              <span>{localizedWorkload(cell.workload, locale)} <b>@{scaleLabel(cell.scale)}</b></span>
              <small>{ready}/{coverage.entryIds.length}</small>
            </button>
          );
        })}
      </div>

      <div className="pipeline-column-guide" aria-hidden="true">
        <span>{text('entry', '条目')}</span>
        <span>{text('operation', '操作')}</span>
        <span>{text('sync PAPI', '同步 PAPI')}</span>
        <span>{text('share', '占比')}</span>
        <span>{text('outside', 'PAPI 外')}</span>
        <span>{text('tree', '树')}</span>
      </div>

      <div className="pipeline-rows">
        {rows.map((row) => {
          if (row.measured == null) {
            return (
              <div className="pipeline-row is-unmeasured" key={row.entry.id}>
                <div className="pipeline-row-head">
                  <span className="pipeline-entry-mark" style={{ background: entryColor(row.entry.id, theme) }} />
                  <b>{shortLabel(row.entry.id)}</b>
                  <span className="pipeline-status">{row.coverageCell?.status ?? text('missing', '缺失')}</span>
                  <span>{row.coverageCell?.reason ?? text('No accepted observation', '没有通过验收的观察')}</span>
                </div>
              </div>
            );
          }
          const { measured } = row;
          const methodCalls = Object.entries(measured.control?.callMultiset ?? {});
          return (
            <article className="pipeline-row" key={row.entry.id}>
              <div className="pipeline-row-head">
                <span className="pipeline-entry-mark" style={{ background: entryColor(row.entry.id, theme) }} />
                <b>{shortLabel(row.entry.id)}</b>
                <strong>{fmtMs(measured.operationMs)}</strong>
                <strong>{fmtMs(measured.papiMs)}</strong>
                <strong>{fmtShare(measured.papiShare)}</strong>
                <span>{fmtMs(measured.outside)}</span>
                <span>{measured.control?.committedRows ?? '—'} {text('rows', '行')}</span>
              </div>

              <div className="pipeline-lane-group">
                <div className="pipeline-lane-label">
                  <span>{text('Wall time', '墙钟时间')}</span>
                  <small>{text('shared scale across entries', '条目间共用刻度')}</small>
                </div>
                <div className="pipeline-track" aria-label={`${shortLabel(row.entry.id)} ${fmtMs(measured.operationMs)}`}>
                  <div className="pipeline-stack" style={{ width: `${maxOperation === 0 ? 0 : (measured.operationMs / maxOperation) * 100}%` }}>
                    {measured.segments.map((segment) => segment.time > 0 ? (
                      <span
                        key={segment.name}
                        className={`pipeline-segment is-${segment.name}`}
                        style={{ width: `${(segment.time / measured.operationMs) * 100}%` }}
                      />
                    ) : null)}
                    <span
                      className="pipeline-segment is-outside"
                      style={{ width: `${(measured.outside / measured.operationMs) * 100}%` }}
                    />
                  </div>
                </div>

                <div className="pipeline-lane-label">
                  <span>{text('PAPI zoom', 'PAPI 放大')}</span>
                  <small>{fmtMs(measured.papiMs)} · 100%</small>
                </div>
                <div className="pipeline-track is-papi-zoom" aria-label={text('Normalized PAPI segment composition', '归一化 PAPI 分段构成')}>
                  {measured.papiMs > 0 ? measured.segments.map((segment) => segment.time > 0 ? (
                    <span
                      key={segment.name}
                      className={`pipeline-segment is-${segment.name}`}
                      style={{ width: `${(segment.time / measured.papiMs) * 100}%` }}
                    />
                  ) : null) : <span className="pipeline-zero">0</span>}
                </div>
              </div>

              <div className="pipeline-segment-ledger" aria-label={text('Segment time and calls', '分段时间与调用数')}>
                {measured.segments.map((segment) => (
                  <span key={segment.name}>
                    <i className={`is-${segment.name}`} />
                    <b>{segment.name}</b>
                    <strong>{fmtSegmentTime(segment.time)}</strong>
                    <small>{segment.calls} {text('calls', '次调用')}</small>
                  </span>
                ))}
              </div>

              <details className="pipeline-control">
                <summary>
                  <span>{text('Committed-tree control', '提交树控制')}</span>
                  <span>{measured.control?.requestedRows ?? '—'} → {measured.control?.committedRows ?? '—'} {text('rows', '行')}</span>
                  <span>{methodCalls.length} {text('method kinds', '种方法')} · n={measured.reps}{measured.dnfCount ? ` · DNF ${measured.dnfCount}` : ''}</span>
                </summary>
                <div>
                  {methodCalls.map(([name, calls]) => <code key={name}>{name} × {calls}</code>)}
                </div>
              </details>
            </article>
          );
        })}
      </div>

      <div className="legend pipeline-legend">
        {SEGMENTS.map(([name]) => <span className="item" key={name}><span className={`swatch is-${name}`} />{name}</span>)}
        <span className="item"><span className="swatch is-outside" />{text('outside synchronous PAPI', '同步 PAPI 外')}</span>
      </div>
    </section>
  );
}
