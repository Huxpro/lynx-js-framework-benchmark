import { classifyPapiMethod, PAPI_SEGMENTS } from './pipeline.mjs';

// Framework-neutral instrumentation installed in the harness page BEFORE
// @lynx-js/web-core boots. Three independent instruments:
//
// 1. Wire meter — every BTS↔MTS message on Lynx for Web crosses one
//    MessageChannel driven by @lynx-js/web-worker-rpc; each rpc envelope is
//    `{ name, data, … }`. Patching `MessagePort.prototype.postMessage` (page →
//    worker, i.e. MTS→BTS direction) and the `onmessage` setter (worker →
//    page, BTS→MTS) counts BOTH directions for EVERY framework, tagged by
//    endpoint name. Bytes are the UTF-8 length of a JSON serialization — a
//    structured-clone-cost proxy, applied identically to all entries.
//    Caveat: app-created MessageChannels inside the page realm (none of the
//    current entries create one there; storm channels live in the worker) are
//    excluded by tagging: only ports observed carrying rpc-shaped traffic
//    (`{name, data}` envelopes) are counted.
//
// 2. Seeded PRNG — `Math.random` replaced with mulberry32(42) in the page
//    realm and (via the worker bootstrap) in the background realm, so row
//    labels and therefore wire payload bytes are deterministic across runs and
//    frameworks.
//
// 3. Worker bootstrap patch — `Worker` is subclassed so module workers boot
//    from a Blob that first imports the harness's worker-side instrument
//    (`/instrument-worker.js`: seeded PRNG + lynx.profile neutralization +
//    handler-time meter) and then the real worker module. Import order is
//    guaranteed by ESM semantics; the init message cannot be delivered before
//    module evaluation completes.
//
// The lynx.profile neutralization (see NEUTRALIZE_LYNX_PROFILE below) is a
// fairness patch inherited from the unified benchmark: web-core's always-on
// profiling shim maps framework profiling calls onto performance.mark/measure
// and never clears them, so per-snapshot profilers (ReactLynx) degrade
// superlinearly in a way that does not exist on native. Applied to every
// entry identically.

export const SEEDED_RANDOM_JS = `(() => {
  let seed = 42 >>> 0;
  Math.random = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
})()`;

export const NEUTRALIZE_LYNX_PROFILE = `(() => {
  const P = globalThis.Performance && globalThis.Performance.prototype;
  if (!P || P.__lynxProfileNeutralized) return;
  P.__lynxProfileNeutralized = true;
  const isProf = (n) => typeof n === 'string' && n.startsWith('lynx.profile:');
  for (const k of ['mark', 'clearMarks']) {
    const orig = P[k];
    P[k] = function (name, ...rest) {
      if (isProf(name)) return undefined;
      return orig.call(this, name, ...rest);
    };
  }
  const origMeasure = P.measure;
  P.measure = function (name, ...rest) {
    if (isProf(name) || (typeof rest[0] === 'string' && isProf(rest[0]))
      || (rest[0] && typeof rest[0] === 'object' && isProf(rest[0].start))) {
      return undefined;
    }
    return origMeasure.call(this, name, ...rest);
  };
})()`;

// Worker-side instrument, served as /instrument-worker.js by the harness
// server and imported ahead of the real worker module.
export const WORKER_INSTRUMENT_JS = `${SEEDED_RANDOM_JS};
${NEUTRALIZE_LYNX_PROFILE};
(() => {
  // Handler-time meter (diagnostic): sync time spent in MessagePort message
  // handlers in the background realm. The headline btsCpu metric comes from
  // the CDP sampling profiler; this cheap counter is kept as a cross-check.
  const busy = (globalThis.__LYNX_BENCH_BUSY__ = { handlerMs: 0, tasks: 0 });
  const desc = Object.getOwnPropertyDescriptor(MessagePort.prototype, 'onmessage');
  if (desc && desc.set) {
    Object.defineProperty(MessagePort.prototype, 'onmessage', {
      get() { return desc.get.call(this); },
      set(fn) {
        if (typeof fn !== 'function') return desc.set.call(this, fn);
        desc.set.call(this, function (ev) {
          const t0 = performance.now();
          try { return fn.call(this, ev); }
          finally { busy.handlerMs += performance.now() - t0; busy.tasks += 1; }
        });
      },
      configurable: true,
    });
  }
})();`;

// Page-side instrument. Must be inlined in a <script> that runs before the
// web-core module script.
export const PAGE_INSTRUMENT_JS = `${SEEDED_RANDOM_JS};
${NEUTRALIZE_LYNX_PROFILE};
(() => {
  const stats = {
    // toBts: page realm -> worker (MTS -> BTS). toMts: worker -> page (BTS -> MTS).
    toBts: { messages: 0, bytes: 0, byName: {} },
    toMts: { messages: 0, bytes: 0, byName: {} },
    workers: [],
  };
  globalThis.__LYNX_WIRE__ = stats;
  globalThis.__LYNX_BENCH_BUSY__ = { handlerMs: 0, tasks: 0 };

  const enc = new TextEncoder();
  const sizeOf = (data) => {
    try {
      const s = JSON.stringify(data, (_k, v) => {
        if (v instanceof ArrayBuffer) return { $ab: v.byteLength };
        if (ArrayBuffer.isView(v)) return { $abv: v.byteLength };
        if (typeof v === 'function') return '$fn';
        return v;
      });
      return s ? enc.encode(s).length : 0;
    } catch {
      return -1;
    }
  };
  const looksRpc = (data) => data && typeof data === 'object' && 'name' in data && 'data' in data;
  const record = (side, data) => {
    const size = sizeOf(data);
    const name = looksRpc(data) ? String(data.name) : '$raw';
    side.messages += 1;
    if (size > 0) side.bytes += size;
    const slot = side.byName[name] ?? (side.byName[name] = { messages: 0, bytes: 0 });
    slot.messages += 1;
    if (size > 0) slot.bytes += size;
  };

  // Snapshot API for the harness.
  globalThis.__LYNX_WIRE_SNAPSHOT__ = () => JSON.parse(JSON.stringify(stats));

  const origPost = MessagePort.prototype.postMessage;
  MessagePort.prototype.postMessage = function (data, ...rest) {
    record(stats.toBts, data);
    return origPost.call(this, data, ...rest);
  };
  const desc = Object.getOwnPropertyDescriptor(MessagePort.prototype, 'onmessage');
  Object.defineProperty(MessagePort.prototype, 'onmessage', {
    get() { return desc.get.call(this); },
    set(fn) {
      if (typeof fn !== 'function') return desc.set.call(this, fn);
      desc.set.call(this, function (ev) {
        record(stats.toMts, ev.data);
        const busy = globalThis.__LYNX_BENCH_BUSY__;
        const t0 = performance.now();
        try { return fn.call(this, ev); }
        finally { busy.handlerMs += performance.now() - t0; busy.tasks += 1; }
      });
    },
    configurable: true,
  });

  // Boot module workers through a blob that installs the worker-side
  // instrument first. Absolute URLs keep import resolution intact.
  const OrigWorker = globalThis.Worker;
  globalThis.Worker = class extends OrigWorker {
    constructor(url, opts) {
      const abs = new URL(url, location.href).href;
      let blobUrl = null;
      if (opts && opts.type === 'module') {
        const boot = 'import ' + JSON.stringify(new URL('/instrument-worker.js', location.href).href)
          + ';\\nimport ' + JSON.stringify(abs) + ';';
        blobUrl = URL.createObjectURL(new Blob([boot], { type: 'text/javascript' }));
        super(blobUrl, opts);
      } else {
        super(url, opts);
      }
      // blobUrl lets the harness map CDP worker targets (which see the blob
      // bootstrap URL) back to the worker's real identity (e.g. "lynx-bg").
      stats.workers.push({ url: abs, name: opts && opts.name, blobUrl });
    }
  };
})();`;

// ElementPAPI attribution is deliberately separate from PAGE_INSTRUMENT_JS.
// The ordinary table/startup page must not pay wrapper overhead, because a new
// capture dimension is never allowed to mutate an already-published timing.
// server.mjs installs this script only on the dedicated /pipeline page.
//
// web-core creates ElementPAPIs in the outer page realm, then Object.assigns
// them onto a same-origin sandboxed MTS iframe window. Intercept that one
// recognizable assignment (the source owns __FlushElementTree), wrap every
// function on the surface, and leave all unrelated Object.assign calls intact.
const CLASSIFY_PAPI_SOURCE = classifyPapiMethod.toString();
const PAPI_SEGMENTS_JSON = JSON.stringify(PAPI_SEGMENTS);

export const PAPI_PAGE_INSTRUMENT_JS = `(() => {
  const segmentNames = ${PAPI_SEGMENTS_JSON};
  const classify = ${CLASSIFY_PAPI_SOURCE};
  const originalAssign = Object.assign;
  const wrapperCache = new WeakMap();
  let active = null;
  let surfaceNames = [];

  const emptySegment = () => ({ calls: 0, selfMs: 0, byName: {} });
  const emptyCapture = () => ({
    version: 1,
    surfaceNames: [...surfaceNames],
    segments: Object.fromEntries(segmentNames.map((name) => [name, emptySegment()])),
  });
  const clone = (value) => JSON.parse(JSON.stringify(value));

  globalThis.__LYNX_PAPI_BEGIN__ = () => {
    if (active != null) throw new Error('ElementPAPI capture is already active');
    active = emptyCapture();
  };
  globalThis.__LYNX_PAPI_END__ = () => {
    if (active == null) throw new Error('ElementPAPI capture is not active');
    const result = active;
    active = null;
    delete result.stack;
    result.surfaceNames = [...surfaceNames];
    return clone(result);
  };
  globalThis.__LYNX_PAPI_ABORT__ = () => { active = null; };
  globalThis.__LYNX_PAPI_SURFACE__ = () => [...surfaceNames];

  const wrap = (name, original) => {
    let byName = wrapperCache.get(original);
    if (!byName) {
      byName = new Map();
      wrapperCache.set(original, byName);
    }
    if (byName.has(name)) return byName.get(name);
    const wrapped = function (...args) {
      const capture = active;
      if (capture == null) return Reflect.apply(original, this, args);
      const parentFrame = capture.stack?.[capture.stack.length - 1] ?? null;
      if (!capture.stack) capture.stack = [];
      const frame = { childMs: 0 };
      capture.stack.push(frame);
      const start = performance.now();
      try {
        return Reflect.apply(original, this, args);
      } finally {
        const elapsed = performance.now() - start;
        capture.stack.pop();
        if (parentFrame) parentFrame.childMs += elapsed;
        const selfMs = Math.max(0, elapsed - frame.childMs);
        const segment = capture.segments[classify(name)];
        segment.calls += 1;
        segment.selfMs += selfMs;
        const method = segment.byName[name] ?? (segment.byName[name] = { calls: 0, selfMs: 0 });
        method.calls += 1;
        method.selfMs += selfMs;
      }
    };
    byName.set(name, wrapped);
    return wrapped;
  };

  const instrumentSurface = (source) => {
    if (!source || typeof source.__FlushElementTree !== 'function') return source;
    const copy = originalAssign({}, source);
    surfaceNames = Object.keys(source)
      .filter((name) => name.startsWith('__') && typeof source[name] === 'function')
      .sort();
    for (const name of surfaceNames) copy[name] = wrap(name, source[name]);
    return copy;
  };

  Object.assign = function (target, ...sources) {
    let intercepted = false;
    const mapped = sources.map((source) => {
      const instrumented = instrumentSurface(source);
      if (instrumented !== source) intercepted = true;
      return instrumented;
    });
    const result = originalAssign(target, ...mapped);
    // web-core installs the complete surface once for this LynxView. Restore
    // the intrinsic immediately so unrelated framework Object.assign calls
    // during the measured operation pay no interception overhead.
    if (intercepted) Object.assign = originalAssign;
    return result;
  };
})();`;
