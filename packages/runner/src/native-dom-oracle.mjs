function validateSearch(found, label) {
  if (typeof found?.searchId !== 'string' && typeof found?.searchId !== 'number') {
    throw new Error(`${label} returned an invalid searchId`);
  }
  if (!Number.isSafeInteger(found.resultCount) || found.resultCount < 0) {
    throw new Error(`${label} returned an invalid resultCount`);
  }
  return found;
}

function validateCount(found, label) {
  if (!Number.isSafeInteger(found?.resultCount) || found.resultCount < 0) {
    throw new Error(`${label} returned an invalid resultCount`);
  }
  return found.resultCount;
}

async function withSearch(cdp, query, action) {
  const found = validateSearch(
    await cdp('DOM.performSearch', { query }),
    `DOM.performSearch(${JSON.stringify(query)})`,
  );
  let primaryError = null;
  try {
    return await action(found);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await cdp('DOM.discardSearchResults', { searchId: found.searchId });
    } catch (cleanupError) {
      if (primaryError) {
        throw new AggregateError(
          [primaryError, cleanupError],
          'DOM search failed and discardSearchResults also failed',
          { cause: primaryError },
        );
      }
      throw cleanupError;
    }
  }
}

export function createNativeDomOracle(cdp) {
  const count = async (query) => validateCount(
    await cdp('DOM.performSearch', { query, countOnly: true }),
    `DOM.performSearch(${JSON.stringify(query)}, countOnly)`,
  );

  const nodeAt = (query, index) => withSearch(cdp, query, async ({ searchId, resultCount }) => {
    if (!Number.isSafeInteger(index) || index < 0 || index >= resultCount) {
      throw new Error(`${query}[${index}] is outside resultCount ${resultCount}`);
    }
    const result = await cdp('DOM.getSearchResults', {
      searchId,
      fromIndex: index,
      toIndex: index + 1,
    });
    if (!Array.isArray(result?.nodeIds) || result.nodeIds.length !== 1) {
      throw new Error(`${query}[${index}] returned malformed nodeIds`);
    }
    return result.nodeIds[0];
  });

  const describe = async (query, index) => {
    const nodeId = await nodeAt(query, index);
    const result = await cdp('DOM.describeNode', { nodeId, depth: 2 });
    if (!result?.node || typeof result.node !== 'object') {
      throw new Error(`${query}[${index}] returned no node`);
    }
    return result.node;
  };

  const text = async (query, index) => {
    const node = await describe(query, index);
    const values = [];
    const visit = (candidate) => {
      if (typeof candidate?.nodeValue === 'string' && candidate.nodeValue.length > 0) {
        values.push(candidate.nodeValue);
      }
      const attributes = candidate?.attributes ?? [];
      if (Array.isArray(attributes)) {
        for (let cursor = 0; cursor + 1 < attributes.length; cursor += 2) {
          if (attributes[cursor] === 'text'
            && typeof attributes[cursor + 1] === 'string'
            && attributes[cursor + 1].length > 0) {
            values.push(attributes[cursor + 1]);
          }
        }
      }
      for (const child of candidate?.children ?? []) visit(child);
    };
    visit(node);
    const unique = [...new Set(values)];
    if (unique.length !== 1) {
      throw new Error(`${query}[${index}] must contain exactly one text value`);
    }
    return unique[0];
  };

  const attribute = async (query, index, name) => {
    const node = await describe(query, index);
    const attributes = node.attributes ?? [];
    if (!Array.isArray(attributes) || attributes.length % 2 !== 0) {
      throw new Error(`${query}[${index}] has malformed attributes`);
    }
    const values = [];
    for (let cursor = 0; cursor < attributes.length; cursor += 2) {
      if (attributes[cursor] === name) values.push(attributes[cursor + 1]);
    }
    if (values.length !== 1) {
      throw new Error(`${query}[${index}] must contain exactly one ${name} attribute`);
    }
    return values[0];
  };

  return {
    count,
    nodeAt,
    text,
    attribute,
    assertRenderedRows: async (expected) => {
      const actual = await count('col-id');
      if (actual !== expected) {
        throw new Error(`Native rendered row count mismatch: expected ${expected}, got ${actual}`);
      }
      return actual;
    },
    assertReady: async () => {
      const matches = await count('Benchmark on Lynx');
      if (matches !== 1) {
        throw new Error(`Native readiness mismatch: expected 1, got ${matches}`);
      }
    },
    assertUniqueDanger: async (expectedIndex) => {
      const selected = await count('danger');
      if (selected !== 1) {
        throw new Error(`Native selected row count mismatch: expected 1, got ${selected}`);
      }
      const selectedRowId = await nodeAt('danger', 0);
      const expectedLabel = await describe('col-label', expectedIndex);
      if (expectedLabel.parentId !== selectedRowId) {
        throw new Error(
          `Native selected row mismatch: expected ${expectedIndex}, `
          + `label parent ${String(expectedLabel.parentId)} != selected row ${String(selectedRowId)}`,
        );
      }
    },
  };
}

export async function captureNativePreState(oracle, kase, scale) {
  if (kase.pre === 'empty') await oracle.assertRenderedRows(0);
  else await oracle.assertRenderedRows(scale);
  if (kase.pre === 'rows+preselect') await oracle.assertUniqueDanger(5);
  const state = {};
  if (kase.name === 'replace') state.lastId = await oracle.text('col-id', scale - 1);
  if (kase.name === 'update10th') state.firstLabel = await oracle.text('col-label', 0);
  if (kase.name === 'swap') state.row998Label = await oracle.text('col-label', 998);
  return state;
}

export async function assertNativePostState(oracle, kase, scale, state) {
  switch (kase.name) {
    case 'create':
      return oracle.assertRenderedRows(scale);
    case 'replace':
      await oracle.assertRenderedRows(1000);
      if (await oracle.text('col-id', 0) !== String(Number(state.lastId) + 1)) {
        throw new Error('Native replace first id mismatch');
      }
      return;
    case 'append1k':
      return oracle.assertRenderedRows(scale + 1000);
    case 'update10th':
      if (await oracle.text('col-label', 0) !== `${state.firstLabel} !!!`) {
        throw new Error('Native update10th first label mismatch');
      }
      return;
    case 'select':
      return oracle.assertUniqueDanger(1);
    case 'swap':
      if (await oracle.text('col-label', 1) !== state.row998Label) {
        throw new Error('Native swap row label mismatch');
      }
      return;
    case 'remove':
      return oracle.assertRenderedRows(scale - 1);
    case 'clear':
      return oracle.assertRenderedRows(0);
    case 'updateStorm':
      if (await oracle.text('col-label', 0) !== 'bench 50') {
        throw new Error('Native updateStorm final label mismatch');
      }
      return;
    case 'selectStorm':
      return oracle.assertUniqueDanger(0);
    default:
      throw new Error(`unsupported Native outcome workload: ${kase.name}`);
  }
}

export async function collectValidatedNativeStartup({
  acquireTiming,
  oracle,
  rows,
  requireReady = rows === 0,
}) {
  const timing = await acquireTiming();
  await oracle.assertRenderedRows(rows);
  if (requireReady) await oracle.assertReady();
  return timing;
}
