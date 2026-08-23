import { BENCHMARK_HISTORY, TimelineSnapshot } from '../data';

const dateLabel = (generatedAt: string, compact = false) => new Date(generatedAt).toLocaleString(
  undefined,
  compact
    ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' },
);

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
        <div className="timeline-copy" title={checkpoint.description}>
          <span className="timeline-eyebrow">Dataset</span>
          <time dateTime={snapshot.generatedAt}>{dateLabel(snapshot.generatedAt, true)}</time>
          <code>{checkpoint.label}</code>
        </div>
        </section>
      </div>
    </div>
  );
}
