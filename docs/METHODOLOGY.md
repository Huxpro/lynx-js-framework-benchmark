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
  is outside the sample. The Sandbox adapter subscribes before dispatching real Native touch input
  for every featured entry. Octane additionally waits for `root.flushTransport()` before its two
  frames, then emits a post-ACK row/ID/label/selection snapshot. The adapter validates that
  snapshot against the requested workload. Its optional DevTool driver is diagnostic-only and
  records a distinct trigger source/boundary so it cannot masquerade as a tap sample.
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
  `enable_perf_metrics` switch. A versioned producer receipt must also prove the requested row
  state after two Native frames; a producer frame timestamp alone is never called FCP.
  `pipelineEnd - openTime` is retained as settled only when both sources validate.
  Octane's custom renderer publishes no pipeline entries in this Explorer build, so **no Native
  Octane FCP is reported**. Instead it emits two isolated metrics with different names and
  boundaries: host `openPage` request → initial transport commit ACK (`octaneCommitAck`), and →
  second frame after that ACK (`octaneSecondFrame`). The request time is converted to the device
  epoch using seven ADB clock samples (lowest RTT wins); offset and RTT remain in machine metadata.
  Neither isolated metric enters an FCP ranking.
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
  same physical LynxExplorer/Sandbox device cohort for every featured entry. A formal matrix may
  span explicit official leases of that same serial, but hardware/environment, input, connector
  toolchain, method policy, and campaign identity cannot change. Bundles are served locally
  through ADB reverse with cache-busting URLs;
  bundles are vendored with commit + build command + sha256 (fixing the lynx-table PR's
  unverifiable references).
- The driver contract (buttons, classes, predicates) is shared, versioned in this repo, and
  never forked per framework. A predicate that cannot see a framework's DOM shape is an
  instrument bug, not a DNF.

## Statistics

- Web warmup: two untimed create/clear cycles per page; storms and startup use fresh pages per
  sample (page-load variance is inside the sample, stated on the site). Native opens a fresh
  page/session per repetition without dropping any raw sample. Formal Android runs use direct
  transport, one persistent CDP channel per page, a 100 ms unmeasured DebugRouter teardown
  interval, and a configured clean-Explorer recycle cadence (five pages by default). The first
  post-recycle sample remains in the raw set; there is no outlier filtering. Transport, recycle,
  timeout, and retry settings are encoded in the Native machine identity, and the full matrix
  order is fixed so every entry sees the same cycle.
- Reported per sample set: median (headline), mean, sample std, min, p95, and a
  t-distribution 95% CI (octane's `stats` discipline); raw samples retained in run files.
- Raw `samples`/one-shot `value` are authoritative. Collection recalculates every statistic and
  ignores stored aggregate snapshots in run files; see [DATA_MODEL.md](./DATA_MODEL.md).
- **DNF is data**: timeouts are counted (`dnfCount`), retained with per-repetition structured
  `failures` evidence, and shown; a slow framework looks slow, never absent. Long Native
  workload/startup cells use a configurable ceiling (240 seconds by default). If a failed create makes a later cell's
  prestate unreachable, that later DNF records the inherited cause rather than spending another
  timeout or silently skipping the cell. Strict producer payload validation failures become
  `producer-protocol-invalid` DNF evidence for the current cell only. Evidence says validation was
  attempted and did not pass; it never claims successful validation and contains no fabricated
  timing. Unrelated cells continue. Other non-timeout harness/programming errors still abort the run.
  DevTool `No response found`/inactive-hook failures and page/session-start transport failures
  (including an unresponsive `Runtime.enable`) use a configurable bounded attempt count (three by
  default); exhaustion becomes a `transport-retries-exhausted` DNF with the recovery log. Bundle
  integrity, thermal, producer validation, and unknown harness errors are not folded into that
  category. Device/adapter initialization before any contract key exists remains fatal; entry-specific
  page/session setup happens only after the first pending contract cell is selected, so its failure
  maps deterministically to that table key or to the complete two-metric startup scale, never to
  broad entry-wide unsupported status. Startup transport DNFs contain no fabricated
  FCP/settled observations. Semantic timeouts are never retried and never converted to numbers.
  Native source files are atomically checkpointed after each cell (and each complete startup pair),
  so a later transport failure or lease boundary cannot erase prior cells. Before the lease safety
  window the runner exits cleanly with an incomplete checkpoint rather than starting a cell it may
  not finish. The safety window is derived from the
  largest formal repetition count and configured thermal gate, page/session and long-workload
  timeouts, every transient attempt and reconnect window, plus cleanup. An environment override
  may increase but cannot lower that minimum, so timeout changes automatically change expiry safety.
  The original `No response found` chain was traced to Explorer DebugRouter's single USB-client
  rule: a persistent Runtime console stream and a second DOM/Input connection replaced each other,
  after which the device logged `ReadAndCheckMessageHeader` protocol failure. Formal runs use one
  persistent direct CDP channel; retries remain only as bounded evidence for genuinely interrupted
  device sessions, not as the normal control path.
  Octane uses the configured long ceiling required by its renderer cliff. Other Native operations
  use the configured 30-second control ceiling; Web case timeouts are not imported into the Native
  domain and a global Octane timeout is not imposed on every framework.
- Startup polling applies the cell deadline to each individual CDP request as the remaining total
  time, so a final unresponsive Performance request cannot overrun the declared timeout. A timeout
  at rows 0 proves only that cell failed: every later scale is attempted independently and emits
  complete `fcp`/`settled` records. Entry-wide unsupported status is allowed only with affirmative
  capability evidence; absence or one timeout is not capability proof.
- No single aggregate score across suites; per-suite geomeans only (the unified benchmark's
  audit rejected a global score; we follow).
- The site time slider selects four exact, representative source snapshots rather than a moving
  archive cutoff. Octane always means the upstream-main source recorded by that snapshot, even
  though its commit SHA changes. Historical storm values need special care: the Aug 11/12 and
  Aug 15 Octane runs recorded only 6–8 BTS→MTS and 14–17 MTS→BTS messages for a nominal
  30-tick select storm, while the current run records 60 and 92. The benchmark app's
  MessageChannel storm implementation is unchanged across those commits, so the old fast values
  reflect runtime/transport batching or collapsed intermediate commits, not 30 equivalent
  end-to-end commits. The slider labels this comparability break. New Web storm samples fail
  closed as `incomplete-storm-transport` unless both transport directions observe at least one
  rpc message per requested tick (50 update / 30 select); reaching only the final DOM predicate is
  no longer sufficient.

## Machines and calibration

- Every run embeds a machine fingerprint (CPU model, cores, OS, node) and a **preflight
  calibration score**: a fixed, versioned, seeded CPU probe (~1s of JSON/array/string churn
  approximating render work) run in the same headless browser. Higher = faster machine.
- Web default comparisons use records from one physical run. Native checkpoints combine only when
  they share the exact stable physical-device cohort, environment, harness configuration, campaign,
  210-cell contract, immutable input receipt, and recursive connector toolchain receipt. Each
  checkpoint carries an ordered chain of structured official lease receipts and maps every cell to
  its producing lease. Split checkpoints combine only if one chain is an exact receipt-for-receipt
  prefix of the other; a same-serial `[A,B]` versus `[A,C]` fork is rejected. A correctness fix made
  after an incomplete checkpoint can continue only through an explicitly allowlisted source-only
  method revision whose exact target input digest is supplied by the operator. The original
  campaign/input identity remains stable, while a second hashed prefix chain retains both complete
  source receipts and maps every cell to its producing method revision. Bundles, manifests, entry
  commits, connector trees, matrix, runtime policy, hardware, and device cohort are invariant across
  that transition. The collector rejects missing/malformed chains, overlaps, cross-serial or
  hardware/toolchain changes, unapproved method drift, and missing/unknown cell attribution. It rejects a selected cohort
  unless every cell is measured, DNF, or capability-proven unsupported. The incremental archive
  retains source identity on every record; stale entry commits and
  Lab variants cannot keep an older cohort public. Opt-in historical Lab time
  fields are multiplied by source-score / comparison-score and marked as calibrated estimates.
  Heap, wire, bundle, and count fields are not scaled. The probe corrects scalar CPU speed,
  never memory hierarchy or core count; probe version bumps invalidate cross-version estimates.
  Each lease ID hashes the issue ID, expiry, and serial SHA-256. The stable cohort intentionally
  excludes the individual lease IDs but includes the serial digest plus hardware/environment,
  method, input, matrix, campaign, and connector digest. Hashing the serial alone is forbidden, and
  silently reusing a serial without its explicit ordered receipt chain is forbidden. Every Native
  source run also retains Explorer package version, DebugRouter and Lynx SDK versions, plus battery
  temperature, Android thermal status, and named HAL readings at every bundle-load gate plus
  adapter start/end. Each sample starts only after thermal status returns to 0 and battery
  temperature is at or below the declared 40 °C ceiling. The versioned campaign hashes the matrix,
  immutable input receipt, timeout/render/retry settings, and lifecycle/reconnect/thermal policy;
  the same policy is in the machine identity. These fields are prospective controls/audit metadata, not a post-hoc
  calibration or an outlier filter.

## Harness separation

- `harness: "web"` — Lynx for Web in headless Chromium. Measures architectural behavior
  (wire cost, thread split, scaling shape), not native absolute performance.
- `harness: "native"` — real Native Engine execution on an Android 10 ByteDance aries_10
  Lynx Sandbox device through LynxExplorer and `@byted/agent-lynx`. The boundary is
  `native-input-handler-to-second-native-frame`; startup normally uses Native pipeline
  performance entries, while Octane's commit-ACK/second-frame observations remain isolated and
  are not labelled FCP. Unsupported input/session paths and timeouts are explicit DNF. No Web, node
  `--jitless`, jsdom, or extrapolated value is published as Native.
- The published Native Octane entry is upstream `main` only. Historical/experimental Octane Lab
  variants remain opt-in Web history and are not run in the Native cohort.
