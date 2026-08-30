# Design

> The architecture of lynx-js-framework-benchmark: what it measures, how it stays neutral,
> and why each decision was made. See [METHODOLOGY.md](./METHODOLOGY.md) for the measurement
> rules and [../README.md](../README.md) for usage.

## Mission

A neutral, extensible benchmark infrastructure for JS frameworks running on Lynx, serving two
purposes at once:

1. **Evaluation** — fair, reproducible comparisons across frameworks, versions, and configs.
2. **Insight** — expose *why* results differ. On Lynx the dominant variable is the dual-thread
   wiring: how much work happens on the background thread (BTS) vs the main thread (MTS), and
   how many bytes cross between them. Transported payload size changes every equation, and a
   benchmark that only reports total wall-clock hides exactly the thing framework authors need
   to see.

## Lineage

This infra unifies and generalizes three prior systems:

| source | what we take | what we fix |
| --- | --- | --- |
| vue-lynx `packages/benchmark` + `packages/ifr-bench` (branch `huxcx/unify-benchmark-system`) | the krausest-superset workload & app contract, the black-box `pointerdown → DOM predicate` timing, storm protocol, scale ladders, the `unified.json` record schema with comparability dimensions, `NEUTRALIZE_LYNX_PROFILE` | vue-only instrumentation (`__VUE_LYNX_FLUSH_HOOK__`) replaced by a framework-neutral wire meter; results unified into one repo/format |
| octane `benchmarks/` | runner contract (BENCH_JSON), steady statistics discipline (median + CI, seeded PRNG, `window.gc()`, in-page clicks), ratio-guard gating idea, the site's visual language (ranked bars, geomean grid, ×-vs-baseline) | none of it measured Lynx's thread boundary |
| octane PR #1 `benchmarks/lynx-table` | the shared page driver contract (class-based predicates), vendored-bundle provenance manifests | its wire profiler was octane-internal, one-directional, commit-only, and counted JSON UTF-16 length; ours instruments the host boundary so **every** framework is measured with the same instrument, both directions, all message types |

## Core concepts

### Entry = framework × version × config

An *entry* is one buildable/runnable benchmark app. Entries live in `entries/<id>/` with a
manifest `entry.json`:

```jsonc
{
  "id": "vue-vdom",
  "label": "Vue-Lynx VDOM 0.x",           // shown on the site
  "framework": "vue-lynx",
  "frameworkVersion": "…",
  "config": "vdom baseline",               // human description of flags
  "tags": ["baseline"],                    // baseline | optimized | reference
  "harnesses": ["web", "native"],       // optional; omitted means both
  "color": "#42b883",
  "kind": "vendored" | "built",
  // kind=vendored: dist/ is committed, provenance is mandatory:
  "provenance": {
    "source": "https://github.com/Huxpro/vue-lynx",
    "ref": "huxcx/unify-benchmark-system",
    "commit": "…",
    "buildCommand": "…",
    "builtAt": "…",
    "sha256": { "main.web.bundle": "…", "main.lynx.bundle": "…" }
  },
  // kind=built: the runner builds it on demand:
  "build": { "command": "pnpm build", "cwd": "." },
  "bundles": { "web": "dist/main.web.bundle", "lynx": "dist/main.lynx.bundle" }
}
```

Adding an entry — a new framework, a new version of an existing framework, or the same
framework with different compiler flags — is *adding one directory*. The runner and the site
discover entries by scanning `entries/*/entry.json`. Vendored entries carry sha256 checksums so
a stale or tampered bundle is detectable (a gap PR #1's manifest had).

Both bundle flavors are kept: `main.web.bundle` feeds the web harness; `main.lynx.bundle` is
preserved so a native-engine harness can consume Native-eligible entries (see Harnesses).
`tier` controls public visibility, while `harnesses` independently controls which complete
comparison matrix the entry joins.

### Workload contract

All entries implement the same app — a krausest-style table with a fixed **driver contract**
(inherited from the unified benchmark, byte-compatible with the existing ui-vdom/ui-vapor/
ui-react/octane apps):

- Title text `Benchmark on Lynx` (readiness predicate).
- Toolbar buttons identified by exact `.btn-text` label: `Create 1,000 rows`,
  `Create 10,000 rows` (and 3k/5k/20k/30k), `Append 1,000 rows`, `Update every 10th row`,
  `Swap Rows`, `Clear`, `Update storm`, `Select storm`.
- Rows: `.rows` container > `.row` (selected: `.danger`) > `.col-id` / `.col-label` /
  `.col-remove`.
- Storms: one tap triggers 50 sequential update passes / 30 sequential selection moves driven
  by a `MessageChannel` macrotask pump inside the app.
- Startup at scale: the app reads `initData.autoRows` and renders N rows in its first screen,
  so one bundle serves the whole startup scale ladder (and IFR-capable configs get to show
  their first-frame path honestly).

Cases (`workload × scale`) are defined once in `packages/shared/src/workloads.mjs`; a case is
*data*, not code: `{ name, pre, trigger, predicate, scales }`.

### Metrics: five layers per case

| layer | metrics | boundary | instrument |
| --- | --- | --- | --- |
| **time** | `latency` (ms) | `pointerdown → dom-predicate` (rAF-observed) | shared page driver |
| | `fcp`, `settled` (ms) | `view-attach → content` / `→ quiesce` | shared page driver |
| | `btsCpu`, `mtsCpu` (ms) | per-realm CPU during the op | CDP `Profiler` on the page and on the `lynx-bg` worker |
| **wire** | `wireUpMsgs/wireUpBytes` (MTS→BTS), `wireDownMsgs/wireDownBytes` (BTS→MTS), per-endpoint histogram | the real `MessageChannel` between web-core's UI realm and the background worker | `MessagePort.prototype` patch installed before web-core boots |
| **element pipeline** | source: synchronous self-time + call counts for `create / props / events / topology / read / flush`; derived: `outsidePapiTime` from aligned samples | dedicated pipeline page's `pointerdown → dom-predicate` capture | pre-boot interception of the ElementPAPI surface assignment; Web-only |
| **storm semantics** | source: operation time, pointer ticks, rAF-observable committed frames, CPU/wire totals; derived: contract outcome, coalescing ratio, bytes/messages per tick | first real pointerdown → terminal observed frame | dedicated `/storm` driver repeatedly issues standard actions; Web-only |
| **static** | `bundleWebRaw/Gzip`, `bundleLynxRaw/Gzip`, `mtsSectionGzip`, `btsSectionGzip` | — | bundle inspection (JSON-format bundles expose `lepusCode.root` = MTS and `manifest['/app-service.js']` = BTS; binary bundles report whole-bundle only) |

Why this is neutral: ReactLynx, Vue-Lynx (vdom/vapor), and Octane-on-Lynx all ride the same
`@lynx-js/web-worker-rpc` channel on Lynx for Web — every cross-thread message is an rpc
envelope `{name, data, …}`, so one page-side patch counts both directions for every framework,
tagged by endpoint (`publishEvent`, `callLepusMethod`, `markTiming`, …). Verified empirically:
a tap on a Vue-Lynx app shows `publicComponentEvent` (293 B up) and `callLepusMethod`
(724 B down) with no framework cooperation.

Byte counts are the UTF-8 length of a stable JSON serialization of the message (a structured-
clone-cost proxy; documented, and consistent across entries). Message counts and per-endpoint
splits are exact.

### Result schema

The flat-record shape of vue-lynx's `unified.json`, extended with harness and machine
dimensions. One record per (entry × workload × scale × metric):

```jsonc
{
  "schemaVersion": 2,
  "meta": { "generatedAt": "…", "machine": { "id": "…", "platform": "…", "cpuModel": "…",
             "cores": 0, "node": "…", "chromium": "…" },
           "calibration": { "score": 0, "probeVersion": 1 } },
  "records": [{
    "suite": "table" | "startup" | "pipeline" | "storm",
    "harness": "web" | "native",
    "environment": "lynx-for-web",       // e.g. lynx-for-web, lynx-native-<device>
    "entry": "vue-vdom",
    "workload": "update10th",
    "scale": 10000,
    "metric": "latency",
    "boundary": "pointerdown-to-dom-predicate",
    "unit": "ms",
    "n": 10, "median": 0, "mean": 0, "std": 0, "ci95": 0, "min": 0, "p95": 0,
    "samples": [],
    "detail": { /* metric-specific, e.g. wire per-endpoint histogram */ },
    "entryCommit": "…", "runId": "…"
  }]
}
```

**Comparability policy** (inherited): two records may be charted against each other only when
`harness`, `environment`, `workload`, `scale`, `metric`, `boundary`, and `unit` all agree.
The site enforces this structurally — the harness dimension is a top-level selector, never a
series in the same chart.

## Harnesses

### `web` (primary)

Headless Chromium via `playwright-core` (Chromium resolved from the Playwright cache or
`PLAYWRIGHT_CHROMIUM_PATH`). Per (entry × rep):

1. Static server serves `/webcore/*` (from `@lynx-js/web-core` `dist/client_prod`),
   `/bundles/<entry>/main.web.bundle`, and the harness page (with COOP/COEP headers so the
   rpc's `SharedArrayBuffer` sync path works).
2. Harness page installs (before web-core): the wire meter, `NEUTRALIZE_LYNX_PROFILE`
   (drops web-core's unbounded `lynx.profile:` performance marks — an artifact absent on
   native; applied identically to every entry), and the shared driver `globalThis.__x`.
3. Ops are driven by real Chromium input (`page.mouse.click` on geometry the driver reports);
   `t0` = in-page capture-phase `pointerdown`, `t1` = first rAF where the DOM predicate holds.
4. Around each op the runner snapshots the wire meter and (optionally, `--profile`) runs CDP
   `Profiler.start/stop` on both the page and the `lynx-bg` worker for `btsCpu`/`mtsCpu`.
5. The separate `/pipeline` page alone installs ElementPAPI wrappers. Its capture begins at the
   real pointerdown and freezes at the same shared DOM predicate; ordinary table/startup pages
   never execute the wrappers.
6. The separate `/storm` page alone installs the storm observer. The shared harness emits real
   pointer ticks against the standard update/select controls; no app-authored storm button or
   framework-specific hook participates.
7. Fresh page per rep; warmup reps discarded per methodology.

### `native` (Android Sandbox, explicitly separated)

The unified benchmark had no automated native harness (its "native" evidence was node
`--jitless` proxies, a jsdom PAPI oracle, and manual LynxExplorer observations). This repository
now runs real Native Engine bundles:

- every entry keeps its `main.lynx.bundle`;
- the schema carries `harness: "native"` end-to-end (runner flag `--harness native`, site
  selector, API);
- `packages/runner/adapters/lynx-sandbox-android.mjs` serves bundles over ADB reverse, opens a
  fresh LynxExplorer page/session, dispatches Native touch input, reads device-clock timing
  markers from the Runtime console, and reads startup pipeline entries from the Performance
  domain. Because Explorer DebugRouter accepts one USB connector, the adapter uses the official
  direct Android transport and multiplexes Runtime events, DOM requests, and input through one
  persistent CDP channel per page. It waits for device-side channel teardown and recycles Explorer
  on a configured cadence (five pages by default); every bundle load passes a thermal gate. The
  full transport, reconnect, lifecycle, render, timeout, thermal, and retry policy is versioned
  and included in campaign and machine identity. Explorer client discovery is repeated
  after every restart because DebugRouter may reassign the client port/ID.
  Featured Octane entries are Web-only because their current Native path lacks the same black-box
  producer boundary. The benchmark does not inject `flushTransport()` acknowledgements or a
  DevTool-only handler driver into an entry to manufacture Native eligibility;
- `packages/runner/src/harness-native.mjs` owns the framework-neutral adapter contract,
  workload matrix, retries, and DNF emission. It refuses to emit records marked `web`.

Native and web numbers are never mixed in one chart series; the site renders the harness as a
mode switch. A publishable Native campaign schedules five eligible entries in a 115-cell contract. Since
the honest per-cell timeout can exceed one Sandbox lease's capacity, a campaign may continue over
multiple official leases of the same physical device. Each acquisition supplies `serial`,
`issueId`, and `expiredAt`; the raw serial is equality-checked and replaced in metadata by its
SHA-256. A stable device cohort hashes that serial digest together with hardware/environment,
campaign, matrix, input, connector toolchain, and harness method, while the ordered lease chain
preserves every per-lease receipt. The reusable ADB serial or a lease ID alone is never sufficient
identity. Featured Octane and Lab variants are not scheduled on Native.

The CLI atomically checkpoints after every cell and stops before lease expiry with
`checkpointComplete: false`. `--resume` accepts only an incomplete v2 checkpoint, validates the
full immutable identity before adapter/device work, appends a strictly later same-serial receipt,
rejects overlapping cells and partially written startup metric pairs, and schedules only missing
keys. Every record key maps to the receipt that produced it. The pre-cell stop window is a derived
worst-cell envelope covering repetitions, thermal gating, page/session and workload timeouts, all
transport recovery/reconnect attempts, and cleanup; an environment override cannot lower it. The
collector can join split source checkpoints only under that same stable cohort, with no overlap,
when one ordered receipt chain is an exact prefix of the other. Same-serial forks are rejected, and
the published cohort identity and evidence use the longer chain's digest. Incomplete checkpoints
from older, non-resumable campaign protocols remain raw diagnostic files and are omitted from the
derived dataset entirely.
Octane's custom renderer does not expose the common Performance pipeline boundary in the tested
Explorer build. It therefore publishes no current Native metric; older private-protocol
observations remain historical appendix evidence only.

## Runs, incremental collection, calibration

The authoritative source/derived contract is specified in [DATA_MODEL.md](./DATA_MODEL.md).
In particular, raw run observations and entry artifacts are source; statistics, cohort selection,
calibration output, `latest.json`, and every site score/visual are derived.

- `bench run` writes one **run file** `results/runs/<iso>-<machineId>.json`. Web supports focused
  subsets; publishable Native runs require the full matrix. Machine fingerprint + calibration
  score are embedded. Native files are atomically rewritten after every completed cell; the
  `meta.checkpoint` marker, `checkpointComplete`, stable device cohort, ordered lease chain,
  per-cell lease attribution, and 115-cell coverage ledger identify this resumable format.
- `bench preflight` (also auto-run before `run`) executes a fixed, versioned CPU probe in the
  same headless Chromium (seeded JSON churn + array/alloc mix, ~1 s) → `calibration.score`.
  Probe version bumps invalidate comparisons.
- `bench collect` merges `results/runs/*.json` → `results/latest.json`: newest record wins per
  (harness, environment, entry, workload, scale, metric, machineId); cross-machine records
  coexist, each carrying its own source run and calibration. Separately, the collector chooses
  one coherent physical run for the weighted Web comparison (featured-entry coverage, then featured
  matrix coverage, then newest). Dedicated pipeline/storm views may attach the best coherent
  current campaign for each exact contract, while remaining outside the weighted matrix. Native comparison records require one complete current-commit
  campaign with identical stable-device/method/matrix/input/connector identity and an explicit
  valid same-serial lease chain. Partial reruns and
  historical Lab variants therefore cannot replace the public ranking. A current featured Native
  entry absent from that cohort may be exposed separately from one unmerged source run as an
  absolute observation; it never enters rankings, ratios, heatmaps, or geomeans. For opt-in Lab
  mode, the collector chooses one complete source run per entry and emits `labComparisonRecords`:
  `ms` fields are scaled by source-score / comparison-score and marked `calibrated-estimate`;
  heap, wire, bundle, and count fields remain `historical`. Calibration cannot correct memory
  hierarchy or core-count differences.
- Web hypothesis mode: `bench run --entry vue-vapor --case select --scale 10000 --reps 20`
  gives a focused, high-N answer; Native diagnostics use a separate non-publishable tool.

## Statistics

Per sample set: median (headline), mean, std, min, p95, ci95 (t-distribution for small n,
following octane's `stats.mjs` discipline), raw samples retained in run files. Seeded PRNG for
row data. GC (`--js-flags=--expose-gc` + `window.gc()`) before timed samples where available.
DNF is recorded as a first-class value (`n`, `dnfCount`), never silently dropped — a slow
framework that times out must look slow, not absent; an *instrument* failure (predicate never
matched for shape reasons) is a run error, not a DNF.

## Website (`site/`)

React 19 + Vite + TypeScript. Two chart systems:

- **Ranked bars / geomean grid** (octanejs.dev-style, hand-rolled divs + CSS): suite cards
  with framework pills, per-op chips, ×-vs-baseline ranked bars, all-suites heatmap with
  `vs baseline` / `vs fastest` re-baselining, log-scaled diverging tint, collapsible exact-
  number tables. Baseline = ReactLynx (the ecosystem incumbent), toggleable.
- **Observable Plot** for the analytical pages: scale-trend lines (linear + log-log with
  fitted scaling exponents α), cost-space scatter (MTS gzip vs FCP), stacked
  BTS/MTS/uncounted time bars, wire bytes/messages charts.

Pages:
1. **Overview** — for-everyone readable; harness selector; suite cards.
2. **Scale** — the unified-matrix lineage: FCP/latency vs N (1k–30k), per entry.
3. **Threads** (advanced) — the Lynx-specific story: per-op wire bytes/messages by direction,
   per-endpoint breakdown, BTS vs MTS CPU split, bundle MTS/BTS section sizes.
4. **Method** — methodology, machines, calibration table, comparability audit.

Before every dev/build, the collector regenerates `results/latest.json` from run observations and
current entry artifacts. The site then imports that materialized view plus automatically discovered
`entries/*/entry.json` manifests, so stale collected statistics cannot publish.

## Non-goals (v1)

- No single aggregate score across suites (the unified benchmark's audit explicitly rejects
  one; we follow).
- No cross-machine absolute-ms claims without the estimated badge.
- Native device coverage currently represents one Android 10 Lynx Sandbox/LynxExplorer cohort;
  it is not a claim about every Android or iOS device class.
