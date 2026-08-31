import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const app = fs.readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('./theme.css', import.meta.url), 'utf8');
const hooks = fs.readFileSync(new URL('./hooks.tsx', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const timeline = fs.readFileSync(new URL('./components/TimelineSlider.tsx', import.meta.url), 'utf8');

test('color-blind heatmap preference boots before paint and persists independently from theme', () => {
  assert.match(html, /localStorage\.getItem\('heat-palette'\)/);
  assert.match(html, /dataset\.heatPalette = heatPalette/);
  assert.match(hooks, /export function useHeatPalette/);
  assert.match(hooks, /localStorage\.setItem\('heat-palette', next\)/);
  assert.match(hooks, /delete document\.documentElement\.dataset\.heatPalette/);
  assert.match(app, /const \[heatPalette, toggleHeatPalette\] = useHeatPalette\(\)/);
});

test('toolbar exposes a compact non-color-only palette toggle', () => {
  assert.match(timeline, /className="palette-toggle"/);
  assert.match(timeline, /aria-pressed=\{heatPalette === 'colorblind'\}/);
  assert.match(timeline, /color-blind-safe blue–orange heatmap/);
  assert.match(timeline, /色盲友好的蓝—橙热图/);
  assert.match(timeline, /className="palette-pair"/);
  assert.match(css, /\.palette-toggle\[aria-pressed='true'\]::after/);
});

test('theme toggle uses a consistent vector icon instead of font glyphs', () => {
  assert.match(timeline, /className="theme-icon"/);
  assert.match(timeline, /Use light theme/);
  assert.match(timeline, /Use dark theme/);
  assert.doesNotMatch(timeline, /☀|☾/);
  assert.match(css, /\.theme-icon\s*\{[\s\S]*?stroke:\s*currentColor/);
});

test('GitHub-style blue-orange heat tokens are calibrated separately for light and dark', () => {
  assert.match(css, /--primer-data-blue-light: 0, 110, 219/);
  assert.match(css, /--primer-data-orange-light: 235, 103, 15/);
  assert.match(css, /--primer-data-blue-dark: 88, 166, 255/);
  assert.match(css, /--primer-data-orange-dark: 240, 136, 62/);
  assert.match(css, /:root\[data-heat-palette='colorblind'\]/);
  assert.match(css, /data-heat-palette='colorblind'.*not\(\[data-theme='light'\]\)/);
  assert.match(css, /data-theme='dark'\]\[data-heat-palette='colorblind'\]/);
  assert.match(css, /td\.fastest[^}]*var\(--heat-fast-outline\)/);
});
