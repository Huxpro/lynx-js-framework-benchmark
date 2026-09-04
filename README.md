# Lynx JS Framework Benchmark

A neutral, extensible benchmark infrastructure for JS frameworks on [Lynx](https://lynxjs.org)
— built to **evaluate** (fair, reproducible comparisons) and to **explain** (the dual-thread
wiring that changes every equation on Lynx: background-thread vs main-thread time, and the
bytes that cross between them).

The source/derived boundary is strict: run files retain observations, entry manifests and bundles
retain build provenance, and every statistic, score, cohort, and visualization is recalculated.
See [docs/DATA_MODEL.md](./docs/DATA_MODEL.md).

**Entries today:** ReactLynx · Vue-Lynx VDOM (baseline & +IFR+ET) · Vue-Lynx Vapor (baseline
& +IFR) · Octane. Adding a framework, a version, or a config is one directory.

## Quick start

```bash
pnpm install
pnpm bench run            # Web table + startup + pipeline + storm → results/runs/<stamp>-<machine>.json
pnpm bench collect        # explicitly regenerate the derived results/latest.json cache
pnpm site:dev             # regenerates the cache, then starts the results site
```

Web runs default to the historical V8 JIT / unthrottled regime. The directional interpreter
probes are explicit and remain Web-only:

```bash
pnpm bench run --harness web --jit=interp --cpu-throttle=1 --label web-interp
pnpm bench run --harness web --jit=interp --cpu-throttle=4 \
  --throttle-scope=process-cgroup --label web-interp-4x
```

`Interp 4×` always means the whole-process calibration lane. It starts Chromium inside an
inherited CPU cgroup: writable
cgroup-v2 `cpu.max` when delegated, or cgroup-v1 `cgexec` with non-interactive `sudo` on the lab
runner. It never chases renderer PIDs with `cpulimit`. Before every entry, three in-page probes use
their median score to verify a 3.5–4.5× slowdown; the observed `verifiedSlowdown` is written into
every record. The former page-target CDP lane is frozen as historical source evidence; the CLI
rejects new `--throttle-scope=page-cdp` runs.

`--startup-scale=0,1000,10000` is the budget fallback for dropping only the 30k startup cell;
the default remains `0,1000,10000,30000`.

Requires Node ≥ 20 and a Chromium (auto-resolved from the Playwright cache, or
`npx playwright install chromium`, or `PLAYWRIGHT_CHROMIUM_PATH`).
The interpreter lanes disable TurboFan, Sparkplug, and Maglev while retaining compiled Wasm.
Before a formal interpreter run, the runner uses a one-off `--allow-natives-syntax` control to
prove a hot function stays never-optimized in Ignition and Wasm still instantiates. The measured
browser never receives that diagnostic flag.

For a leased Lynx Sandbox Android device:

```bash
# Make the device-only @byted/agent-lynx@0.14.4 package resolvable from packages/runner using the ByteDance
# registry in the Native runner environment first.
LYNX_SANDBOX_SERIAL='<leased-adb-serial>' \
LYNX_SANDBOX_LEASE_RECEIPT='<json-or-path-containing-serial-issueId-expiredAt>' \
pnpm bench run \
  --harness native \
  --adapter packages/runner/adapters/lynx-sandbox-android.mjs
```

Native has no partial publish mode: omitting entry/case/scale flags runs all six Native-eligible
featured entries, 15 table cells per entry, and two startup metrics at 0/1k/10k/30k (138 contract cells total; five
table and three startup repetitions). Partial probes cannot enter the published cohort.

The adapter serves the selected local `main.lynx.bundle` through ADB reverse, opens it in
LynxExplorer, drives the Native benchmark through Lynx DevTool, and records device-clock timings.
It defaults to the connector's direct Android transport and carries Runtime events, DOM queries,
and input over one persistent CDP channel. Explorer's DebugRouter accepts one USB connector; using
a long-lived console stream plus separate command connections makes the device replace its own
client and surfaces as `No response found`. The adapter starts a clean Explorer, serializes that
channel, waits 100 ms for device-side router teardown between pages, and recycles Explorer after
the configured number of pages (five by default). Transport mode and recycle cadence are part of the environment identity, so runs
with different lifecycle policies cannot be merged.
Every Native-eligible featured entry uses real Native touch input and the versioned
`input-handler-to-native-dom-predicate-plus-two-frames` settlement contract. The instrumented
input handler supplies only the device-clock start receipt; the shared Sandbox adapter then
observes the workload-specific Native element-tree predicate and ends after two further Native
frames. Ranked table latency never waits for a framework-specific transport/commit
acknowledgement. The Hux Octane benchmark producer marks its transport acknowledgement
`excluded-from-latency`, matching React and Vue's ranked endpoint. Legacy Octane v2 samples that
did wait for `root.flushTransport()` remain visible as absolute descriptive evidence, but are
marked not comparable and cannot enter a ratio, baseline, score, or ranking. A DevTool driver
exists only for unmeasured Octane prestate preparation; ranked actions still begin at the input
handler and finish at the externally observed Native tree. This is an instrumented black-box
renderer observation, not a framework-unmodified claim. A strict producer payload failure is
retained as an evidenced
`producer-protocol-invalid` DNF for that cell; its evidence explicitly records validation as
`attempted: true, passed: false`, never invents a timing value, and never aborts unrelated cells.
Release the Sandbox lease after the command completes.
`LYNX_SANDBOX_TIMEOUT_MS` overrides the 30-second control timeout and
`LYNX_SANDBOX_LONG_TIMEOUT_MS` overrides the 240-second workload/startup timeout.
`LYNX_SANDBOX_TRANSIENT_ATTEMPTS` controls the bounded number of transport attempts (three by
default; one records the first transport failure as DNF without a recovery retry). Exhausted
page/session-start failures, including `Runtime.enable`, are scoped to the first pending table cell
or complete startup metric pair and do not mark the entry unsupported. They retain structured
`transport-retries-exhausted` evidence and never invent startup timing values.
`LYNX_SANDBOX_DEVTOOL_TRANSPORT` can opt back into `daemon` for diagnostics; formal runs use
`direct`. `LYNX_SANDBOX_RECYCLE_EVERY_PAGES` and `LYNX_SANDBOX_ROUTER_SETTLE_MS` are explicit
lifecycle controls whose chosen values are retained in run metadata. Formal runs also wait for
Android thermal status 0 and battery temperature at or below 40 °C before every bundle load
(`LYNX_SANDBOX_MAX_BATTERY_TEMP_C` overrides the ceiling). A hash of these
lifecycle/reconnect/render/thermal/input/timeout/retry settings is hashed into campaign and machine
identities, preventing
differently configured runs from joining one Native cohort.
`LYNX_SANDBOX_LEASE_RECEIPT` (or `--lease-receipt`) is mandatory. It accepts JSON directly or a
JSON-file path and must contain the exact acquired `serial`, traceable `issueId`, and lease API
`expiredAt` epoch milliseconds. The raw serial is checked against `LYNX_SANDBOX_SERIAL` and then
discarded; only its SHA-256 is persisted. Before each cell the runner derives a worst-cell expiry
envelope from the formal repetition count, thermal-gate timeout, page/session and long-workload
timeouts, every configured transport attempt and reconnect window, plus a cleanup margin.
`LYNX_SANDBOX_LEASE_STOP_SAFETY_MS` may increase that envelope but a lower value is rejected. The
runner stops before the resulting boundary, writes `checkpointComplete: false`, and exits cleanly.
Continue only on
a newly acquired official lease for the same physical serial:

```bash
LYNX_SANDBOX_SERIAL='<same-leased-adb-serial>' \
LYNX_SANDBOX_LEASE_RECEIPT='<new-json-or-path>' \
pnpm bench run --harness native \
  --adapter packages/runner/adapters/lynx-sandbox-android.mjs \
  --resume results/runs/<incomplete-checkpoint>.json
```

Resume validates the exact campaign, 138-cell matrix, immutable input and connector receipts,
hardware/environment, method policy, and stable device cohort before device work. It appends the
new structured receipt to an ordered lease chain, skips existing unique cell keys, rejects partial
startup metric pairs and overlaps, and checkpoints atomically after every new cell. Different
serial hashes, hardware, toolchains, methods, or campaign inputs can never be merged.
If a correctness fix must land after an incomplete checkpoint, normal resume remains fail-closed.
One explicitly approved source-only transition may be named with `--method-revision` and its exact
`--method-revision-input-sha256`. The checkpoint retains the original campaign/input receipt, adds
a hashed prefix-ordered method-revision chain containing both full source receipts, and attributes
every cell to the revision that produced it. Bundles, manifests, entry commits, connector trees,
matrix, runtime policy, hardware, and device cohort cannot change; missing, forked, or unknown
revision evidence keeps the entire Native cohort archive-only.

`@byted/agent-lynx` is intentionally not part of the public workspace lockfile because one of its
connector dependencies is unavailable from the public npm registry used by GitHub Actions and the
results-site deployment. Install it only in the Native runner environment. Web benchmarking,
tests, and site builds need no private registry credentials; the Native adapter validates the
device-only dependency when selected.

### Incremental / hypothesis runs

```bash
pnpm bench run --entry vue-vapor --case select --scale 10000 --reps 20   # one cell, high N
pnpm bench run --quick                                                   # fast full sweep
pnpm bench run --suite startup                                           # one suite
pnpm bench run --suite pipeline --case select --scale 1000 --reps 20     # host-boundary attribution
pnpm bench run --suite storm --case selectStorm --commit final-state      # neutral coalescing contract
pnpm bench list                                                          # entries & cases
pnpm bench list-coverage                                                 # versioned list-fixture capability ledger
pnpm bench preflight                                                     # machine calibration only
```

Every `run` writes an independent source run file stamped with a machine fingerprint and
**preflight calibration score** (a fixed CPU probe in the same browser); `collect` merges any
number of run files — from any machines — into `results/latest.json`, newest-per-cell,
per-machine, with source-run calibration attached to every record. The weighted charts use the
single run with the broadest **featured-entry** coverage (then featured matrix coverage), so
Lab-heavy, partial, or cross-machine runs cannot replace the public ranking. Dedicated pipeline
and storm views additionally attach one coherent current campaign per exact contract; those
records cannot enter the weighted score. Opt-in Lab entries use one complete historical run per entry; millisecond fields
are scaled by source-score / comparison-score and marked as estimates. Non-time fields remain
explicitly historical because the CPU probe cannot calibrate them.
`run` refreshes the derived cache immediately; site dev/build refresh it again before loading.
Native runs atomically checkpoint the source file after every completed cell. If a lease approaches
expiry or DevTool transport is exhausted later in a run, already completed cells remain
reproducible instead of being lost with the process. Each cell names the lease that produced it,
and every receipt remains in the ordered chain. Split checkpoints combine only when one receipt
chain is an exact prefix of the other; same-serial forks remain archive-only. Known transport exhaustion and producer-protocol
failures are retained as structured DNF evidence; unknown adapter/programming errors still abort.
Each checkpoint carries a `native-featured-instrumented-matrix-v4` coverage ledger. It distinguishes measured,
measured-with-DNF, DNF, capability-proven unsupported, unscheduled, incompatible cohort, and
display/derivation defects. A completed campaign may contain measured, DNF, or proven unsupported
cells, but never an unscheduled or invalid cell. Bundles are served from immutable byte snapshots;
source, manifest, patch, and bundle receipts are rechecked before completion.

## What is measured

| layer | metrics | how |
| --- | --- | --- |
| time | Web `latency`/`fcp`/`settled`; Native `latency` and pipeline startup where available | real input; harness-specific boundaries are stored on every record |
| element pipeline | Web-only synchronous ElementPAPI segment self-time/calls + outside-PAPI residual | dedicated capture page; raw tree/call controls gate derived comparisons; Native is unsupported |
| storm semantics | Web-only elapsed time, observable frames/ticks, contract outcome, wire bytes/tick | dedicated shared-driver page; every-tick failure is descriptive data, final-state permits coalescing |
| list virtualization | startup, one-viewport recycle, fixed-velocity fling; raw counts/times/wire plus derived per-cell rates | separate declarative `list`/`list-item` fixture; Web and Native observers are isolated; absent fixtures are unsupported |
| staging Pareto | exact scale- and regime-matched artifact/MTS gzip × startup FCP median and CI | collector-derived static artifact records + one FCP regime (Web JIT 1× by default); lower-left frontier only, never a score |
| dual-thread | `btsCpu` / `mtsCpu` | CDP sampling profiler attached per realm (page + `lynx-bg` worker) |
| wire | messages & bytes **both directions**, per rpc endpoint | `MessagePort` patch over web-core's BTS↔MTS channel — one instrument for every framework |
| static | bundle raw/gzip, MTS/BTS section split | bundle inspection |

Cases: the krausest superset (`create` 1k/3k/5k/10k/20k/30k, `replace`, `append1k`,
`update10th`, standard preselected-row `select`, `swap`, `remove`, standard `clear@1k`
plus `clear@10k`) + shared-driver Web storms (50 update / 30 select pointer ticks,
both every-tick and final-state policies) at 1k/10k + the separately versioned Native matrix +
startup at 0/1k/10k/30k pre-rendered rows. Hux Octane Native exposes isolated transport-ACK and
post-ACK-frame startup metrics because its custom renderer publishes no pipeline FCP entry; these
are never ranked as FCP. See
[docs/METHODOLOGY.md](docs/METHODOLOGY.md) for the measurement rules and
[docs/DESIGN.md](docs/DESIGN.md) for the architecture.

The staging Pareto view joins each startup scale only to its exact `rows-N` artifact. The total
axis uses `main.web.bundle` or `main.lynx.bundle` according to the selected harness. The MTS axis
appears only when a bundle exposes a readable `lepusCode.root`; binary bundles remain explicitly
unavailable rather than inheriting whole-artifact bytes. Historical checkpoints without the exact
then-current per-scale artifact bytes do not borrow today's manifest: the view is retroactive only
where those bytes were retained. Each frontier uses one FCP regime only; Web is fixed to JIT at 1×
by default, and interpreter/CPU-throttled lanes are never silently pooled. On the next Octane bundle
refresh, vendor genuine per-scale builds rather than copying one post-rows-0 artifact across scales,
so N-growing code staging becomes observable without inventing historical provenance.

## Harnesses

- **`web` (primary):** headless Chromium running Lynx for Web. Everything above.
- **`native`:** real `main.lynx.bundle` execution in LynxExplorer. The checked-in Sandbox
  adapter uses Lynx DevTool for page/session, input, Runtime console, and Performance domains;
  entry discovery, workload sequencing, retry, and DNF accounting remain in the shared Native
  harness. Native and Web numbers are never mixed in one chart. The published featured cohort
  uses ReactLynx, four Vue-Lynx configs, upstream Octane, and the PR #791 Octane snapshot.
  The dated block-core `new-lynx` snapshot is explicitly Web-only; Octane Lab variants are not
  run on Native.

## Adding an entry

```
entries/<id>/
  entry.json        # label, framework, provenance, eager bundles; optional versioned listFixture
  dist/rows-<n>/    # main.web.bundle (+ main.lynx.bundle), n ∈ {0, 1000, 10000, 30000}
```

Nothing else changes — the runner and site discover entries by scanning `entries/*/entry.json`.

**Tiers.** `"tier": "featured"` entries form the default public view; `"tier": "lab"` entries
(versions, prior releases, PRs, flag permutations) stay hidden until the site's **⚗ Lab** mode.
Historical Lab entries can remain calibration-only instead of being rerun: time fields are shown
as `≈ calibrated`, while heap/wire/bundle/count fields retain their historical label. Any subset
is addressable, for example `/?entries=octane,octane-prior,octane-hux1,octane-hux2&lab=1`.
Bundles are vendored with provenance (source repo, commit, build command, checksums);
`scripts/vendor-entries.mjs` rebuilds them from checkouts of the source repos. The app must
speak the shared workload contract (`packages/shared/src/workloads.mjs`): same buttons, same
class structure, same storm semantics. List measurements additionally require an independent
`listFixture` manifest declaration whose bundle implements the exact contract hash from
`packages/shared/src/list-workloads.mjs`; eager table bundles are never accepted as a substitute.

**Dataset Time Machine.** The slider is a short editorial list of meaningful checkpoints, not an
Octane-commit timeline. Every checkpoint links each framework identity to its recorded commit or
version; Octane normally points to upstream HEAD at measurement time, while Hux1/Hux2 and dated
`new-lynx` entries are preserved as Huxpro branch-head attempts. Checkpoints publish only complete
shared matrices. Vue +IFR pointers also expose and link the exact `pluginVueLynx` options.

The dated `Octane (new-YYYY-MM-DD)` entry is featured, not Lab. It freezes
`Huxpro/octane:new-lynx`, reads only upstream `dist-block[-rowsN]` bundles produced with
`pluginOctane({ core: 'block' })`, and joins Web rankings only through a complete same-run featured
cohort. Its one-file workload patch serializes storm commits so the neutral 50/30-publication
contract remains true for the Block core. See
[the dated block-core campaign](docs/NEW_LYNX_SNAPSHOT_CAMPAIGN.md).

## Repository layout

```
packages/shared/    workload contract, page driver, wire instrument, stats, schema
packages/runner/    lynx-bench CLI: run / collect / preflight / list; web + native harnesses
entries/            one directory per framework×config, vendored bundles + provenance
results/            runs/ (one file per invocation) + latest.json (collected)
site/               the results site (React + Vite + Observable Plot)
docs/               DESIGN.md, METHODOLOGY.md, DATA_MODEL.md
```

## Lineage

This infra unifies the vue-lynx *unified benchmark* (`packages/benchmark` + `ifr-bench`),
the measurement discipline of [octane's benchmarks](https://github.com/octanejs/octane), and
the cross-framework driver contract from octane's lynx-table PR — replacing their
framework-specific instrumentation with the neutral wire/CPU instruments above.

## License

Apache-2.0
