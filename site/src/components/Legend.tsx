import { ENTRIES, entryColor } from '../data';

export function Legend({
  theme,
  selected,
  onToggle,
  labMode = false,
}: {
  theme: 'light' | 'dark';
  selected: Set<string>;
  onToggle: (id: string) => void;
  labMode?: boolean;
}) {
  const visible = ENTRIES.filter((e) => e.tier !== 'lab' || labMode);
  return (
    <div className="legend" role="group" aria-label="Entries">
      {visible.map((e) => (
        <button
          key={e.id}
          className="item"
          aria-pressed={selected.has(e.id)}
          onClick={() => onToggle(e.id)}
          title={`${e.label} — ${e.config}${e.tier === 'lab' ? ` · lab variant (${e.provenance.ref} @ ${e.provenance.commit.slice(0, 8)})` : ''}`}
        >
          <span className="swatch" style={{ background: entryColor(e.id, theme) }} />
          {e.label}
          {e.tier === 'lab' && (
            <span
              style={{
                fontSize: '0.66rem',
                fontFamily: 'ui-monospace, Menlo, monospace',
                border: '1px solid var(--border)',
                borderRadius: '0.3rem',
                padding: '0 0.25rem',
                color: 'var(--text-muted)',
              }}
            >
              ⚗ lab
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
