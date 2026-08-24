import { BENCHMARK_HISTORY, TimelineSnapshot } from '../data';
import { localizedCheckpoint, useI18n } from '../i18n';

export function TimelineSlider({
  snapshots,
  index,
  onChange,
  page,
  onPageChange,
  harness,
  onHarnessChange,
  theme,
  onThemeToggle,
}: {
  snapshots: TimelineSnapshot[];
  index: number;
  onChange: (index: number) => void;
  page: 'overview' | 'scale';
  onPageChange: (page: 'overview' | 'scale') => void;
  harness: string;
  onHarnessChange: (harness: string) => void;
  theme: 'light' | 'dark';
  onThemeToggle: () => void;
}) {
  const { locale, text, date, toggleLocale } = useI18n();
  const snapshot = snapshots[index];
  const checkpoint = BENCHMARK_HISTORY.checkpoints[index];
  const checkpointCopy = localizedCheckpoint(checkpoint, locale);
  const progress = snapshots.length > 1 ? (index / (snapshots.length - 1)) * 100 : 0;
  const cohorts = checkpoint.harnesses.map((cohort) =>
    `${cohort.harness === 'web' ? 'Web' : 'Native'} ${cohort.entryIds.length}${cohort.rankEligible ? '' : text(' observation', '（观察值）')}`);
  return (
    <div className="timeline-sticky">
      <div className="timeline-workspace">
        <div className="workspace-toolbar">
          <nav className="view-switch" aria-label={text('Benchmark views', '基准测试视图')}>
            {(['overview', 'scale'] as const).map((view) => (
              <button
                key={view}
                type="button"
                aria-current={page === view ? 'page' : undefined}
                onClick={() => onPageChange(view)}
              >{view === 'overview' ? text('Overview', '总览') : text('Scale', '规模')}</button>
            ))}
          </nav>
          <div className="workspace-environment">
            <span>{text('Lynx for', 'Lynx 环境')}</span>
            <div className="harness-switch" role="group" aria-label={text('Environment', '运行环境')}>
              {(['web', 'native'] as const).map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  aria-pressed={harness === candidate}
                  onClick={() => onHarnessChange(candidate)}
                >{candidate === 'web' ? 'Web' : 'Native'}</button>
              ))}
            </div>
          </div>
          <button
            className="locale-toggle"
            type="button"
            onClick={toggleLocale}
            aria-label={locale === 'en' ? '切换到中文' : 'Switch to English'}
            title={locale === 'en' ? '切换到中文' : 'Switch to English'}
          >
            <span className={locale === 'en' ? 'is-active' : ''}>EN</span>
            <i aria-hidden="true">/</i>
            <span className={locale === 'zh-CN' ? 'is-active' : ''}>中</span>
          </button>
          <button className="theme-toggle" type="button" onClick={onThemeToggle} aria-label={text('Toggle theme', '切换主题')}>
            {theme === 'dark' ? '☀' : '☾'}
          </button>
        </div>
        <section className="timeline" aria-label={text('Dataset time machine', '数据集时光机')}>
        <div className="timeline-control">
          <button
            type="button"
            aria-label={text('Previous exact-source checkpoint', '上一个精确来源节点')}
            disabled={index === 0}
            onClick={() => onChange(index - 1)}
          >←</button>
          <div className="timeline-range">
            <div className="timeline-range-track" aria-hidden="true">
              <span className="timeline-range-progress" style={{ width: `${progress}%` }} />
              {snapshots.map((candidate, checkpointIndex) => (
                <i
                  key={candidate.id}
                  className={`timeline-dot${checkpointIndex <= index ? ' is-reached' : ''}${checkpointIndex === index ? ' is-active' : ''}`}
                  style={{ left: `${snapshots.length > 1 ? (checkpointIndex / (snapshots.length - 1)) * 100 : 50}%` }}
                />
              ))}
            </div>
            <input
              type="range"
              min={0}
              max={snapshots.length - 1}
              step={1}
              value={index}
              onChange={(event) => onChange(Number(event.target.value))}
              aria-label={text('Dataset checkpoint', '数据集节点')}
              aria-valuetext={`${checkpointCopy.label}, ${date(snapshot.generatedAt, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })}, ${text(`${checkpoint.identityPointers.length} framework identities`, `${checkpoint.identityPointers.length} 个框架身份`)}, ${cohorts.join(', ')}`}
            />
          </div>
          <button
            type="button"
            aria-label={text('Next exact-source checkpoint', '下一个精确来源节点')}
            disabled={index === snapshots.length - 1}
            onClick={() => onChange(index + 1)}
          >→</button>
        </div>
        </section>
      </div>
    </div>
  );
}
