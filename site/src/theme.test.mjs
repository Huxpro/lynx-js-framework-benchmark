import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const css = fs.readFileSync(new URL('./theme.css', import.meta.url), 'utf8');

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

test('ranking series fade as a group while the hovered line is emphasized', () => {
  assert.match(css, /\.history-series \.is-series-muted\s*\{\s*opacity: 0\.12/);
  assert.match(css, /\.history-series-line \.is-series-focus/);
  assert.match(css, /\.history-legend button\.is-series-muted/);
});

test('visualization appendices stay compact until their audited table is opened', () => {
  assert.match(css, /\.visualization-appendix\s*\{/);
  assert.match(css, /\.visualization-appendix > summary\s*\{/);
  assert.match(css, /\.appendix-table-scroll\s*\{/);
  assert.match(css, /max-height\s*:\s*30rem/);
  assert.match(css, /overflow\s*:\s*auto/);
});
