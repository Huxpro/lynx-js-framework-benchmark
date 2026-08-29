import { useBenchmarkData } from '../data-context';
import { BENCHMARK_HISTORY } from '../data';
import { localizedCheckpoint, useI18n } from '../i18n';

export function MeasurementReceipt({ harness }: { harness: string }) {
  const { locale, text, date } = useI18n();
  const { snapshot, regime } = useBenchmarkData();
  const checkpoint = BENCHMARK_HISTORY.checkpoints.find((candidate) => candidate.id === snapshot.id);
  const checkpointCopy = checkpoint ? localizedCheckpoint(checkpoint, locale) : null;
  const cohort = snapshot.comparison.harnesses.find((candidate) => candidate.harness === harness
    && (harness !== 'web' || (candidate.jsRegime === regime.jsRegime
      && candidate.jsFlags === regime.jsFlags
      && candidate.cpuThrottle === regime.cpuThrottle)));
  const boundary = harness === 'web'
    ? text('Interaction: in-page pointerdown → first frame whose composed-DOM predicate passes. Startup: view attach → first frame with benchmark content; this is a workload-defined content boundary, not cold browser-navigation FCP.', '交互：页面内 pointerdown → composed DOM 条件首次通过的帧。启动：view attach → 首个包含 benchmark 内容的帧；这是 workload 定义的内容边界，不是浏览器冷导航 FCP。')
    : text('Interaction: real device input handler → second Native animation frame. Startup: pipeline open → producer FCP; renderer-only ACK/frame metrics stay separately named.', '交互：真实设备输入处理器 → 第二个 Native 动画帧。启动：pipeline open → producer FCP；仅渲染器的 ACK/帧指标会独立命名。');
  const generatedAt = date(snapshot.generatedAt, {
    month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });

  return (
    <details className="measurement-receipt">
      <summary>
        <span>{text('Measurement receipt', '测量凭据')}</span>
        <span className="receipt-context">
          <code title={checkpointCopy?.description}>{checkpointCopy?.label ?? snapshot.label}</code>
          {' · '}<time dateTime={snapshot.generatedAt}>{generatedAt}</time>
          {' · '}{harness === 'web' ? 'Web' : 'Native'}
          {harness === 'web' ? ` · ${regime.jsRegime === 'jit' ? 'JIT' : 'Ignition'} · ${regime.cpuThrottle}× CPU` : ''}
          {' · '}{cohort
            ? text(`${cohort.entryIds.length} comparable entries`, `${cohort.entryIds.length} 个可比条目`)
            : text('no publishable cohort', '无可发布 cohort')}
        </span>
      </summary>
      <div className="receipt-grid">
        {checkpointCopy?.description && (
          <section className="receipt-change">
            <h3>{text('What changed', '发生了什么变化')}</h3>
            <p>{checkpointCopy.description}</p>
          </section>
        )}
        <section>
          <h3>{text('Observation boundary', '观察边界')}</h3>
          <p>{boundary} {text('Timeout and unreachable prestate remain explicit DNF, never proxy values.', '超时和无法到达的前置状态始终记为明确的 DNF，绝不用代理值替代。')}</p>
        </section>
        <section>
          <h3>{text('Fairness controls', '公平性控制')}</h3>
          <p>
            {text(
              'Identical table contract and seeded rows; medians are derived from raw repetitions. Web and Native stay separate comparison domains.',
              '使用相同的表格合约和固定种子行；中位数由原始重复测量派生。Web 与 Native 始终是独立的比较域。',
            )}
          </p>
        </section>
        <section>
          <h3>{text('What startup isolates', '启动指标隔离了什么')}</h3>
          <p>
            {text(
              'Framework artifacts are prebuilt and served locally. Production DNS, TLS, CDN and bandwidth are outside the timing; bundle parse/eval, framework initialization, initial content creation and paint remain inside. Thread attribution is reported separately.',
              '框架产物已预构建并在本地提供。生产环境的 DNS、TLS、CDN 与带宽不在计时内；bundle 解析/求值、框架初始化、首批内容创建与绘制仍在计时内。线程归属会另行展示。',
            )}
          </p>
        </section>
        <section>
          <h3>{text('Benchmark context', 'Benchmark 背景')}</h3>
          <p>
            {locale === 'zh-CN' ? <>
              <a className="external-link" href="https://github.com/krausest/js-framework-benchmark#about-the-benchmarks" target="_blank" rel="noreferrer">js-framework-benchmark <span aria-hidden="true">↗</span></a>
              {' '}把 page load 之后的九项 CPU 交互与启动/体积分开；当前 active size suite 保留 first paint，但 FCP 实验已停用。需要标准 navigation → FCP 时，
              <a className="external-link" href="https://github.com/google/tachometer#first-contentful-paint-fcp" target="_blank" rel="noreferrer">Tachometer <span aria-hidden="true">↗</span></a>
              {' '}和 <a className="external-link" href="https://developer.chrome.com/docs/lighthouse/performance/first-contentful-paint" target="_blank" rel="noreferrer">Lighthouse <span aria-hidden="true">↗</span></a> 会直接读取浏览器 Paint Timing。
            </> : <>
              <a className="external-link" href="https://github.com/krausest/js-framework-benchmark#about-the-benchmarks" target="_blank" rel="noreferrer">js-framework-benchmark <span aria-hidden="true">↗</span></a>
              {' '}separates its nine post-load CPU interactions from startup/size; its active size suite retains first paint while the FCP experiment is disabled. For standard navigation → FCP,
              {' '}<a className="external-link" href="https://github.com/google/tachometer#first-contentful-paint-fcp" target="_blank" rel="noreferrer">Tachometer <span aria-hidden="true">↗</span></a>
              {' '}and <a className="external-link" href="https://developer.chrome.com/docs/lighthouse/performance/first-contentful-paint" target="_blank" rel="noreferrer">Lighthouse <span aria-hidden="true">↗</span></a> read browser Paint Timing directly.
            </>}
          </p>
        </section>
        <section>
          <h3>{text('Published cohort', '已发布 cohort')}</h3>
          <p>
            {cohort
              ? <><code>{cohort.machineId}</code> · {text(`${cohort.sourceRunFiles.length} source run${cohort.sourceRunFiles.length === 1 ? '' : 's'}`, `${cohort.sourceRunFiles.length} 次来源运行`)}</>
              : text('Archived observations may remain as evidence, but cannot enter rankings.', '归档观察值可以保留为证据，但不能进入排名。')}
          </p>
        </section>
      </div>
      <div className="receipt-audit">
        <p>
          <b>{text('Raw → derived.', '原始 → 派生。')}</b> {text(
            'Run identity, raw repetitions, one-shot values, failures and DNF counts are source evidence. Medians, CI, eligible matrices, rankings, geomeans, ratios, trend α and every visual mark are regenerated at build time.',
            '运行身份、原始重复测量、一次性值、失败和 DNF 计数都是来源证据。中位数、CI、可用矩阵、排名、几何平均、比率、趋势 α 和每个视觉标记都会在构建时重新生成。',
          )}
        </p>
        <p>
          <b>{text('Instrumentation.', '测量工具。')}</b> {text(
            'Per-realm CPU and directional BTS↔MTS wire breakdowns appear only when that exact environment captured them. Missing instruments never borrow values from the other environment.',
            '只有对应环境确实采集到数据时，才展示各 realm CPU 和分方向 BTS↔MTS wire 拆分。缺失的测量项绝不会借用另一环境的数据。',
          )}
        </p>
      </div>
      <div className="receipt-foot">
        {text('exact checkpoint', '精确节点')} <code>{checkpoint?.id ?? snapshot.id}</code>
      </div>
    </details>
  );
}
