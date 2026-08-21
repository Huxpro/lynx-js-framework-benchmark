import { BenchRecord, entryColor, fmtMs, shortLabel } from '../data';
import { useBenchmarkData } from '../data-context';

function recordStatus(record: BenchRecord | undefined): string {
  if (!record) return 'not run';
  if (record.median != null) {
    return `${fmtMs(record.median)} · n=${record.n}${record.dnfCount ? ` · ${record.dnfCount} DNF` : ''}`;
  }
  return `${record.dnfCount} DNF · ${record.failures?.[0]?.category ?? 'no samples'}`;
}

function CellList({
  title,
  rows,
}: {
  title: string;
  rows: { label: string; record: BenchRecord | undefined }[];
}) {
  return (
    <div className="observation-group">
      <div className="observation-heading">{title}</div>
      <div className="observation-list">
        {rows.map(({ label, record }) => (
          <div className={`observation-row${record?.median == null ? ' dnf' : ''}`} key={label}>
            <span>{label}</span>
            <strong>{recordStatus(record)}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

export function WebLabRuns({ theme }: { theme: 'light' | 'dark' }) {
  const { snapshot, selectWebLab } = useBenchmarkData();
  if (snapshot.webLabRuns.length === 0) return null;
  return (
    <section className="native-observations" aria-labelledby="web-lab-title">
      <div className="observation-kicker">Web Lab Entry</div>
      <h2 id="web-lab-title">Complete single-entry Chromium campaigns</h2>
      <p>
        Each sheet is one immutable-commit, 35-cell Web campaign. Ranked Lab entries also feed the
        comparison charts through the recorded preflight calibration; this sheet preserves their
        unscaled absolute observations.
      </p>
      {snapshot.webLabRuns.map((run) => {
        const records = selectWebLab({ entry: run.entryId, harness: 'web' });
        const table = records.filter((record) => record.suite === 'table');
        const startup = records.filter((record) => record.suite === 'startup');
        const tableRows = (scale: number) => table
          .filter((record) => record.scale === scale && record.metric === 'latency')
          .map((record) => ({ label: record.workload, record }));
        const startupRows = (metric: string) => [0, 1000, 10000, 30000].map((scale) => ({
          label: `@${scale.toLocaleString()}`,
          record: startup.find((record) => record.metric === metric && record.scale === scale),
        }));
        return (
          <article className="observation-sheet" key={`${run.entryId}:${run.contractSha256}`}>
            <header>
              <div>
                <div className="observation-entry">
                  <span style={{ background: entryColor(run.entryId, theme) }} />
                  {shortLabel(run.entryId)}
                </div>
                <div className="observation-boundary">
                  Immutable commit <code>{run.entryCommit.slice(0, 12)}</code> · complete {run.expectedCellCount}-cell contract
                </div>
              </div>
              <div className="observation-stamp">
                {snapshot.comparison.labEstimates.some((estimate) => estimate.entryId === run.entryId)
                  ? 'Lab · ranked (calibrated)'
                  : 'Lab · not ranked'}
              </div>
            </header>
            <div className="observation-grid">
              <CellList title="table @1k" rows={tableRows(1000)} />
              <CellList title="table @10k" rows={tableRows(10000)} />
              <CellList title="first contentful paint" rows={startupRows('fcp')} />
              <CellList title="settled" rows={startupRows('settled')} />
            </div>
            <footer>
              <code>{run.machineId}</code><span aria-hidden="true">·</span>
              <code>{run.sourceRunFile}</code><span aria-hidden="true">·</span>
              <time dateTime={run.generatedAt}>{new Date(run.generatedAt).toLocaleString()}</time>
            </footer>
          </article>
        );
      })}
    </section>
  );
}
