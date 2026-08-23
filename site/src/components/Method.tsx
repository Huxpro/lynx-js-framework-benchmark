import { useBenchmarkData } from '../data-context';
import { BENCHMARK_HISTORY } from '../data';

export function MeasurementReceipt({ harness }: { harness: string }) {
  const { snapshot } = useBenchmarkData();
  const checkpoint = BENCHMARK_HISTORY.checkpoints.find((candidate) => candidate.id === snapshot.id);
  const cohort = snapshot.comparison.harnesses.find((candidate) => candidate.harness === harness);
  const boundary = harness === 'web'
    ? 'Interaction: in-page pointerdown → first frame whose composed-DOM predicate passes. Startup: view attach → first contentful paint.'
    : 'Interaction: real device input handler → second Native animation frame. Startup: pipeline open → FCP; renderer-only ACK/frame metrics stay separately named.';
  const generatedAt = new Date(snapshot.generatedAt).toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });

  return (
    <details className="measurement-receipt">
      <summary>
        <span>Measurement receipt</span>
        <span className="receipt-context">
          <code title={checkpoint?.description}>{checkpoint?.label ?? snapshot.label}</code>
          {' · '}<time dateTime={snapshot.generatedAt}>{generatedAt}</time>
          {' · '}{harness === 'web' ? 'Web' : 'Native'}
          {' · '}{cohort ? `${cohort.entryIds.length} comparable entries` : 'no publishable cohort'}
        </span>
      </summary>
      <div className="receipt-grid">
        <section>
          <h3>Observation boundary</h3>
          <p>{boundary}. Timeout and unreachable prestate remain explicit DNF, never proxy values.</p>
        </section>
        <section>
          <h3>Fairness controls</h3>
          <p>
            Identical table contract and seeded rows; medians are derived from raw repetitions.
            Web and Native stay separate comparison domains.
          </p>
        </section>
        <section>
          <h3>Published cohort</h3>
          <p>
            {cohort
              ? <><code>{cohort.machineId}</code> · {cohort.sourceRunFiles.length} source run{cohort.sourceRunFiles.length === 1 ? '' : 's'}</>
              : 'Archived observations may remain as evidence, but cannot enter rankings.'}
          </p>
        </section>
      </div>
      <div className="receipt-audit">
        <p>
          <b>Raw → derived.</b> Run identity, raw repetitions, one-shot values, failures and DNF
          counts are source evidence. Medians, CI, eligible matrices, rankings, geomeans, ratios,
          trend α and every visual mark are regenerated at build time.
        </p>
        <p>
          <b>Instrumentation.</b> Per-realm CPU and directional BTS↔MTS wire breakdowns appear only
          when that exact environment captured them. Missing instruments never borrow values from
          the other environment.
        </p>
      </div>
      <div className="receipt-foot">
        exact checkpoint <code>{checkpoint?.id ?? snapshot.id}</code>
      </div>
    </details>
  );
}
