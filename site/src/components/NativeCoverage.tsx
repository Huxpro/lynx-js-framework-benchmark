import { useMemo } from 'react';

import {
  NativeCoverageCell,
  NativeCoverageStatus,
  shortLabel,
} from '../data';
import { useBenchmarkData } from '../data-context';
import { Locale, localizedWorkload, useI18n } from '../i18n';
import { ResponsiveCopy } from './ResponsiveCopy';

const STATUS_ORDER: NativeCoverageStatus[] = [
  'measured',
  'measured-with-dnf',
  'not-reportable',
  'dnf',
  'unsupported',
  'unscheduled',
  'invalid-incomparable',
  'display-derivation-bug',
];

export const COVERAGE_LABELS: Record<NativeCoverageStatus, string> = {
  measured: 'measured',
  'measured-with-dnf': 'measured + DNF',
  'not-reportable': 'not reportable',
  dnf: 'DNF',
  unsupported: 'unsupported',
  unscheduled: 'not scheduled',
  'invalid-incomparable': 'invalid cohort',
  'display-derivation-bug': 'display bug',
};

const COVERAGE_LABELS_ZH: Record<NativeCoverageStatus, string> = {
  measured: '已测量',
  'measured-with-dnf': '已测量 + DNF',
  'not-reportable': '不可报告',
  dnf: 'DNF',
  unsupported: '不支持',
  unscheduled: '未调度',
  'invalid-incomparable': 'cohort 无效',
  'display-derivation-bug': '展示缺陷',
};

export function coverageCellLabel(
  cell: NativeCoverageCell | undefined,
  locale: Locale = 'en',
): string {
  if (!cell) return locale === 'zh-CN' ? '合约外' : 'outside contract';
  const categories = cell.record?.failureCategories ?? [];
  const suffix = categories.length > 0 ? `: ${categories.join(', ')}` : '';
  return `${locale === 'zh-CN' ? COVERAGE_LABELS_ZH[cell.status] : COVERAGE_LABELS[cell.status]}${suffix}`;
}

function cellLabel(cell: NativeCoverageCell, locale: Locale): string {
  const scale = cell.scale.toLocaleString();
  return cell.suite === 'startup'
    ? `${locale === 'zh-CN' ? '启动' : 'startup'} · ${cell.metric} @ ${scale}`
    : `${localizedWorkload(cell.workload, locale)} @ ${scale}`;
}

function CoverageRows({ cells }: { cells: NativeCoverageCell[] }) {
  const { locale } = useI18n();
  return (
    <div className="coverage-cells">
      {cells.map((cell) => (
        <div className="coverage-cell" data-status={cell.status} key={cell.key}>
          <span>{cellLabel(cell, locale)}</span>
          <strong title={cell.reason ?? cell.record?.failureCategories.join(', ') ?? undefined}>
            {coverageCellLabel(cell, locale)}
          </strong>
        </div>
      ))}
    </div>
  );
}

export function NativeCoverage() {
  const { locale, text } = useI18n();
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
          <div className="observation-kicker">{text('Appendix · Native coverage contract', '附录 · Native 覆盖合约')}</div>
          <h2 id="native-coverage-title">{text(`${coverage.expectedCellCount} cells, none implicit`, `${coverage.expectedCellCount} 个单元，无任何隐式项`)}</h2>
        </div>
        <code>{coverage.version}</code>
      </div>
      <ResponsiveCopy className="section-copy">
        {text(
          'Every featured entry has 15 table-latency cells and eight startup cells. Only one complete machine + lease + method + input-receipt cohort can enter rankings; archived measurements remain evidence, but cannot fill this ledger.',
          '每个 featured 条目都有 15 个表格延迟单元和 8 个启动单元。只有一个完整且一致的 machine + lease + method + input-receipt cohort 可以进入排名；归档测量仍作为证据保留，但不能填充这份台账。',
        )}
      </ResponsiveCopy>
      <div className="coverage-summary" aria-label={text('Native coverage status totals', 'Native 覆盖状态总计')}>
        {STATUS_ORDER.filter((status) => (coverage.summary[status] ?? 0) > 0).map((status) => (
          <div data-status={status} key={status}>
            <strong>{coverage.summary[status]}</strong>
            <span>{locale === 'zh-CN' ? COVERAGE_LABELS_ZH[status] : COVERAGE_LABELS[status]}</span>
          </div>
        ))}
      </div>
      <div className="coverage-receipt">
        <span>{text('contract', '合约')} <code>{coverage.contractSha256.slice(0, 12)}</code></span>
        {nativeCohort?.campaign ? (
          <>
            <span>{text('campaign', '批次')} <code>{nativeCohort.campaign.id}</code></span>
            <span>{text('inputs', '输入')} <code>{nativeCohort.campaign.inputReceiptSha256.slice(0, 12)}</code></span>
          </>
        ) : <span>{text('no publishable Native cohort', '无可发布 Native cohort')}</span>}
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
                  `${counts[status]} ${locale === 'zh-CN' ? COVERAGE_LABELS_ZH[status] : COVERAGE_LABELS[status]}`
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
