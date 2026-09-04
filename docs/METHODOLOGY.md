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
- **Native interactive latency** = the entry's Native input handler → the first externally
  observed Native element-tree state that satisfies the shared workload predicate → two further
  `lynx.requestAnimationFrame` callbacks. The entry emits a `__NATIVE_BENCH_RESULT__` producer
  receipt carrying the input-handler `startMs` through the Runtime console; the Sandbox adapter,
  already subscribed before real Native touch input, polls the rendered Native tree and requests
  the final two frames. Both timing endpoints and the duration use the device clock. DevTool polling
  can only delay observation, so its fixed cadence is recorded as bounded endpoint quantization
  rather than subtracted. This is an instrumented input timestamp around a black-box renderer
  observation, not a framework-unmodified black-box claim. React, Vue, and Hux Octane expose the
  same v3 action/start receipt and final-frame hook. The adapter normalizes them to the explicit
  `input-handler-to-native-dom-predicate-plus-two-frames` record field. Framework-specific
  commit/transport acknowledgements are forbidden from this ranked latency interval. Octane's
  benchmark-only patch remains confined to the table app and does not modify Octane core. Its
  transport evidence is explicitly `excluded-from-latency`. The superseded v2 Octane observations
  waited for `root.flushTransport()` before their two frames; the collector retains them only as
  descriptive evidence and excludes them from every ratio, baseline, score, and ranking.
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
  `Performance.getAllPerformanceEntries`, after enabling the Explorer `enable_perf_metrics`
  switch. A versioned producer receipt must also prove the requested row state after two Native
  frames; a producer frame timestamp alone is never called FCP. `pipelineEnd - openTime` is
  retained as settled only when both sources validate. Hux Octane's custom renderer does not expose
  the same pipeline boundary in this Explorer build, so its startup cells use two explicitly
  separate, non-cross-ranked boundaries: open request → transport commit acknowledgement
  (`octaneCommitAck`) and open request → the second Native frame after that acknowledgement
  (`octaneSecondFrame`). These are not labelled FCP or settled.
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
- **Staging Pareto (derived-only)**: for each startup scale, collection reads the matching
  `rows-N/main.web.bundle` or `main.lynx.bundle`, derives raw/gzip bytes, and retains the artifact
  path and SHA-256 beside the static record. The total axis uses the whole selected-harness
  artifact. The MTS axis is emitted only when `lepusCode.root` is structurally readable; binary
  formats are labelled unavailable. The site joins those bytes to FCP from the same entry, harness,
  scale, and one normalized execution regime. Web uses JIT at 1× by default; interpreter and
  throttled lanes are excluded, and the frontier derivation fails closed if lanes are mixed. It
  draws the existing 95% CI vertically and connects exactly the points for which no peer is both no
  larger and no slower (with at least one strict improvement). It is not a score. Current manifests
  are not applied retroactively to historical commits that did not retain their exact per-scale
  bytes; retroactivity applies only where those bytes exist. The next Octane bundle refresh must
  vendor real per-scale builds so straight-line N-growing code staging can become visible.
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
  138-cell contract, immutable input receipt, and recursive connector toolchain receipt. Each
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

## Web JavaScript execution regimes

The Web harness publicly exposes three separately ranked execution lanes. `web` is Chromium's
normal V8 JIT
with CPU throttling disabled (`environment: { jsRegime: "jit", jsFlags: "--expose-gc",
cpuThrottle: 1, throttleScope: "none" }`). `web-interp` uses
`--js-flags=--expose-gc,--no-opt,--no-sparkplug,--no-maglev`, leaving JavaScript on Ignition while
Wasm keeps its normal compiled pipeline, and leaves CPU throttling disabled. Public
`web-interp-4x` keeps the same interpreter flags but applies one calibrated OS quota to the whole
Chromium process tree. Chromium is launched *inside* the quota so every renderer inherits it from
birth: the runner uses cgroup-v2 `cpu.max` when delegated, or creates a cgroup-v1 CPU controller
and enters it through `cgexec` on the lab host. Calibration begins at 25% of one CPU and records
each adjustment needed to bring the page probe to nominal 4×. `cpulimit` PID/fork monitoring is
not an accepted backend because it can miss renderer startup. Immediately before each entry's
measured phase, the same interpreter-only Chromium runs the fixed page probe three times and uses
the median score; the window fails
closed unless `control.score / throttled.score` is within [3.5, 4.5]. Every accepted record stores
that value as `environment.verifiedSlowdown`, while the backend and every per-entry verification
remain in the run receipt. Its environment uses `cpuThrottle: 4, throttleScope:
"process-cgroup"`. `Interp 4×` therefore always means process-wide throttling in the runner, site,
and shareable URL.
Because the whole Chromium tree shares one CFS quota, exhausting that quota can freeze both MTS
and BTS until the next scheduler period; the resulting cross-thread round-trip amplification can
exceed the nominal 4× compute slowdown and is published as an end-to-end latency effect rather than
normalized away.

The former page-target CDP campaign is frozen historical evidence. It used the same interpreter
flags but applied `Emulation.setCPUThrottlingRate` only to the page/MTS target; the separately
attached `lynx-bg` BTS worker remained full-speed. Those records normalize to `throttleScope:
"page-cdp"` and can still be audited, but they are absent from the public regime facet and new runs
are rejected. The mixed regime was defensible only for end-to-end latency, never per-side metrics;
all 84 raw `btsCpu` samples remain source evidence classified `invalid-measurement` and excluded
from charts and rankings.

The 30 August `cpulimit` campaign is retained only as an invalid-measurement cautionary example.
Its one global 4.12× preflight did not prove the later entry windows: most renderer windows matched
the unthrottled lane, while upstream interactions alone were caught after startup. The collector
marks every record from that source run `invalid-measurement`; none of its ranks or scope-difference
claims remain published.

The
historical default is exactly `web`; a
schema-v2 record without regime fields normalizes to JIT / `--expose-gc` / 1×. The machine fingerprint does not
change, but collection keys and comparison cohorts include all four environment dimensions, so
lanes never overwrite, average, or rank together.

All interpreter lanes are **directional probes — interpreter regime under V8; not Native, not
PrimJS**. V8 Ignition is not LepusNG/PrimJS: JavaScript keeps Ignition's ICs, hidden classes, and
feedback vectors (but no compiled JavaScript), plus V8's generational garbage collector; Wasm and
RegExp remain compiled. Before a formal interpreter run, a one-off browser adds
`--allow-natives-syntax`, warms a pure-JavaScript function, and asserts that a JIT control compiles
while the interpreter process reports never-optimized Ignition; it also instantiates a minimal
Wasm module. Measured processes omit the diagnostic flag. Full `--jitless` was rejected because it
also disables Wasm, and restoring Wasm through DrumBrake would require a custom, non-reproducible
Chromium build. These lanes are suitable for ordering,
scale-shape, regression, and "what was JIT hiding?" leads, never absolute device-time prediction.

### Rank-stability calibration against device rounds 1–3

The current calibration uses the same-machine 29 August featured Web campaign, with upstream
Octane at `9779569e`, Huxpro/new-lynx at `8938c126`, and the now-retired page-CDP campaign
(`throttleScope: "page-cdp"`) as the directional probe. Its pre-fix device anchors are the
real-device round-1 and round-2 windows in
[Huxpro/octane#194](https://github.com/Huxpro/octane/issues/194). Those device windows used older
Octane tips and different instrumentation boundaries, so the table below tests only ordering,
completion cliffs, and scaling direction. It does not compare absolute times or claim a controlled
revision A/B.

| Device anchor | Matching historical page-CDP observation | Rank/shape verdict |
| --- | --- | --- |
| Round 1 eager 1k: ReactLynx FCP (1,264 ms) precedes the Octane program (12,789 ms). | ReactLynx startup@1k (923.5 ms) precedes Hux Octane (1,588.1 ms). | **Ordering agrees.** This is a directional historical ordering anchor, not a current cross-framework startup rank. |
| Round 1 program versus template at 1k: program 12,717 ms versus template 14,354 ms; after the round-2 ledger fix, program 657 ms versus template 2,149 ms. | Hux Octane startup@1k is 1,588.1 ms versus upstream Octane 1,485.2 ms. | **Ordering disagrees.** The Web probe does not reproduce the Native compiled-program advantage. |
| Formal Native ReactLynx startup grows from 63.8 ms at 0 rows to 1,434.1 ms at 1k, then is DNF at 10k and 30k. The device rounds also hit the ART/PaintingContext capacity boundary at eager 10k. | ReactLynx grows from 110.2 ms to 923.5 ms at 1k but completes at 8,706.4 ms / 25,934.3 ms for 10k / 30k. Every featured Web entry completes both large scales. | **Only the increasing direction agrees; the scaling shape and capacity cliff do not.** Compiled Wasm plus browser host objects cannot expose the Native JNI global-reference ceiling. |
| Round-2 `mountProgram` bookkeeping falls from 8,565 ms to 4 ms after the ledger fix. | No Web record has a boundary equivalent to Native `mountProgram`. | **Not rank-calibratable.** It remains a Native-only internal anchor and is not imputed into Web. |

The first post-fix anchors use new-lynx `8938c1260` on the same `aries_10` protocol. They are kept
separate from the pre-fix table because they answer transport shape and measurement fidelity, not
an absolute-time revision A/B.

| Post-fix device anchor | Matching Web observation | Rank/shape verdict |
| --- | --- | --- |
| Two create→clear→re-create sequences at 1k each emit 2 MTS→BTS messages and exactly 1 ACK per commit. Create uses compact-v1 with 7,000 acknowledged hosts; encoded ContextProxy totals are 182 B for create and 222 B for clear. | The post-fix Web create commit is likewise constant-size instead of the former 17.4 MB / 23,799-message storm. | **Transport shape agrees.** Native ContextProxy payload bytes and Web RPC-envelope bytes have different boundaries, so this is a post-fix shape anchor, not a ranking anchor. |
| The superseded Native v2 clear@1k receipts waited for an Octane transport ACK while ReactLynx exposed no equivalent ACK. Upstream's create→clear preparation path also DNF'd, requiring an eager-1k clear probe instead. | Web-interp reports a stable Octane-family clear gap under one shared DOM predicate and transport boundary. | **Not rank-calibratable.** These immutable v2 receipts remain descriptive-only. Native v3 removes the framework-specific ACK from ranked table latency instead of relabelling the old samples. |

Within Web itself, turning off compiled JavaScript changes the winning entry in 5 of the 16 shared
latency/FCP cells and reverses 63 of 336 pairwise entry orderings (18.8%). Comparing normal JIT with
the historical page-CDP campaign changes 8 winners and 71 pairwise orderings (21.1%). Thus JIT does
hide material ordering differences, but the device calibration above is too weak for an
interpreter lane to substitute for device rounds: use it to choose confirmation cells, not to
publish Native ranks.
The inherited-launch process-scope campaign passed all seven per-entry gates at 3.86–4.07× with no
DNF. Against the page-CDP lane, it changes the winner in 8 of the same 16 latency/FCP cells and
reverses 78 of 336 pairwise entry orderings (23.2%); every one of the 12 latency cells has a changed
full order.

The frozen mixed lane's useful learning is its *shape*, not another public leaderboard. Relative to
unthrottled Interp, its median slowdown clusters at 3.65–3.90× for create/replace/append/clear, but
only 1.16–1.61× for select/swap/update@1k; large selection and update cells sit between those groups.
That separation diagnoses how much an end-to-end cell is page/MTS-bound. Moving from mixed to the
whole-process quota then costs a 1.27–2.70× entry-level latency geomean across the seven featured
entries, while wire bytes and message counts stay approximately 1×. The wide spread is evidence of
different BTS and cross-thread quota sensitivity, not a transport-protocol change. It is also why
the mixed lane is not retained publicly: process-scope is the sole canonical `Interp 4×` lane;
page-CDP raw records remain an immutable historical calibration, receive no new runs, and do not
appear in the site regime facet or public rankings.

### Issue #42 measurement-boundary audits

- `btsCpu` under the historical page-CDP campaign is invalid. The runner sent
  `Emulation.setCPUThrottlingRate` only to the page session; the `lynx-bg` worker is a separate CDP
  target. This explains why create@10k BTS samples stayed near the unthrottled interpreter lane and
  why the Hux/upstream order could invert. The collector preserves those raw samples for audit but
  gives them `rankingEligible: false`; no throttled BTS CPU claim remains published.
- ReactLynx startup uses the same harness page, `/bundles/<entry>/rows-N/main.web.bundle` serving
  route, `viewAttachTime` origin, composed-tree `contentCount >= 5` first-frame predicate, and
  400 ms content-count quiescence rule as Octane and every Vue entry. There is no React-specific
  startup branch. Its 40%+ FCP advantage therefore stands as a result at this Web boundary.

## Harness separation

- `harness: "web"` — Lynx for Web in headless Chromium. Measures architectural behavior
  (wire cost, thread split, scaling shape), not native absolute performance.
- `harness: "native"` — real Native Engine execution on an Android 10 ByteDance aries_10
  Lynx Sandbox device through LynxExplorer and `@byted/agent-lynx`. The boundary is
  `native-input-handler-to-native-dom-predicate-plus-two-native-frames` with settlement contract
  `input-handler-to-native-dom-predicate-plus-two-frames`; startup normally uses Native pipeline
  performance entries. Unsupported input/session paths and timeouts are explicit DNF. No Web, node
  `--jitless`, jsdom, or extrapolated value is published as Native.
- Hux Octane is Native-eligible under the v3 table producer. Upstream Octane is Web-only in the
  current featured cohort. Hux's separately named startup ACK metrics remain Native-only
  descriptive boundaries and are never treated as pipeline FCP.
