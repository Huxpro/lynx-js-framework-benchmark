import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('./components/TimelineSlider.tsx', import.meta.url), 'utf8');
const rankingSource = fs.readFileSync(new URL('./components/HistoryRanking.tsx', import.meta.url), 'utf8');
const entry = (id) => JSON.parse(fs.readFileSync(
  new URL(`../../entries/${id}/entry.json`, import.meta.url),
  'utf8',
));

test('dataset checkpoints are named independently of any one framework commit', () => {
  assert.match(source, /checkpoint\.label/);
  assert.match(source, /checkpoint\.identityPointers\.map/);
  assert.doesNotMatch(source, /octaneCommit/);
  assert.doesNotMatch(source, />Octane \{/);
  assert.match(rankingSource, /rankHistoryCell\(cohort\.entryIds/);
  assert.doesNotMatch(rankingSource, /FEATURED_IDS/);
});

test('every source pointer is clickable and IFR pointers expose exact plugin options', () => {
  assert.match(source, /href=\{pointer\.href\}/);
  assert.match(source, /title=\{pointer\.configuration\.summary\}/);
  assert.match(source, /href=\{pointer\.configuration\.href\}/);

  assert.equal(entry('vue-vdom').label, 'Vue');
  assert.equal(entry('vue-vdom-ifr-et').label, 'Vue +IFR');
  assert.equal(entry('vue-vapor').label, 'Vue Vapor');
  assert.equal(entry('vue-vapor-ifr').label, 'Vue Vapor +IFR');
  assert.match(entry('vue-vdom-ifr-et').configuration.summary, /enableElementTemplates: true/);
  assert.match(entry('vue-vapor-ifr').configuration.summary, /enableElementTemplates: false/);
});

test('sticky workspace owns view and environment navigation', () => {
  assert.match(source, /className="workspace-toolbar"/);
  assert.match(source, /\(\['overview', 'scale'\] as const\)/);
  assert.match(source, /<span>Lynx for<\/span>/);
  assert.match(source, /candidate === 'web' \? 'Web' : 'Native'/);
  assert.doesNotMatch(source, /Native engine/);
});

test('source identities expose keyboard and touch-compatible method details', () => {
  assert.match(source, /className="identity-detail"/);
  assert.match(source, /role="tooltip"/);
  assert.match(source, /aria-describedby=\{detailId\}/);
});
