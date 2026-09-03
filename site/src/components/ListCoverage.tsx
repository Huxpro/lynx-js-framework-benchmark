import { useMemo } from 'react';

import { ListCoverageStatus, shortLabel } from '../data';
import { useBenchmarkData } from '../data-context';
import { useI18n } from '../i18n';
import { ResponsiveCopy } from './ResponsiveCopy';

const STATUS_ORDER: ListCoverageStatus[] = [
  'measured', 'measured-with-dnf', 'dnf', 'not-measured',
  'unsupported', 'unscheduled', 'invalid-incomparable',
];

const LABELS: Record<ListCoverageStatus, [string, string]> = {
  measured: ['measured', '已测量'],
  'measured-with-dnf': ['measured + DNF', '已测量 + DNF'],
  dnf: ['DNF', 'DNF'],
  'not-measured': ['not measured', '未测量'],
  unsupported: ['unsupported', '不支持'],
  unscheduled: ['not scheduled', '未调度'],
  'invalid-incomparable': ['invalid', '无效'],
};

const workloadLabel = (workload: string, scale: number) =>
  `${workload.replace('list-', '')} @${scale.toLocaleString()}`;

export function ListCoverage({ harness }: { harness: string }) {
  const { locale, text } = useI18n();
  const { snapshot } = useBenchmarkData();
  const coverage = snapshot.listCoverage;
  const cells = useMemo(
    () => coverage.cells.filter((cell) => cell.harness === harness),
    [coverage, harness],
  );
  if (cells.length === 0) return null;
  const label = (status: ListCoverageStatus) => LABELS[status][locale === 'zh-CN' ? 1 : 0];

  return (
    <section className="native-coverage list-coverage" aria-labelledby="list-coverage-title">
      <div className="coverage-heading">
        <div>
          <div className="observation-kicker">
            {text('List virtualization contract', '列表虚拟化合约')}
          </div>
          <h2 id="list-coverage-title">
            {text(`${cells.length} ${harness} cases, none inferred`, `${cells.length} 个 ${harness} case，不做推断`)}
          </h2>
        </div>
        <code>{coverage.version}</code>
      </div>
      <ResponsiveCopy className="section-copy">
        {text(
          'A separate fixture capability for declarative list/list-item workloads. Startup, one-viewport recycle, and fixed-velocity fling never reuse eager-table numbers. Blank frames are measured data; only a failed driver or capture is DNF.',
          '这是声明式 list/list-item workload 的独立 fixture 能力。启动、单 viewport recycle 与固定速度 fling 绝不复用 eager-table 数字。空白帧属于测量数据；只有 driver 或采集失败才是 DNF。',
        )}
      </ResponsiveCopy>
      <div className="coverage-summary" aria-label={text('List capability totals', '列表能力状态总计')}>
        {STATUS_ORDER.map((status) => {
          const count = cells.filter((cell) => cell.status === status).length;
          return count > 0 ? (
            <div data-status={status} key={status}>
              <strong>{count}</strong><span>{label(status)}</span>
            </div>
          ) : null;
        })}
      </div>
      <div className="coverage-receipt">
        <span>{text('contract', '合约')} <code>{coverage.contractSha256.slice(0, 12)}</code></span>
        <span>{text('fixture', 'fixture')} <code>{coverage.fixtureProtocol}</code></span>
        <span>{coverage.config.viewport.widthPx}×{coverage.config.viewport.heightPx}px</span>
        <span>{coverage.config.fling.velocityPxPerSecond}px/s · {coverage.config.fling.durationMs}ms</span>
        <span>{text('input', '输入')} <code>{coverage.config.input[harness as 'web' | 'native'].fling}</code></span>
        <span>{text('observer', '观测器')} <code>{coverage.config.observation[harness as 'web' | 'native']}</code></span>
      </div>
      <div className="coverage-ledger">
        {coverage.entryIds.map((entryId) => {
          const entryCells = cells.filter((cell) => cell.entry === entryId);
          const counts = STATUS_ORDER.map((status) => {
            const count = entryCells.filter((cell) => cell.status === status).length;
            return count > 0 ? `${count} ${label(status)}` : null;
          }).filter(Boolean).join(' · ');
          return (
            <details key={entryId}>
              <summary><span>{shortLabel(entryId)}</span><span>{counts}</span></summary>
              <div className="coverage-cells">
                {entryCells.map((cell) => (
                  <div className="coverage-cell" data-status={cell.status} key={cell.key}>
                    <span title={`source: ${cell.sourceMetrics.join(', ')}; derived: ${cell.derivedMetrics.join(', ') || 'none'}`}>
                      {workloadLabel(cell.workload, cell.scale)}
                    </span>
                    <strong title={cell.reason ?? undefined}>{label(cell.status)}</strong>
                  </div>
                ))}
              </div>
            </details>
          );
        })}
      </div>
    </section>
  );
}
