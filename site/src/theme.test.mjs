import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const css = fs.readFileSync(new URL('./theme.css', import.meta.url), 'utf8');

test('expanded exact-data tables scroll inside their card on narrow viewports', () => {
  const rule = css.match(/details\.data-table\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(rule, /max-width\s*:\s*100%/);
  assert.match(rule, /overflow-x\s*:\s*auto/);
});
