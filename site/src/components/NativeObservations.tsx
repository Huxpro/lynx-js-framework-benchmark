import {
  BenchRecord,
  entryColor,
  fmtMs,
  shortLabel,
} from '../data';
import { useBenchmarkData } from '../data-context';
import { localizedWorkload, useI18n } from '../i18n';
import {
  NATIVE_CAPACITY_ANDROID_ART_GLOBAL_REF_FAILURE_CATEGORY,
  nativeOutcomeState,
} from '../derive.mjs';
import { ResponsiveCopy } from './ResponsiveCopy';

const TABLE_GROUPS = [
  {
    title: 'interactive @1k',
    records: ['create', 'replace', 'append1k', 'update10th', 'select', 'swap', 'remove'],
  },
  {
    title: 'storms @1k',
    records: ['updateStorm', 'selectStorm'],
  },
];

function reasonLabel(
  category: string,
  text: (english: string, chinese: string) => string,
): string {
  if (category === NATIVE_CAPACITY_ANDROID_ART_GLOBAL_REF_FAILURE_CATEGORY) {
    return text('capacity · Android ART global-reference table', '容量 · Android ART 全局引用表');
  }
  if (category === 'timeout') return text('timeout', '超时');
  if (category === 'process-failure') return text('process failure', '进程失败');
  return category;
}

function outcomeReasonSummary(
  record: BenchRecord,
  text: (english: string, chinese: string) => string,
): string {
  return Object.entries(record.outcomeCounts?.byReason ?? {})
    .filter(([, count]) => count > 0)
    .map(([category, count]) => `${count} ${reasonLabel(category, text)}`)
    .join(' · ');
}

function status(
  record: BenchRecord | undefined,
  text: (english: string, chinese: string) => string,
): string {
  if (!record) return text('not run', '未运行');
  const outcome = nativeOutcomeState(record);
  if (outcome === 'not-measured') {
    const reason = record.notMeasuredReason?.category ?? 'observer unavailable';
    return text(`not measured · ${reason}`, `未测量 · ${reason}`);
  }
  if (outcome === 'not-reportable' && record.reportability) {
    const reasons = outcomeReasonSummary(record, text);
    return text(
      `not reportable · ${record.acceptedCount ?? 0}/${record.reportability.minAcceptedSamples} accepted`
        + `${record.dnfCount ? ` · ${record.dnfCount} DNF` : ''}`
        + `${reasons ? ` · ${reasons}` : ''}`,
      `不可报告 · 接受 ${record.acceptedCount ?? 0}/${record.reportability.minAcceptedSamples}`
        + `${record.dnfCount ? ` · ${record.dnfCount} DNF` : ''}`
        + `${reasons ? ` · ${reasons}` : ''}`,
    );
  }
  if (record.median != null) {
    return `${fmtMs(record.median)} · n=${record.n}${record.dnfCount ? ` · ${record.dnfCount} DNF` : ''}`;
  }
  const failure = record.failures?.[0];
  const reasons = outcomeReasonSummary(record, text);
  const category = reasons || reasonLabel(failure?.category ?? 'DNF', text);
  const timeout = failure?.timeoutMs
    ? text(` · ${(failure.timeoutMs / 1000).toFixed(0)}s ceiling`, ` · 上限 ${(failure.timeoutMs / 1000).toFixed(0)} 秒`)
    : '';
  return `${record.dnfCount} DNF · ${category}${timeout}`;
}

function RecordList({
  title,
  records,
}: {
  title: string;
  records: { label: string; record: BenchRecord | undefined }[];
}) {
  const { text } = useI18n();
  return (
    <div className="observation-group">
      <div className="observation-heading">{title}</div>
      <div className="observation-list">
        {records.map(({ label, record }) => (
          <div
            className={`observation-row${record?.median == null ? ' dnf' : ''}`}
            data-status={nativeOutcomeState(record)}
            key={label}
            title={record?.failures?.[0]?.message}
          >
            <span>{label}</span>
            <strong>{status(record, text)}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

export function NativeObservations({ theme }: { theme: 'light' | 'dark' }) {
  const { locale, text, date } = useI18n();
  const { snapshot, selectNativeObservations } = useBenchmarkData();
  if (snapshot.nativeObservations.length === 0) return null;

  return (
    <section className="native-observations" aria-labelledby="native-observations-title">
      <div className="observation-kicker">{text('Archive-only device evidence', '仅供归档的设备证据')}</div>
      <h2 id="native-observations-title">{text('Native entries outside the selected campaign', '所选 campaign 之外的 Native 条目')}</h2>
      <ResponsiveCopy className="section-copy">
        {text(
          'These measurements are real, but their machine, lease, method, campaign, or immutable input receipt differs from the selected cohort (or predates explicit identity). They are shown as absolute evidence and never enter heatmaps, geomeans, rankings, or ratios.',
          '这些测量是真实的，但其 machine、lease、method、campaign 或不可变输入凭据与所选 cohort 不同（或早于明确身份规则）。它们只作为绝对证据展示，绝不进入热图、几何平均、排名或比率。',
        )}
      </ResponsiveCopy>
      {snapshot.nativeObservations.map((observation) => {
        const records = selectNativeObservations({
          harness: 'native',
          entry: observation.entryId,
        }).filter((record) => observation.sourceRunFile == null
          || record.runFile === observation.sourceRunFile);
        const table = records.filter((record) =>
          record.suite === 'table' && record.metric === 'latency');
        const startup = records.filter((record) =>
          record.suite === 'startup' && record.workload === 'startup');
        const capacity = records.filter((record) => record.suite === 'native-capacity');
        const list = records.filter((record) => record.suite === 'list');
        return (
          <article className="observation-sheet" key={`${observation.entryId}:${observation.machineId}:${observation.sourceRunFile}`}>
            <header>
              <div>
                <div className="observation-entry">
                  <span style={{ background: entryColor(observation.entryId, theme) }} />
                  {shortLabel(observation.entryId)}
                </div>
                <div className="observation-boundary">{observation.kind === 'capacity'
                  ? text('Cold Native launch → semantic completion or correlated process death', '冷启动 Native → 语义完成或关联进程终止')
                  : observation.kind === 'list'
                    ? text('Bounded Native list · semantic receipt + declared allocation observer', '有界 Native 列表 · 语义凭据 + 已声明分配观察器')
                    : text('Real Native tap → renderer ACK → second Native frame', '真实 Native 点击 → renderer ACK → 第二个 Native 帧')}</div>
              </div>
                <div className="observation-stamp">{text('archive only', '仅归档')}</div>
            </header>
            <div className="observation-grid">
              {table.length > 0 && TABLE_GROUPS.map((group) => (
                <RecordList
                  key={group.title}
                  title={text(group.title, group.title === 'interactive @1k' ? '交互 @1k' : '连续交互 @1k')}
                  records={group.records.map((workload) => ({
                    label: localizedWorkload(workload, locale),
                    record: table.find((record) =>
                      record.workload === workload && record.scale === 1000),
                  }))}
                />
              ))}
              {table.length > 0 && <RecordList
                title={text('10k boundary', '10k 边界')}
                records={[
                  { label: localizedWorkload('create', locale), record: table.find((record) => record.workload === 'create' && record.scale === 10000) },
                  { label: localizedWorkload('update10th', locale), record: table.find((record) => record.workload === 'update10th' && record.scale === 10000) },
                  { label: localizedWorkload('select', locale), record: table.find((record) => record.workload === 'select' && record.scale === 10000) },
                  { label: localizedWorkload('clear', locale), record: table.find((record) => record.workload === 'clear' && record.scale === 10000) },
                ]}
              />}
              {capacity.length > 0 && (
                <RecordList
                  title={text('eager capacity', '急切容量')}
                  records={capacity.map((record) => ({
                    label: `${record.scale.toLocaleString()} rows`,
                    record,
                  }))}
                />
              )}
              {list.length > 0 && (
                <RecordList
                  title={text('bounded Native list', '有界 Native 列表')}
                  records={['list-startup', 'list-recycle', 'list-fling'].map((workload) => ({
                    label: localizedWorkload(workload, locale),
                    record: list.find((record) => record.workload === workload
                      && (record.metric === 'peakLiveNativeListItems'
                        || record.metric === 'materializationTimesMs')),
                  }))}
                />
              )}
              {startup.length > 0 && <RecordList
                title={text('startup', '启动')}
                records={[0, 1000, 10000, 30000].flatMap((scale) => [
                  {
                    label: `ACK @${scale.toLocaleString()}`,
                    record: startup.find((record) =>
                      record.metric === 'octaneCommitAck' && record.scale === scale),
                  },
                  {
                    label: text(`2nd frame @${scale.toLocaleString()}`, `第二帧 @${scale.toLocaleString()}`),
                    record: startup.find((record) =>
                      record.metric === 'octaneSecondFrame' && record.scale === scale),
                  },
                ])}
              />}
            </div>
            <footer>
              <code>{observation.machineId}</code>
              <span aria-hidden="true">·</span>
              <code>{observation.sourceRunFile}</code>
              <span aria-hidden="true">·</span>
              <time dateTime={observation.generatedAt}>
                {date(observation.generatedAt, {
                  year: 'numeric', month: 'short', day: 'numeric',
                  hour: '2-digit', minute: '2-digit',
                })}
              </time>
            </footer>
          </article>
        );
      })}
    </section>
  );
}
