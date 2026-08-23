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
      {visible.map((e) => (
        <button
          key={e.id}
          className="item"
          aria-pressed={selected.has(e.id)}
          onClick={() => onToggle(e.id)}
          title={`${e.label} — ${e.config}${e.tier === 'lab' ? ` · calibrated historical Lab estimate (${e.provenance.ref} @ ${e.provenance.commit.slice(0, 8)})` : ''}`}
        >
          <span className="swatch" style={{ background: entryColor(e.id, theme) }} />
          {e.label}
        </button>
      ))}
    </div>
  );
}
