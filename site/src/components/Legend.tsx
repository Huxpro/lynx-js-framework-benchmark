import { ENTRIES, entryColor, entrySupportsHarness } from '../data';
import { useBenchmarkData } from '../data-context';

export function Legend({
  harness,
  theme,
  selected,
  onToggle,
}: {
  harness: string;
  theme: 'light' | 'dark';
  selected: Set<string>;
  onToggle: (id: string) => void;
}) {
  const { snapshot } = useBenchmarkData();
  const available = new Set(snapshot.comparison.harnesses
    .find((cohort) => cohort.harness === harness)?.entryIds ?? []);
  const visible = ENTRIES.filter((entry) =>
    available.has(entry.id) && entrySupportsHarness(entry, harness));
  return (
    <div className="legend" role="group" aria-label="Entries">
      {visible.map((e) => {
        const detailId = `entry-method-${harness}-${e.id}`;
        return (
          <div className="legend-entry" key={e.id}>
            <button
              className="item"
              aria-pressed={selected.has(e.id)}
              aria-describedby={detailId}
              onClick={() => onToggle(e.id)}
            >
              <span className="swatch" style={{ background: entryColor(e.id, theme) }} />
              {e.label}
            </button>
            <aside className="entry-method" id={detailId} role="tooltip">
              <strong>{e.label}</strong>
              <span>{e.framework} {e.frameworkVersion}</span>
              <span>{e.config}</span>
              {e.configuration && <span>{e.configuration.summary}</span>}
              <a href={`${e.provenance.source}/commit/${e.provenance.commit}`} target="_blank" rel="noreferrer">
                {e.provenance.source.replace('https://github.com/', '')} @ {e.provenance.commit.slice(0, 10)} ↗
              </a>
            </aside>
          </div>
        );
      })}
    </div>
  );
}
