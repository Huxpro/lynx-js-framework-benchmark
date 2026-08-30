import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('./components/TimelineSlider.tsx', import.meta.url), 'utf8');
const themeSource = fs.readFileSync(new URL('./theme.css', import.meta.url), 'utf8');
const legendSource = fs.readFileSync(new URL('./components/Legend.tsx', import.meta.url), 'utf8');
const receiptSource = fs.readFileSync(new URL('./components/Method.tsx', import.meta.url), 'utf8');
const rankingSource = fs.readFileSync(new URL('./components/HistoryRanking.tsx', import.meta.url), 'utf8');
const appSource = fs.readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
const contextSource = fs.readFileSync(new URL('./data-context.tsx', import.meta.url), 'utf8');
const dataSource = fs.readFileSync(new URL('./data.ts', import.meta.url), 'utf8');
const entry = (id) => JSON.parse(fs.readFileSync(
  new URL(`../../entries/${id}/entry.json`, import.meta.url),
  'utf8',
));

test('dataset checkpoints are named independently of any one framework commit', () => {
  assert.match(source, /localizedCheckpoint\(checkpoint, locale\)/);
  assert.doesNotMatch(source, /checkpoint\.identityPointers\.map/);
  assert.doesNotMatch(source, /octaneCommit/);
  assert.doesNotMatch(source, />Octane \{/);
  assert.match(rankingSource, /rankHistoryCell\(cohort\.entryIds/);
  assert.doesNotMatch(rankingSource, /FEATURED_IDS/);
});

test('dataset navigation and ranking share the same discrete checkpoint model', () => {
  assert.match(source, /snapshots\.map/);
  assert.match(source, /className=\{`timeline-dot/);
  assert.match(source, /timeline-range-progress/);
  assert.match(rankingSource, /type: 'point'/);
  assert.match(rankingSource, /domain: DATASET_IDS/);
  assert.match(rankingSource, /x: 'dataset'/);
  assert.match(rankingSource, /text\('Rank by dataset', '按 dataset 排名'\)/);
  assert.doesNotMatch(rankingSource, /type: 'utc'/);
  assert.doesNotMatch(rankingSource, /x: 'time'/);
});

test('history ranking keeps cohort transitions visible and puts rank context inside the plot', () => {
  assert.match(rankingSource, /Plot\.link\(transitions/);
  assert.match(rankingSource, /strokeDasharray: '5,4'/);
  assert.match(rankingSource, /Plot\.text\(selectedPoints/);
  assert.match(rankingSource, /formatPointValue\(point, locale\)/);
  assert.doesNotMatch(rankingSource, /className="history-selected"/);
  assert.match(rankingSource, /className="history-choice-rail"/);
  assert.match(rankingSource, /'ArrowLeft', 'ArrowRight', 'Home', 'End'/);
  assert.match(rankingSource, /tabIndex=\{option\.value === value \? 0 : -1\}/);
  assert.doesNotMatch(rankingSource, /<select/);
  assert.match(rankingSource, /label=\{text\('Rank', '排名'\)\}/);
  assert.match(rankingSource, /Composite score/);
  assert.match(rankingSource, /Single measurement/);
  assert.match(rankingSource, /label=\{text\('Formula', '公式'\)\}/);
  assert.match(rankingSource, /label: text\('weighted · available', '加权 · 可用单元'\)/);
  assert.match(rankingSource, /label: text\(`equal · \$\{scale \/ 1000\}k`, `等权 · \$\{scale \/ 1000\}k`\)/);
  assert.match(rankingSource, /rankHistoryAggregate\(\s*cohort\.entryIds/);
  assert.match(rankingSource, /activeScoreMode\.weights/);
  assert.match(rankingSource, /completeHistoryAggregateCells\(cohort\.entryIds/);
  assert.match(rankingSource, /selectedAggregateCellCount/);
  assert.match(rankingSource, /history-choice-info/);
  assert.match(rankingSource, /remaining weights are renormalized/);
  assert.doesNotMatch(rankingSource, /label="Scale"[\s\S]*relative geomean/);
});

test('history ranking defaults to a complete replay and explains every dataset delta', () => {
  assert.match(rankingSource, /WEB_HISTORY_REPLAY/);
  assert.match(rankingSource, /historyReplayRecordsForCheckpoint/);
  assert.match(rankingSource, /const REPLAY_BASIS = 'replay'/);
  assert.match(rankingSource, /param\('historyBasis'\) === ORIGINAL_BASIS/);
  assert.match(rankingSource, /label: text\('Unified replay', '统一 replay'\)/);
  assert.match(rankingSource, /label: text\('Original runs', '原始运行'\)/);
  assert.match(rankingSource, /11 repetitions · 12\/12 standard latency cells/);
  assert.match(rankingSource, /className="history-change-asterisk"/);
  assert.match(rankingSource, /text\('Change ledger', '变化台账'\)/);
  assert.match(rankingSource, /rankDeltaGlyph/);
  assert.match(rankingSource, /sourceChanges/);
  assert.match(rankingSource, /formulaAdded/);
  assert.match(rankingSource, /machineChanged/);
  assert.match(rankingSource, /run-to-run measurement variance/);
});

test('history ranking exposes every series to hover and legend focus highlighting', () => {
  assert.match(rankingSource, /className: 'history-series history-series-line'/);
  assert.match(rankingSource, /className: 'history-series history-series-point'/);
  assert.match(rankingSource, /focusSeriesRef/);
  assert.match(rankingSource, /mark\.classList\.toggle\('is-series-muted'/);
  assert.match(rankingSource, /data-history-entry=\{entry\.id\}/);
  assert.match(rankingSource, /aria-label=\{text\(`Highlight \$\{shortLabel\(entry\.id\)\}`, `高亮 \$\{shortLabel\(entry\.id\)\}`\)\}/);
});

test('framework hover cards own source links and exact plugin options', () => {
  assert.match(legendSource, /snapshot\.identityPointers\.find/);
  assert.match(legendSource, /className="external-link"/);
  assert.match(legendSource, /href=\{configuration\.href\}/);
  assert.doesNotMatch(legendSource, /<a[^>]+className="item"/);
  assert.doesNotMatch(legendSource, /<button\s+className="item"[^>]*aria-controls/);
  assert.match(legendSource, /className="entry-info-trigger"/);
  assert.match(legendSource, /aria-controls=\{detailId\}/);

  assert.equal(entry('vue-vdom').label, 'Vue');
  assert.equal(entry('vue-vdom-ifr-et').label, 'Vue +IFR');
  assert.equal(entry('vue-vapor').label, 'Vue Vapor');
  assert.equal(entry('vue-vapor-ifr').label, 'Vue Vapor +IFR');
  assert.match(entry('vue-vdom-ifr-et').configuration.summary, /enableElementTemplates: true/);
  assert.match(entry('vue-vapor-ifr').configuration.summary, /enableElementTemplates: false/);
  assert.equal(entry('octane-hux').label, 'Octane (Hux)');
  assert.equal(entry('octane-hux1').tier, 'archive');
  assert.equal(entry('octane-hux2').tier, 'archive');
  assert.equal(entry('octane-hux2').supersededBy, 'octane-hux');
});

test('sticky workspace owns view and environment navigation', () => {
  assert.match(source, /`workspace-toolbar\$\{/);
  assert.match(source, /\(\['overview', 'scale'\] as const\)/);
  assert.match(source, /<span>\{text\('Lynx for', 'Lynx 环境'\)\}<\/span>/);
  assert.match(source, /candidate === 'web' \? 'Web' : 'Native'/);
  assert.doesNotMatch(source, /Native engine/);
});

test('Web regime facet is explicit, URL-addressable, and cannot mix ranking records', () => {
  assert.match(source, /JavaScript execution regime/);
  assert.match(source, /WEB_REGIMES\.map/);
  assert.match(source, /cohort\.jsRegime === candidate\.jsRegime/);
  assert.match(source, /cohort\.jsFlags === candidate\.jsFlags/);
  assert.match(source, /cohort\.cpuThrottle === candidate\.cpuThrottle/);
  assert.match(appSource, /params\.set\('regime', id\)/);
  assert.doesNotMatch(appSource, /regime-disclaimer|Directional probe — interpreter-only/);
  assert.match(dataSource, /label: 'JIT'/);
  assert.match(dataSource, /label: 'Interp'/);
  assert.doesNotMatch(`${source}\n${receiptSource}\n${appSource}\n${dataSource}`, /Ignition/);
  assert.match(contextSource, /recordMatchesWebRegime\(record, regime\)/);
  assert.match(rankingSource, /record\.jsRegime === regime\.jsRegime/);
  assert.match(rankingSource, /record\.jsFlags === regime\.jsFlags/);
  assert.match(rankingSource, /record\.cpuThrottle === regime\.cpuThrottle/);
});

test('mobile workspace folds advanced regimes without hiding primary controls', () => {
  assert.match(source, /useMediaQuery\('\(max-width: 48rem\)'\)/);
  assert.match(source, /className="advanced-toggle"/);
  assert.match(source, /aria-expanded=\{advancedOpen\}/);
  assert.match(source, /aria-controls=\{advancedId\}/);
  assert.match(source, /showAdvanced = harness === 'web' && \(!compact \|\| advancedOpen\)/);
  assert.match(source, /workspace-toolbar\$\{showAdvanced \? ' is-advanced-open' : ''\}/);
  assert.match(source, /\{showAdvanced && \(\s*<div className="workspace-advanced" id=\{advancedId\}>/);
  assert.doesNotMatch(source, /className="workspace-advanced"[^>]*hidden=/);
  assert.match(source, /<span>JS<\/span>/);
  assert.match(source, /className="workspace-preferences"/);
  assert.match(source, /className="harness-switch"/);
  assert.match(themeSource, /grid-template-areas: 'view environment toggle preferences';/);
  assert.match(themeSource, /\.workspace-toolbar\.is-advanced-open\s*\{[\s\S]*?'advanced advanced advanced advanced'/);
});

test('regime measurement details are available from the compact information disclosure', () => {
  assert.match(source, /<details className="regime-info">/);
  assert.match(source, /How these lanes are measured/);
  assert.match(source, /Chromium runs the default V8 compilation tiers/);
  assert.match(source, /V8 JavaScript compiler tiers are disabled; Wasm stays compiled/);
  assert.match(source, /CDP 4× throttling on the page\/MTS target/);
  assert.match(source, /inherited, calibrated OS quota for the Chromium process tree/);
  assert.match(source, /Every entry must verify 3\.5–4\.5× slowdown/);
  assert.match(source, /Rankings stay separate across every lane/);
});

test('sticky workspace gives its second row entirely to the dataset slider', () => {
  assert.match(source, /className="timeline-control"/);
  assert.doesNotMatch(source, /timeline-copy/);
  assert.doesNotMatch(source, /timeline-identities/);
  assert.doesNotMatch(source, /timeline-meta/);
  assert.match(receiptSource, /checkpointCopy\?\.label/);
  assert.match(receiptSource, /checkpointCopy\?\.description/);
  assert.match(receiptSource, /text\('What changed', '发生了什么变化'\)/);
  assert.match(receiptSource, /dateTime=\{snapshot\.generatedAt\}/);
  assert.match(legendSource, /className="entry-method"/);
});
