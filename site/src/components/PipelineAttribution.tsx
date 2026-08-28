import { useMemo, useState } from 'react';

import { useBenchmarkData } from '../data-context';
import { ENTRIES, entryColor, fmtMs, shortLabel } from '../data';
import { localizedWorkload, useI18n } from '../i18n';

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
  const [expandedEntry, setExpandedEntry] = useState<string | null>(null);
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
  const attemptedCells = coverage.expectedCellCount - (coverage.summary.unscheduled ?? 0);
  const measuredCells = (coverage.summary.measured ?? 0)
    + (coverage.summary['measured-with-dnf'] ?? 0);

  return (
    <section className="card pipeline-attribution" aria-labelledby="pipeline-attribution-title">
      <div className="pipeline-heading">
        <div className="pipeline-intro">
          <h3 className="card-title" id="pipeline-attribution-title">{text('Where the time goes', '时间花在哪')}</h3>
          <p>{text(
            'Total separates synchronous ElementPAPI from the rest. The color strip breaks that synchronous work into six calls.',
            '总耗时分为同步 ElementPAPI 和其余工作；彩条再拆解同步部分的 6 类调用。',
          )}</p>
        </div>
        <div className="pipeline-coverage" aria-label={text('Pipeline matrix coverage', '流水线矩阵覆盖')}>
          <strong>{measuredCells}/{coverage.expectedCellCount}</strong>
          <span>{text('measured', '已测')}</span>
          {attemptedCells !== measuredCells ? <small>{attemptedCells} {text('attempted', '已尝试')}</small> : null}
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
              aria-label={`${localizedWorkload(cell.workload, locale)} @${scaleLabel(cell.scale)} · ${ready}/${coverage.entryIds.length}`}
              onClick={() => {
                setRequestedCell(key);
                setExpandedEntry(null);
              }}
            >
              <span>{localizedWorkload(cell.workload, locale)}</span>
              <b>@{scaleLabel(cell.scale)}</b>
              {ready !== coverage.entryIds.length ? <small>{ready}/{coverage.entryIds.length}</small> : null}
            </button>
          );
        })}
      </div>

      <div className="pipeline-column-guide" aria-hidden="true">
        <span>{text('framework', '框架')}</span>
        <span>{text('total', '总耗时')}</span>
        <span>{text('PAPI time', 'PAPI 耗时')}</span>
        <span>{text('rest', '其余')}</span>
        <span>{text('PAPI breakdown', 'PAPI 分段')}</span>
        <span />
      </div>

      <div className="pipeline-rows">
        {rows.map((row) => {
          if (row.measured == null) {
            return (
              <div className="pipeline-row is-unmeasured" key={row.entry.id}>
                <div className="pipeline-row-summary">
                  <span className="pipeline-entry">
                    <span className="pipeline-entry-mark" style={{ background: entryColor(row.entry.id, theme) }} />
                    <b>{shortLabel(row.entry.id)}</b>
                  </span>
                  <span className="pipeline-status">{row.coverageCell?.status ?? text('missing', '缺失')}</span>
                  <span>{row.coverageCell?.reason ?? text('No accepted observation', '没有通过验收的观察')}</span>
                </div>
              </div>
            );
          }
          const { measured } = row;
          const methodCalls = Object.entries(measured.control?.callMultiset ?? {});
          const expanded = expandedEntry === row.entry.id;
          const detailId = `pipeline-detail-${row.entry.id.replace(/[^a-z0-9_-]/gi, '-')}`;
          return (
            <article className={`pipeline-row${expanded ? ' is-expanded' : ''}`} key={row.entry.id}>
              <div className="pipeline-row-summary">
                <span className="pipeline-entry">
                  <span className="pipeline-entry-mark" style={{ background: entryColor(row.entry.id, theme) }} />
                  <b>{shortLabel(row.entry.id)}</b>
                </span>
                <strong className="pipeline-total" data-label={text('Total', '总耗时')}>{fmtMs(measured.operationMs)}</strong>
                <span className="pipeline-host" data-label={text('PAPI time', 'PAPI 耗时')}>
                  <strong>{fmtMs(measured.papiMs)}</strong>
                  <small>{fmtShare(measured.papiShare)}</small>
                </span>
                <span className="pipeline-rest" data-label={text('Rest', '其余')}>{fmtMs(measured.outside)}</span>
                <div className="pipeline-composition" aria-label={text('Normalized PAPI call breakdown', '归一化 PAPI 调用分段')}>
                  {measured.papiMs > 0 ? measured.segments.map((segment) => segment.time > 0 ? (
                    <span
                      key={segment.name}
                      className={`pipeline-segment is-${segment.name}`}
                      style={{ width: `${(segment.time / measured.papiMs) * 100}%` }}
                    />
                  ) : null) : <span className="pipeline-zero">0</span>}
                </div>
                <button
                  type="button"
                  className="pipeline-detail-toggle"
                  aria-expanded={expanded}
                  aria-controls={detailId}
                  aria-label={text(`View ${shortLabel(row.entry.id)} call breakdown`, `查看 ${shortLabel(row.entry.id)} 调用分段`)}
                  onClick={() => setExpandedEntry(expanded ? null : row.entry.id)}
                >
                  <span>{text('Details', '看分段')}</span>
                  <i aria-hidden="true">›</i>
                </button>
              </div>

              {expanded ? (
                <div className="pipeline-row-detail" id={detailId}>
                  <div className="pipeline-segment-ledger" aria-label={text('Segment time and calls', '分段时间与调用数')}>
                    {measured.segments.map((segment) => (
                      <span key={segment.name}>
                        <i className={`is-${segment.name}`} />
                        <b>{segment.name}</b>
                        <strong>{fmtSegmentTime(segment.time)}</strong>
                        <small>{segment.calls} {text('calls', '次')}</small>
                      </span>
                    ))}
                  </div>
                  <div className="pipeline-control">
                    <span>{text('Sample', '样本')} n={measured.reps}{measured.dnfCount ? ` · DNF ${measured.dnfCount}` : ''}</span>
                    <span>{text('Committed rows', '提交行')} {measured.control?.requestedRows ?? '—'} → {measured.control?.committedRows ?? '—'}</span>
                    <span>{methodCalls.length} {text('method kinds', '种方法')}</span>
                    {methodCalls.map(([name, calls]) => <code key={name}>{name} × {calls}</code>)}
                  </div>
                </div>
              ) : null}
            </article>
          );
        })}
      </div>

      <div className="legend pipeline-legend">
        {SEGMENTS.map(([name]) => <span className="item" key={name}><span className={`swatch is-${name}`} />{name}</span>)}
      </div>

      <details className="pipeline-methodology">
        <summary>{text('How this is measured', '测量口径')}</summary>
        <p>{text(
          'Each framework uses one real sample nearest its operation median. Total spans pointerdown→predicate; synchronous host is ElementPAPI self time within that same sample. The rest includes framework scheduling and asynchronous browser work. Flush covers synchronous web-core host work, not full layout or paint.',
          '每个框架都取最接近操作中位数的同一份真实样本。总耗时覆盖 pointerdown→predicate；同步 Host 是该样本内的 ElementPAPI self time；其余时间包含框架调度和浏览器异步工作。Flush 只含同步 web-core host 工作，不代表完整布局或绘制。',
        )}</p>
      </details>
    </section>
  );
}
