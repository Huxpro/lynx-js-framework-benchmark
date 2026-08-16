# Methodology

The measurement rules. Where a rule descends from a prior system (the vue-lynx unified
benchmark, octane's benchmarks, or octane's lynx-table PR) it is noted; where those systems
had a documented weakness, the fix is noted.

## Timing

- **Web interactive latency** = in-page capture-phase `pointerdown` (excludes CDP input latency)
  → the first `requestAnimationFrame` at which a composed-DOM predicate holds
  (shadow-piercing walk; ≤1 frame quantization). Ops are driven by real Chromium input
  (`page.mouse.click`) on geometry the in-page driver reports — never synthetic framework
  events.
- **Native interactive latency** = the entry's Native input handler → its second
  `lynx.requestAnimationFrame`. The entry emits a `__NATIVE_BENCH_RESULT__` payload through the
  Runtime console, so both endpoints and the duration use the device clock; host ADB/CDP latency
  is outside the sample. The Sandbox adapter subscribes before dispatching Native touch input.
  ReactLynx and Vue-Lynx are triggered by real touches. Upstream Octane currently cannot receive
  its registered string-event token in the Native background realm, so DevTool invokes the same
  background handler through a benchmark-only data driver; the invocation itself remains outside
  the timer, which begins inside that handler.
- **Web startup** = `lynx-view` attach → first frame with ≥5 table-content elements (`fcp`), and
  → content-count quiesce for 400ms (`settled`). Startup scale uses bundle variants whose
  first screen pre-renders N rows (build-time `__BENCH_AUTOROWS__`, seeded data), so
  IFR-capable configs exercise their real first-frame path.
- **Startup loading model: local/cached, never online.** The FCP window *does* contain the
  bundle fetch (and the background worker chunk fetch), but both come from a loopback
  `node:http` server: measured 1.6–3ms regardless of bundle size (93kB and 368kB alike —
  loopback cost is syscalls, not bandwidth), i.e. 0.1–4% of any measured FCP and constant
  across entries. This approximates the dominant real deployment — native Lynx loading a
  local/preloaded bundle via IO — and matches the field convention: krausest and octane both
  serve fixtures from localhost with no network emulation for their core numbers (octane's
  only "online" numbers live in a separate Lighthouse suite with `throttlingMethod:
  'simulate'`, never mixed in). We standardize on this local/cached model. An online
  cold-start scenario is *capturable* in this harness (CDP
  `Network.emulateNetworkConditions`, or cache-warm A/B) — if ever added it becomes a new
  comparability dimension, never a change to these numbers. What the loopback model cannot
  capture is native's binary-template decode vs web's JSON decode — that difference belongs
  to `harness: "native"`, which the schema already isolates.
- **Native startup** = Lynx pipeline `openTime` → `totalFcp.duration` from
  `Performance.getAllPerformanceEntries`, after enabling the Explorer
  `enable_perf_metrics` switch. `pipelineEnd - openTime` is retained as settled when available.
  Octane's custom renderer publishes no pipeline entries in this Explorer build, so its explicit
  fallback is host `openPage` request → first/second post-commit Native frame. The request time is
  converted to the device epoch using seven ADB clock samples (lowest RTT wins); offset and RTT
  are retained in the machine metadata. This fallback can include a small DevTool scheduling
  overestimate and is identified in the stored pipeline detail.
- Storm predicates await the final tick's state (`bench 50` label / final selection), so a
  storm number is end-to-end throughput of N sequential render cycles.

## Dual-thread metrics

- **Wire**: on Lynx for Web, every BTS↔MTS message crosses one `MessageChannel` driven by
  `@lynx-js/web-worker-rpc`; envelopes carry their endpoint name. The harness patches
  `MessagePort.prototype.postMessage` (MTS→BTS) and the `onmessage` setter (BTS→MTS) in the
  page realm before web-core boots: **both directions, all message types, every framework,
  one instrument** — fixing the lynx-table PR profiler's limitations (octane-internal,
  commit-only, one-directional). Bytes are the UTF-8 length of a stable JSON serialization —
  a structured-clone-cost proxy applied identically to every entry (documented limitation:
  transferables are size-tagged, not serialized).
- **CPU**: the CDP sampling profiler (200µs) attached separately to the page (MTS + harness
  overhead; the UI thread) and the `lynx-bg` worker (BTS), summing non-idle sample time.
  Includes GC and microtasks. The two threads run concurrently — per-realm CPU values are
  not additive into wall latency, and the site never stacks them into one bar.
- **Heap**: one fresh page holds a 10k-row table. After the table settles, the harness sends
  `HeapProfiler.collectGarbage` to the MTS and BTS CDP sessions independently, then records
  each realm's `Runtime.getHeapUsage().usedSize`. These are absolute live-heap snapshots,
  not retained-heap deltas or native-process memory.
- Boundaries are recorded on every record (`boundary` field); records with different
  boundaries are never comparable.

## Fairness

- **Seeded PRNG** (mulberry32) replaces `Math.random` in both realms before app boot — row
  labels, and therefore wire bytes, are deterministic across runs and entries (octane's
  determinism discipline; fixes the unified benchmark's random-label byte noise).
- **`window.gc()`** before every timed sample (`--js-flags=--expose-gc`).
- **`lynx.profile` neutralization**: web-core's always-on profiling shim maps framework
  profiling onto `performance.mark/measure` and never clears them — an unbounded-timeline
  artifact absent on native that penalizes per-snapshot profilers (ReactLynx)
  superlinearly. The patch no-ops `lynx.profile:`-prefixed entries only, in both realms,
  for every entry identically (inherited from the unified benchmark, documented here).
- **Same runtime within each harness**: Web uses one pinned `@lynx-js/web-core`; Native uses the
  same LynxExplorer/Sandbox lease for every featured entry. Bundles are served locally through
  ADB reverse with cache-busting URLs;
  bundles are vendored with commit + build command + sha256 (fixing the lynx-table PR's
  unverifiable references).
- The driver contract (buttons, classes, predicates) is shared, versioned in this repo, and
  never forked per framework. A predicate that cannot see a framework's DOM shape is an
  instrument bug, not a DNF.

## Statistics

- Warmup: two untimed create/clear cycles per page; storms and startup use fresh pages per
  sample (page-load variance is inside the sample, stated on the site).
- Reported per sample set: median (headline), mean, sample std, min, p95, and a
  t-distribution 95% CI (octane's `stats` discipline); raw samples retained in run files.
- Raw `samples`/one-shot `value` are authoritative. Collection recalculates every statistic and
  ignores stored aggregate snapshots in run files; see [DATA_MODEL.md](./DATA_MODEL.md).
- **DNF is data**: timeouts are counted (`dnfCount`) and shown; a slow framework looks slow,
  never absent. Non-timeout errors abort the run — they are harness bugs.
- No single aggregate score across suites; per-suite geomeans only (the unified benchmark's
  audit rejected a global score; we follow).

## Machines and calibration

- Every run embeds a machine fingerprint (CPU model, cores, OS, node) and a **preflight
  calibration score**: a fixed, versioned, seeded CPU probe (~1s of JSON/array/string churn
  approximating render work) run in the same headless browser. Higher = faster machine.
- Web default comparisons use records from one physical run. Native runs are split per entry to
  keep long device sessions recoverable; the collector combines them only when they share the
  same anonymized Sandbox lease ID, device class, and environment, and chooses one complete run
  per current entry. The incremental archive retains source identity on every record. Run
  selection ranks featured-entry coverage and featured matrix coverage; stale entry commits and
  Lab variants cannot keep an older cohort public. Opt-in historical Lab time
  fields are multiplied by source-score / comparison-score and marked as calibrated estimates.
  Heap, wire, bundle, and count fields are not scaled. The probe corrects scalar CPU speed,
  never memory hierarchy or core count; probe version bumps invalidate cross-version estimates.

## Harness separation

- `harness: "web"` — Lynx for Web in headless Chromium. Measures architectural behavior
  (wire cost, thread split, scaling shape), not native absolute performance.
- `harness: "native"` — real Native Engine execution on an Android 10 ByteDance aries_10
  Lynx Sandbox device through LynxExplorer and `@byted/agent-lynx`. The boundary is
  `native-input-handler-to-second-native-frame`; startup normally uses Native pipeline
  performance entries, with the documented Octane clock-calibrated frame fallback. Unsupported
  input/session paths and timeouts are explicit DNF. No Web, node
  `--jitless`, jsdom, or extrapolated value is published as Native.
- The published Native Octane entry is upstream `main` only. Historical/experimental Octane Lab
  variants remain opt-in Web history and are not run in the Native cohort.
