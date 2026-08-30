import { useMemo, useState } from 'react';

import { useBenchmarkData } from '../data-context';
import { ENTRIES, entryColor, shortLabel } from '../data';
import { useI18n } from '../i18n';
import {
  PIPELINE_SEGMENTS,
  PIPELINE_SHAPES,
  formatPipelineCount,
} from './PipelineAttribution';

type CountMode = 'mount' | 'row';

const percent = (value: number) => `${value < 0.1 ? value.toFixed(2) : value.toFixed(1)}%`;

export function NativePipelineAttribution({
  theme,
}: {
  theme: 'light' | 'dark';
}) {
  const { text } = useI18n();
  const { snapshot } = useBenchmarkData();
  const [expandedEntries, setExpandedEntries] = useState<Set<string>>(() => new Set());
  const [countMode, setCountMode] = useState<CountMode>('mount');
  const evidence = snapshot.nativePipelineAttributionRecords;
  const rows = useMemo(() => ENTRIES.flatMap((entry) => {
    const entryRecords = evidence.filter((record) =>
      record.suite === 'pipeline-native'
      && record.harness === 'native'
      && record.entry === entry.id
      && record.workload === 'mount-create');
    if (entryRecords.length === 0) return [];
    const segments = PIPELINE_SEGMENTS.map((segment) => {
      const record = entryRecords.find((candidate) => candidate.metric === segment.callsMetric);
      return {
        ...segment,
        calls: record?.samples?.[0] ?? record?.value ?? record?.median ?? 0,
      };
    });
    const controlRecord = entryRecords.find((record) => record.detailSamples?.[0]?.callMultiset)
      ?? entryRecords.find((record) => record.detail?.callMultiset)
      ?? entryRecords[0];
    const control = controlRecord.detailSamples?.[0] ?? controlRecord.detail;
    return [{
      entry,
      segments,
      control,
      totalCalls: segments.reduce((sum, segment) => sum + segment.calls, 0),
      runFile: controlRecord.runFile,
      entryCommit: controlRecord.entryCommit,
    }];
  }), [evidence]);

  if (rows.length === 0) return null;
  const evidenceEntries = new Set(evidence.map((record) => record.entry));

  return (
    <section
      className="card pipeline-attribution native-pipeline-attribution"
      aria-labelledby="native-pipeline-attribution-title"
    >
      <div className="pipeline-heading">
        <div className="pipeline-intro">
          <h3 className="card-title" id="native-pipeline-attribution-title">
            {text('What the Native mount asks PAPI to do', '一次 Native mount 调用了哪些 PAPI')}
          </h3>
          <p>{text(
            'The same six segments as Web attribution, rendered as whole-mount call composition.',
            '沿用 Web attribution 的六段口径，展示整次 mount 的调用构成。',
          )}</p>
          <p className="pipeline-boundary-note">{text(
            'Real device · Lepus main thread · 1k requested rows · counts only · never ranked.',
            '真实设备 · Lepus 主线程 · 请求 1k 行 · 仅调用计数 · 不参与排名。',
          )}</p>
        </div>
        <div className="pipeline-coverage" aria-label={text('Native attribution coverage', 'Native 归因覆盖')}>
          <strong>{rows.length}/{evidenceEntries.size}</strong>
          <span>{text('frameworks shown', '个框架已展示')}</span>
        </div>
      </div>

      <div className="pipeline-reading-key native-pipeline-reading-key">
        <div className="native-pipeline-segment-key" aria-label={text('PAPI segments', 'PAPI 分段')}>
          {PIPELINE_SEGMENTS.map((segment) => (
            <span key={segment.name}>
              <i className={`is-${segment.name}`} />
              {text(segment.label[0], segment.label[1])}
            </span>
          ))}
        </div>
        <p className="pipeline-bill-guide">{text(
          'Bar width = calls. The capture includes app-shell creation, so ÷ rows is normalization—not steady-state row cost.',
          '条宽 = 调用数；采集包含 app shell，所以“÷ 行数”只是归一，不等于稳态单行成本。',
        )}</p>
        <div className="pipeline-scale-mode" role="group" aria-label={text('Count normalization', '调用数归一方式')}>
          <button type="button" aria-pressed={countMode === 'mount'} onClick={() => setCountMode('mount')}>
            {text('Whole mount', '整次 mount')}
          </button>
          <button type="button" aria-pressed={countMode === 'row'} onClick={() => setCountMode('row')}>
            {text('÷ requested rows', '÷ 请求行数')}
          </button>
        </div>
      </div>

      <div className="pipeline-rows">
        {rows.map((row) => {
          const expanded = expandedEntries.has(row.entry.id);
          const detailId = `native-pipeline-detail-${row.entry.id.replace(/[^a-z0-9_-]/gi, '-')}`;
          const requestedRows = Math.max(1, Number(row.control?.requestedRows ?? 1000));
          const displayCount = (value: number) => formatPipelineCount(
            countMode === 'row' ? value / requestedRows : value,
          );
          const activeSegments = row.segments.filter((segment) => segment.calls > 0);
          const largest = activeSegments.reduce((current, segment) =>
            current == null || segment.calls > current.calls ? segment : current, activeSegments[0]);
          const shape = PIPELINE_SHAPES[row.entry.id];
          const methodCalls = Object.entries(row.control?.callMultiset ?? {});
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
                <div className="pipeline-owner-ledger native-pipeline-call-ledger">
                  <div className="native-pipeline-call-values">
                    <span>
                      <small>{text(countMode === 'row' ? 'calls ÷ rows' : 'total PAPI calls', countMode === 'row' ? '调用数 ÷ 行数' : 'PAPI 总调用')}</small>
                      <strong>{displayCount(row.totalCalls)}</strong>
                    </span>
                    <span>
                      <small>{text('largest segment', '最大分段')}</small>
                      <strong>{largest ? `${text(largest.label[0], largest.label[1])} · ${displayCount(largest.calls)}` : '—'}</strong>
                    </span>
                    <span className="pipeline-operation-total">
                      {text('whole mount', '整次 mount')} · {requestedRows} {text('rows', '行')}
                    </span>
                  </div>
                  <div
                    className="native-pipeline-call-bar"
                    role="img"
                    aria-label={text(
                      `${shortLabel(row.entry.id)} whole-mount PAPI calls: ${row.totalCalls}`,
                      `${shortLabel(row.entry.id)} 整次 mount PAPI 调用：${row.totalCalls}`,
                    )}
                  >
                    {activeSegments.map((segment) => (
                      <span
                        className={`pipeline-segment is-${segment.name}`}
                        key={segment.name}
                        style={{ width: `${(segment.calls / row.totalCalls) * 100}%` }}
                        title={`${text(segment.label[0], segment.label[1])} · ${displayCount(segment.calls)}`}
                      />
                    ))}
                  </div>
                </div>
                <button
                  type="button"
                  className="pipeline-detail-toggle"
                  aria-expanded={expanded}
                  aria-controls={detailId}
                  aria-label={text(`Toggle ${shortLabel(row.entry.id)} call audit`, `展开或关闭 ${shortLabel(row.entry.id)} 调用审计`)}
                  onClick={() => setExpandedEntries((current) => {
                    const next = new Set(current);
                    if (next.has(row.entry.id)) next.delete(row.entry.id);
                    else next.add(row.entry.id);
                    return next;
                  })}
                >
                  <span>{text('Call audit', '调用审计')}</span>
                  <i aria-hidden="true">›</i>
                </button>
              </div>

              {expanded ? (
                <div className="pipeline-row-detail" id={detailId}>
                  <div className="pipeline-segment-ledger" aria-label={text('Native PAPI segment calls', 'Native PAPI 分段调用数')}>
                    {row.segments.map((segment) => (
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
                          <strong>{displayCount(segment.calls)}</strong>
                          <span>{percent(row.totalCalls === 0 ? 0 : (segment.calls / row.totalCalls) * 100)} {text('of calls', '调用占比')}</span>
                        </span>
                      </span>
                    ))}
                  </div>
                  <details className="pipeline-control">
                    <summary>
                      {text('Exact device sample', '真机精确样本')}
                      {' · '}{text('rows', '行')} {row.control?.requestedRows ?? '—'} → {row.control?.committedRows ?? '—'}
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
        <summary>{text('Measurement boundary and why there is no time chart', '测量边界，以及为什么没有耗时图')}</summary>
        <p>{text(
          'The MTS prefix counts rebindable ElementPAPI calls across the whole Native mount, including the app shell. Lepus exposed only a 1 ms Date.now clock and no high-resolution performance.now surface, so no self-time, framework remainder, or cost-per-call value is published.',
          'MTS 前置 shim 统计整次 Native mount 中可重绑定的 ElementPAPI 调用，包含 app shell。Lepus 只有 1ms 的 Date.now，且没有高分辨率 performance.now，因此不发布 self-time、框架剩余时间或单次调用成本。',
        )}</p>
      </details>
    </section>
  );
}
