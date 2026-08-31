import { useState } from 'react';
import {
  BENCHMARK_HISTORY,
  TimelineSnapshot,
  WEB_REGIMES,
  WebRegime,
  isPublicWebRegime,
} from '../data';
import { useMediaQuery } from '../hooks';
import { localizedCheckpoint, useI18n } from '../i18n';

export function TimelineSlider({
  snapshots,
  index,
  onChange,
  page,
  onPageChange,
  harness,
  onHarnessChange,
  regime,
  onRegimeChange,
  theme,
  onThemeToggle,
  heatPalette,
  onHeatPaletteToggle,
}: {
  snapshots: TimelineSnapshot[];
  index: number;
  onChange: (index: number) => void;
  page: 'overview' | 'scale';
  onPageChange: (page: 'overview' | 'scale') => void;
  harness: string;
  onHarnessChange: (harness: string) => void;
  regime: WebRegime;
  onRegimeChange: (regime: WebRegime) => void;
  theme: 'light' | 'dark';
  onThemeToggle: () => void;
  heatPalette: 'standard' | 'colorblind';
  onHeatPaletteToggle: () => void;
}) {
  const { locale, text, date, toggleLocale } = useI18n();
  const compact = useMediaQuery('(max-width: 48rem)');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const snapshot = snapshots[index];
  const checkpoint = BENCHMARK_HISTORY.checkpoints[index];
  const checkpointCopy = localizedCheckpoint(checkpoint, locale);
  const progress = snapshots.length > 1 ? (index / (snapshots.length - 1)) * 100 : 0;
  const activeRegime = WEB_REGIMES.find((candidate) => candidate.jsRegime === regime.jsRegime
    && candidate.jsFlags === regime.jsFlags
    && candidate.cpuThrottle === regime.cpuThrottle
    && candidate.throttleScope === regime.throttleScope);
  const showAdvanced = harness === 'web' && (!compact || advancedOpen);
  const advancedId = 'workspace-advanced-configuration';
  const cohorts = checkpoint.harnesses.filter((cohort) => cohort.harness !== 'web'
    || isPublicWebRegime({
      jsRegime: cohort.jsRegime!,
      jsFlags: cohort.jsFlags!,
      cpuThrottle: cohort.cpuThrottle!,
      throttleScope: cohort.throttleScope!,
    })).map((cohort) => {
    const environment = cohort.harness === 'web'
      ? `Web ${cohort.jsRegime === 'interp' ? 'Interp' : 'JIT'} ${
        cohort.cpuThrottle === 1
          ? '1×'
          : `${cohort.cpuThrottle ?? 1}×`
      }`
      : 'Native';
    return `${environment} ${cohort.entryIds.length}${cohort.rankEligible ? '' : text(' observation', '（观察值）')}`;
  });
  return (
    <div className="timeline-sticky">
      <div className="timeline-workspace">
        <div className={`workspace-toolbar${showAdvanced ? ' is-advanced-open' : ''}`}>
          <nav className="view-switch" aria-label={text('Benchmark views', '基准测试视图')}>
            {(['overview', 'scale'] as const).map((view) => (
              <button
                key={view}
                type="button"
                aria-current={page === view ? 'page' : undefined}
                onClick={() => onPageChange(view)}
              >{view === 'overview' ? text('Overview', '总览') : text('Scale', '规模')}</button>
            ))}
          </nav>
          <div className="workspace-environment">
            <span>{text('Lynx for', 'Lynx 环境')}</span>
            <div className="harness-switch" role="group" aria-label={text('Environment', '运行环境')}>
              {(['web', 'native'] as const).map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  aria-pressed={harness === candidate}
                  onClick={() => onHarnessChange(candidate)}
                >{candidate === 'web' ? 'Web' : 'Native'}</button>
              ))}
            </div>
          </div>
          {harness === 'web' && compact && (
            <button
              className="advanced-toggle"
              type="button"
              aria-expanded={advancedOpen}
              aria-controls={advancedId}
              aria-label={text(
                `JavaScript configuration, current ${activeRegime?.label ?? 'regime'}`,
                `JavaScript 配置，当前为 ${activeRegime?.label ?? 'regime'}`,
              )}
              title={text('JavaScript configuration', 'JavaScript 配置')}
              onClick={() => setAdvancedOpen((open) => !open)}
            >
              <span>JS</span>
              <output>{activeRegime?.label ?? text('Regime', '政权')}</output>
              <i aria-hidden="true">⌄</i>
            </button>
          )}
          {showAdvanced && (
            <div className="workspace-advanced" id={advancedId}>
              <div className="workspace-regime-heading">
                <span>{text('JavaScript', 'JavaScript')}</span>
                <details className="regime-info">
                  <summary
                    aria-label={text('How JavaScript regimes are measured', 'JavaScript 政权如何测量')}
                    title={text('How JavaScript regimes are measured', 'JavaScript 政权如何测量')}
                  >i</summary>
                  <aside className="regime-method" aria-label={text('JavaScript regime measurement details', 'JavaScript 政权测量详情')}>
                    <strong>{text('How these lanes are measured', '这些 lane 如何测量')}</strong>
                    <dl>
                      <div>
                        <dt>JIT</dt>
                        <dd>{text('Chromium runs the default V8 compilation tiers. CPU runs at 1×.', 'Chromium 使用 V8 默认编译层级，CPU 为 1×。')}</dd>
                      </div>
                      <div>
                        <dt>Interp</dt>
                        <dd>{text('V8 JavaScript compiler tiers are disabled; Wasm stays compiled. CPU runs at 1×.', '关闭 V8 的 JavaScript 编译层级；Wasm 保持编译执行。CPU 为 1×。')}</dd>
                      </div>
                      <div>
                        <dt>Interp 4×</dt>
                        <dd>{text('Interp plus an inherited, calibrated OS quota for the Chromium process tree. Every entry must verify 3.5–4.5× slowdown.', 'Interp 加 Chromium 进程树继承式、经校准的 OS 配额；每个 entry 都必须验证 3.5–4.5× slowdown。')}</dd>
                      </div>
                    </dl>
                    <p>{text('Interp 4× always means whole-process throttling. Rankings stay separate across every lane.', 'Interp 4× 始终表示整进程限速；每条 lane 始终独立排名。')}</p>
                  </aside>
                </details>
              </div>
              <div
                className="regime-scroll"
                tabIndex={0}
                aria-label={text('Scrollable JavaScript execution regimes', '可横向滚动的 JavaScript 执行政权')}
              >
                <div className="regime-switch" role="group" aria-label={text('JavaScript execution regime', 'JavaScript 执行政权')}>
                  {WEB_REGIMES.map((candidate) => {
                    const available = checkpoint.harnesses.some((cohort) => cohort.harness === 'web'
                      && cohort.jsRegime === candidate.jsRegime
                      && cohort.jsFlags === candidate.jsFlags
                      && cohort.cpuThrottle === candidate.cpuThrottle
                      && cohort.throttleScope === candidate.throttleScope);
                    return (
                      <button
                        key={candidate.id}
                        type="button"
                        aria-pressed={regime.jsRegime === candidate.jsRegime
                          && regime.jsFlags === candidate.jsFlags
                          && regime.cpuThrottle === candidate.cpuThrottle
                          && regime.throttleScope === candidate.throttleScope}
                        disabled={!available}
                        onClick={() => onRegimeChange({
                          jsRegime: candidate.jsRegime,
                          jsFlags: candidate.jsFlags,
                          cpuThrottle: candidate.cpuThrottle,
                          throttleScope: candidate.throttleScope,
                        })}
                      >{candidate.label}</button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
          <div className="workspace-preferences">
            <button
              className="palette-toggle"
              type="button"
              aria-pressed={heatPalette === 'colorblind'}
              onClick={onHeatPaletteToggle}
              aria-label={heatPalette === 'colorblind'
                ? text('Use green–red heatmap', '使用绿—红热图')
                : text('Use color-blind-safe blue–orange heatmap', '使用色盲友好的蓝—橙热图')}
              title={heatPalette === 'colorblind'
                ? text('Color-blind mode: blue–orange', '色盲模式：蓝—橙')
                : text('Standard mode: green–red', '标准模式：绿—红')}
            >
              <span className="palette-pair" aria-hidden="true"><i /><i /></span>
            </button>
            <button
              className="locale-toggle"
              type="button"
              onClick={toggleLocale}
              aria-label={locale === 'en' ? '切换到中文' : 'Switch to English'}
              title={locale === 'en' ? '切换到中文' : 'Switch to English'}
            >
              <span className={locale === 'en' ? 'is-active' : ''}>EN</span>
              <i aria-hidden="true">/</i>
              <span className={locale === 'zh-CN' ? 'is-active' : ''}>中</span>
            </button>
            <button className="theme-toggle" type="button" onClick={onThemeToggle} aria-label={text('Toggle theme', '切换主题')}>
              {theme === 'dark' ? '☀' : '☾'}
            </button>
          </div>
        </div>
        <section className="timeline" aria-label={text('Dataset time machine', '数据集时光机')}>
        <div className="timeline-control">
          <button
            type="button"
            aria-label={text('Previous exact-source checkpoint', '上一个精确来源节点')}
            disabled={index === 0}
            onClick={() => onChange(index - 1)}
          >←</button>
          <div className="timeline-range">
            <div className="timeline-range-track" aria-hidden="true">
              <span className="timeline-range-progress" style={{ width: `${progress}%` }} />
              {snapshots.map((candidate, checkpointIndex) => (
                <i
                  key={candidate.id}
                  className={`timeline-dot${checkpointIndex <= index ? ' is-reached' : ''}${checkpointIndex === index ? ' is-active' : ''}`}
                  style={{ left: `${snapshots.length > 1 ? (checkpointIndex / (snapshots.length - 1)) * 100 : 50}%` }}
                />
              ))}
            </div>
            <input
              type="range"
              min={0}
              max={snapshots.length - 1}
              step={1}
              value={index}
              onChange={(event) => onChange(Number(event.target.value))}
              aria-label={text('Dataset checkpoint', '数据集节点')}
              aria-valuetext={`${checkpointCopy.label}, ${date(snapshot.generatedAt, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })}, ${text(`${checkpoint.identityPointers.length} framework identities`, `${checkpoint.identityPointers.length} 个框架身份`)}, ${cohorts.join(', ')}`}
            />
          </div>
          <button
            type="button"
            aria-label={text('Next exact-source checkpoint', '下一个精确来源节点')}
            disabled={index === snapshots.length - 1}
            onClick={() => onChange(index + 1)}
          >→</button>
        </div>
        </section>
      </div>
    </div>
  );
}
