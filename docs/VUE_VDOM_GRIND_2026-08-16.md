# Vue Lynx VDOM grind — 2026-08-16

This campaign applies the Octane grind method to Vue Lynx VDOM: establish one
vendored base, change one mechanism at a time, measure candidate-first and
candidate-last on the same host, retain raw runs, and only claim deltas that
survive both orders. Web and Native numbers are separate cohorts.

## Accepted review units

| Unit | Source commit | Stable result | Cost / non-claim |
|---|---|---|---|
| Shared empty class state | `710e649` (`7b32377` with changeset) | Web `heapBts@10k` 53.90 → 47.82 MB (**-11.3%**) in both orders; Web create10k BTS CPU **-5.8% / -4.2%**; Native create1k latency **-5.1% / -4.5%**, create10k **-1.4% / -1.1%** | Web/Lynx gzip **+0.2%**; no stable FCP, MTS heap, wire, or interaction-latency claim |
| Shared empty style state, stacked on class | `b2c8cd4` | Incremental Web `heapBts@10k` 47.82 → 46.70/46.69 MB (**-2.3% / -2.4%**); combined class+style vs base is about **-13.4%** | Web/Lynx gzip **+0.2%** incremental; latency and CPU changed sign across order, so no speed claim |
| Deferred removed-subtree teardown | `67577d7` | Web `heapBtsAfterClear@10k` 6.32 → 1.16/1.17 MB (**-81.6% / -81.5%**) | This is a memory-correctness trade: clear10k latency **+12.9% / +5.7%**, BTS CPU **+66.2% / +16.2%**. Keep separate from speed PRs |

The class result was also checked on an Aries Android sandbox with five Native
repetitions per order. Native clear remains unsupported by the adapter and is
recorded as DNF rather than inferred from Web.

## Benchmark support units

- Vue benchmark startup bundles validate `BENCH_AUTOROWS`, use identical
  deterministic seeded rows in Vue and React, and emit Native interactive
  timing markers after the second Lynx frame (`b81e26a`, `478868d`). Web keeps
  its existing MessageChannel path and black-box measurement behavior.
- The runner records post-clear heap in both realms and applies an explicit
  Native `--scale` filter to startup as well as table workloads (`78af9cc`).

## Candidate ledger

| Candidate | Observed signal | Verdict |
|---|---|---|
| REMOVE_MANY wire coalescing | clear10k wire bytes **-41.6%** | Reject: latency/CPU changed sign by order; current protocol compatibility and full-buffer scan are not reviewable |
| IFR+ET CSS-ID batching | Native create1k **+1.1%**, create10k **+0.7%** | Reject: no benefit |
| IFR+ET sparse index | No repeatable VDOM IFR+ET improvement | Reject for this stack |
| Fixed/spread emitters | Micro signal did not survive real-app A/B | Reject |
| Lazy combined auxiliary state | Class component survived independently; other combined deltas did not | Split and keep only class/style units above |
| Unique-ID selector upper bound | No-op selector attributes suggested create1k **-17.1%**, create10k **-20.5%**, append **-13.2%**, heap **-38.1%** | Follow-up only: needs a real Native unique-ID acknowledgement protocol and legacy fallback |

## Metric coverage

The Web campaign exercised create (1k/10k), replace, append1k, update10th,
select, swap, remove, clear10k, update/select storms, startup (0/1k/10k/30k),
BTS/MTS CPU, BTS/MTS heap, post-clear heap, both wire directions, and raw/gzip
bundle size. Native exercised supported create and append workloads at 1k/10k;
unsupported startup/clear paths are DNF, not zero.

## Raw evidence

- Class Web A/B: `2026-08-16T08-45-29-65160668d8d9-vue-vdom-lazy-class-ab.json`
- Class Web B/A: `2026-08-16T08-49-23-65160668d8d9-vue-vdom-lazy-class-ab-forward.json`
- Class Native A/B and B/A: `2026-08-16T09-47-25-lynx-native-android-aries_10-10-787948fbcb16-native-native-vue-vdom-lazy-class-ab.json`, `2026-08-16T09-52-39-lynx-native-android-aries_10-10-787948fbcb16-native-native-vue-vdom-lazy-class-ab-reverse.json`
- Style incremental A/B and B/A: `2026-08-16T10-16-19-65160668d8d9-vue-vdom-lazy-style-incremental-ab.json`, `2026-08-16T10-23-26-65160668d8d9-vue-vdom-lazy-style-incremental-ab-reverse.json`
- Teardown Web A/B and B/A: `2026-08-16T10-36-53-65160668d8d9-vue-vdom-event-prop-teardown-reviewed-ab.json`, `2026-08-16T10-41-14-65160668d8d9-vue-vdom-event-prop-teardown-reviewed-ab-reverse.json`

All files are under `results/runs/`. Order-control entries use the same bundle
bytes under a `z-` ID so alphabetical discovery genuinely reverses execution.
