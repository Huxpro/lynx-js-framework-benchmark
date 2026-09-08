import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { featuredEntriesForHarness } from './entry-cohorts.mjs';
import { discoverEntries, selectEntriesForHarness } from './entries.mjs';

test('explicit entry discovery preserves AB/BA order and rejects ambiguous selections', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'entry-order-'));
  try {
    for (const id of ['candidate', 'comparator']) {
      const dir = path.join(root, 'entries', id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'entry.json'), JSON.stringify({ id }));
    }
    assert.deepEqual(
      discoverEntries({ root, only: ['comparator', 'candidate'] }).map(({ id }) => id),
      ['comparator', 'candidate'],
    );
    assert.throws(
      () => discoverEntries({ root, only: ['candidate', 'candidate'] }),
      /selection contains duplicates/,
    );
    assert.throws(
      () => discoverEntries({ root, only: ['missing'] }),
      /unknown entry selection: missing/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('harness selection skips implicit unsupported entries and explains explicit requests', () => {
  const entries = [
    { id: 'both', harnesses: ['web', 'native'] },
    {
      id: 'native-only',
      harnesses: ['native'],
      unsupportedHarnessReasons: { web: 'typed PAPI unavailable' },
    },
  ];

  assert.deepEqual(
    selectEntriesForHarness(entries, 'web').map(({ id }) => id),
    ['both'],
  );
  assert.throws(
    () => selectEntriesForHarness(entries, 'web', { explicit: true }),
    /native-only does not support the web harness: typed PAPI unavailable/,
  );
  assert.deepEqual(
    selectEntriesForHarness(entries, 'native', { explicit: true }).map(({ id }) => id),
    ['both', 'native-only'],
  );
});

test('explicit per-harness tiers replace only that harness current cohort', () => {
  const entries = [
    { id: 'm0-candidate', tier: 'featured', harnesses: ['web', 'native'] },
    { id: 'm0-comparator', tier: 'featured', harnesses: ['web', 'native'] },
    {
      id: 'm3-candidate',
      tier: 'archive',
      tiers: { native: 'featured' },
      harnesses: ['web', 'native'],
    },
    {
      id: 'm3-comparator',
      tier: 'archive',
      tiers: { native: 'featured' },
      harnesses: ['native'],
    },
    {
      id: 'm3-diagnostic',
      tier: 'archive',
      tiers: { native: 'lab' },
      harnesses: ['native'],
    },
  ];

  assert.deepEqual(
    featuredEntriesForHarness(entries, 'web').map(({ id }) => id),
    ['m0-candidate', 'm0-comparator'],
  );
  assert.deepEqual(
    featuredEntriesForHarness(entries, 'native').map(({ id }) => id),
    ['m3-candidate', 'm3-comparator'],
  );
});
