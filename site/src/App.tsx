import { useEffect, useMemo, useRef, useState } from 'react';

import { CostSpace } from './components/CostSpace';
import { AxisEffects } from './components/AxisEffects';
import { Legend } from './components/Legend';
import { ListCoverage } from './components/ListCoverage';
import { HeatGrid } from './components/HeatGrid';
import { HistoryRanking } from './components/HistoryRanking';
import { InteractionScaleComposite } from './components/InteractionScaleComposite';
import { MeasurementReceipt } from './components/Method';
import { NativeCoverage } from './components/NativeCoverage';
import { NativeObservations } from './components/NativeObservations';
import { PipelineAttribution } from './components/PipelineAttribution';
import { StormCoalescing } from './components/StormCoalescing';
import { RankedBars } from './components/RankedBars';
import { ResponsiveCopy } from './components/ResponsiveCopy';
import { ScaleTrend, trendSpecsForHarness } from './components/ScaleTrends';
import { ThreadsPage } from './components/Threads';
import { TimelineSlider, type BenchmarkPage } from './components/TimelineSlider';
import { BenchmarkDataProvider, useBenchmarkData } from './data-context';
import {
  ENTRIES,
  ENTRY_BY_ID,
  TIMELINE_SNAPSHOTS,
  DEFAULT_WEB_REGIME,
  WEB_REGIMES,
  WebRegime,
  entrySupportsHarness,
  webRegimeId,
} from './data';
import { useHeatPalette, useTheme } from './hooks';
import { localizedWorkload, useI18n } from './i18n';
import {
  INTERACTION_WORKLOADS,
  JS_FRAMEWORK_SCORE_OPS,
  JS_FRAMEWORK_SCORE_WEIGHTS,
} from './interaction-score';

const KrausestBenchmarkLink = () => (
  <a
    className="external-link benchmark-source-link"
    href="https://github.com/krausest/js-framework-benchmark"
    target="_blank"
    rel="noreferrer"
  >
    krausest/js-framework-benchmark <span aria-hidden="true">↗</span>
  </a>
);

// Sharable comparison state: ?entries=a,b,c picks an exact featured set.
function initialSelection(defaultIds: string[]): Set<string> {
  const params = new URLSearchParams(location.search);
  const ids = params.get('entries')?.split(',').map((s) => s.trim())
    .filter((id) => defaultIds.includes(id));
  return new Set(ids?.length ? ids : defaultIds);
}

function syncUrl(selected: Set<string>, defaultIds: string[]) {
  const params = new URLSearchParams(location.search);
  const isDefault = selected.size === defaultIds.length
    && defaultIds.every((id) => selected.has(id));
  if (isDefault) {
    params.delete('entries');
  } else {
    params.set('entries', ENTRIES.filter((e) => selected.has(e.id)).map((e) => e.id).join(','));
  }
  params.delete('lab');
  const qs = params.toString();
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
}

const scaleLabel = (s: number) => (s >= 1000 ? `${s / 1000}k` : String(s));

function initialSnapshotIndex(): number {
  const id = new URLSearchParams(location.search).get('snapshot');
  const index = TIMELINE_SNAPSHOTS.findIndex((snapshot) => snapshot.id === id);
  if (index >= 0) return index;
  const current = TIMELINE_SNAPSHOTS.findIndex((snapshot) => snapshot.id === 'current-main');
  return current >= 0 ? current : TIMELINE_SNAPSHOTS.length - 1;
}

function initialWebRegime(): WebRegime {
  const requested = new URLSearchParams(location.search).get('regime') ?? 'web';
  const id = requested === 'web-interp-4x-cg' ? 'web-interp-4x' : requested;
  const match = WEB_REGIMES.find((candidate) => candidate.id === id);
  return match == null
    ? DEFAULT_WEB_REGIME
    : {
      jsRegime: match.jsRegime,
      jsFlags: match.jsFlags,
      cpuThrottle: match.cpuThrottle,
      throttleScope: match.throttleScope,
    };
}

function AppContent({
  snapshotIndex,
  onSnapshotChange,
  regime,
  onRegimeChange,
}: {
  snapshotIndex: number;
  onSnapshotChange: (index: number) => void;
  regime: WebRegime;
  onRegimeChange: (regime: WebRegime) => void;
}) {
  const { locale, text } = useI18n();
  const [theme, toggleTheme] = useTheme();
  const [heatPalette, toggleHeatPalette] = useHeatPalette();
  const { select, snapshot, workloadScales } = useBenchmarkData();
  const [page, setPage] = useState<BenchmarkPage>('overview');
  const [harness, setHarness] = useState<string>(() =>
    new URLSearchParams(location.search).get('harness') === 'native' ? 'native' : 'web');
  const cohortEntryIds = snapshot.comparison.harnesses
    .find((cohort) => cohort.harness === harness && (harness !== 'web'
      || (cohort.jsRegime === regime.jsRegime
        && cohort.jsFlags === regime.jsFlags
        && cohort.cpuThrottle === regime.cpuThrottle
        && cohort.throttleScope === regime.throttleScope)))?.entryIds ?? [];
  const cohortKey = `${snapshot.id}:${harness}:${webRegimeId(regime)}`;
  const previousCohort = useRef(cohortKey);
  const [selected, setSelected] = useState<Set<string>>(() => initialSelection(cohortEntryIds));
  const availableIds = useMemo(() => new Set(cohortEntryIds), [cohortEntryIds]);
  useEffect(() => {
    if (previousCohort.current === cohortKey) return;
    const next = new Set(cohortEntryIds);
    previousCohort.current = cohortKey;
    setSelected(next);
    syncUrl(next, cohortEntryIds);
  }, [cohortEntryIds, cohortKey]);
  const activeSelected = useMemo(() => new Set([...selected].filter((id) => {
    const entry = ENTRY_BY_ID.get(id);
    return availableIds.has(id) && entry != null && entrySupportsHarness(entry, harness);
  })), [availableIds, harness, selected]);
  const changeHarness = (next: string) => {
    setHarness(next);
    const params = new URLSearchParams(location.search);
    if (next === 'web') params.delete('harness');
    else params.set('harness', next);
    const query = params.toString();
    history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
  };
  const changeRegime = (next: WebRegime) => {
    onRegimeChange(next);
    const params = new URLSearchParams(location.search);
    const id = webRegimeId(next);
    if (id === 'web') params.delete('regime');
    else params.set('regime', id);
    const query = params.toString();
    history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
  };

  const toggleEntry = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      syncUrl(next, cohortEntryIds);
      return next;
    });

  const heatRows = useMemo(() => {
    const rows: { key: string; label: string; suite: string; workload: string; scale: number; metric: string }[] = [];
    if (harness === 'native') {
      const seen = new Set<string>();
      for (const cell of snapshot.nativeCoverage.cells) {
        const key = `${cell.suite}:${cell.workload}:${cell.scale}:${cell.metric}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const startupBoundary = {
          fcp: 'FCP',
          settled: text('settled', '稳定'),
          octaneCommitAck: text('commit ACK', '提交 ACK'),
          octaneSecondFrame: text('second frame', '第二帧'),
        }[cell.metric] ?? cell.metric;
        const label = cell.suite === 'startup'
          ? `${text('startup', '启动')} ${startupBoundary} @${scaleLabel(cell.scale)}`
          : `${localizedWorkload(cell.workload, locale)} @${scaleLabel(cell.scale)}`;
        rows.push({
          key,
          label,
          suite: cell.suite,
          workload: cell.workload,
          scale: cell.scale,
          metric: cell.metric,
        });
      }
      return rows;
    }
    for (const w of ['create', 'replace', 'append1k', 'update10th', 'select', 'swap', 'remove', 'clear', 'updateStorm', 'selectStorm']) {
      for (const s of workloadScales({ suite: 'table', harness, workload: w, metric: 'latency' })) {
        if (select({ suite: 'table', harness, workload: w, scale: s, metric: 'latency' }).length >= 2) {
          rows.push({ key: `${w}@${s}`, label: `${localizedWorkload(w, locale)} @${scaleLabel(s)}`, suite: 'table', workload: w, scale: s, metric: 'latency' });
        }
      }
    }
    for (const s of workloadScales({ suite: 'startup', harness, workload: 'startup', metric: 'fcp' })) {
      if (select({ suite: 'startup', harness, workload: 'startup', scale: s, metric: 'fcp' }).length >= 2) {
        rows.push({ key: `startup@${s}`, label: `${text('startup', '启动')} @${scaleLabel(s)}`, suite: 'startup', workload: 'startup', scale: s, metric: 'fcp' });
      }
    }
    return rows;
  }, [harness, locale, select, snapshot.nativeCoverage.cells, text, workloadScales]);

  const tableOps = (scales: number[]) =>
    INTERACTION_WORKLOADS.flatMap((w) =>
      workloadScales({ suite: 'table', harness, workload: w, metric: 'latency' })
        .filter((s) => scales.includes(s))
        .map((s) => ({ key: `${w}@${s}`, label: `${localizedWorkload(w, locale)}${scales.length > 1 ? ` @${scaleLabel(s)}` : ''}`, workload: w, scale: s })));

  const equal1kOps = tableOps([1000]);
  const equal10kOps = tableOps([10000]);
  const interactionModes = [
    ...(harness === 'web' ? [{
      key: 'weighted',
      label: text('js-framework weighted', 'js-framework 加权'),
      ops: JS_FRAMEWORK_SCORE_OPS,
      scoreWeights: JS_FRAMEWORK_SCORE_WEIGHTS,
      summaryLabel: text('weighted score', '加权得分'),
      caption: text(
        'weighted geometric mean of all 9 upstream CPU workload ratios × vs each workload\'s fastest entry — 1× is the per-workload oracle; incomplete entries are excluded',
        '九项上游 CPU workload 相对各自最快项的比值 ×，按权重取几何平均——1× 是逐 workload 的理论最优；不完整条目不参与计算',
      ),
      equation: {
        head: text('Upstream weighted geometric mean', '上游加权几何平均'),
        lines: [
          text('rᵢ = medianᵢ ÷ fastest medianᵢ', 'rᵢ = 中位数ᵢ ÷ 最快中位数ᵢ'),
          'score = exp(Σ wᵢ · ln(rᵢ) ÷ Σ wᵢ)',
          text('9/9 cells required · upstream CPU weights', '必须具备 9/9 单元 · 使用上游 CPU 权重'),
        ],
      },
    }] : []),
    {
      key: 'equal-1k',
      label: text('equal · 1k', '等权 · 1k'),
      ops: equal1kOps,
      summaryLabel: text('equal score', '等权得分'),
      caption: text(
        `equal-weight geometric mean of the complete ${equal1kOps.length}-operation 1k matrix × vs each operation's fastest entry — 1× is the per-operation oracle`,
        `完整 ${equal1kOps.length} 项 1k 操作矩阵相对各操作最快项的比值 ×，等权取几何平均——1× 是逐操作的理论最优`,
      ),
      equation: {
        head: text('Equal-weight 1k geometric mean', '1k 等权几何平均'),
        lines: [
          text('rᵢ = medianᵢ ÷ fastest medianᵢ', 'rᵢ = 中位数ᵢ ÷ 最快中位数ᵢ'),
          `score = exp(Σ ln(rᵢ) ÷ ${equal1kOps.length})`,
          text(
            `${equal1kOps.length}/${equal1kOps.length} 1k cells required · every operation counts equally`,
            `必须具备 ${equal1kOps.length}/${equal1kOps.length} 个 1k 单元 · 每项操作权重相同`,
          ),
        ],
      },
    },
    {
      key: 'equal-10k',
      label: text('equal · 10k', '等权 · 10k'),
      ops: equal10kOps,
      summaryLabel: text('equal score', '等权得分'),
      caption: text(
        `equal-weight geometric mean of the complete ${equal10kOps.length}-operation 10k matrix × vs each operation's fastest entry — 1× is the per-operation oracle`,
        `完整 ${equal10kOps.length} 项 10k 操作矩阵相对各操作最快项的比值 ×，等权取几何平均——1× 是逐操作的理论最优`,
      ),
      equation: {
        head: text('Equal-weight 10k geometric mean', '10k 等权几何平均'),
        lines: [
          text('rᵢ = medianᵢ ÷ fastest medianᵢ', 'rᵢ = 中位数ᵢ ÷ 最快中位数ᵢ'),
          `score = exp(Σ ln(rᵢ) ÷ ${equal10kOps.length})`,
          text(
            `${equal10kOps.length}/${equal10kOps.length} 10k cells required · every operation counts equally`,
            `必须具备 ${equal10kOps.length}/${equal10kOps.length} 个 10k 单元 · 每项操作权重相同`,
          ),
        ],
      },
    },
  ];

  const nativeHasData = select({ harness: 'native' }).length > 0;

  return (
    <div className="page">
      <header className="site-header">
        <div className="site-title"><span className="lynx">Lynx</span> {text('JS Framework Benchmark', 'JS 框架基准测试')}</div>
      </header>
      <TimelineSlider
        snapshots={TIMELINE_SNAPSHOTS}
        index={snapshotIndex}
        onChange={onSnapshotChange}
        page={page}
        onPageChange={setPage}
        harness={harness}
        onHarnessChange={changeHarness}
        regime={regime}
        onRegimeChange={changeRegime}
        theme={theme}
        onThemeToggle={toggleTheme}
        heatPalette={heatPalette}
        onHeatPaletteToggle={toggleHeatPalette}
      />
      <MeasurementReceipt harness={harness} />

      {page === 'lab' ? (
        <>
          <header className="lab-header">
            <div>
              <p className="section-kicker">{text('For framework authors', '面向 framework author')}</p>
              <h1>{text('Benchmark Lab', '基准实验室')}</h1>
              <p>{text('Research instruments outside the featured ranking.', '主排名之外的研究仪器。')}</p>
            </div>
            <nav className="lab-suite-index" aria-label={text('Lab suites', 'Lab suite')}>
              <a href="#lab-attribution">
                <span>01</span><b>{text('Attribution', '架构归因')}</b><small>6-axis ledger</small>
                <i className="is-axis" aria-hidden="true"><em /><em /><em /><em /><em /><em /></i>
              </a>
              {harness === 'web' ? <a href="#lab-storm">
                <span>02</span><b>{text('Storm', '连续交互')}</b><small>ticks → frames</small>
                <i className="is-storm" aria-hidden="true"><em /><em /><em /><em /><em /></i>
              </a> : null}
              <a href="#lab-list">
                <span>{harness === 'web' ? '03' : '02'}</span><b>{text('List', '列表能力')}</b><small>contract matrix</small>
                <i className="is-list" aria-hidden="true"><em /><em /><em /><em /><em /><em /></i>
              </a>
            </nav>
          </header>
          {harness === 'web' && snapshot.id === 'current-main' ? <AxisEffects /> : harness === 'web' ? (
            <div className="empty-state">
              <p><b>{text('Lab evidence is published at the current checkpoint.', 'Lab 证据发布在当前节点。')}</b></p>
              <p>{text('Move the timeline to the latest checkpoint to inspect the architecture comparisons.', '请把时间线移到最新节点，再查看架构对照。')}</p>
            </div>
          ) : null}
          <section className="lab-research" aria-label={text('Behavior and capability suites', '行为与能力 suite')}>
            {harness === 'web' && <StormCoalescing theme={theme} selected={activeSelected} />}
            <ListCoverage harness={harness} />
          </section>
        </>
      ) : harness === 'native' && !nativeHasData ? (
        page === 'overview' ? (
          <>
            <h1>{text('How fast is each framework on Lynx?', '各框架在 Lynx 上有多快？')}</h1>
            <ResponsiveCopy className="subtitle">
              {text(
                'No complete Native comparison cohort is publishable for this snapshot. The at-a-glance matrix keeps every contracted cell visible without turning archived observations into rankings.',
                '此快照没有可发布的完整 Native 对比 cohort。概览矩阵仍展示合约中的每个单元，但不会把归档观察值转成排名。',
              )}
            </ResponsiveCopy>
            <HeatGrid rows={heatRows} scoreModes={interactionModes} harness={harness} theme={theme} selected={activeSelected} onToggle={toggleEntry} />
            <div className="empty-state">
              <p><b>{text('No publishable Native comparison cohort for this snapshot.', '此快照没有可发布的 Native 对比 cohort。')}</b></p>
              <p style={{ maxWidth: '62ch', margin: '0.5rem auto' }}>
                {text(
                  'Any archive-only observations follow. The appendix at the end distinguishes work that was never scheduled from evidenced DNF, proven unsupported capability, incompatible archived runs, and derivation defects.',
                  '下方保留仅供归档的观察值。末尾附录会区分从未调度的工作、有证据的 DNF、已证明不支持的能力、不兼容的归档运行和派生缺陷。',
                )}
              </p>
            </div>
            <NativeObservations theme={theme} />
            <NativeCoverage />
          </>
        ) : (
          <>
            <h1>{text('How does Native cost grow with scale?', 'Native 成本如何随规模增长？')}</h1>
            <ResponsiveCopy className="subtitle">
              {text(
                'This checkpoint has no complete Native cohort, so no cross-framework scale curve can be published. Archived observations remain visible as evidence below.',
                '此节点没有完整 Native cohort，因此无法发布跨框架规模曲线。归档观察值仍在下方作为证据展示。',
              )}
            </ResponsiveCopy>
            <NativeObservations theme={theme} />
          </>
        )
      ) : page === 'overview' ? (
        <>
          <h1>{text('How fast is each framework on Lynx?', '各框架在 Lynx 上有多快？')}</h1>
          <ResponsiveCopy className="subtitle">
            {text('The same table app, one instrument. ', '相同的表格应用，同一套测量工具。')}{harness === 'web'
              ? text('Headless Chromium running Lynx for Web; input is measured to the composed-DOM result.', '无头 Chromium 运行 Lynx for Web；从输入测量到 composed DOM 结果。')
              : text('Lynx Native Engine on an Android 10 Sandbox device; input-handler time is measured to the second native frame.', 'Android 10 Sandbox 设备运行 Lynx Native Engine；从输入处理器测量到第二个原生帧。')}{' '}
            {text(
              'Medians, lower is better. DNF is shown explicitly. Pick entries, hover anything, open any card\'s data table for exact numbers.',
              '结果取中位数，越低越好；DNF 会明确标出。可选择条目、悬停任意图形，并展开卡片数据表查看精确值。',
            )}
          </ResponsiveCopy>
          <HeatGrid rows={heatRows} scoreModes={interactionModes} harness={harness} theme={theme} selected={activeSelected} onToggle={toggleEntry} />
          {harness === 'native' && <NativeObservations theme={theme} />}
          <RankedBars
            title={text('interaction benchmark', '交互基准测试')}
            description={harness === 'web'
              ? locale === 'zh-CN'
                ? <>同一套 <KrausestBenchmarkLink /> workload，提供三种视图：上游九项加权得分，以及 1k/10k 等权规模切片。从 pointerdown 测量到 composed DOM；悬停或聚焦公式标签可查看方程。</>
                : <>One <KrausestBenchmarkLink /> workload family, three views: the upstream-weighted nine-case score and equal-weight 1k/10k scale slices. Measured from pointerdown → composed DOM; hover or focus a formula tab for its equation.</>
              : locale === 'zh-CN'
                ? <>相同的 <KrausestBenchmarkLink /> workload 在两个 Native 规模切片上运行，从输入处理器测量到第二个原生动画帧。悬停或聚焦公式标签可查看方程。</>
                : <>The same <KrausestBenchmarkLink /> workload family at two Native scale slices, measured from the input handler → second native animation frame. Hover or focus a formula tab for its equation.</>}
            suite="table"
            scoreModes={interactionModes}
            harness={harness}
            theme={theme}
            selected={activeSelected}
          />
          <RankedBars
            title={text('storms', '连续交互')}
            description={harness === 'web'
              ? text('one tap, many sequential render cycles (50 update / 30 select ticks through a MessageChannel pump). Throughput of the full state→render→wire→apply loop.', '一次点击触发多轮连续渲染（通过 MessageChannel pump 执行 50 次更新 / 30 次选择）。衡量完整 state→render→wire→apply 循环的吞吐。')
              : text('one tap, many sequential Native task/transport commits (50 update / 30 select ticks), each acknowledged before the next tick.', '一次点击触发多次连续 Native task/transport 提交（50 次更新 / 30 次选择），每次都在下一 tick 前收到确认。')}
            suite="table"
            ops={['updateStorm', 'selectStorm'].flatMap((w) =>
              workloadScales({ suite: 'table', harness, workload: w, metric: 'latency' })
                .map((s) => ({ key: `${w}@${s}`, label: `${localizedWorkload(w, locale)} @${scaleLabel(s)}`, workload: w, scale: s })))}
            harness={harness}
            theme={theme}
            selected={activeSelected}
          />
          <RankedBars
            title={text('startup (first contentful paint)', '启动（首次内容绘制）')}
            description={harness === 'web'
              ? text(
                'Local/cached startup: view attach → first frame with benchmark content, with N rows pre-rendered on the first screen. Production network transfer is outside this comparison; the signal is bundle parse/eval, framework boot, initial create and paint. Bundle gzip remains a separate shipping-cost metric.',
                '本地/缓存启动：view attach → 首个包含 benchmark 内容的帧，首屏预渲染 N 行。这里不比较生产网络传输；信号主要来自 bundle 解析/求值、框架初始化、首次创建与绘制。bundle gzip 仍作为独立的交付成本指标。',
              )
              : text(
                'Local/preloaded startup: native pipeline open → first contentful paint. Production network transfer is outside this comparison. Entries without a pipeline performance entry are absent rather than replaced by another boundary.',
                '本地/预加载启动：Native pipeline open → 首次内容绘制。这里不比较生产网络传输。缺少 pipeline performance entry 的条目直接留空，不会用其他边界替代。',
              )}
            suite="startup"
            metric="fcp"
            ops={workloadScales({ suite: 'startup', harness, workload: 'startup', metric: 'fcp' }).map((s) => ({
              key: `startup@${s}`, label: `@${scaleLabel(s)} ${text('rows', '行')}`, workload: 'startup', scale: s,
            }))}
            harness={harness}
            theme={theme}
            selected={activeSelected}
          />
          {harness === 'native' && ['octaneCommitAck', 'octaneSecondFrame'].map((metric) => {
            const metricRecords = select({ suite: 'startup', harness, workload: 'startup', metric });
            if (metricRecords.length === 0) return null;
            const isAck = metric === 'octaneCommitAck';
            return (
              <RankedBars
                key={metric}
                title={isAck ? text('Octane startup (transport commit ACK)', 'Octane 启动（transport 提交 ACK）') : text('Octane startup (second post-ACK frame)', 'Octane 启动（ACK 后第二帧）')}
                description={isAck
                  ? text('Open request → acknowledgement of Octane’s initial root transport commit. Octane-only Native metric; not FCP.', 'Open request → Octane 初始根 transport 提交的确认。仅适用于 Octane 的 Native 指标，不是 FCP。')
                  : text('Open request → second Native frame after Octane’s initial transport acknowledgement. Octane-only Native metric; not FCP.', 'Open request → Octane 初始 transport 确认后的第二个 Native 帧。仅适用于 Octane 的 Native 指标，不是 FCP。')}
                suite="startup"
                metric={metric}
                ops={workloadScales({ suite: 'startup', harness, workload: 'startup', metric }).map((s) => ({
                  key: `startup@${s}`, label: `@${scaleLabel(s)} ${text('rows', '行')}`, workload: 'startup', scale: s,
                }))}
                harness={harness}
                theme={theme}
                selected={activeSelected}
              />
            );
          })}
          <section className="thread-section" aria-labelledby="thread-section-title">
            <div className="section-heading">
              <div className="section-kicker">{text('Inside the operation', '操作内部')}</div>
              <h2 id="thread-section-title">{text('Thread & transport', '线程与传输')}</h2>
              <ResponsiveCopy className="section-copy">
                {text(
                  'Wall time can hide where work runs. This environment-specific breakdown keeps CPU, wire traffic, memory and bundle placement beside the headline ranking.',
                  '墙钟时间可能掩盖工作实际运行的位置。按环境拆分 CPU、wire traffic、内存和 bundle 分布，并与核心排名并列展示。',
                )}
              </ResponsiveCopy>
            </div>
            <ThreadsPage harness={harness} theme={theme} selected={activeSelected} />
            {harness === 'web' && <PipelineAttribution theme={theme} selected={activeSelected} />}
          </section>
          {harness === 'native' && <NativeCoverage />}
        </>
      ) : (
        <>
          <h1>{text('How does cost grow with scale?', '成本如何随规模增长？')}</h1>
          <ResponsiveCopy className="subtitle">
            {text(
              'The unified-matrix lineage: each case across row scales, linear for absolute gaps and log–log for shape. α is the fitted scaling exponent (1 = linear in N; below 1 = amortizing; 0 ≈ scale-independent).',
              '统一矩阵的规模轨迹：每个 case 跨行数观察；线性坐标展示绝对差距，log–log 展示增长形态。α 是拟合出的规模指数（1 = 随 N 线性增长；低于 1 = 成本被摊薄；0 ≈ 与规模无关）。',
            )}
          </ResponsiveCopy>
          <Legend harness={harness} theme={theme} selected={activeSelected} onToggle={toggleEntry} />
          <InteractionScaleComposite harness={harness} theme={theme} selected={activeSelected} />
          <CostSpace harness={harness} theme={theme} selected={activeSelected} />
          {trendSpecsForHarness(harness).map((spec) => (
            <ScaleTrend key={spec.title} spec={spec} harness={harness} theme={theme} selected={activeSelected} />
          ))}
        </>
      )}

      <HistoryRanking
        harness={harness}
        regime={regime}
        onHarnessChange={changeHarness}
        theme={theme}
        snapshotIndex={snapshotIndex}
        onSnapshotChange={onSnapshotChange}
      />

      <footer className="note" style={{ marginTop: '3rem', borderTop: '1px solid var(--border)', paddingTop: '1rem' }}>
        <a href="https://github.com/Huxpro/lynx-js-framework-benchmark" target="_blank" rel="noreferrer">
          github.com/Huxpro/lynx-js-framework-benchmark
        </a>
        {' '}· {text('reproduce with', '复现命令')} <code>pnpm bench run</code> · {text(
          'results are the checked-in materialized cache, regenerated from source before every build:',
          '结果是提交到仓库的物化缓存，每次构建前都会从来源重新生成：',
        )}{' '}<code>results/latest.json</code>
      </footer>
    </div>
  );
}

export default function App() {
  const [snapshotIndex, setSnapshotIndex] = useState(initialSnapshotIndex);
  const [regime, setRegime] = useState<WebRegime>(initialWebRegime);
  const snapshot = TIMELINE_SNAPSHOTS[snapshotIndex];
  const changeSnapshot = (index: number) => {
    setSnapshotIndex(index);
    const params = new URLSearchParams(location.search);
    const candidate = TIMELINE_SNAPSHOTS[index];
    const regimeAvailable = candidate.comparison.harnesses.some((cohort) => cohort.harness === 'web'
      && cohort.jsRegime === regime.jsRegime && cohort.jsFlags === regime.jsFlags
      && cohort.cpuThrottle === regime.cpuThrottle
      && cohort.throttleScope === regime.throttleScope);
    if (!regimeAvailable) {
      setRegime(DEFAULT_WEB_REGIME);
      params.delete('regime');
    }
    if (candidate.id === 'current-main') params.delete('snapshot');
    else params.set('snapshot', candidate.id);
    const query = params.toString();
    history.replaceState(null, '', query ? `?${query}` : location.pathname);
  };
  return (
    <BenchmarkDataProvider snapshot={snapshot} regime={regime}>
      <AppContent
        snapshotIndex={snapshotIndex}
        onSnapshotChange={changeSnapshot}
        regime={regime}
        onRegimeChange={setRegime}
      />
    </BenchmarkDataProvider>
  );
}
