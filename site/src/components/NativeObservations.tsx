import {
  BenchRecord,
  entryColor,
  fmtMs,
  NATIVE_OBSERVATIONS,
  selectNativeObservations,
  shortLabel,
} from '../data';

const TABLE_GROUPS = [
  {
    title: 'interactive @1k',
    records: ['create', 'replace', 'append1k', 'update10th', 'select', 'swap', 'remove'],
  },
  {
    title: 'storms @1k',
    records: ['updateStorm', 'selectStorm'],
  },
];

function status(record: BenchRecord | undefined): string {
  if (!record) return 'not run';
  if (record.median != null) {
    return `${fmtMs(record.median)} · n=${record.n}${record.dnfCount ? ` · ${record.dnfCount} DNF` : ''}`;
  }
  const failure = record.failures?.[0];
  const category = failure?.category ?? 'DNF';
  const timeout = failure?.timeoutMs ? ` · ${(failure.timeoutMs / 1000).toFixed(0)}s ceiling` : '';
  return `${record.dnfCount} DNF · ${category}${timeout}`;
}

function RecordList({
  title,
  records,
}: {
  title: string;
  records: { label: string; record: BenchRecord | undefined }[];
}) {
  return (
    <div className="observation-group">
      <div className="observation-heading">{title}</div>
      <div className="observation-list">
        {records.map(({ label, record }) => (
          <div
            className={`observation-row${record?.median == null ? ' dnf' : ''}`}
            key={label}
            title={record?.failures?.[0]?.message}
          >
            <span>{label}</span>
            <strong>{status(record)}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

export function NativeObservations({ theme }: { theme: 'light' | 'dark' }) {
  if (NATIVE_OBSERVATIONS.length === 0) return null;

  return (
    <section className="native-observations" aria-labelledby="native-observations-title">
      <div className="observation-kicker">Separate Device Observation</div>
      <h2 id="native-observations-title">Native entries outside the comparison cohort</h2>
      <p>
        These measurements are real, but they were captured under a different Sandbox lease from
        the five-entry comparison cohort above. They are shown as absolute observations and never
        enter heatmaps, geomeans, “fastest” rankings, or cross-framework ratios.
      </p>
      {NATIVE_OBSERVATIONS.map((observation) => {
        const records = selectNativeObservations({
          harness: 'native',
          entry: observation.entryId,
        });
        const table = records.filter((record) =>
          record.suite === 'table' && record.metric === 'latency');
        const startup = records.filter((record) =>
          record.suite === 'startup' && record.workload === 'startup');
        return (
          <article className="observation-sheet" key={`${observation.entryId}:${observation.machineId}`}>
            <header>
              <div>
                <div className="observation-entry">
                  <span style={{ background: entryColor(observation.entryId, theme) }} />
                  {shortLabel(observation.entryId)}
                </div>
                <div className="observation-boundary">
                  Real Native tap → renderer ACK → second Native frame
                </div>
              </div>
              <div className="observation-stamp">not cross-comparable</div>
            </header>
            <div className="observation-grid">
              {TABLE_GROUPS.map((group) => (
                <RecordList
                  key={group.title}
                  title={group.title}
                  records={group.records.map((workload) => ({
                    label: workload,
                    record: table.find((record) =>
                      record.workload === workload && record.scale === 1000),
                  }))}
                />
              ))}
              <RecordList
                title="10k boundary"
                records={[
                  { label: 'create', record: table.find((record) => record.workload === 'create' && record.scale === 10000) },
                  { label: 'update10th', record: table.find((record) => record.workload === 'update10th' && record.scale === 10000) },
                  { label: 'select', record: table.find((record) => record.workload === 'select' && record.scale === 10000) },
                  { label: 'clear', record: table.find((record) => record.workload === 'clear' && record.scale === 10000) },
                ]}
              />
              <RecordList
                title="startup"
                records={[0, 1000, 10000, 30000].flatMap((scale) => [
                  {
                    label: `ACK @${scale.toLocaleString()}`,
                    record: startup.find((record) =>
                      record.metric === 'octaneCommitAck' && record.scale === scale),
                  },
                  {
                    label: `2nd frame @${scale.toLocaleString()}`,
                    record: startup.find((record) =>
                      record.metric === 'octaneSecondFrame' && record.scale === scale),
                  },
                ])}
              />
            </div>
            <footer>
              <code>{observation.machineId}</code>
              <span aria-hidden="true">·</span>
              <code>{observation.sourceRunFile}</code>
              <span aria-hidden="true">·</span>
              <time dateTime={observation.generatedAt}>
                {new Date(observation.generatedAt).toLocaleString()}
              </time>
            </footer>
          </article>
        );
      })}
    </section>
  );
}
