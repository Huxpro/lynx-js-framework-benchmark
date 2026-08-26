import { useMemo, useState } from 'react';

import {
  AXIS_EFFECTS,
  AxisEffectMetric,
  AxisEffectPair,
  AxisName,
  ENTRY_BY_ID,
  fmtMs,
} from '../data';
import { useI18n } from '../i18n';
import { ResponsiveCopy } from './ResponsiveCopy';

const AXIS_LABELS: Record<AxisName, [string, string]> = {
  invalidation: ['① invalidation source', '① 失效来源'],
  recompute: ['② recompute granularity', '② 重算粒度'],
  sharing: ['③ sharing degree', '③ 共享程度'],
  staging: ['④ staging', '④ 分段形态'],
  residency: ['⑤ driver residency', '⑤ 驱动驻留'],
  handover: ['⑥ handover', '⑥ 交接'],
};

function number(value: number, unit: string) {
  if (unit === 'ms') return fmtMs(value);
  if (unit === 'bytes') return `${Math.round(value).toLocaleString()} B`;
  return `${value.toFixed(Math.abs(value) < 10 ? 2 : 1)} ${unit}`;
}

function metricLabel(effect: AxisEffectMetric) {
  return `${effect.metric} · ${effect.workload}@${effect.scale.toLocaleString()}`;
}

function EffectsTable({
  effects,
  claim,
}: {
  effects: AxisEffectMetric[];
  claim: 'axis' | 'descriptive' | 'residue';
}) {
  const { text } = useI18n();
  if (!effects.length) return null;
  return (
    <div className="axis-effect-table-wrap">
      <table className="axis-effect-table">
        <thead>
          <tr>
            <th>{text('metric', '指标')}</th>
            <th>{text('against', '对照')}</th>
            <th>{text('entry', '条目')}</th>
            <th>Δ median</th>
            <th>CI</th>
            <th>{text('ranges', '范围')}</th>
            <th>{text('claim', '结论级别')}</th>
          </tr>
        </thead>
        <tbody>
          {effects.map((effect) => (
            <tr key={`${effect.suite}:${effect.harness}:${effect.workload}:${effect.scale}:${effect.metric}:${effect.boundary}`}>
              <td><code>{metricLabel(effect)}</code><small>{effect.harness} · {effect.boundary}</small></td>
              <td>{number(effect.against.median, effect.unit)}<small>n={effect.against.n}</small></td>
              <td>{number(effect.entry.median, effect.unit)}<small>n={effect.entry.n}</small></td>
              <td className={effect.medianDelta < 0 ? 'is-negative' : effect.medianDelta > 0 ? 'is-positive' : ''}>
                {effect.medianDelta > 0 ? '+' : ''}{number(effect.medianDelta, effect.unit)}
                {effect.relativeDelta != null && <small>{effect.relativeDelta > 0 ? '+' : ''}{(effect.relativeDelta * 100).toFixed(1)}%</small>}
              </td>
              <td>{effect.ci95 == null ? '—' : <>{number(effect.ci95.low, effect.unit)} … {number(effect.ci95.high, effect.unit)}</>}</td>
              <td>{effect.rangesDisjoint == null ? '—' : effect.rangesDisjoint
                ? text('disjoint', '不重叠')
                : text('overlap', '重叠')}</td>
              <td>{claim === 'axis'
                ? text('axis effect', '轴效应')
                : claim === 'residue'
                  ? text('implementation residue', '实现残差')
                  : text('descriptive only', '仅描述')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function coordinates(pair: AxisEffectPair) {
  if (!pair.coordinates.context) return 'unclassified';
  return Object.entries(pair.coordinates.context).map(([axis, value]) => `${axis}=${value}`).join(' · ');
}

function PairCard({ pair }: { pair: AxisEffectPair }) {
  const { text } = useI18n();
  const against = ENTRY_BY_ID.get(pair.against)?.label ?? pair.against;
  const entry = ENTRY_BY_ID.get(pair.entry)?.label ?? pair.entry;
  const effects = pair.attributable ? pair.effects : pair.descriptiveEffects;
  const status = pair.validation.status === 'validated'
    ? text('validated single-axis pair', '已校验单轴 pair')
    : pair.validation.status === 'coupled'
      ? text('controlled coupled move', '受控耦合移动')
      : text('excluded: failed controls', '已排除：控制校验失败');
  return (
    <article className="axis-pair">
      <header className="axis-pair-head">
        <div>
          <b>{against} → {entry}</b>
          <span className={`axis-status is-${pair.validation.status}`}>{status}</span>
        </div>
        <code>{pair.delta}</code>
      </header>
      <p className="axis-context">
        {text('Local coordinate context:', '局部坐标上下文：')} <code>{coordinates(pair)}</code>
      </p>
      {pair.coupled.length > 0 && (
        <p className="axis-warning">
          {text(
            `Also moves ${pair.coupled.join(', ')}. The measurements stay visible, but none are admitted to ${pair.axis} attribution.`,
            `同时移动 ${pair.coupled.join('、')}。测量仍保留，但不会进入 ${pair.axis} 轴归因。`,
          )}
        </p>
      )}
      {pair.validation.reasons.length > 0 && (
        <p className="axis-warning"><code>{pair.validation.reasons.join(' · ')}</code></p>
      )}
      {pair.validation.run && (
        <p className="axis-source">
          <code>{pair.validation.run.sourceRunFile}</code> · {pair.validation.run.cells} {text('cells', '单元')} · n≥{pair.validation.run.minimumReps}
        </p>
      )}
      <details open={effects.length <= 12}>
        <summary>{text(`${effects.length} measured metric effects`, `${effects.length} 项测量效应`)}</summary>
        <EffectsTable effects={effects} claim={pair.attributable ? 'axis' : 'descriptive'} />
      </details>

      {pair.ceiling.separated && (
        <div className="axis-ceiling">
          <h4>{text('Ceiling decomposition', 'ceiling 分解')}</h4>
          <p>{text(
            'Axis effect and implementation residue are separate quantities. A residue is entry − its own hand-written ceiling; it is never relabelled as an axis effect.',
            '轴效应与实现残差是两个独立量。残差定义为条目 − 自身手写 ceiling，绝不会改名为轴效应。',
          )}</p>
          {pair.ceiling.axisEffect && (
            <details>
              <summary>{text('ceiling → ceiling axis effect', 'ceiling → ceiling 轴效应')}</summary>
              <EffectsTable effects={pair.ceiling.axisEffect.effects} claim="axis" />
            </details>
          )}
          {Object.entries(pair.ceiling.implementationResidue).map(([side, residue]) => residue && (
            <details key={side} open>
              <summary>{text(
                `${side} implementation residue · ceiling ${residue.ceilingEntry}`,
                `${side} 实现残差 · ceiling ${residue.ceilingEntry}`,
              )}</summary>
              <EffectsTable effects={residue.effects} claim="residue" />
            </details>
          ))}
        </div>
      )}
    </article>
  );
}

export function AxisEffects() {
  const { locale, text } = useI18n();
  const populatedAxes = useMemo(() => AXIS_EFFECTS.axes.filter((axis) => axis.pairCount > 0), []);
  const [requestedAxis, setRequestedAxis] = useState<AxisName | null>(null);
  const active = populatedAxes.find((axis) => axis.axis === requestedAxis) ?? populatedAxes[0];
  if (!active) return null;
  return (
    <section className="axis-effects" aria-labelledby="axis-effects-title">
      <div className="section-heading">
        <div className="section-kicker">⚗ Lab · {text('derived only', '仅派生视图')}</div>
        <h2 id="axis-effects-title">{text('Axis effects, not framework rankings', '轴效应，而非框架排名')}</h2>
        <ResponsiveCopy className="section-copy">
          {text(
            'Cross-framework points describe the space but never identify an axis effect. Only a same-codebase, same-fixture, same-run pair that changes one coordinate is causal here. The view reports per-pair effects and direction consistency only—no regression or interaction fitting.',
            '跨框架点只能描述空间，不能识别轴效应。这里只允许同代码库、同 fixture、同一次运行且只改变一个坐标的 pair 做因果归因。视图只报告逐 pair 效应与方向一致性——不做回归或交互拟合。',
          )}
        </ResponsiveCopy>
      </div>
      <div className="chips axis-tabs" role="tablist" aria-label={text('Design axis', '设计轴')}>
        {populatedAxes.map((axis) => (
          <button
            type="button"
            className="chip"
            role="tab"
            aria-selected={axis === active}
            key={axis.axis}
            onClick={() => setRequestedAxis(axis.axis)}
          >
            {AXIS_LABELS[axis.axis][locale === 'zh-CN' ? 1 : 0]}
            <small>{axis.attributablePairCount}/{axis.pairCount}</small>
          </button>
        ))}
      </div>
      {active.instrument?.status === 'pending' && (
        <p className="axis-instrument-placeholder">
          {text('Axis ④ segment attribution: waiting for #200 source records; no proxy estimate is substituted.', '轴④分段归因：等待 #200 的 source records；不会用代理估算替代。')}{' '}
          <a href={active.instrument.issue} target="_blank" rel="noreferrer">Huxpro/octane#200 ↗</a>
        </p>
      )}
      <div className="axis-summary">
        <b>{AXIS_LABELS[active.axis][locale === 'zh-CN' ? 1 : 0]}</b>
        <span>{active.attributablePairCount}/{active.pairCount} {text('pairs attributable', '个 pair 可归因')}</span>
        <span>{active.directionConsistency.length
          ? text(`${active.directionConsistency.filter((item) => item.consistent).length}/${active.directionConsistency.length} metric contexts direction-consistent`, `${active.directionConsistency.filter((item) => item.consistent).length}/${active.directionConsistency.length} 个指标上下文方向一致`)
          : text('direction consistency unavailable until a validated pair exists', '需有已校验 pair 后才报告方向一致性')}</span>
      </div>
      {active.pairs.map((pair) => <PairCard pair={pair} key={pair.id} />)}
    </section>
  );
}
