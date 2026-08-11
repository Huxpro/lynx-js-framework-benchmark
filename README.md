# Lynx JS Framework Benchmark

A neutral, extensible benchmark infrastructure for JS frameworks on [Lynx](https://lynxjs.org)
— built to **evaluate** (fair, reproducible comparisons) and to **explain** (the dual-thread
wiring that changes every equation on Lynx: background-thread vs main-thread time, and the
bytes that cross between them).

**Entries today:** ReactLynx · Vue-Lynx VDOM (baseline & +IFR+ET) · Vue-Lynx Vapor (baseline
& +IFR) · Octane (main, Hux1, and Hux2 checkpoints). Adding a framework, a version, or a
config is one directory.

## Quick start

```bash
pnpm install
pnpm bench run            # full matrix → results/runs/<stamp>-<machine>.json
pnpm bench collect        # merge runs → results/latest.json
pnpm site:dev             # the results site (imports results/latest.json at build time)
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

Every `run` writes an independent run file stamped with a machine fingerprint and a
**preflight calibration score** (a fixed CPU probe in the same browser); `collect` merges any
number of run files — from any machines — into `results/latest.json`, newest-per-cell,
per-machine. Comparisons are always within one machine's run; calibration relates
cross-machine numbers as labeled estimates.

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
  (`--harness native`), and site carry the dimension end to end. No automated device adapter
  is wired yet — the adapter contract lives in `packages/runner/src/harness-native.mjs`.
  Native and web numbers are never mixed in one chart.

## Adding an entry

```
entries/<id>/
  entry.json        # label, framework, config, provenance (+ sha256), bundle paths
  dist/rows-<n>/    # main.web.bundle (+ main.lynx.bundle), n ∈ {0, 1000, 10000, 30000}
```

Nothing else changes — the runner and site discover entries by scanning `entries/*/entry.json`.

**Tiers.** `"tier": "featured"` entries form the default public view; `"tier": "lab"` entries
(versions, PRs, flag permutations — as many as you like) stay hidden until the site's **⚗ Lab**
mode. Any comparison subset is addressable:
`/?entries=octane-main,octane&lab=1` — so a framework author can benchmark 8 PRs
(`pnpm bench run --entry my-pr-entry` each, `collect` merges) and share exact-permutation
links, while the public page stays curated.
Bundles are vendored with provenance (source repo, commit, build command, checksums);
`scripts/vendor-entries.mjs` rebuilds the original framework matrix and
`pnpm vendor:octane-checkpoints` vendors the exact B0/P2/P3/P6/P7 checkouts from the Octane
Hux2 stack. The app must
speak the shared workload contract (`packages/shared/src/workloads.mjs`): same buttons, same
class structure, same storm semantics.

## Repository layout

```
packages/shared/    workload contract, page driver, wire instrument, stats, schema
packages/runner/    lynx-bench CLI: run / collect / preflight / list; web + native harnesses
entries/            one directory per framework×config, vendored bundles + provenance
results/            runs/ (one file per invocation) + latest.json (collected)
site/               the results site (React + Vite + Observable Plot)
docs/               DESIGN.md, METHODOLOGY.md
```

## Lineage

This infra unifies the vue-lynx *unified benchmark* (`packages/benchmark` + `ifr-bench`),
the measurement discipline of [octane's benchmarks](https://github.com/octanejs/octane), and
the cross-framework driver contract from octane's lynx-table PR — replacing their
framework-specific instrumentation with the neutral wire/CPU instruments above.

## License

Apache-2.0
