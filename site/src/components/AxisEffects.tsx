import {
  AXIS_EFFECTS,
  AxisCoordinates,
  AxisEffectMetric,
  AxisEffectPair,
  AxisName,
  ENTRY_BY_ID,
  fmtMs,
} from '../data';
import { useI18n } from '../i18n';

const AXIS_ORDER: AxisName[] = [
  'invalidation',
  'recompute',
  'sharing',
  'staging',
  'residency',
  'handover',
];

const AXIS_LABELS: Record<AxisName, [string, string]> = {
  invalidation: ['① invalidation source', '① 失效来源'],
  recompute: ['② recompute granularity', '② 重算粒度'],
  sharing: ['③ sharing degree', '③ 共享程度'],
  staging: ['④ staging', '④ 分段形态'],
  residency: ['⑤ driver residency', '⑤ 驱动驻留'],
  handover: ['⑥ handover', '⑥ 交接方式'],
};

function axisValue(coordinates: AxisCoordinates, axis: AxisName) {
  if (axis === 'residency') {
    return `${coordinates.residency.firstFrame}/${coordinates.residency.steadyState}`;
  }
  return coordinates[axis];
}

function changedCoordinates(pair: AxisEffectPair) {
  if (!pair.coordinates.against || !pair.coordinates.entry) return [];
  return AXIS_ORDER.filter((axis) =>
    axisValue(pair.coordinates.against!, axis) !== axisValue(pair.coordinates.entry!, axis));
}

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
  const caption = claim === 'axis'
    ? text('Isolated axis effects in this exact context', '此精确上下文中的单轴效应')
    : claim === 'residue'
      ? text('Implementation gap: measured point minus its own ceiling', '实现差距：测量点减去自身 ceiling')
      : text('Combined-change measurements; not attributed to one axis', '组合变化的测量值；不归因到单独一轴');
  return (
    <div className="axis-effect-table-wrap">
      <table className="axis-effect-table">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th>{text('metric', '指标')}</th>
            <th>{text('before', '变化前')}</th>
            <th>{text('after', '变化后')}</th>
            <th>Δ median</th>
            <th>CI</th>
            <th>{text('raw ranges', '原始范围')}</th>
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
                {effect.relativeDelta != null && (
                  <small>
                    {effect.relativeDelta > 0 ? '+' : ''}{(effect.relativeDelta * 100).toFixed(1)}%
                  </small>
                )}
              </td>
              <td>{effect.ci95 == null
                ? '—'
                : <>{number(effect.ci95.low, effect.unit)} … {number(effect.ci95.high, effect.unit)}</>}</td>
              <td>{effect.rangesDisjoint == null
                ? '—'
                : effect.rangesDisjoint
                  ? text('do not overlap', '不重叠')
                  : text('overlap', '有重叠')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CeilingEvidence({ pair }: { pair: AxisEffectPair }) {
  const { text } = useI18n();
  if (!pair.ceiling.separated) return null;
  return (
    <div className="axis-ceiling">
      <p className="axis-ceiling-intro">
        <b>{text('The ceiling answers a different question.', 'Ceiling 回答的是另一个问题。')}</b>{' '}
        {text(
          'A hand-written ceiling measures implementation gap only; it does not reveal which architecture axis caused the observed change.',
          '手写 ceiling 只测实现差距；它不能说明观测变化是由哪条架构轴造成的。',
        )}
      </p>
      {pair.ceiling.axisEffect && (
        <details>
          <summary>{text('Inspect ceiling-to-ceiling axis effects', '查看 ceiling 对 ceiling 的轴效应')}</summary>
          <EffectsTable effects={pair.ceiling.axisEffect.effects} claim="axis" />
        </details>
      )}
      {Object.entries(pair.ceiling.implementationResidue).map(([side, residue]) => residue && (
        <details key={side}>
          <summary>
            {text(
              `Inspect ${side} implementation gap against ${residue.ceilingEntry}`,
              `查看 ${side} 相对 ${residue.ceilingEntry} 的实现差距`,
            )}
          </summary>
          <EffectsTable effects={residue.effects} claim="residue" />
        </details>
      ))}
    </div>
  );
}

function Experiment({ pair, index }: { pair: AxisEffectPair; index: number }) {
  const { locale, text } = useI18n();
  const against = ENTRY_BY_ID.get(pair.against)?.label ?? pair.against;
  const entry = ENTRY_BY_ID.get(pair.entry)?.label ?? pair.entry;
  const changes = changedCoordinates(pair);
  const effects = pair.attributable ? pair.effects : pair.descriptiveEffects;
  const disjoint = effects.filter((effect) => effect.rangesDisjoint).length;
  const controlled = pair.validation.status !== 'invalid';
  const verdict = pair.attributable
    ? text(`Isolates ${AXIS_LABELS[pair.axis][0]}`, `已隔离 ${AXIS_LABELS[pair.axis][1]}`)
    : pair.validation.status === 'coupled'
      ? text(
        `Cannot attribute to ${AXIS_LABELS[pair.axis][0]}`,
        `不能归因到 ${AXIS_LABELS[pair.axis][1]}`,
      )
      : text('Excluded: controls failed', '已排除：控制校验失败');

  return (
    <article className="axis-experiment">
      <header className="axis-experiment-head">
        <span className="axis-experiment-index">{String(index + 1).padStart(2, '0')}</span>
        <div>
          <p className="axis-overline">{text('Controlled experiment', '受控实验')}</p>
          <h3>{against} <span aria-hidden="true">→</span> {entry}</h3>
          <p>{text(
            `The intended question is the effect of ${AXIS_LABELS[pair.axis][0]}. First check whether that is the only thing that moved.`,
            `原本要问的是 ${AXIS_LABELS[pair.axis][1]} 的效应。第一步必须先看：它是不是唯一发生变化的坐标。`,
          )}</p>
        </div>
        <div className={`axis-verdict is-${pair.validation.status}`}>
          <span>{text('Verdict', '判定')}</span>
          <strong>{verdict}</strong>
        </div>
      </header>

      <div className="axis-experiment-body">
        <section className="axis-change-ledger" aria-labelledby={`axis-changes-${index}`}>
          <h4 id={`axis-changes-${index}`}>{text('What changed?', '到底改了什么？')}</h4>
          {pair.coordinates.against && pair.coordinates.entry ? (
            <>
              <ol>
                {changes.map((axis) => (
                  <li className={axis === pair.axis ? 'is-question' : 'is-coupled'} key={axis}>
                    <span className="axis-change-name">
                      {AXIS_LABELS[axis][locale === 'zh-CN' ? 1 : 0]}
                    </span>
                    <code>
                      {axisValue(pair.coordinates.against!, axis)}
                      <span aria-hidden="true"> → </span>
                      {axisValue(pair.coordinates.entry!, axis)}
                    </code>
                    <span className="axis-change-role">
                      {axis === pair.axis
                        ? text('question', '要研究的轴')
                        : text('also moved', '也变了')}
                    </span>
                  </li>
                ))}
              </ol>
              <p className="axis-unchanged">
                {text(
                  `${AXIS_ORDER.length - changes.length} other coordinates stayed fixed.`,
                  `其余 ${AXIS_ORDER.length - changes.length} 个坐标保持不变。`,
                )}
              </p>
            </>
          ) : (
            <p>{text('Coordinates are incomplete.', '坐标信息不完整。')}</p>
          )}
        </section>

        <section className="axis-meaning" aria-labelledby={`axis-meaning-${index}`}>
          <h4 id={`axis-meaning-${index}`}>{text('What can the result mean?', '这些结果能说明什么？')}</h4>
          <p className="axis-meaning-lead">
            {pair.attributable
              ? text(
                `Only ${AXIS_LABELS[pair.axis][0]} moved, so these measurements are local axis effects.`,
                `只有 ${AXIS_LABELS[pair.axis][1]} 发生变化，因此这些测量是局部轴效应。`,
              )
              : pair.validation.status === 'coupled'
                ? text(
                  `This experiment moved ${changes.length} coordinates. These measurements describe that combined change; they cannot tell us which axis deserves the credit.`,
                  `这次实验同时移动了 ${changes.length} 个坐标。测量值描述的是这个组合变化，不能告诉我们功劳属于哪一条轴。`,
                )
                : text(
                  'The controls did not hold, so this pair contributes no effect claim.',
                  '控制条件没有成立，因此这组 pair 不产生任何效应结论。',
                )}
          </p>
          <p className="axis-measure-count">
            <b>{effects.length}</b> {text('measured comparisons retained', '项测量差异被保留')}
            {effects.length > 0 && (
              <span> · {disjoint} {text('with non-overlapping raw ranges', '项原始范围不重叠')}</span>
            )}
          </p>
          {effects.length > 0 && (
            <details className="axis-measurements">
              <summary>{text('Inspect the measured differences', '展开查看测量差异')}</summary>
              <EffectsTable effects={effects} claim={pair.attributable ? 'axis' : 'descriptive'} />
            </details>
          )}
          <CeilingEvidence pair={pair} />
        </section>
      </div>

      <details className="axis-audit">
        <summary>{text('Why this verdict?', '为什么会得出这个判定？')}</summary>
        <dl>
          <div>
            <dt>{text('Target axis', '目标轴')}</dt>
            <dd>{AXIS_LABELS[pair.axis][locale === 'zh-CN' ? 1 : 0]} · <code>{pair.delta}</code></dd>
          </div>
          <div>
            <dt>{text('Control result', '控制结果')}</dt>
            <dd>{controlled
              ? text('Same codebase, fixture, build matrix, and physical run', '同代码库、fixture、build matrix 与物理 run')
              : <code>{pair.validation.reasons.join(' · ')}</code>}</dd>
          </div>
          <div>
            <dt>{text('Other changed axes', '其他变化轴')}</dt>
            <dd>{pair.coupled.length
              ? pair.coupled.map((axis) => AXIS_LABELS[axis][locale === 'zh-CN' ? 1 : 0]).join(' · ')
              : text('none', '无')}</dd>
          </div>
          {pair.validation.run && (
            <div>
              <dt>{text('Source', '来源')}</dt>
              <dd><code>{pair.validation.run.sourceRunFile}</code> · n≥{pair.validation.run.minimumReps}</dd>
            </div>
          )}
        </dl>
      </details>
    </article>
  );
}

export function AxisEffects() {
  const { text } = useI18n();
  const pairs = AXIS_EFFECTS.pairs;
  const attributable = pairs.filter((pair) => pair.attributable).length;
  const controlled = pairs.filter((pair) => pair.validation.status !== 'invalid').length;
  const staging = AXIS_EFFECTS.axes.find((axis) => axis.axis === 'staging');

  if (!pairs.length) return null;

  return (
    <section className="axis-effects" aria-labelledby="axis-effects-title">
      <header className="axis-story-head">
        <div>
          <p className="section-kicker">⚗ Lab · {text('causal evidence', '因果证据')}</p>
          <h2 id="axis-effects-title">
            {text('Can performance be attributed to one architecture axis?', '性能差异能归因到哪条架构轴？')}
          </h2>
          <p className="axis-story-lede">
            {attributable === 0
              ? text(
                'Not yet. Both first experiments change three coordinates at once. We measured the differences, but we will not assign them to staging or residency.',
                '暂时不能。首批两组实验都同时移动了三个坐标。我们测到了差异，但不会把功劳分配给 staging 或 residency。',
              )
              : text(
                `${attributable} experiments isolate one axis. The remaining experiments stay descriptive.`,
                `已有 ${attributable} 组实验隔离出单轴；其余实验仍只作描述。`,
              )}
          </p>
        </div>
        <div className="axis-answer" aria-label={text('Current answer', '当前答案')}>
          <span>{text('Current answer', '当前答案')}</span>
          <strong>{attributable}</strong>
          <b>{text('isolated axis effects', '个可归因轴效应')}</b>
          <small>{controlled}/{pairs.length} {text('experiments passed basic controls', '组实验通过基础控制')}</small>
        </div>
      </header>

      <ol className="axis-reading-key" aria-label={text('How to read this section', '如何阅读本节')}>
        <li><span>1</span><b>{text('List every coordinate that moved', '列出所有变化坐标')}</b></li>
        <li><span>2</span><b>{text('Ask whether only the target moved', '判断是否只改变目标轴')}</b></li>
        <li><span>3</span><b>{text('Only then label an axis effect', '通过后才标记为轴效应')}</b></li>
      </ol>

      {staging?.instrument && (
        <div className={`axis-instrument is-${staging.instrument.status}`}>
          <span>④</span>
          <p>
            <b>{text('Staging instrument', 'Staging 观测仪器')}</b>
            {staging.instrument.status === 'observed'
              ? text(
                'The #200 instrument has measured an attributable single-axis pair.',
                '#200 仪器已经测到一组可归因的单轴 pair。',
              )
              : staging.instrument.status === 'ready'
                ? text(
                  'The #200 instrument is ready, but no single-axis staging experiment has exercised it yet. The effect table therefore stays empty.',
                  '#200 仪器已经就绪，但还没有单轴 staging 实验使用它，因此效应表保持为空。',
                )
                : text(
                  'The #200 instrument is not available yet. No proxy estimate is substituted.',
                  '#200 仪器尚不可用；不会用代理估算替代。',
                )}
          </p>
          <a href={staging.instrument.issue} target="_blank" rel="noreferrer">#200 ↗</a>
        </div>
      )}

      <div className="axis-experiment-list">
        {pairs.map((pair, index) => <Experiment pair={pair} index={index} key={pair.id} />)}
      </div>

      <details className="axis-method-note">
        <summary>{text('Rules that this view will not relax', '这张视图绝不会放松的规则')}</summary>
        <ul>
          <li>{text('Cross-framework comparisons never identify an axis effect.', '跨框架对比永远不产生轴效应。')}</li>
          <li>{text('Failed controls and coupled moves never enter attribution.', '控制失败或耦合移动永远不进入归因。')}</li>
          <li>{text('The view reports effect tables only—no regression or interaction fitting.', '只报告效应表——不做回归或交互拟合。')}</li>
          <li>{text('Ceiling effects and implementation gaps remain separate.', 'Ceiling 效应与实现差距始终分开。')}</li>
        </ul>
      </details>
    </section>
  );
}
