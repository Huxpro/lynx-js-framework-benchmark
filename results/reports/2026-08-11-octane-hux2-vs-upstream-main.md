# Octane Hux2 vs live upstream main

> Historical baseline comparison. Its preliminary P6→P1 landing order is superseded by `2026-08-11-octane-upstream-residual-audit.md`, which reruns every live-upstream residual and concludes that no current product candidate passes the final gate.

Primary run: `results/runs/2026-08-11T06-27-46-65160668d8d9-octane-hux2-vs-upstream-main.json` · SHA-256 `c1ebbb47aa08b4275a0b5d97ce2687f785f5996b23b71b1017c175e337b50b67`
Reverse adverse rerun: `results/runs/2026-08-11T06-39-01-65160668d8d9-octane-upstream-adverse-reverse.json` · SHA-256 `1e45a48d00bc6d5b0e404246db1e871bab0e96d01a7c35444562becf583ba446`
Reverse startup rerun: `results/runs/2026-08-11T06-48-07-65160668d8d9-octane-upstream-startup0-reverse.json` · SHA-256 `359831971ccd3cc5e95e76eb45498e73f22f94416cb8bd0e22a675a748e352cc`

## Verdict

- Live upstream main is faster in **15/18 interaction latency cells**, 14/18 BTS CPU cells, and 15/18 MTS CPU cells.
- create@1k: 261.4 → 152.8 ms (-41.5%).
- create@10k: 2604.1 → 2058.7 ms (-20.9%).
- create@30k: 7960.1 → 6032.2 ms (-24.2%).
- Therefore the old P3/P4/P5/P7 implementation should not be replayed upstream: #693/#700 already replace that architecture and outperform the final Hux2 tip on its primary large-materialization cells.
- The comparison is not all-green. Expanded reverse-order runs confirm clear@10k, update storm@30k, startup@0, and bundle gzip as remaining upstream costs; select@1k is a small overlapping-CI adverse cell.
- Audit: 438 records across three same-machine runs, zero DNF/null medians, 16 bundle checksums, exact clean source SHAs.

## Provenance

| Entry | Exact commit | App tree | Lockfile SHA-256 | Patched |
| --- | --- | --- | --- | --- |
| Hux2 / P7 | `ff7d2c71c2296b7936f17c809e46637a18963338` | `7de49ecb635b8bcf7b9498a20d7c191db65a23fc` | `9bfa66384d7cd40cb59b589c777f176cc5f8dc6a3f17a865039e902402bea226` | false |
| Live upstream main | `9b147781c9b4ec4df053a059633978ddc0ed922a` | `40fc02e0febf0572512291f755e96869985af725` | `47137830d3f76e5a87be45044717ec5360f2f11880e3f8a8de83cb9b1d01db28` | false |

| Run | Entry order | Samples | Calibration | Machine |
| --- | --- | --- | ---: | --- |
| Primary | Hux2 → upstream | ordinary 7, storms 3, startup 5 | 2298.8 | `65160668d8d9` |
| Adverse repeat | upstream → Hux2 | ordinary 15, storm 9 | 2281.8 | `65160668d8d9` |
| Startup repeat | upstream → Hux2 | startup 15 | 2312.5 | `65160668d8d9` |

The app trees differ because live upstream changed the benchmark together with the renderer. Both entries implement the same neutral workload/DOM contract and were driven by the same runner boundaries; neither source was patched.

## Primary interaction latency

| Workload | Scale | Hux2 ms (CI95) | Upstream ms (CI95) | Delta |
| --- | ---: | ---: | ---: | ---: |
| create | 1,000 | 261.4 ±6.6 | 152.8 ±7.5 | -41.5% |
| create | 10,000 | 2604.1 ±127.8 | 2058.7 ±158.3 | -20.9% |
| create | 30,000 | 7960.1 ±448.1 | 6032.2 ±180.6 | -24.2% |
| replace | 1,000 | 309.7 ±251.4 | 264.2 ±218.7 | -14.7% |
| append1k | 1,000 | 271.7 ±12.1 | 164.1 ±5.9 | -39.6% |
| update10th | 1,000 | 26.2 ±5.7 | 18.9 ±5.3 | -27.6% |
| update10th | 10,000 | 203.1 ±7.3 | 138.3 ±26.2 | -31.9% |
| select | 1,000 | 16.8 ±4.5 | 22.0 ±2.8 | +30.8% |
| select | 10,000 | 75.8 ±5.2 | 46.1 ±7.8 | -39.2% |
| swap | 1,000 | 50.5 ±47.6 | 50.5 ±43.3 | -0.1% |
| remove | 1,000 | 26.6 ±1.8 | 25.7 ±1.7 | -3.3% |
| clear | 10,000 | 777.2 ±26.7 | 934.5 ±38.5 | +20.2% |
| updateStorm | 1,000 | 91.9 ±8.2 | 84.6 ±0.5 | -7.9% |
| updateStorm | 10,000 | 676.5 ±131.7 | 567.3 ±70.0 | -16.1% |
| updateStorm | 30,000 | 1975.5 ±259.9 | 2088.2 ±604.8 | +5.7% |
| selectStorm | 1,000 | 41.2 ±16.4 | 35.2 ±6.2 | -14.6% |
| selectStorm | 10,000 | 245.4 ±12.6 | 232.8 ±31.7 | -5.2% |
| selectStorm | 30,000 | 621.3 ±19.3 | 536.4 ±19.0 | -13.7% |

## Expanded reverse-order classification

| Cell | Upstream | Hux2 | Upstream delta | Classification |
| --- | ---: | ---: | ---: | --- |
| select@1,000 | 20.9 ±2.8 ms | 19.0 ±2.4 ms | +10.3% | small absolute delta; CI95 overlaps |
| clear@10,000 | 976.8 ±13.9 ms | 727.9 ±35.3 ms | +34.2% | confirmed adverse; clear/teardown owner |
| updateStorm@30,000 | 2148.0 ±77.8 ms | 1897.1 ±130.5 ms | +13.2% | confirmed adverse; pacing candidate |
| startup@0 | 49.9 ±2.1 ms | 46.2 ±1.5 ms | +8.0% | confirmed fixed-cost adverse |
| startup@1,000 | 264.7 ±5.9 ms | 340.2 ±4.2 ms | -22.2% | upstream materialization win |
| startup@30,000 | 5414.7 ±44.4 ms | 7171.6 ±87.0 ms | -24.5% | upstream materialization win |

## CPU, memory, startup, and static cost

| Metric | Hux2 | Upstream | Delta |
| --- | ---: | ---: | ---: |
| create@10k BTS CPU | 968.6 | 916.5 | -5.4% |
| create@10k MTS CPU | 2062.4 | 1613.7 | -21.8% |
| clear@10k BTS CPU | 65.1 | 134.0 | +105.8% |
| clear@10k MTS CPU | 918.4 | 1037.1 | +12.9% |
| BTS heap with 10k rows | 279682.4 KiB | 277219.4 KiB | -0.9% |
| MTS heap with 10k rows | 149427.9 KiB | 134702.3 KiB | -9.9% |
| startup FCP@10k | 2396.0 | 1789.8 | -25.3% |
| startup FCP@30k | 7217.2 | 5496.3 | -23.8% |
| Web bundle gzip | 108.2 KiB | 128.6 KiB | +18.8% |
| Lynx bundle gzip | 130.9 KiB | 154.9 KiB | +18.4% |

## Upstream landing decision

| Old layer | Live upstream treatment |
| --- | --- |
| P0 attribution tooling | Keep as Huxpro diagnostic provenance; current upstream benchmarks and #693/#700 evidence supersede its old target matrix. No product PR. |
| P1 frame pacing | Missing on live main. Reimplement against the new protocol as a narrow, separately benchmarked PR; update storm@30k is the current owner signal. |
| P2 retained adoption | Already landed independently as upstream #696. Do not duplicate. |
| P3 plan wire · P4 validation · P5 protocol v2 · P7 materialization | Superseded by the combined, newer #693/#700 renderer protocol and template-run architecture. Do not replay or cherry-pick. |
| P6 lazy worklet bridge | Still missing. Rebase/reimplement as a narrow bundle-only PR and remeasure against live main; retain the explicit “no startup win” claim boundary. |

P1 and P6 should remain separate rollback units. For the sequential upstream train, land P6 first because it is a low-risk static dependency boundary with deterministic bundle evidence; then rebase and benchmark P1, whose scheduling behavior has higher semantic and responsiveness risk. Do not combine either with the clear@10k follow-up, which has a different owner.

## Measurement boundaries

- latency: `pointerdown-to-dom-predicate`
- btsCpu: `sampled-js-cpu-background-realm`
- mtsCpu: `sampled-js-cpu-ui-thread`
- wireToBtsBytes: `web-core-rpc-channel`
- wireToBtsMsgs: `web-core-rpc-channel`
- wireToMtsBytes: `web-core-rpc-channel`
- wireToMtsMsgs: `web-core-rpc-channel`
- fcp: `view-attach-to-first-content`
- settled: `view-attach-to-dom-settled`
- heapBts: `gc-heap-with-10k-rows`
- heapMts: `gc-heap-with-10k-rows`
- bundleWebGzip: `static`
- bundleLynxGzip: `static`
