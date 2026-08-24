import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const i18nSource = fs.readFileSync(new URL('./i18n.tsx', import.meta.url), 'utf8');
const mainSource = fs.readFileSync(new URL('./main.tsx', import.meta.url), 'utf8');
const timelineSource = fs.readFileSync(new URL('./components/TimelineSlider.tsx', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('./theme.css', import.meta.url), 'utf8');

test('the app has one locale provider and a compact bilingual toolbar control', () => {
  assert.match(mainSource, /<I18nProvider>/);
  assert.match(timelineSource, /className="locale-toggle"/);
  assert.match(timelineSource, />EN<\/span>/);
  assert.match(timelineSource, />中<\/span>/);
  assert.match(timelineSource, /onClick=\{toggleLocale\}/);
  assert.match(css, /\.locale-toggle\s*\{/);
});

test('locale follows URL, persists across reloads, and updates document metadata', () => {
  assert.match(i18nSource, /new URLSearchParams\(location\.search\)\.get\('lang'\)/);
  assert.match(i18nSource, /lynx-benchmark-locale/);
  assert.match(i18nSource, /document\.documentElement\.lang = locale/);
  assert.match(i18nSource, /document\.title = locale === 'zh-CN'/);
  assert.match(i18nSource, /params\.set\('lang', locale === 'zh-CN' \? 'zh' : 'en'\)/);
  assert.match(i18nSource, /location\.hash/);
});

test('every retained dataset checkpoint has Chinese editorial copy', () => {
  for (const checkpoint of [
    '2026-08-08-peer-reference',
    '2026-08-10-slow-octane',
    '2026-08-11-octane-step-change',
    '2026-08-15-octane-converges',
    '2026-08-22-new-lynx',
    'current-main',
  ]) {
    assert.match(i18nSource, new RegExp(`'${checkpoint}'`));
  }
  assert.match(i18nSource, /localizedCheckpoint/);
  assert.match(i18nSource, /localizedWorkload/);
});
