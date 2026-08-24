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

test('visualization appendices stay compact until their audited table is opened', () => {
  assert.match(css, /\.visualization-appendix\s*\{/);
  assert.match(css, /\.visualization-appendix > summary\s*\{/);
  assert.match(css, /\.appendix-table-scroll\s*\{/);
  assert.match(css, /max-height\s*:\s*30rem/);
  assert.match(css, /overflow\s*:\s*auto/);
});
