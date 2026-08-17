import { useMemo } from 'react';

import {
  NativeCoverageCell,
  NativeCoverageStatus,
  shortLabel,
} from '../data';
import { useBenchmarkData } from '../data-context';

const STATUS_ORDER: NativeCoverageStatus[] = [
  'measured',
  'measured-with-dnf',
  'dnf',
  'unsupported',
  'unscheduled',
  'invalid-incomparable',
  'display-derivation-bug',
];

export const COVERAGE_LABELS: Record<NativeCoverageStatus, string> = {
  measured: 'measured',
  'measured-with-dnf': 'measured + DNF',
  dnf: 'DNF',
  unsupported: 'unsupported',
  unscheduled: 'not scheduled',
  'invalid-incomparable': 'invalid cohort',
  'display-derivation-bug': 'display bug',
};

export function coverageCellLabel(cell: NativeCoverageCell | undefined): string {
  if (!cell) return 'outside contract';
  const categories = cell.record?.failureCategories ?? [];
  const suffix = categories.length > 0 ? `: ${categories.join(', ')}` : '';
  return `${COVERAGE_LABELS[cell.status]}${suffix}`;
}

function cellLabel(cell: NativeCoverageCell): string {
  const scale = cell.scale.toLocaleString();
  return cell.suite === 'startup'
    ? `startup · ${cell.metric} @ ${scale}`
    : `${cell.workload} @ ${scale}`;
}

function CoverageRows({ cells }: { cells: NativeCoverageCell[] }) {
  return (
    <div className="coverage-cells">
      {cells.map((cell) => (
        <div className="coverage-cell" data-status={cell.status} key={cell.key}>
          <span>{cellLabel(cell)}</span>
          <strong title={cell.reason ?? cell.record?.failureCategories.join(', ') ?? undefined}>
            {coverageCellLabel(cell)}
          </strong>
        </div>
      ))}
    </div>
  );
}

export function NativeCoverage() {
  const { snapshot } = useBenchmarkData();
  const coverage = snapshot.nativeCoverage;
  const nativeCohort = snapshot.comparison.harnesses.find(({ harness }) => harness === 'native');
  const byEntry = useMemo(() => new Map(coverage.entryIds.map((entryId) => [
    entryId,
    coverage.cells.filter((cell) => cell.entry === entryId),
  ])), [coverage]);

  return (
    <section className="native-coverage" aria-labelledby="native-coverage-title">
      <div className="coverage-heading">
        <div>
          <div className="observation-kicker">Native coverage contract</div>
          <h2 id="native-coverage-title">{coverage.expectedCellCount} cells, none implicit</h2>
        </div>
        <code>{coverage.version}</code>
      </div>
      <p>
        Every featured entry has 27 table-latency cells and eight startup cells. Only one complete
        machine + lease + method + input-receipt cohort can enter rankings; archived measurements
        remain evidence, but cannot fill this ledger.
      </p>
      <div className="coverage-summary" aria-label="Native coverage status totals">
        {STATUS_ORDER.filter((status) => (coverage.summary[status] ?? 0) > 0).map((status) => (
          <div data-status={status} key={status}>
            <strong>{coverage.summary[status]}</strong>
            <span>{COVERAGE_LABELS[status]}</span>
          </div>
        ))}
      </div>
      <div className="coverage-receipt">
        <span>contract <code>{coverage.contractSha256.slice(0, 12)}</code></span>
        {nativeCohort?.campaign ? (
          <>
            <span>campaign <code>{nativeCohort.campaign.id}</code></span>
            <span>inputs <code>{nativeCohort.campaign.inputReceiptSha256.slice(0, 12)}</code></span>
          </>
        ) : <span>no publishable Native cohort</span>}
      </div>
      <div className="coverage-ledger">
        {coverage.entryIds.map((entryId) => {
          const cells = byEntry.get(entryId) ?? [];
          const counts = Object.fromEntries(STATUS_ORDER.map((status) => [
            status, cells.filter((cell) => cell.status === status).length,
          ]));
          return (
            <details key={entryId}>
              <summary>
                <span>{shortLabel(entryId)}</span>
                <span>{STATUS_ORDER.filter((status) => counts[status] > 0).map((status) => (
                  `${counts[status]} ${COVERAGE_LABELS[status]}`
                )).join(' · ')}</span>
              </summary>
              <CoverageRows cells={cells} />
            </details>
          );
        })}
      </div>
    </section>
  );
}
