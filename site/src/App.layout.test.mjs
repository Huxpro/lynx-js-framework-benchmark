import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
const threadsSource = fs.readFileSync(new URL('./components/Threads.tsx', import.meta.url), 'utf8');
const rankedBarsSource = fs.readFileSync(new URL('./components/RankedBars.tsx', import.meta.url), 'utf8');
const scaleCompositeSource = fs.readFileSync(new URL('./components/InteractionScaleComposite.tsx', import.meta.url), 'utf8');
const interactionScoreSource = fs.readFileSync(new URL('./interaction-score.ts', import.meta.url), 'utf8');
const heatGridSource = fs.readFileSync(new URL('./components/HeatGrid.tsx', import.meta.url), 'utf8');
const costSpaceSource = fs.readFileSync(new URL('./components/CostSpace.tsx', import.meta.url), 'utf8');
const methodSource = fs.readFileSync(new URL('./components/Method.tsx', import.meta.url), 'utf8');
const scaleTrendsSource = fs.readFileSync(new URL('./components/ScaleTrends.tsx', import.meta.url), 'utf8');

test('rank by dataset is the final content section', () => {
  const history = source.indexOf('<HistoryRanking');
  const pageContentEnd = source.lastIndexOf("      )}\n", history);
  const historyEnd = source.indexOf('/>', history);
  const footer = source.indexOf('<footer', history);

  assert.notEqual(history, -1);
  assert.ok(pageContentEnd < history, 'history ranking must follow the selected page content');
  assert.ok(historyEnd < footer, 'history ranking must remain before the footer');
  assert.equal(source.slice(historyEnd + 2, footer).trim(), '');
});

test('Native overview leads with the at-a-glance table and ends with coverage appendix', () => {
  const overview = source.slice(
    source.indexOf("page === 'overview'"),
    source.indexOf("page === 'scale'"),
  );
  const glance = overview.indexOf('<HeatGrid');
  const coverage = overview.indexOf('<NativeCoverage');

  assert.notEqual(glance, -1);
  assert.notEqual(coverage, -1);
  assert.ok(glance < coverage, 'at-a-glance table must precede the Native coverage appendix');
});

test('Native empty snapshots lead with at-a-glance and end with the coverage appendix', () => {
  const emptyState = source.slice(
    source.indexOf("harness === 'native' && !nativeHasData"),
    source.indexOf(") : page === 'overview'"),
  );
  const glance = emptyState.indexOf('<HeatGrid');
  const observations = emptyState.indexOf('<NativeObservations');
  const coverage = emptyState.indexOf('<NativeCoverage');

  assert.notEqual(glance, -1);
  assert.notEqual(observations, -1);
  assert.notEqual(coverage, -1);
  assert.ok(glance < observations, 'at-a-glance table must lead the Native empty state');
  assert.ok(observations < coverage, 'coverage contract must remain the final Native appendix');
});

test('Threads and method are inlined instead of competing page tabs', () => {
  assert.match(source, /type Page = 'overview' \| 'scale'/);
  assert.doesNotMatch(source, /page === 'threads'/);
  assert.doesNotMatch(source, /page === 'method'/);
  assert.match(source, /<ThreadsPage harness=\{harness\}/);
  assert.match(source, /<MeasurementReceipt harness=\{harness\}/);
});

test('endpoint rows are a collapsed data appendix owned by the wire visualization', () => {
  const wireGroup = threadsSource.indexOf('className="wire-analysis"');
  const appendix = threadsSource.indexOf('<EndpointTable', wireGroup);

  assert.notEqual(wireGroup, -1);
  assert.ok(appendix > wireGroup);
  assert.match(threadsSource, /<details className="visualization-appendix">/);
  assert.match(threadsSource, /<small>\{text\('Data appendix', '数据附录'\)\}<\/small>/);
  assert.doesNotMatch(threadsSource, /<details className="visualization-appendix" open/);
});

test('Native empty checkpoints preserve the selected Scale view', () => {
  const emptyState = source.slice(
    source.indexOf("harness === 'native' && !nativeHasData"),
    source.indexOf(") : page === 'overview'"),
  );
  assert.match(emptyState, /How does Native cost grow with scale/);
});

test('interaction workloads share one module with three formula modes and one detail rail', () => {
  assert.match(source, /https:\/\/github\.com\/krausest\/js-framework-benchmark/);
  assert.match(source, /className="external-link benchmark-source-link"/);
  assert.match(source, /title=\{text\('interaction benchmark', '交互基准测试'\)\}/);
  assert.match(source, /label: text\('js-framework weighted', 'js-framework 加权'\)/);
  assert.match(source, /label: text\('equal · 1k', '等权 · 1k'\)/);
  assert.match(source, /label: text\('equal · 10k', '等权 · 10k'\)/);
  assert.match(interactionScoreSource, /select@1000/);
  assert.match(interactionScoreSource, /clear@1000/);
  assert.match(source, /scoreModes=\{interactionModes\}/);
  assert.doesNotMatch(source, /title="js-framework weighted score"/);
  assert.doesNotMatch(source, /title="interaction latency @(?:1|10)k"/);
  assert.match(rankedBarsSource, /className="score-mode-tabs"/);
  assert.match(rankedBarsSource, /className="score-mode-info">\?</);
  assert.match(rankedBarsSource, /className=\{hasScoreModes \? 'chips score-detail-tabs'/);
  assert.match(rankedBarsSource, /showEquation\(mode\)/);
  assert.match(rankedBarsSource, /onFocus=\{\(event\) =>/);
  assert.match(rankedBarsSource, /'ArrowLeft', 'ArrowRight', 'Home', 'End'/);
});

test('at-a-glance conclusions lead with startup FCP and reuse the three interaction equations', () => {
  assert.equal(source.match(/<HeatGrid[^>]*scoreModes=\{interactionModes\}/g)?.length, 2);
  assert.match(heatGridSource, /scoreModes: ScoreModeSpec\[\]/);
  assert.match(heatGridSource, /completeEntryScores/);
  assert.doesNotMatch(heatGridSource, /completeRowGeomeans|>geomean<|'geomean', '几何平均'/);
  assert.match(heatGridSource, /scoreMode\.scoreWeights/);
  assert.match(heatGridSource, /scoreMode\.ops\.map\(\(op\) => op\.key\)/);
  assert.match(heatGridSource, /scoreInputKey\(row\.spec\)/);
  assert.match(heatGridSource, /const startupScoreRow = useMemo/);
  assert.match(heatGridSource, /row\.spec\.suite === 'startup'/);
  assert.match(heatGridSource, /row\.spec\.metric === 'fcp'/);
  assert.match(heatGridSource, /groupLabel: text\('Startup', '启动'\)/);
  assert.match(heatGridSource, /const conclusionRows =/);
  assert.match(heatGridSource, /rebaseEntryScores\(ids, scoreRow\.values, activeMode\)/);
  assert.match(heatGridSource, /formula score ÷.*formula score/);
  assert.match(heatGridSource, /const fastestValue = activeMode === 'fastest'/);
  assert.match(heatGridSource, /const isFastest = fastestValue != null && value === fastestValue/);
  assert.match(heatGridSource, /`data\$\{isFastest \? ' fastest' : ''\}`/);
});

test('at-a-glance equations expose pointer, keyboard, and pinned row tracing', () => {
  assert.match(heatGridSource, /onPointerEnter=\{showEquation\}/);
  assert.match(heatGridSource, /onFocus=\{showEquation\}/);
  assert.match(heatGridSource, /aria-pressed=\{isPinned\}/);
  assert.match(heatGridSource, /setPinnedScore/);
  assert.match(heatGridSource, /is-score-source/);
  assert.match(heatGridSource, /is-score-muted/);
  assert.match(heatGridSource, /document\.addEventListener\('pointerdown', clearOutside\)/);
  assert.match(heatGridSource, /event\.key === 'Escape'/);
});

test('Scale leads with one scale-comparable interaction composite instead of misusing the upstream mixed-scale score', () => {
  const composite = source.indexOf('<InteractionScaleComposite');
  const costSpace = source.indexOf('<CostSpace', composite);

  assert.notEqual(composite, -1);
  assert.ok(composite < costSpace, 'the interaction composite should lead the Scale diagrams');
  assert.match(scaleCompositeSource, /same complete operation set at every scale/i);
  assert.match(scaleCompositeSource, /completeEntryScores\(ids, cells\)/);
  assert.match(scaleCompositeSource, /equal-weight geometric mean/);
  assert.match(scaleCompositeSource, /distinct from the upstream score/);
  assert.match(scaleCompositeSource, /mixes fixed 1k and 10k cases/);
  assert.match(scaleCompositeSource, /commonWorkloads\.length/);
  assert.match(scaleCompositeSource, /commonWorkloads\.length < 2/);
  assert.match(scaleCompositeSource, /no aggregate is drawn/);
  assert.match(scaleCompositeSource, /className="formula-explainer"/);
});

test('startup FCP states its local bundle and non-network boundary everywhere it is interpreted', () => {
  assert.match(source, /Local\/cached startup: view attach/);
  assert.match(source, /Production network transfer is outside this comparison/);
  assert.match(source, /bundle parse\/eval, framework boot, initial create and paint/);
  assert.match(costSpaceSource, /x-axis is a separate static shipping cost/);
  assert.match(costSpaceSource, /production network transfer is not inside FCP/);
  assert.match(scaleTrendsSource, /Local\/cached bundle: view attach/);
  assert.match(methodSource, /workload-defined content boundary, not cold browser-navigation FCP/);
  assert.match(methodSource, /DNS, TLS, CDN and bandwidth are outside the timing/);
  assert.match(methodSource, /github\.com\/google\/tachometer#first-contentful-paint-fcp/);
  assert.match(methodSource, /developer\.chrome\.com\/docs\/lighthouse\/performance\/first-contentful-paint/);
});
