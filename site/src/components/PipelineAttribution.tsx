import { useMemo, useState } from 'react';

import { useBenchmarkData } from '../data-context';
import { ENTRIES, entryColor, fmtMs, shortLabel } from '../data';
import { localizedWorkload, useI18n } from '../i18n';

export const PIPELINE_SEGMENTS = [
  {
    name: 'create', timeMetric: 'papiCreateTime', callsMetric: 'papiCreateCalls', role: 'strategy',
    label: ['Element creates', '建节点'],
  },
  {
    name: 'props', timeMetric: 'papiPropsTime', callsMetric: 'papiPropsCalls', role: 'strategy',
    label: ['Attribute writes', '写属性'],
  },
  {
    name: 'events', timeMetric: 'papiEventsTime', callsMetric: 'papiEventsCalls', role: 'obligation',
    label: ['Listener attach', '挂监听'],
  },
  {
    name: 'topology', timeMetric: 'papiTopologyTime', callsMetric: 'papiTopologyCalls', role: 'obligation',
    label: ['Tree attach', '接树'],
  },
  {
    name: 'read', timeMetric: 'papiReadTime', callsMetric: 'papiReadCalls', role: 'obligation',
    label: ['State reads', '读状态'],
  },
  {
    name: 'flush', timeMetric: 'papiFlushTime', callsMetric: 'papiFlushCalls', role: 'obligation',
    label: ['Synchronous commit', '同步提交'],
  },
] as const;

export const PIPELINE_SHAPES: Record<string, {
  elements: number;
  listeners: number;
  text: [string, string];
}> = {
  octane: {
    elements: 7, listeners: 2,
    text: ['text: raw-text child elements', '文本：raw-text 子元素'],
  },
  'octane-hux': {
    elements: 7, listeners: 2,
    text: ['text: raw-text child elements', '文本：raw-text 子元素'],
  },
  react: {
    elements: 6, listeners: 2,
    text: ['text: static attribute; dynamic child', '文本：静态走属性，动态走子元素'],
  },
  'vue-vapor': {
    elements: 4, listeners: 2,
    text: ['text: carried by the text element', '文本：由 text 元素自身承载'],
  },
  'vue-vapor-ifr': {
    elements: 4, listeners: 2,
    text: ['text: carried by the text element', '文本：由 text 元素自身承载'],
  },
  'vue-vdom': {
    elements: 4, listeners: 2,
    text: ['text: carried by the text element', '文本：由 text 元素自身承载'],
  },
  'vue-vdom-ifr-et': {
    elements: 4, listeners: 2,
    text: ['text: carried by the text element', '文本：由 text 元素自身承载'],
  },
};

type ScaleMode = 'operation' | 'row';

const scaleLabel = (scale: number) => scale >= 1000 ? `${scale / 1000}k` : String(scale);
const cellKey = (workload: string, scale: number) => `${workload}@${scale}`;
const fmtShare = (share: number) => `${share < 0.1 ? share.toFixed(2) : share.toFixed(1)}%`;
const fmtSegmentTime = (value: number) => {
  if (value === 0) return '0ms';
  if (value < 0.01) return `${(value * 1000).toFixed(value < 0.001 ? 2 : 1)}µs`;
  if (value < 1) return `${value.toFixed(3)}ms`;
  return fmtMs(value);
};
export const formatPipelineCount = (value: number) => {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}m`;
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  if (value >= 10) return value.toFixed(0);
  if (value >= 1) return value.toFixed(1).replace(/\.0$/, '');
  return value.toFixed(value < 0.01 ? 3 : 2);
};
const fmtUnitCost = (timeMs: number, calls: number) => {
  if (calls === 0) return '—';
  const micros = (timeMs * 1000) / calls;
  if (micros >= 1000) return `${(micros / 1000).toFixed(2)}ms`;
  if (micros >= 10) return `${micros.toFixed(1)}µs`;
  if (micros >= 1) return `${micros.toFixed(2)}µs`;
  return `${micros.toFixed(3)}µs`;
};
const fmtRowTime = (timeMs: number, rows: number) => {
  const micros = (timeMs * 1000) / rows;
  if (micros >= 1000) return `${(micros / 1000).toFixed(2)}ms/row`;
  if (micros >= 10) return `${micros.toFixed(1)}µs/row`;
  if (micros >= 1) return `${micros.toFixed(2)}µs/row`;
  return `${micros.toFixed(3)}µs/row`;
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
  const [expandedEntries, setExpandedEntries] = useState<Set<string>>(() => new Set());
  const [scaleMode, setScaleMode] = useState<ScaleMode>('operation');
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
    const segments = PIPELINE_SEGMENTS.map((segment) => ({
      ...segment,
      time: one({
        suite: 'pipeline', harness: 'web', entry: entry.id,
        workload: active.workload, scale: active.scale, metric: segment.timeMetric,
      })?.samples?.[sampleIndex] ?? 0,
      calls: one({
        suite: 'pipeline', harness: 'web', entry: entry.id,
        workload: active.workload, scale: active.scale, metric: segment.callsMetric,
      })?.samples?.[sampleIndex] ?? 0,
    }));
    const frameworkMs = one({
      suite: 'pipeline', harness: 'web', entry: entry.id,
      workload: active.workload, scale: active.scale, metric: 'outsidePapiTime',
    })?.samples?.[sampleIndex] ?? null;
    const control = operation.detailSamples?.[sampleIndex] ?? operation.detail;
    if (frameworkMs == null) return { entry, coverageCell, measured: null };
    const engineMs = segments.reduce((sum, segment) => sum + segment.time, 0);
    return {
      entry,
      coverageCell,
      measured: {
        operationMs,
        frameworkMs,
        engineMs,
        engineShare: operationMs === 0 ? 0 : (engineMs / operationMs) * 100,
        segments,
        control,
        reps: operation.n,
        dnfCount: operation.dnfCount,
      },
    };
  }).sort((left, right) => {
    if (left.measured == null) return 1;
    if (right.measured == null) return -1;
    return left.measured.frameworkMs - right.measured.frameworkMs;
  });
  const attemptedCells = coverage.expectedCellCount - (coverage.summary.unscheduled ?? 0);
  const measuredCells = (coverage.summary.measured ?? 0)
    + (coverage.summary['measured-with-dnf'] ?? 0);

  return (
    <section className="card pipeline-attribution" aria-labelledby="pipeline-attribution-title">
      <div className="pipeline-heading">
        <div className="pipeline-intro">
          <h3 className="card-title" id="pipeline-attribution-title">{text('Where the operation time goes', '一次操作的时间花在哪')}</h3>
          <p>{text(
            'Compare the framework side first. Open the engine bill to see calls × cost per call.',
            '先比框架侧时间；点开引擎账单，看调用次数 × 每次成本。',
          )}</p>
          <p className="pipeline-boundary-note">{text(
            'Web host only—not Native. Framework side is the remaining interval, not pure JS CPU time.',
            '仅 Web Host，不代表 Native；框架侧是剩余区间，不等于纯 JS CPU 时间。',
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
                setExpandedEntries(new Set());
              }}
            >
              <span>{localizedWorkload(cell.workload, locale)}</span>
              <b>@{scaleLabel(cell.scale)}</b>
              {ready !== coverage.entryIds.length ? <small>{ready}/{coverage.entryIds.length}</small> : null}
            </button>
          );
        })}
      </div>

      <div className="pipeline-reading-key">
        <div className="pipeline-owner-key" aria-label={text('Time ownership legend', '时间归属图例')}>
          <span className="is-framework">{text('Framework side', '框架侧')}</span>
          <span className="is-engine">{text('Web-host engine bill', 'Web Host 引擎账单')}</span>
        </div>
        <p className="pipeline-bill-guide">{text(
          'Bill chart: width = calls · height = cost/call · area = total time. Compare element creates and attribute writes with the row shape.',
          '账单图：宽 = 调用数 · 高 = 每次成本 · 面积 = 总耗时；建节点与写属性请结合每行结构比较。',
        )}</p>
        <div className="pipeline-scale-mode" role="group" aria-label={text('Normalization', '归一方式')}>
          <button type="button" aria-pressed={scaleMode === 'operation'} onClick={() => setScaleMode('operation')}>
            {text('Whole operation', '整次操作')}
          </button>
          <button type="button" aria-pressed={scaleMode === 'row'} onClick={() => setScaleMode('row')}>
            {text('Per row', '每行')}
          </button>
        </div>
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
          const shape = PIPELINE_SHAPES[row.entry.id];
          const methodCalls = Object.entries(measured.control?.callMultiset ?? {});
          const expanded = expandedEntries.has(row.entry.id);
          const detailId = `pipeline-detail-${row.entry.id.replace(/[^a-z0-9_-]/gi, '-')}`;
          const rowCount = Math.max(1, Number(measured.control?.requestedRows ?? active.scale ?? 1));
          const ownerTime = (value: number) => scaleMode === 'row'
            ? fmtRowTime(value, rowCount)
            : fmtMs(value);
          const engineShare = measured.engineShare;
          const frameworkShare = Math.max(0, 100 - engineShare);
          const activeSegments = measured.segments.filter((segment) => segment.calls > 0 || segment.time > 0);
          const maxUnitCost = Math.max(0, ...activeSegments.map((segment) =>
            segment.calls === 0 ? 0 : (segment.time * 1000) / segment.calls));
          return (
            <article className={`pipeline-row${expanded ? ' is-expanded' : ''}`} key={row.entry.id}>
              <div className="pipeline-row-summary">
                <span className="pipeline-entry">
                  <span className="pipeline-entry-name">
                    <span className="pipeline-entry-mark" style={{ background: entryColor(row.entry.id, theme) }} />
                    <b>{shortLabel(row.entry.id)}</b>
                  </span>
                  {shape ? (
                    <small>
                      {shape.elements} {text('elements/row', '元素/行')} · {text(...shape.text)} · {shape.listeners} {text('listeners/row', '监听/行')}
                    </small>
                  ) : null}
                </span>
                <div className="pipeline-owner-ledger">
                  <div className="pipeline-owner-values">
                    <span className="is-framework">
                      <small>{text('Framework side', '框架侧')}</small>
                      <strong>{ownerTime(measured.frameworkMs)}</strong>
                    </span>
                    <span className="is-engine">
                      <small>{text('Web-host engine', 'Web Host 引擎')}</small>
                      <strong>{ownerTime(measured.engineMs)}</strong>
                    </span>
                    <span className="pipeline-operation-total">{text('total', '总计')} {ownerTime(measured.operationMs)}</span>
                  </div>
                  <div
                    className="pipeline-owner-bar"
                    role="img"
                    aria-label={text(
                      `${shortLabel(row.entry.id)}: framework side ${ownerTime(measured.frameworkMs)}, web-host engine bill ${ownerTime(measured.engineMs)}`,
                      `${shortLabel(row.entry.id)}：框架侧 ${ownerTime(measured.frameworkMs)}，Web Host 引擎账单 ${ownerTime(measured.engineMs)}`,
                    )}
                  >
                    <span className="is-framework" style={{ width: `${frameworkShare}%` }} />
                    <span className="is-engine" style={{ width: `${engineShare}%` }} />
                  </div>
                </div>
                <button
                  type="button"
                  className="pipeline-detail-toggle"
                  aria-expanded={expanded}
                  aria-controls={detailId}
                  aria-label={text(`Toggle ${shortLabel(row.entry.id)} engine bill`, `展开或关闭 ${shortLabel(row.entry.id)} 引擎账单`)}
                  onClick={() => setExpandedEntries((current) => {
                    const next = new Set(current);
                    if (next.has(row.entry.id)) next.delete(row.entry.id);
                    else next.add(row.entry.id);
                    return next;
                  })}
                >
                  <span>{text('Engine bill', '引擎账单')}</span>
                  <i aria-hidden="true">›</i>
                </button>
              </div>

              {expanded ? (
                <div className="pipeline-row-detail" id={detailId}>
                  <div className="pipeline-mekko" aria-label={text('Call count by unit cost chart', '调用数与单次成本图')}>
                    {activeSegments.map((segment) => {
                      const unitCost = segment.calls === 0 ? 0 : (segment.time * 1000) / segment.calls;
                      return (
                        <span
                          className="pipeline-mekko-column"
                          key={segment.name}
                          style={{ flexGrow: Math.max(segment.calls, 0.001) }}
                          title={`${text(segment.label[0], segment.label[1])} · ${fmtSegmentTime(segment.time)} · ${formatPipelineCount(segment.calls)} · ${fmtUnitCost(segment.time, segment.calls)}/call`}
                        >
                          <span
                            className={`pipeline-segment is-${segment.name}`}
                            style={{ height: `${maxUnitCost === 0 ? 0 : (unitCost / maxUnitCost) * 100}%` }}
                          />
                        </span>
                      );
                    })}
                  </div>
                  <div className="pipeline-segment-ledger" aria-label={text('Segment time, calls, and unit cost', '分段时间、调用数和单次成本')}>
                    {measured.segments.map((segment) => (
                      <span key={segment.name}>
                        <span className="pipeline-segment-name">
                          <i className={`is-${segment.name}`} />
                          <b>{text(segment.label[0], segment.label[1])}</b>
                          <em className={`is-${segment.role}`}>{text(
                            segment.role === 'strategy' ? 'shape-sensitive' : 'required step',
                            segment.role === 'strategy' ? '受行结构影响' : '固定步骤',
                          )}</em>
                        </span>
                        <span className="pipeline-segment-values">
                          <strong>{scaleMode === 'row' ? fmtRowTime(segment.time, rowCount) : fmtSegmentTime(segment.time)}</strong>
                          <span>{formatPipelineCount(scaleMode === 'row' ? segment.calls / rowCount : segment.calls)} {text(scaleMode === 'row' ? 'calls/row' : 'calls', scaleMode === 'row' ? '次/行' : '次调用')}</span>
                          <span>{fmtUnitCost(segment.time, segment.calls)}/{text('call', '次')}</span>
                        </span>
                      </span>
                    ))}
                  </div>
                  <details className="pipeline-control">
                    <summary>
                      {text('Audit sample', '审计样本')} n={measured.reps}{measured.dnfCount ? ` · DNF ${measured.dnfCount}` : ''}
                      {' · '}{text('rows', '行')} {measured.control?.requestedRows ?? '—'} → {measured.control?.committedRows ?? '—'}
                      {' · '}{methodCalls.length} {text('methods', '种方法')}
                    </summary>
                    <div>{methodCalls.map(([name, calls]) => <code key={name}>{name} × {calls}</code>)}</div>
                  </details>
                </div>
              ) : null}
            </article>
          );
        })}
      </div>

      <details className="pipeline-methodology">
        <summary>{text('Measurement boundary and sample choice', '测量边界与样本选择')}</summary>
        <p>{text(
          'Each framework uses one real sample nearest its operation median. Total spans pointerdown→predicate. The engine bill is synchronous ElementPAPI self time in lynx-web-core; framework side is the remaining interval and can include scheduling or asynchronous browser work. Synchronous commit does not include full browser layout or paint.',
          '每个框架取最接近操作中位数的一份真实样本。总耗时覆盖 pointerdown→predicate。引擎账单是 lynx-web-core 内同步 ElementPAPI 自耗时；框架侧是剩余区间，可能含调度或浏览器异步工作。同步提交不包含完整浏览器布局或绘制。',
        )}</p>
      </details>
    </section>
  );
}
