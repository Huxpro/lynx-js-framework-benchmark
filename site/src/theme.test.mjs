import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const css = fs.readFileSync(new URL('./theme.css', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const hooks = fs.readFileSync(new URL('./hooks.tsx', import.meta.url), 'utf8');
const costSpace = fs.readFileSync(new URL('./components/CostSpace.tsx', import.meta.url), 'utf8');
const scaleTrends = fs.readFileSync(new URL('./components/ScaleTrends.tsx', import.meta.url), 'utf8');
const scaleComposite = fs.readFileSync(new URL('./components/InteractionScaleComposite.tsx', import.meta.url), 'utf8');
const responsiveCopy = fs.readFileSync(new URL('./components/ResponsiveCopy.tsx', import.meta.url), 'utf8');

test('expanded exact-data tables scroll inside their card on narrow viewports', () => {
  const rule = css.match(/details\.data-table\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(rule, /max-width\s*:\s*100%/);
  assert.match(rule, /overflow-x\s*:\s*auto/);
});

test('framework details do not share the selection button hover target', () => {
  assert.match(css, /\.entry-info:hover \.entry-method/);
  assert.match(css, /\.entry-info:focus-within \.entry-method/);
  assert.doesNotMatch(css, /\.legend-entry:hover \.entry-method/);
});

test('dataset slider owns the full sticky second row', () => {
  const timeline = css.match(/\.timeline\s*\{([^}]*)\}/)?.[1] ?? '';
  const control = css.match(/\.timeline-control\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.doesNotMatch(timeline, /grid-template-columns/);
  assert.match(control, /minmax\(0, 1fr\)/);
});

test('dataset slider exposes a visible checkpoint rail without replacing the range input', () => {
  assert.match(css, /\.timeline-range-track\s*\{/);
  assert.match(css, /\.timeline-dot\s*\{/);
  assert.match(css, /\.timeline-dot\.is-active\s*\{/);
  assert.match(css, /\.timeline-range input\[type='range'\]/);
});

test('ranking configuration is a horizontally browsable one-click option rail', () => {
  assert.match(css, /\.history-choice-rail\s*\{/);
  assert.match(css, /\.history-choice-scroll\s*\{/);
  assert.match(css, /overflow-x\s*:\s*auto/);
  assert.match(css, /\.history-choice-scroll button\[aria-pressed='true'\]/);
  assert.match(css, /@media \(pointer: coarse\)/);
});

test('ranking choices use an independent selection rule instead of a rounded bordered block', () => {
  const button = css.match(/\.history-choice-scroll button\s*\{([^}]*)\}/)?.[1] ?? '';
  const active = css.match(/\.history-choice-scroll button\[aria-pressed='true'\]\s*\{([^}]*)\}/)?.[1] ?? '';

  assert.doesNotMatch(button, /border-radius/);
  assert.doesNotMatch(active, /background|border|box-shadow/);
  assert.match(css, /\.history-choice-scroll button::after\s*\{/);
  assert.match(css, /button\[aria-pressed='true'\]::after\s*\{\s*transform: scaleX\(1\)/);
});

test('interaction formula and detail tabs each stay on one horizontally browsable row', () => {
  const formulas = css.match(/\.score-mode-tabs\s*\{([^}]*)\}/)?.[1] ?? '';
  const details = css.match(/\.score-detail-tabs\s*\{([^}]*)\}/)?.[1] ?? '';
  const formulaButton = css.match(/\.score-mode-tab\s*\{([^}]*)\}/)?.[1] ?? '';

  assert.match(formulas, /grid-auto-flow\s*:\s*column/);
  assert.match(formulas, /overflow-x\s*:\s*auto/);
  assert.match(details, /flex-wrap\s*:\s*nowrap/);
  assert.match(details, /overflow-x\s*:\s*auto/);
  assert.doesNotMatch(formulaButton, /border-radius/);
});

test('all case rails browse horizontally instead of wrapping into extra rows', () => {
  const chips = css.match(/\.chips\s*\{([^}]*)\}/)?.[1] ?? '';
  const chip = css.match(/\.chips \.chip\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(chips, /flex-wrap\s*:\s*nowrap/);
  assert.match(chips, /overflow-x\s*:\s*auto/);
  assert.match(chip, /flex\s*:\s*0 0 auto/);
  assert.match(chip, /white-space\s*:\s*nowrap/);
});

test('heat matrix preserves readable labels and delegates narrow width to scrolling', () => {
  const scroll = css.match(/\.heat-scroll\s*\{([^}]*)\}/)?.[1] ?? '';
  const table = css.match(/table\.heat\s*\{([^}]*)\}/)?.[1] ?? '';
  const column = css.match(/table\.heat th\.colhead\s*\{([^}]*)\}/)?.[1] ?? '';
  const row = css.match(/table\.heat \.rowhead\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(scroll, /overflow-x\s*:\s*auto/);
  assert.match(table, /width\s*:\s*max-content/);
  assert.match(column, /white-space\s*:\s*nowrap/);
  assert.match(row, /white-space\s*:\s*nowrap/);
});

test('heat score tracing emphasizes formula inputs without hiding source rows', () => {
  assert.match(css, /table\.heat tbody tr\.is-score-muted\s*\{\s*opacity: 0\.18/);
  assert.match(css, /table\.heat tbody tr\.is-score-source \.rowhead/);
  assert.match(css, /\.score-summary-trigger\s*\{/);
  assert.match(css, /\.score-summary-trigger\[aria-pressed='true'\]/);
  assert.doesNotMatch(css.match(/\.score-summary-trigger\s*\{([^}]*)\}/)?.[1] ?? '', /border-radius/);
});

test('compact prose uses native progressive disclosure without hiding primary results', () => {
  assert.match(responsiveCopy, /useMediaQuery\('\(max-width: 48rem\)'\)/);
  assert.match(responsiveCopy, /<details className=/);
  assert.match(responsiveCopy, /<summary>/);
  assert.match(responsiveCopy, /if \(!compact\) return/);
  assert.match(css, /--leading-copy\s*:\s*1\.62/);
  assert.match(css, /\.responsive-copy-body\s*\{/);
});

test('ranking series fade as a group while the hovered line is emphasized', () => {
  assert.match(css, /\.history-series \.is-series-muted\s*\{\s*opacity: 0\.12/);
  assert.match(css, /\.history-series-line \.is-series-focus/);
  assert.match(css, /\.history-legend button\.is-series-muted/);
});

test('scale composite uses the same line-focus language and a flat formula trigger', () => {
  const trigger = css.match(/\.formula-explainer\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(css, /\.scale-composite-series \.is-series-muted\s*\{\s*opacity: 0\.12/);
  assert.match(css, /\.scale-composite-line \.is-series-focus\s*\{\s*stroke-width: 3\.25px/);
  assert.match(css, /\.interaction-scale-composite \.plot-figure svg\s*\{\s*max-width: none/);
  assert.match(trigger, /border\s*:\s*0/);
  assert.doesNotMatch(trigger, /border-radius/);
});

test('visualization appendices stay compact until their audited table is opened', () => {
  assert.match(css, /\.visualization-appendix\s*\{/);
  assert.match(css, /\.visualization-appendix > summary\s*\{/);
  assert.match(css, /\.appendix-table-scroll\s*\{/);
  assert.match(css, /max-height\s*:\s*30rem/);
  assert.match(css, /overflow\s*:\s*auto/);
});

test('page and prose measures use the wide data workspace without losing readable line length', () => {
  const page = css.match(/\.page\s*\{([^}]*)\}/)?.[1] ?? '';
  const subtitle = css.match(/\.subtitle\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(css, /--page-max\s*:\s*92rem/);
  assert.match(css, /--page-gutter\s*:\s*clamp\(/);
  assert.match(css, /--measure-lead\s*:\s*104ch/);
  assert.match(page, /width\s*:\s*min\(100%, var\(--page-max\)\)/);
  assert.match(page, /safe-area-inset-left/);
  assert.match(subtitle, /max-width\s*:\s*min\(100%, var\(--measure-lead\)\)/);
  assert.doesNotMatch(css, /\.subtitle[^}]*62ch/);
});

test('narrow components adapt locally and cannot force page-level overflow', () => {
  const grid = css.match(/(?:^|\n)\.grid-2\s*\{([^}]*)\}/)?.[1] ?? '';
  const segment = css.match(/\.seg\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(css, /@container \(max-width: 38rem\)/);
  assert.match(grid, /minmax\(min\(100%, 22rem\), 1fr\)/);
  assert.match(segment, /max-width\s*:\s*100%/);
  assert.match(segment, /overflow-x\s*:\s*auto/);
  assert.doesNotMatch(css, /body\s*\{[^}]*font-size\s*:\s*14px/);
  assert.match(html, /viewport-fit=cover/);
});

test('plots observe their containers instead of staying capped at desktop widths', () => {
  assert.match(hooks, /new ResizeObserver/);
  assert.match(costSpace, /useElementWidth\(ref\)/);
  assert.match(scaleTrends, /useElementWidth\(ref\)/);
  assert.match(scaleComposite, /const compact = width < 620/);
  assert.match(scaleComposite, /marginRight: compact \? 16 : 120/);
  assert.doesNotMatch(costSpace, /Math\.min\(640/);
  assert.doesNotMatch(scaleTrends, /Math\.min\(680/);
});
