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
pnpm bench run            # full matrix → results/runs/<stamp>-<machine>.json
pnpm bench collect        # explicitly regenerate the derived results/latest.json cache
pnpm site:dev             # regenerates the cache, then starts the results site
```

Requires Node ≥ 20 and a Chromium (auto-resolved from the Playwright cache, or
`npx playwright install chromium`, or `PLAYWRIGHT_CHROMIUM_PATH`).

### Incremental / hypothesis runs

```bash
pnpm bench run --entry vue-vapor --case select --scale 10000 --reps 20   # one cell, high N
pnpm bench run --quick                                                   # fast full sweep
pnpm bench run --suite startup                                           # one suite
pnpm bench list                                                          # entries & cases
pnpm bench preflight                                                     # machine calibration only
```

Every `run` writes an independent source run file stamped with a machine fingerprint and
**preflight calibration score** (a fixed CPU probe in the same browser); `collect` merges any
number of run files — from any machines — into `results/latest.json`, newest-per-cell,
per-machine, with source-run calibration attached to every record. Charts use
`comparisonRecords`, selected from the single run with the broadest **featured-entry** coverage
(then featured matrix coverage), so Lab-heavy, partial, or cross-machine runs cannot replace the
public ranking. Opt-in Lab entries use one complete historical run per entry; millisecond fields
are scaled by source-score / comparison-score and marked as estimates. Non-time fields remain
explicitly historical because the CPU probe cannot calibrate them.
`run` refreshes the derived cache immediately; site dev/build refresh it again before loading.

## What is measured

| layer | metrics | how |
| --- | --- | --- |
| time | `latency` (tap → DOM predicate), `fcp`/`settled` (startup at N rows) | real Chromium input; rAF-polled composed-DOM predicates |
| dual-thread | `btsCpu` / `mtsCpu` | CDP sampling profiler attached per realm (page + `lynx-bg` worker) |
| wire | messages & bytes **both directions**, per rpc endpoint | `MessagePort` patch over web-core's BTS↔MTS channel — one instrument for every framework |
| static | bundle raw/gzip, MTS/BTS section split | bundle inspection |

Cases: the krausest superset (`create` 1k/10k, `append1k`, `update10th`, `select`, `swap`,
`remove`, `clear`) + storms (50 update / 30 select sequential ticks) at 1k–30k scales +
startup FCP at 0/1k/10k/30k pre-rendered rows. See
[docs/METHODOLOGY.md](docs/METHODOLOGY.md) for the measurement rules and
[docs/DESIGN.md](docs/DESIGN.md) for the architecture.

## Harnesses

- **`web` (primary):** headless Chromium running Lynx for Web. Everything above.
- **`native` (preserved):** every entry ships `main.lynx.bundle`; the schema, runner flag
  (`--harness native --adapter <module.mjs>`), and site carry the dimension end to end. The
  runner side is executable — entry discovery, workload sequencing, DNF accounting, and
  native-record emission live in `packages/runner/src/harness-native.mjs` behind a validated
  adapter contract — and a device adapter (lynx-devtool CDP, agent-device, …) plugs in as a
  module; no proxy adapter ships in this repo. Native and web numbers are never mixed in one
  chart.

## Adding an entry

```
entries/<id>/
  entry.json        # label, framework, config, provenance (+ sha256), bundle paths
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
class structure, same storm semantics.

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
