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
  for every Native-eligible featured entry. Featured Octane entries are Web-only: the benchmark
  does not patch Octane's runtime or app to expose a private completion protocol.
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
  Octane's custom renderer does not expose the same pipeline boundary in this Explorer build, so
  **no featured Native Octane metric is reported**. Archived private-protocol observations remain
  evidence, but cannot fill the current black-box matrix.
- Old app-authored update/select storms remain archived experiments. Featured Web storms use a
  separate shared `/storm` driver: 50 standard update-every-tenth pointer ticks (10%-column width)
  or 30 alternating standard selection ticks (one-row width), at a declared 8ms interval. Both
  `every-tick` and `final-state` policies use that identical stimulus. Every-tick requires the rAF
  observer to see the exact state sequence; final-state permits coalescing and requires only the
  terminal state. The source retains actual input offsets and transitions. A semantic miss is
  `contract-failed` descriptive data, not DNF; timeout/driver failure is DNF. Storms never enter the
  js-framework weighted score. A full-column shape stays unsupported until every entry exposes one
  standard black-box action; no framework-specific proxy is used.
- The standard `select@1k` preselects one row, then measures moving selection to another row. That
  matches js-framework-benchmark's Playwright `init()`/`run()` sequence; an unselected-to-selected
  variant is not substituted. Web `select@10k` remains the larger-scale Lynx extension. Likewise,
  Web `clear` covers the standard 1k workload and the existing 10k scale/memory extension. The Web
  clear addition does not change the published Native matrix.

### js-framework weighted score

The Web results expose one strict, formula-compatible score over the nine CPU workloads in
[js-framework-benchmark's current order](https://github.com/krausest/js-framework-benchmark/blob/afe7c118dd217ccae4c10813613ac0d7566b1ef1/webdriver-ts/src/benchmarksCommon.ts):
create 1k, replace 1k, update every tenth row, move selection, swap, remove, create 10k,
append 1k to 1k, and clear 1k. For each workload, every featured entry's median is divided by
the fastest featured median for that workload. The score is the weighted geometric mean

`exp(sum(weight[i] * ln(ratio[i])) / sum(weight))`

using the nine weights from
[the upstream results implementation](https://github.com/krausest/js-framework-benchmark/blob/afe7c118dd217ccae4c10813613ac0d7566b1ef1/webdriver-ts-results/src/Common.ts).
An entry missing any one of the nine cells is not scored; a partial matrix is never divided by
the full weight denominator.

This is **formula and operation-set parity, not measurement-protocol identity**. Upstream measures
Chrome trace duration and applies case-specific CPU throttling (4× for update/select/swap/clear,
2× for remove) plus its own warmup schedule. This lab applies the same formula to medians from
the framework-neutral Lynx for Web boundary: input `pointerdown` until the composed-DOM predicate
is true. The label therefore says `js-framework weighted score`, not `official js-framework-benchmark score`.

Startup FCP is intentionally not folded into that score. The upstream weighted score is a composite
of the nine post-load CPU operations. Upstream separately retains `first paint` in its active size
suite; its experimental `first-contentful-paint` entry was added in November 2023 and disabled in
the Chrome 120 result update after the published experiment reported the same timestamp as
`first paint` for every entry. This repository's startup workload is materially different: the
first visible benchmark content is N pre-rendered rows, so local/cached startup distinguishes bundle
parse/eval, framework initialization, initial create, and paint. It remains a separate startup
metric rather than silently changing the upstream interaction formula.

## Dual-thread metrics

- **Wire**: on Lynx for Web, every BTS↔MTS message crosses one `MessageChannel` driven by
  `@lynx-js/web-worker-rpc`; envelopes carry their endpoint name. The harness patches
  `MessagePort.prototype.postMessage` (MTS→BTS) and the `onmessage` setter (BTS→MTS) in the
  page realm before web-core boots: **both directions, all message types, every framework,
  one instrument** — fixing the lynx-table PR profiler's limitations (octane-internal,
  commit-only, one-directional). Bytes are the UTF-8 length of a stable JSON serialization —
  a structured-clone-cost proxy applied identically to every entry (documented limitation:
  transferables are size-tagged, not serialized).
- **Element pipeline (Web-only)**: a dedicated `/pipeline` harness page intercepts the one
  `Object.assign` that installs web-core's ElementPAPI surface onto its same-origin sandboxed MTS
  iframe. The outer hook is installed before web-core boots and wraps every framework identically.
  Each sample retains synchronous self-time and call counts for `create / props / events /
  topology / read / flush`, together with the complete call multiset, intercepted surface,
  requested rows, and committed rows. Nested host calls are subtracted from their parent's
  self-time. This is a separate `pipeline` suite: the ordinary table/startup page installs no PAPI
  wrappers, so the new instrument cannot change an already-published latency. Raw runs retain only
  the operation interval and six synchronous self-time series; `collect` derives
  `outsidePapiTime` by subtracting aligned samples. It means the black-box
  pointerdown→predicate interval minus synchronous PAPI self-time; it includes
  framework script, scheduling, and asynchronous style/layout/paint and is **not** labelled
  framework-only time. Likewise, `__FlushElementTree` self-time is synchronous web-core flush
  bookkeeping/root attach, not the browser's full layout/commit cost. Native is explicitly
  unsupported because it has no equivalent framework-neutral seam; no proxy value is emitted.
- **List virtualization (capability-gated)**: `list-startup@1k/10k` attaches a separately built,
  prepopulated declarative list and observes the first visible content frame. `list-recycle@10k`
  moves exactly one 390×640 viewport twenty times and retains raw elapsed time, recycled-cell count,
  and wire totals. `list-fling@10k` applies 4,800 px/s for 1,500 ms and retains materialized cells,
  materialization samples, and every blank frame. Collection alone derives cost/bytes per recycled
  cell, materialized cells/s, and p50/p99. The fixture uses stable keyed `list-item` children with a
  40 px estimate and two leading/trailing buffer rows. Native observes the versioned visible-cell
  tree and uses a shared fixed-velocity touch gesture; Web uses its separate composed-tree observer
  and shared wheel schedule. A materialization is a stable item key first becoming visible on a
  presented frame; a blank frame has zero expected visible keys. Renderer internals such as
  `componentAtIndex` are observational implementation details, never framework-facing calls.
  Existing eager-table artifacts declare no list fixture, so their cells are explicitly
  unsupported instead of being proxied. A non-zero blank-frame count is valid measured data; only
  driver/capture failure is DNF.
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
- Pipeline comparison eligibility is derived, never source-authored. A sample set is rejected when
  its call multiset, intercepted surface, requested rows, or committed rows varies across
  repetitions; an operation cell is rejected for every entry when observed peers commit different
  tree sizes. Call multisets may differ *between* frameworks—the counts are a result—but must be
  stable within one entry/case/scale sample set.
- Storm comparison eligibility is also derived. `contractPass`, committed-frames/ticks, and
  bytes/messages per tick are computed from aligned raw observations. Declared contract drift,
  invalid transition evidence, or pointer cadence outside the declared 8ms + 50ms tolerance fails
  closed. Contract-failed observations remain visible in the dedicated view but cannot enter a
  ranking; final-state observations expose coalescing rather than treating it as missing work.

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

- Web warmup: two untimed create/clear cycles per page; startup uses a fresh page per
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
  Native operations use the configured 30-second control ceiling; Web case timeouts are not
  imported into the Native domain.
- Startup polling applies the cell deadline to each individual CDP request as the remaining total
  time, so a final unresponsive Performance request cannot overrun the declared timeout. A timeout
  at rows 0 proves only that cell failed: every later scale is attempted independently and emits
  complete `fcp`/`settled` records. Entry-wide unsupported status is allowed only with affirmative
  capability evidence; absence or one timeout is not capability proof.
- No single aggregate score across suites; per-suite geomeans only (the unified benchmark's
  audit rejected a global score; we follow).
- The site time slider uses a small editorial list of meaningful exact-source checkpoints rather
  than treating every complete retry—or one framework's commit—as a timeline identity. Every valid
  run remains in the source audit. Web positions are one physical run and expose the complete cell
  intersection shared by their declared framework identities; Native positions
  combine incremental source runs only inside one unchanged machine/lease/environment/method
  identity. Every framework identity shows a linked version or commit pointer. Octane normally means
  the upstream HEAD recorded by that checkpoint, even when older files called it `octane-main`;
  Hux1, Hux2, and dated `new-lynx` entries are labelled as Huxpro branch-head attempts. The original
  source ID, file, and commit remain visible. Rank-over-time never carries a value forward or ranks
  an isolated observation.
  Historical storm values need special care: the Aug 11/12 and
  Aug 15 Octane runs recorded only 6–8 BTS→MTS and 14–17 MTS→BTS messages for a nominal
  30-tick select storm, while the later patched audit run recorded 60 and 92. The benchmark app's
  MessageChannel storm implementation is unchanged across those commits, so the old fast values
  reflect runtime/transport batching or collapsed intermediate commits, not 30 equivalent
  end-to-end commits. Those archived app-authored storms therefore stay absent from the featured
  matrix rather than being repaired with framework-specific barriers; they are not the new shared
  `/storm` suite. The controlled immutable-bundle replay and root-cause split are in
  [OCTANE_WEB_AUDIT.md](./OCTANE_WEB_AUDIT.md). Those old medians remain visible as
  provenance-bearing incomparable points, but are excluded from rank lines.

## Machines and calibration

- Every run embeds a machine fingerprint (CPU model, cores, OS, node) and a **preflight
  calibration score**: a fixed, versioned, seeded CPU probe (~1s of JSON/array/string churn
  approximating render work) run in the same headless browser. Higher = faster machine.
- Web default comparisons use records from one physical run. Native checkpoints combine only when
  they share the exact stable physical-device cohort, environment, harness configuration, campaign,
  115-cell contract, immutable input receipt, and recursive connector toolchain receipt. Each
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
  performance entries. Unsupported input/session paths and timeouts are explicit DNF. No Web, node
  `--jitless`, jsdom, or extrapolated value is published as Native.
- All featured Octane entries are explicitly Web-only. Historical Octane Native observations remain
  appendix evidence and never enter the current Native cohort or ranking.
