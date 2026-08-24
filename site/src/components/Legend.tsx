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
        const pointer = snapshot.identityPointers.find((candidate) => candidate.entryId === e.id);
        const detailId = `entry-method-${harness}-${e.id}`;
        const commit = pointer?.commit ?? e.provenance.commit;
        const source = pointer?.source ?? e.provenance.source;
        const href = pointer?.href ?? `${source}/commit/${commit}`;
        const version = pointer ? pointer.version : e.frameworkVersion;
        const configuration = pointer ? pointer.configuration : e.configuration;
        const config = pointer ? pointer.config : e.config;
        return (
          <div className="legend-entry" key={e.id}>
            <button
              className="item"
              aria-pressed={selected.has(e.id)}
              onClick={() => onToggle(e.id)}
            >
              <span className="swatch" style={{ background: entryColor(e.id, theme) }} />
              {e.label}
            </button>
            <span className="entry-info">
              <button
                className="entry-info-trigger"
                type="button"
                aria-label={`Details for ${e.label}`}
                aria-controls={detailId}
              >i</button>
              <aside className="entry-method" id={detailId} aria-label={`${e.label} source and configuration`}>
                <strong>{e.label}</strong>
                {pointer?.channel && <span>{pointer.channel}</span>}
                {config && <span>{config}</span>}
                {configuration && <span>{configuration.summary}</span>}
                <div className="entry-links">
                  <a className="external-link" href={href} target="_blank" rel="noreferrer">
                    {version && <span>{version}</span>}<code>{commit.slice(0, 10)}</code><span aria-hidden="true">↗</span>
                  </a>
                  {configuration && (
                    <a className="external-link" href={configuration.href} target="_blank" rel="noreferrer">
                      config <span aria-hidden="true">↗</span>
                    </a>
                  )}
                </div>
              </aside>
            </span>
          </div>
        );
      })}
    </div>
  );
}
