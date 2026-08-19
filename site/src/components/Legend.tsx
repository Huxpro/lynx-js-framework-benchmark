import { ENTRIES, entryColor } from '../data';

export function Legend({
  theme,
  selected,
  onToggle,
  labMode,
  harness,
}: {
  theme: 'light' | 'dark';
  selected: Set<string>;
  onToggle: (id: string) => void;
  labMode: boolean;
  harness: string;
}) {
  const visible = ENTRIES.filter((e) => e.tier !== 'lab' || (labMode && harness === 'web'));
  return (
    <div className="legend" role="group" aria-label="Entries">
      {visible.map((e) => (
        <button
          key={e.id}
          className="item"
          aria-pressed={selected.has(e.id)}
          onClick={() => onToggle(e.id)}
          title={`${e.label} — ${e.config}${e.tier === 'lab' ? ` · Lab entry (${e.provenance.ref} @ ${e.provenance.commit.slice(0, 8)})` : ''}`}
        >
          <span className="swatch" style={{ background: entryColor(e.id, theme) }} />
          {e.label}
        </button>
      ))}
    </div>
  );
}
