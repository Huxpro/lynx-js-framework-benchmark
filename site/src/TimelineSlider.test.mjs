import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('./components/TimelineSlider.tsx', import.meta.url), 'utf8');
const legendSource = fs.readFileSync(new URL('./components/Legend.tsx', import.meta.url), 'utf8');
const receiptSource = fs.readFileSync(new URL('./components/Method.tsx', import.meta.url), 'utf8');
const rankingSource = fs.readFileSync(new URL('./components/HistoryRanking.tsx', import.meta.url), 'utf8');
const entry = (id) => JSON.parse(fs.readFileSync(
  new URL(`../../entries/${id}/entry.json`, import.meta.url),
  'utf8',
));

test('dataset checkpoints are named independently of any one framework commit', () => {
  assert.match(source, /checkpoint\.label/);
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
  assert.match(rankingSource, />Rank by dataset</);
  assert.doesNotMatch(rankingSource, /type: 'utc'/);
  assert.doesNotMatch(rankingSource, /x: 'time'/);
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
  assert.match(source, /className="workspace-toolbar"/);
  assert.match(source, /\(\['overview', 'scale'\] as const\)/);
  assert.match(source, /<span>Lynx for<\/span>/);
  assert.match(source, /candidate === 'web' \? 'Web' : 'Native'/);
  assert.doesNotMatch(source, /Native engine/);
});

test('sticky workspace gives its second row entirely to the dataset slider', () => {
  assert.match(source, /className="timeline-control"/);
  assert.doesNotMatch(source, /timeline-copy/);
  assert.doesNotMatch(source, /timeline-identities/);
  assert.doesNotMatch(source, /timeline-meta/);
  assert.match(receiptSource, /checkpoint\?\.label/);
  assert.match(receiptSource, /checkpoint\?\.description/);
  assert.match(receiptSource, />What changed</);
  assert.match(receiptSource, /dateTime=\{snapshot\.generatedAt\}/);
  assert.match(legendSource, /className="entry-method"/);
});
