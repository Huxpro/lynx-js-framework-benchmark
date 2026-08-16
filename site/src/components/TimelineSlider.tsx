import { TimelineSnapshot } from '../data';

export function TimelineSlider({
  snapshots,
  index,
  onChange,
}: {
  snapshots: TimelineSnapshot[];
  index: number;
  onChange: (index: number) => void;
}) {
  const snapshot = snapshots[index];
  const webEntries = snapshot.comparison.harnesses
    .find((cohort) => cohort.harness === 'web')?.entryIds.length ?? 0;
  const nativeEntries = snapshot.comparison.harnesses
    .find((cohort) => cohort.harness === 'native')?.entryIds.length ?? 0;
  const historicalStormCaveat = snapshot.id !== 'current-main';
  return (
    <section className="timeline" aria-label="Benchmark history">
      <div className="timeline-copy">
        <div className="timeline-eyebrow">Dataset Time Machine</div>
        <div className="timeline-title">
          <time dateTime={snapshot.generatedAt}>
            {new Date(snapshot.generatedAt).toLocaleDateString(undefined, {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            })}
          </time>
          <code>Octane main {snapshot.octaneCommit?.slice(0, 8) ?? 'unknown'}</code>
        </div>
        <div className="timeline-desc">{snapshot.description}</div>
      </div>
      <div className="timeline-control">
        <input
          type="range"
          min={0}
          max={snapshots.length - 1}
          step={1}
          value={index}
          onChange={(event) => onChange(Number(event.target.value))}
          aria-label="Dataset snapshot"
          aria-valuetext={`${snapshot.label}, Octane main ${snapshot.octaneCommit?.slice(0, 8) ?? 'unknown'}`}
        />
        <div className="timeline-ticks" aria-hidden="true">
          {snapshots.map((candidate, candidateIndex) => (
            <button
              key={candidate.id}
              type="button"
              className={candidateIndex === index ? 'active' : ''}
              onClick={() => onChange(candidateIndex)}
              tabIndex={-1}
            >
              {candidate.label}
            </button>
          ))}
        </div>
      </div>
      <div className="timeline-meta">
        <span>{webEntries} Web entries</span>
        <span>{nativeEntries || 'no'} Native entries</span>
        {historicalStormCaveat && (
          <span className="timeline-warning">
            historical Octane storm runs emitted fewer than 30 sequential transport commits
          </span>
        )}
      </div>
    </section>
  );
}
