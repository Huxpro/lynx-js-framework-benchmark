import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertNativePostState,
  captureNativePreState,
  collectValidatedNativeStartup,
  createNativeDomOracle,
} from './native-dom-oracle.mjs';

function cdpFixture({
  counts = {},
  texts = {},
  textAttributes = {},
  attributes = {},
  nodeIds = {},
  parentIds = {},
  discardError = null,
} = {}) {
  const calls = [];
  let searchIndex = 0;
  const searches = new Map();
  const nodes = new Map();
  const cdp = async (method, params) => {
    calls.push([method, params]);
    if (method === 'DOM.performSearch') {
      const searchId = `search-${searchIndex++}`;
      searches.set(searchId, params.query);
      return { searchId, resultCount: counts[params.query] ?? 0 };
    }
    if (method === 'DOM.getSearchResults') {
      const key = `${searches.get(params.searchId)}:${params.fromIndex}`;
      const nodeId = nodeIds[key] ?? nodes.size + 1;
      nodes.set(nodeId, {
        query: searches.get(params.searchId),
        index: params.fromIndex,
      });
      return { nodeIds: [nodeId] };
    }
    if (method === 'DOM.describeNode') {
      const { query, index } = nodes.get(params.nodeId);
      return {
        node: {
          attributes: Object.entries({
            ...attributes[`${query}:${index}`],
            ...(Object.hasOwn(textAttributes, `${query}:${index}`)
              ? { text: textAttributes[`${query}:${index}`] }
              : {}),
          }).flat(),
          children: [{
            nodeValue: texts[`${query}:${index}`] ?? '',
          }],
          parentId: parentIds[`${query}:${index}`],
        },
      };
    }
    if (method === 'DOM.discardSearchResults') {
      if (discardError) throw discardError;
      return {};
    }
    throw new Error(`unexpected CDP method ${method}`);
  };
  return { cdp, calls };
}

test('row count is count-only even at 30k and needs no search lifecycle', async () => {
  const { cdp, calls } = cdpFixture({ counts: { 'col-id': 30000 } });
  const oracle = createNativeDomOracle(cdp);
  assert.equal(await oracle.assertRenderedRows(30000), 30000);
  assert.equal(calls.some(([method]) => method === 'DOM.getSearchResults'), false);
  assert.deepEqual(calls, [
    ['DOM.performSearch', { query: 'col-id', countOnly: true }],
  ]);
});

test('indexed reads request exactly [index,index+1) and strict text', async () => {
  const { cdp, calls } = cdpFixture({
    counts: { 'col-label': 1000 },
    texts: { 'col-label:998': 'expected' },
  });
  const oracle = createNativeDomOracle(cdp);
  assert.equal(await oracle.text('col-label', 998), 'expected');
  const get = calls.find(([method]) => method === 'DOM.getSearchResults');
  assert.deepEqual(get[1], {
    searchId: 'search-0',
    fromIndex: 998,
    toIndex: 999,
  });
});

test('indexed reads accept Lynx text attributes without child node values', async () => {
  const { cdp } = cdpFixture({
    counts: { 'col-id': 1000 },
    textAttributes: { 'col-id:999': '1000' },
  });
  const oracle = createNativeDomOracle(cdp);
  assert.equal(await oracle.text('col-id', 999), '1000');
});

test('indexed reads reject conflicting text representations', async () => {
  const { cdp } = cdpFixture({
    counts: { 'col-id': 1 },
    texts: { 'col-id:0': 'child' },
    textAttributes: { 'col-id:0': 'attribute' },
  });
  const oracle = createNativeDomOracle(cdp);
  await assert.rejects(
    () => oracle.text('col-id', 0),
    /must contain exactly one text value/,
  );
});

test('discard failure is a correctness failure and preserves a primary error', async () => {
  const cleanup = new Error('discard failed');
  const { cdp } = cdpFixture({
    counts: { 'col-label': 0 },
    discardError: cleanup,
  });
  const oracle = createNativeDomOracle(cdp);
  await assert.rejects(
    () => oracle.text('col-label', 0),
    (error) => {
      assert.equal(error instanceof AggregateError, true);
      assert.match(error.errors[0].message, /outside resultCount/);
      assert.equal(error.errors[1], cleanup);
      return true;
    },
  );
});

test('pre/post workload predicates validate rendered state one-shot', async () => {
  const { cdp } = cdpFixture({
    counts: {
      'col-id': 1000,
      'col-label': 1000,
      danger: 1,
    },
    texts: {
      'col-id:999': '1000',
      'col-id:0': '1001',
      'col-label:0': 'row !!!',
      'col-label:998': 'swap-me',
      'col-label:1': 'swap-me',
    },
    attributes: {
      'danger:0': {},
    },
    nodeIds: {
      'danger:0': 101,
    },
    parentIds: {
      'col-label:1': 101,
    },
  });
  const oracle = createNativeDomOracle(cdp);
  const replace = await captureNativePreState(
    oracle,
    { name: 'replace', pre: 'rows' },
    1000,
  );
  await assertNativePostState(
    oracle,
    { name: 'replace' },
    1000,
    replace,
  );
  await assertNativePostState(oracle, { name: 'select' }, 1000, {});
  const swap = await captureNativePreState(
    oracle,
    { name: 'swap', pre: 'rows' },
    1000,
  );
  await assertNativePostState(oracle, { name: 'swap' }, 1000, swap);
});

test('startup timing is frozen before any rendered-state observation', async () => {
  const order = [];
  const timing = { fcpMs: 10 };
  const result = await collectValidatedNativeStartup({
    acquireTiming: async () => {
      order.push('timing');
      return timing;
    },
    oracle: {
      async assertRenderedRows(rows) {
        order.push(`rows:${rows}`);
      },
      async assertReady() {
        order.push('ready');
      },
    },
    rows: 0,
  });
  assert.equal(result, timing);
  assert.deepEqual(order, ['timing', 'rows:0', 'ready']);
});
