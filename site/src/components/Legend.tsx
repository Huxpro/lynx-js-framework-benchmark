import { ENTRIES, entryColor } from '../data';

export function Legend({
  theme,
  selected,
  onToggle,
}: {
  theme: 'light' | 'dark';
  selected: Set<string>;
  onToggle: (id: string) => void;
}) {
  return (
    <div className="legend" role="group" aria-label="Entries">
      {ENTRIES.map((e) => (
        <button
          key={e.id}
          className="item"
          aria-pressed={selected.has(e.id)}
          onClick={() => onToggle(e.id)}
          title={`${e.label} — ${e.config}`}
        >
          <span className="swatch" style={{ background: entryColor(e.id, theme) }} />
          {e.label}
        </button>
      ))}
    </div>
  );
}
