import { ENTRIES, entryColor, entrySupportsHarness } from '../data';

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
  const visible = ENTRIES.filter((e) => e.tier !== 'lab' && entrySupportsHarness(e, harness));
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
