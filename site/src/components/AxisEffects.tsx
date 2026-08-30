import {
  AXIS_EFFECTS,
  AxisEvidenceComparison,
  AxisEvidenceObservation,
  AxisEvidenceVerdict,
  AxisName,
} from '../data';
import { useI18n } from '../i18n';

const AXIS_LABELS: Record<AxisName, [string, string]> = {
  invalidation: ['① invalidation', '① 什么会触发失效'],
  recompute: ['② recompute', '② 重算多大范围'],
  sharing: ['③ sharing', '③ 有多少结果可共享'],
  staging: ['④ staging', '④ 工作以什么形态执行'],
  residency: ['⑤ residency', '⑤ 工作在哪个线程'],
  handover: ['⑥ handover', '⑥ 两个线程交接什么'],
};

const COPY: Record<string, { title: [string, string]; conclusion: [string, string] }> = {
  'octane-core-switch': {
    title: ['Switching universal core to block core', '把 universal core 换成 block core'],
    conclusion: [
      'The background bundle shrank, but recompute and sharing changed together. The saving cannot be assigned to either axis alone.',
      '后台包体确实变小了，但“重算范围”和“共享方式”同时改变，不能把节省单独记到其中一条轴上。',
    ],
  },
  'octane-template-program': {
    title: ['Interpreted template versus compiled program', '解释模板与编译程序对比'],
    conclusion: [
      'First screen improved by 36–42%, but sharing, staging, and handover all moved. This proves the combined design is faster here—not which axis caused it.',
      '首屏快了 36–42%，但共享、执行形态和线程交接一起变了。它只证明这套组合在这里更快，不能说明是哪条轴造成的。',
    ],
  },
  'octane-adoption-inversion': {
    title: ['Tree-description adoption versus slot state', '“描述整棵树”与“交接 slot state”对比'],
    conclusion: [
      'The adoption selector count fell to zero. That directly observes less handover work, but the same build also changed sharing and staging.',
      'adoption selector 数量降到了 0，直接说明交接工作消失了；但同一版本还改变了共享和执行形态，所以仍不能单独归因给交接轴。',
    ],
  },
  'vue-feature-matrix': {
    title: ['Vue baseline × Vapor × IFR/ET', 'Vue baseline × Vapor × IFR/ET 矩阵'],
    conclusion: [
      'These four points map useful parts of the design space. They are not a one-switch ablation: enabling IFR/ET also moves staging, residency, and handover.',
      '这四个点能画出设计空间，但不是“只拨一个开关”的实验：启用 IFR/ET 时，执行形态、线程位置和交接方式也会一起变化。',
    ],
  },
  'octane-sync-residue': {
    title: ['Upstream sync before and after', '同步 upstream 前后'],
    conclusion: [
      'The architecture coordinates stayed fixed. The overall gap barely moved and the create gap remained, so this is implementation residue—not an axis effect.',
      '六条架构坐标没有变化。总体差距几乎没动，create 残差仍在；这是实现残差，不是架构轴效应。',
    ],
  },
  'octane-wire-fix-residue': {
    title: ['Two wire-reply defects before and after', '修复两个 wire reply 缺陷前后'],
    conclusion: [
      'At the same coordinates, 10k MTS→BTS traffic collapsed from 17.4 MB to 727 B while latency and heap residue remained. Implementation quality can move a point dramatically.',
      '六条坐标不变时，10k 的 MTS→BTS 流量从 1742 万 B 降到 727 B，但延迟和 heap 残差仍在。这证明同一架构点也会被实现质量大幅移动。',
    ],
  },
};

const VERDICT_LABELS: Record<AxisEvidenceVerdict, [string, string]> = {
  attributable: ['single-axis effect', '可归因单轴效应'],
  coupled: ['combined change', '多轴一起变化'],
  descriptive: ['descriptive map', '只描述设计空间'],
  uncontrolled: ['control missing', '控制条件不足'],
  'implementation-residue': ['same-coordinate residue', '同坐标实现残差'],
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

function Fact({ observation }: { observation: AxisEvidenceObservation }) {
  const { locale } = useI18n();
  return (
    <li className={`axis-fact is-${observation.direction}`}>
      <span>{locale === 'zh-CN' ? OBSERVATION_LABELS[observation.label] ?? observation.label : observation.label}</span>
      <b>{fmt(observation.before.value, observation.unit)}<i aria-hidden="true">→</i>{fmt(observation.after.value, observation.unit)}</b>
      {deltaLabel(observation) && <em>{deltaLabel(observation)}</em>}
    </li>
  );
}

function controlsText(comparison: AxisEvidenceComparison, zh: boolean) {
  const labels: Record<string, [string, string]> = {
    sameCodebase: ['same codebase', '同一代码库'],
    sameFixture: ['same fixture', '同一 fixture'],
    singlePhysicalRun: ['one physical run', '同一次物理 run'],
    singleBuildVariable: ['one build variable', '只改一个 build 变量'],
  };
  return Object.entries(comparison.controls).map(([key, value]) =>
    `${value === true ? '✓' : value === false ? '×' : '?'} ${labels[key][zh ? 1 : 0]}`).join(' · ');
}

function EvidenceCard({ comparison }: { comparison: AxisEvidenceComparison }) {
  const { locale, text } = useI18n();
  const zh = locale === 'zh-CN';
  const copy = COPY[comparison.id];
  return (
    <article className={`axis-card is-${comparison.verdict}`}>
      <header>
        <span className="axis-status">{VERDICT_LABELS[comparison.verdict][zh ? 1 : 0]}</span>
        <h4>{copy?.title[zh ? 1 : 0] ?? comparison.title}</h4>
      </header>
      <p className="axis-conclusion">{copy?.conclusion[zh ? 1 : 0]}</p>
      <div className="axis-moved">
        <b>{comparison.changedAxes.length ? text('Changed together', '本次同时变化') : text('Architecture coordinates', '架构坐标')}</b>
        {comparison.changedAxes.length ? comparison.changedAxes.map((axis) => (
          <span key={axis}>{AXIS_LABELS[axis][zh ? 1 : 0]}</span>
        )) : <span className="is-fixed">{text('all six stayed fixed', '六条轴全部不变')}</span>}
      </div>
      {comparison.observations.length > 0 && (
        <ul className="axis-facts">
          {comparison.observations.map((observation) => (
            <Fact observation={observation} key={`${observation.metric}:${observation.scale ?? 'all'}`} />
          ))}
        </ul>
      )}
      <details className="axis-audit">
        <summary>{text('Why this verdict?', '为什么这样判定？')}</summary>
        <p>{controlsText(comparison, zh)}</p>
        {comparison.auditEffectCount > 0 && <p>{text(
          `${comparison.auditEffectCount} detailed metric cells stay in the audit data; they do not change this verdict.`,
          `审计数据中仍保留 ${comparison.auditEffectCount} 个详细指标单元；它们不会改变这个判定。`,
        )}</p>}
        <a href={comparison.source.url} target="_blank" rel="noreferrer">{comparison.source.label} ↗</a>
      </details>
    </article>
  );
}

export function AxisEffects() {
  const { text } = useI18n();
  const ledger = AXIS_EFFECTS.ledger;
  if (!ledger?.comparisons.length) return null;
  const architecture = ledger.comparisons.filter((comparison) => comparison.group === 'architecture');
  const residue = ledger.comparisons.filter((comparison) => comparison.group === 'residue');

  return (
    <section className="axis-effects" aria-labelledby="axis-effects-title">
      <header className="axis-story-head">
        <div>
          <p className="section-kicker">⚗ Lab · {text('architecture evidence', '架构证据')}</p>
          <h2 id="axis-effects-title">{text('What do these experiments actually prove?', '这些实验到底证明了什么？')}</h2>
          <p className="axis-story-lede">{text(
            'They show large differences, but none of the first architecture comparisons changes only one axis. So the honest answer is not “no difference”; it is “do not give one axis credit for a combined change.”',
            '它们测到了很大的差异，但首批架构对照没有一组只改变一条轴。因此诚实的答案不是“没有差异”，而是“不能把组合变化的功劳记到某一条轴上”。',
          )}</p>
        </div>
        <div className="axis-answer" aria-label={text('Current answer', '当前答案')}>
          <span>{text('Current answer', '当前答案')}</span>
          <strong>{ledger.summary.attributableCount}</strong>
          <b>{text('single-axis causal effects', '个单轴因果效应')}</b>
          <small>{text(
            `${ledger.summary.implementationResidueCount} same-coordinate controls show implementation residue`,
            `${ledger.summary.implementationResidueCount} 组同坐标对照证明实现残差存在`,
          )}</small>
        </div>
      </header>

      <div className="axis-plain-key">
        <p><b>{text('One rule is enough:', '只需记住一条规则：')}</b>{' '}{text(
          'only a same-codebase experiment that changes exactly one axis can become an axis effect.',
          '只有“同一代码库里，恰好只改变一条轴”的实验，才能成为轴效应。',
        )}</p>
        <div>
          <span className="is-coupled">{text('several axes changed → combined result', '多条轴变化 → 组合结果')}</span>
          <span className="is-residue">{text('zero axes changed → implementation residue', '零条轴变化 → 实现残差')}</span>
        </div>
      </div>

      <section className="axis-ledger-group" aria-labelledby="axis-combined-title">
        <header><span>01</span><div>
          <h3 id="axis-combined-title">{text('Architecture comparisons: informative, not attributable', '架构对照：有信息，但暂时不能归因')}</h3>
          <p>{text(
            'These four backfills tell us where promising regions are. They do not tell us which single coordinate caused the movement.',
            '这四组历史回填能告诉我们哪些设计区域值得继续做，但不能告诉我们是哪一个坐标造成了变化。',
          )}</p>
        </div></header>
        <div className="axis-card-grid">{architecture.map((comparison) => <EvidenceCard comparison={comparison} key={comparison.id} />)}</div>
      </section>

      <section className="axis-ledger-group is-residue" aria-labelledby="axis-residue-title">
        <header><span>02</span><div>
          <h3 id="axis-residue-title">{text('Same coordinates: implementation alone still moves the result', '坐标不变：只改实现也会大幅移动结果')}</h3>
          <p>{text(
            'These controls are why ceiling effects and implementation gaps must stay separate.',
            '这两组控制解释了为什么必须把“架构轴效应”和“实现离各自理论上限还有多远”分开报告。',
          )}</p>
        </div></header>
        <div className="axis-card-grid">{residue.map((comparison) => <EvidenceCard comparison={comparison} key={comparison.id} />)}</div>
      </section>

      <aside className="axis-instruments">
        <h3>{text('What the instruments observe', '测量工具各自看什么')}</h3>
        <p>{text('Instruments observe physical work; they do not grant causal credit by themselves.', '测量工具负责看到真实工作量，但不会自动替某条架构轴完成因果归因。')}</p>
        <ul>
          <li><b>⑥</b><span>wire</span><small>{text('handover bytes', '线程交接字节')}</small></li>
          <li><b>⑤</b><span>{text('per-realm CPU', '分 realm CPU')}</span><small>{text('where work ran', '工作跑在哪')}</small></li>
          <li><b>④</b><span>pipeline</span><small>{text('script / create / flush', 'script / create / flush 分段')}</small></li>
          <li><b>①②</b><span>update + storm</span><small>{text('what invalidated and recomputed', '什么失效、重算多少')}</small></li>
        </ul>
      </aside>

      <details className="axis-method-note">
        <summary>{text('Non-negotiable limits', '不会放松的边界')}</summary>
        <ul>
          <li>{text('Cross-framework points are descriptive only.', '跨框架的点只作描述。')}</li>
          <li>{text('Uncontrolled or coupled pairs are never attributable.', '未受控或多轴耦合的 pair 永不进入归因。')}</li>
          <li>{text('Effect tables only; no regression or interaction fitting.', '只报告效应表；不做回归或交互拟合。')}</li>
          <li>{text('Ceiling axis effects and implementation residue stay separate.', 'Ceiling 的轴效应与实现残差始终分开。')}</li>
        </ul>
      </details>
    </section>
  );
}
