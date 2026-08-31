import { useState } from 'react';

import {
  AXIS_EFFECTS,
  AxisEvidenceComparison,
  AxisEvidenceObservation,
  AxisEvidenceVerdict,
  AxisName,
} from '../data';
import { useI18n } from '../i18n';

const AXES: AxisName[] = [
  'invalidation', 'recompute', 'sharing', 'staging', 'residency', 'handover',
];

const AXIS_LABELS: Record<AxisName, {
  label: [string, string];
  question: [string, string];
  instrument: string;
}> = {
  invalidation: {
    label: ['Invalidation trigger', '失效触发'],
    question: ['What change makes old output stale?', '什么变化会让旧结果失效？'],
    instrument: 'update · storm',
  },
  recompute: {
    label: ['Recompute scope', '重算范围'],
    question: ['How much work is recomputed?', '每次需要重算多少工作？'],
    instrument: 'update · storm',
  },
  sharing: {
    label: ['Result sharing', '结果共享'],
    question: ['Which work or results can be shared?', '哪些工作或结果可以共享？'],
    instrument: 'bundle · adoption',
  },
  staging: {
    label: ['Execution form', '执行形态'],
    question: ['In what form is the work executed?', '工作以什么形态执行？'],
    instrument: 'pipeline',
  },
  residency: {
    label: ['Thread residency', '线程位置'],
    question: ['Which thread performs the work?', '工作在哪个线程执行？'],
    instrument: 'realm CPU',
  },
  handover: {
    label: ['Thread handover', '线程交接'],
    question: ['What crosses the thread boundary?', '两个线程之间需要交接什么？'],
    instrument: 'wire',
  },
};

const COPY: Record<string, { title: [string, string]; conclusion: [string, string] }> = {
  'octane-core-switch': {
    title: ['Universal core → block core', 'Universal core → block core'],
    conclusion: [
      'Bundle size moved, but recompute and sharing changed together.',
      'Bundle 体积发生变化，但重算范围与共享方式同时改变。',
    ],
  },
  'octane-template-program': {
    title: ['Template → compiled program', '解释模板 → 编译程序'],
    conclusion: [
      'First screen improved 36–42%; three architecture axes moved together.',
      '首屏改善 36–42%；三条架构轴同时变化。',
    ],
  },
  'octane-adoption-inversion': {
    title: ['Tree adoption → slot state', '整树 adoption → slot state'],
    conclusion: [
      'Adoption work disappeared, alongside changes to sharing and staging.',
      'Adoption 工作消失，同时共享与执行形态也发生变化。',
    ],
  },
  'vue-feature-matrix': {
    title: ['Vue × Vapor × IFR/ET', 'Vue × Vapor × IFR/ET'],
    conclusion: [
      'A useful design-space map, not a one-switch ablation.',
      '这是有用的设计空间地图，不是单开关消融实验。',
    ],
  },
  'octane-sync-residue': {
    title: ['Upstream sync', '同步 upstream'],
    conclusion: [
      'Coordinates stayed fixed and the create gap remained: implementation residue.',
      '坐标保持不变，create 差距仍在：这是实现残差。',
    ],
  },
  'octane-wire-fix-residue': {
    title: ['Wire-reply fixes', 'Wire reply 修复'],
    conclusion: [
      'At fixed coordinates, 10k MTS→BTS traffic fell from 17.4 MB to 727 B.',
      '坐标不变时，10k MTS→BTS 流量从 1742 万 B 降至 727 B。',
    ],
  },
};

const VERDICT_LABELS: Record<AxisEvidenceVerdict, [string, string]> = {
  attributable: ['attributable', '可归因'],
  coupled: ['coupled', '多轴耦合'],
  descriptive: ['descriptive', '描述性'],
  uncontrolled: ['uncontrolled', '控制不足'],
  'implementation-residue': ['residue', '实现残差'],
};

const OBSERVATION_LABELS: Record<string, string> = {
  'background bundle gzip': '后台 bundle gzip',
  'main-thread bundle gzip': '主线程 bundle gzip',
  'first screen @1k': '首屏 @1k',
  'first screen @10k': '首屏 @10k',
  'first screen @30k': '首屏 @30k',
  'adoption selectors @1k': 'adoption selector @1k',
  'adoption selectors @10k': 'adoption selector @10k',
  'adoption selectors @30k': 'adoption selector @30k',
  'nine-cell gap vs upstream': '九项加权差距（相对 upstream）',
  'create @10k vs upstream': 'create @10k（相对 upstream）',
  'MTS→BTS wire @10k': 'MTS→BTS 传输量 @10k',
  'latency @10k': '延迟 @10k',
  'BTS CPU @10k': 'BTS CPU @10k',
  'heap after clear @10k': '清空后 heap @10k',
};

const CONTROL_LABELS: Record<string, [string, string]> = {
  sameCodebase: ['same codebase', '同一代码库'],
  sameFixture: ['same fixture', '同一 fixture'],
  singlePhysicalRun: ['one physical run', '同一次物理 run'],
  singleBuildVariable: ['one build variable', '单一 build 变量'],
};

function fmt(value: number, unit: string) {
  if (unit === 'bytes') {
    if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(2)} MB`;
    if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)} kB`;
    return `${Math.round(value).toLocaleString()} B`;
  }
  if (unit === 'ms') return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} ms`;
  if (unit === 'ratio') return `${value.toFixed(4)}×`;
  return value.toLocaleString();
}

function deltaLabel(observation: AxisEvidenceObservation) {
  if (observation.relativeDelta == null) return null;
  const percent = observation.relativeDelta * 100;
  return `${percent > 0 ? '+' : ''}${percent.toFixed(Math.abs(percent) >= 10 ? 0 : 1)}%`;
}

function barWidth(value: number, observation: AxisEvidenceObservation) {
  const max = Math.max(Math.abs(observation.before.value), Math.abs(observation.after.value), 1);
  return `${Math.max(2, Math.abs(value) / max * 100)}%`;
}

function ObservationPlot({ observation }: { observation: AxisEvidenceObservation }) {
  const { locale } = useI18n();
  const label = locale === 'zh-CN'
    ? OBSERVATION_LABELS[observation.label] ?? observation.label
    : observation.label;
  return (
    <li className={`axis-observation is-${observation.direction}`}>
      <div className="axis-observation-label">
        <span>{label}</span><em>{deltaLabel(observation)}</em>
      </div>
      <div className="axis-bar-row">
        <small>{observation.before.label}</small>
        <i><span className="is-before" style={{ width: barWidth(observation.before.value, observation) }} /></i>
        <b>{fmt(observation.before.value, observation.unit)}</b>
      </div>
      <div className="axis-bar-row">
        <small>{observation.after.label}</small>
        <i><span className="is-after" style={{ width: barWidth(observation.after.value, observation) }} /></i>
        <b>{fmt(observation.after.value, observation.unit)}</b>
      </div>
    </li>
  );
}

function EvidenceDetail({ comparison }: { comparison: AxisEvidenceComparison }) {
  const { locale, text } = useI18n();
  const zh = locale === 'zh-CN';
  const copy = COPY[comparison.id];
  return (
    <article className={`axis-detail is-${comparison.verdict}`} aria-live="polite">
      <header className="axis-detail-head">
        <div>
          <span className="axis-verdict">{VERDICT_LABELS[comparison.verdict][zh ? 1 : 0]}</span>
          <h3>{copy?.title[zh ? 1 : 0] ?? comparison.title}</h3>
        </div>
        <p>{copy?.conclusion[zh ? 1 : 0]}</p>
      </header>

      <div className="axis-detail-grid">
        <section aria-labelledby="axis-observations-title">
          <h4 id="axis-observations-title">{text('Observed movement', '观测变化')}</h4>
          {comparison.observations.length ? (
            <ul className="axis-observations">
              {comparison.observations.map((observation) => (
                <ObservationPlot observation={observation} key={`${observation.label}:${observation.metric}:${observation.scale ?? 'all'}`} />
              ))}
            </ul>
          ) : <p className="axis-empty-observation">{text('No comparable metric pair.', '没有可比较的指标 pair。')}</p>}
        </section>

        <aside className="axis-coordinate-audit">
          <h4>{text('Coordinate delta', '坐标变化')}</h4>
          <div className="axis-coordinate-map">
            {AXES.map((axis, index) => {
              const changed = comparison.changedAxes.includes(axis);
              return (
                <span className={changed ? 'is-changed' : ''} key={axis}>
                  <i>{index + 1}</i><b>{AXIS_LABELS[axis].label[zh ? 1 : 0]}</b><small>{changed ? text('changed', '变化') : text('fixed', '不变')}</small>
                </span>
              );
            })}
          </div>
          <h4>{text('Controls', '控制条件')}</h4>
          <ul className="axis-controls">
            {Object.entries(comparison.controls).map(([key, value]) => (
              <li data-state={value === true ? 'yes' : value === false ? 'no' : 'unknown'} key={key}>
                <i>{value === true ? '✓' : value === false ? '×' : '?'}</i>
                <span>{CONTROL_LABELS[key][zh ? 1 : 0]}</span>
              </li>
            ))}
          </ul>
          <details className="axis-audit">
            <summary>{text('Audit receipt', '审计回执')}</summary>
            <span>{comparison.auditEffectCount} {text('metric cells', '个指标单元')}</span>
            <a href={comparison.source.url} target="_blank" rel="noreferrer">{comparison.source.label} ↗</a>
          </details>
        </aside>
      </div>
    </article>
  );
}

export function AxisEffects() {
  const { locale, text } = useI18n();
  const ledger = AXIS_EFFECTS.ledger;
  const [requestedId, setRequestedId] = useState<string | null>(null);
  if (!ledger?.comparisons.length) return null;
  const active = ledger.comparisons.find((comparison) => comparison.id === requestedId)
    ?? ledger.comparisons[0];
  const zh = locale === 'zh-CN';

  const rows = (group: AxisEvidenceComparison['group']) => ledger.comparisons
    .filter((comparison) => comparison.group === group)
    .map((comparison) => {
      const selected = comparison.id === active.id;
      return (
        <tr className={selected ? 'is-selected' : ''} key={comparison.id}>
          <th scope="row">
            <button type="button" aria-pressed={selected} onClick={() => setRequestedId(comparison.id)}>
              <span>{COPY[comparison.id]?.title[zh ? 1 : 0] ?? comparison.title}</span>
              <small>{comparison.subjects.join(' × ')}</small>
            </button>
          </th>
          {AXES.map((axis) => (
            <td data-changed={comparison.changedAxes.includes(axis) ? 'true' : 'false'} key={axis}>
              <span aria-label={comparison.changedAxes.includes(axis) ? text('changed', '变化') : text('fixed', '不变')} />
            </td>
          ))}
          <td><span className="axis-row-verdict">{VERDICT_LABELS[comparison.verdict][zh ? 1 : 0]}</span></td>
        </tr>
      );
    });

  return (
    <section className="axis-effects" id="lab-attribution" aria-labelledby="axis-effects-title">
      <div className="axis-section-heading">
        <div>
          <p className="section-kicker">01 · {text('Architecture attribution', '架构归因')}</p>
          <h2 id="axis-effects-title">{text('Six-axis experiment ledger', '六轴实验账本')}</h2>
        </div>
        <div className="axis-summary-strip" aria-label={text('Attribution summary', '归因摘要')}>
          <span><b>{ledger.summary.comparisonCount}</b>{text('comparisons', '组对照')}</span>
          <span><b>{ledger.summary.attributableCount}</b>{text('single-axis', '单轴归因')}</span>
          <span><b>{ledger.summary.implementationResidueCount}</b>{text('fixed-coordinate', '同坐标残差')}</span>
        </div>
      </div>

      <div className="axis-definition-heading">
        <b>{text('Six coordinates, six questions', '六条轴，分别回答六个问题')}</b>
        <span>{text('A comparison changes an axis when its answer changes.', '一组对照中，只要答案改变，对应坐标就算发生变化。')}</span>
      </div>
      <ol className="axis-definitions" aria-label={text('Definitions of the six architecture axes', '六条架构轴的定义')}>
        {AXES.map((axis, index) => (
          <li key={axis}>
            <i>{index + 1}</i>
            <span>
              <b>{AXIS_LABELS[axis].label[zh ? 1 : 0]}</b>
              <small>{AXIS_LABELS[axis].question[zh ? 1 : 0]}</small>
            </span>
          </li>
        ))}
      </ol>

      <div className="axis-matrix-scroll">
        <table className="axis-matrix">
          <thead>
            <tr>
              <th>{text('Experiment', '实验')}</th>
              {AXES.map((axis, index) => (
                <th key={axis}>
                  <span>{index + 1}</span>{AXIS_LABELS[axis].label[zh ? 1 : 0]}
                </th>
              ))}
              <th>{text('Verdict', '判定')}</th>
            </tr>
          </thead>
          <tbody>
            <tr className="axis-group-row"><th colSpan={8}>{text('Architecture comparisons', '架构对照')}</th></tr>
            {rows('architecture')}
            <tr className="axis-group-row"><th colSpan={8}>{text('Same-coordinate controls', '同坐标控制')}</th></tr>
            {rows('residue')}
          </tbody>
        </table>
      </div>
      <div className="axis-matrix-key">
        <span><i className="is-changed" />{text('coordinate changed', '坐标变化')}</span>
        <span><i />{text('coordinate fixed', '坐标不变')}</span>
        <b>{text('Select a row to inspect its evidence.', '选择一行查看证据。')}</b>
      </div>

      <EvidenceDetail comparison={active} />

      <div className="axis-instrument-map" aria-label={text('Axis instruments', '架构轴测量工具')}>
        {AXES.map((axis, index) => (
          <span key={axis}>
            <i>{index + 1}</i><b>{AXIS_LABELS[axis].label[zh ? 1 : 0]}</b><small>{AXIS_LABELS[axis].instrument}</small>
          </span>
        ))}
      </div>
      <details className="axis-method-note">
        <summary>{text('Attribution boundary', '归因边界')}</summary>
        <span>{text(
          'Single-axis attribution requires the same codebase and fixture with exactly one changed coordinate. Coupled and cross-framework comparisons remain descriptive; implementation residue is reported separately.',
          '单轴归因要求同一代码库、同一 fixture 且恰好一条坐标变化。多轴与跨框架对照只作描述，实现残差单独报告。',
        )}</span>
      </details>
    </section>
  );
}
