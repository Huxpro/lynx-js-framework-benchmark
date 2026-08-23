import { BENCHMARK_HISTORY, TimelineSnapshot } from '../data';

const dateLabel = (generatedAt: string, compact = false) => new Date(generatedAt).toLocaleString(
  undefined,
  compact
    ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' },
);

const pointerText = (pointer: TimelineSnapshot['identityPointers'][number]) =>
  (pointer.channel && pointer.commit
    ? pointer.commit.slice(0, 8)
    : pointer.version ?? pointer.commit?.slice(0, 8)) ?? 'source';

const pointerTitle = (pointer: TimelineSnapshot['identityPointers'][number]) => [
  pointer.channel,
  pointer.source && `${pointer.source.replace('https://github.com/', '')} @ ${pointer.ref ?? 'recorded source'}`,
  pointer.commit && `commit ${pointer.commit}`,
  pointer.configuration?.summary && `plugin config: ${pointer.configuration.summary}`,
].filter(Boolean).join('\n');

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
  const snapshot = snapshots[index];
  const checkpoint = BENCHMARK_HISTORY.checkpoints[index];
  const cohorts = checkpoint.harnesses.map((cohort) =>
    `${cohort.harness === 'web' ? 'Web' : 'Native'} ${cohort.entryIds.length}${cohort.rankEligible ? '' : ' observation'}`);
  return (
    <div className="timeline-sticky">
      <div className="timeline-workspace">
        <div className="workspace-toolbar">
          <nav className="view-switch" aria-label="Benchmark views">
            {(['overview', 'scale'] as const).map((view) => (
              <button
                key={view}
                type="button"
                aria-current={page === view ? 'page' : undefined}
                onClick={() => onPageChange(view)}
              >{view === 'overview' ? 'Overview' : 'Scale'}</button>
            ))}
          </nav>
          <div className="workspace-environment">
            <span>Lynx for</span>
            <div className="harness-switch" role="group" aria-label="Environment">
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
          <button className="theme-toggle" type="button" onClick={onThemeToggle} aria-label="Toggle theme">
            {theme === 'dark' ? '☀' : '☾'}
          </button>
        </div>
        <section className="timeline" aria-label="Dataset time machine">
        <div className="timeline-copy">
          <div className="timeline-eyebrow">Dataset time machine</div>
          <div className="timeline-title">
            <time dateTime={snapshot.generatedAt}>{dateLabel(snapshot.generatedAt)}</time>
            <code title={checkpoint.description}>{checkpoint.label}</code>
          </div>
        </div>
        <div className="timeline-control">
          <button
            type="button"
            aria-label="Previous exact-source checkpoint"
            disabled={index === 0}
            onClick={() => onChange(index - 1)}
          >←</button>
          <input
            type="range"
            min={0}
            max={snapshots.length - 1}
            step={1}
            value={index}
            onChange={(event) => onChange(Number(event.target.value))}
            aria-label="Dataset checkpoint"
            aria-valuetext={`${checkpoint.label}, ${dateLabel(snapshot.generatedAt)}, ${checkpoint.identityPointers.length} framework identities, ${cohorts.join(', ')}`}
          />
          <button
            type="button"
            aria-label="Next exact-source checkpoint"
            disabled={index === snapshots.length - 1}
            onClick={() => onChange(index + 1)}
          >→</button>
        </div>
        <div className="timeline-identities" aria-label="Framework source pointers">
          {checkpoint.identityPointers.map((pointer, pointerIndex) => {
            const text = pointerText(pointer);
            const title = pointerTitle(pointer);
            const detailId = `source-detail-${index}-${pointerIndex}`;
            return (
              <div className="timeline-identity" key={pointer.entryId}>
                {pointer.href ? (
                  <a href={pointer.href} target="_blank" rel="noreferrer" title={title} aria-describedby={detailId}>
                    <b>{pointer.label}</b>
                    <code>{text}</code>
                  </a>
                ) : (
                  <span title={title} tabIndex={0} aria-describedby={detailId}>
                    <b>{pointer.label}</b>
                    <code>{text}</code>
                  </span>
                )}
                {pointer.configuration && (
                  <a
                    className="timeline-config"
                    href={pointer.configuration.href}
                    target="_blank"
                    rel="noreferrer"
                    title={pointer.configuration.summary}
                    aria-label={`${pointer.label} plugin configuration: ${pointer.configuration.summary}`}
                  >config ↗</a>
                )}
                <aside className="identity-detail" id={detailId} role="tooltip">
                  <strong>{pointer.label}</strong>
                  {pointer.channel && <span>{pointer.channel}</span>}
                  {pointer.source && <span>{pointer.source.replace('https://github.com/', '')} @ {pointer.ref ?? 'recorded source'}</span>}
                  {pointer.commit && <code>{pointer.commit}</code>}
                  {pointer.configuration?.summary && <span>{pointer.configuration.summary}</span>}
                </aside>
              </div>
            );
          })}
        </div>
        <div className="timeline-meta">
          <span>{index + 1}/{snapshots.length} exact checkpoints</span>
          <span>{checkpoint.id}</span>
          <span>{cohorts.join(' · ')}</span>
          <span>{checkpoint.sourceIndexes.length} source run{checkpoint.sourceIndexes.length === 1 ? '' : 's'}</span>
          {checkpoint.harnesses.some((cohort) => !cohort.rankEligible) && (
            <span className="timeline-warning">observation only — no cross-run rank</span>
          )}
        </div>
        </section>
      </div>
    </div>
  );
}
