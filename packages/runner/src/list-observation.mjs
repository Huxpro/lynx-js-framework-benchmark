import { LIST_CONFIG } from '../../shared/src/list-workloads.mjs';

const ROW_KEY = /^row-(\d+)$/;

function nodeAttributes(node) {
  const entries = node?.attributes ?? [];
  const result = {};
  for (let index = 0; index + 1 < entries.length; index += 2) {
    result[entries[index]] = entries[index + 1];
  }
  return result;
}

export function nativeListCellKey(node) {
  const attributes = nodeAttributes(node);
  const classes = typeof attributes.class === 'string'
    ? attributes.class.split(/\s+/).filter(Boolean)
    : [];
  if (node?.localName !== 'list-item' || !classes.includes('bench-list-cell')) return null;
  const key = attributes['item-key'];
  if (typeof key !== 'string' || !ROW_KEY.test(key)) {
    throw new Error(`Native visible list cell has invalid item-key ${JSON.stringify(key)}.`);
  }
  return key;
}

export function listKeyIndex(key) {
  const match = ROW_KEY.exec(key);
  return match == null ? null : Number(match[1]);
}

function firstNonEmpty(frames) {
  return frames.find((frame) => frame.keys.length > 0) ?? null;
}

export function analyzeListRecycle(initial, frames, config = LIST_CONFIG) {
  if (initial == null || initial.keys.length === 0) {
    throw new Error('list recycle requires a non-empty initial visible snapshot');
  }
  const initialIndices = initial.keys.map(listKeyIndex);
  if (initialIndices.some((index) => index == null)) {
    throw new Error('list recycle observed a malformed stable item key');
  }
  const initialFirst = Math.min(...initialIndices);
  const expectedAdvance = Math.round(config.recycle.distancePx / config.row.estimatedHeightPx);
  const observed = frames.map((frame) => {
    const indices = frame.keys.map(listKeyIndex).filter((index) => index != null);
    return {
      frame,
      first: indices.length === 0 ? null : Math.min(...indices),
      last: indices.length === 0 ? null : Math.max(...indices),
    };
  });
  const terminal = observed.find(({ first }) =>
    first !== null && first >= initialFirst + expectedAdvance)?.frame;
  if (terminal == null) {
    const furthest = observed.reduce((best, next) =>
      next.first !== null && (best === null || next.first > best.first) ? next : best, null);
    const maximumAdvance = furthest === null ? 0 : furthest.first - initialFirst;
    const visibleRange = furthest === null ? 'empty' : `${furthest.first}-${furthest.last}`;
    throw new Error(
      `list recycle did not advance ${expectedAdvance} visible rows `
        + `(maximum observed advance ${maximumAdvance}; furthest visible range ${visibleRange})`,
    );
  }
  const initialKeys = new Set(initial.keys);
  return {
    operationTimeMs: terminal.atMs,
    recycledCells: terminal.keys.filter((key) => !initialKeys.has(key)).length,
    terminal,
  };
}

export function analyzeListFling(initial, frames, config = LIST_CONFIG) {
  if (initial == null || initial.keys.length === 0) {
    throw new Error('list fling requires a non-empty initial visible snapshot');
  }
  const initialIndices = initial.keys.map(listKeyIndex);
  if (initialIndices.some((index) => index == null)) {
    throw new Error('list fling observed a malformed stable item key');
  }
  const initialFirst = Math.min(...initialIndices);
  const initialKeys = new Set(initial.keys);
  const firstAppearance = new Map();
  let blankFrames = 0;
  for (const frame of frames) {
    if (frame.keys.length === 0) blankFrames++;
    for (const key of frame.keys) {
      if (!initialKeys.has(key) && !firstAppearance.has(key)) {
        firstAppearance.set(key, frame.atMs);
      }
    }
  }
  const materializationTimesMs = [];
  for (const [key, observedAt] of firstAppearance) {
    const index = listKeyIndex(key);
    if (index == null) throw new Error('list fling observed a malformed stable item key');
    const distanceToViewport = Math.max(
      0,
      (index - initialFirst) * config.row.estimatedHeightPx - config.viewport.heightPx,
    );
    const expectedAt = (distanceToViewport / config.fling.velocityPxPerSecond) * 1000;
    materializationTimesMs.push(Math.max(0, observedAt - expectedAt));
  }
  return {
    elapsedMs: frames.at(-1)?.atMs ?? 0,
    materializedCells: firstAppearance.size,
    blankFrames,
    materializationTimesMs,
    firstVisibleFrame: firstNonEmpty(frames),
  };
}
