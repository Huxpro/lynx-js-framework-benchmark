# Octane Hux2 neutral checkpoint benchmark

Raw run: `results/runs/2026-08-11T05-44-21-65160668d8d9-octane-hux2-checkpoints.json`
SHA-256: `59dbf957616646bd96e1467cf0176a3570c37ad4ed2716c09d18e1aa0faa079c`

## Verdict

- Hux2 is faster than Hux1 in **17/18 interaction latency cells**. The only adverse median is select@1k (+0.8%), inside the two confidence intervals.
- Neutral create@10k is 3007.2 → 2632.4 ms (-12.5%), passing the P7 ≥10% acceptance gate.
- BTS CPU improves in **18/18 interaction cells**. At create@10k it is 1645.4 → 957.9 ms (-41.8%).
- The result is not literally all-green: startup FCP@10k/@30k is +0.8%/+1.9%, create@10k MTS CPU is +3.9%, and Web/Lynx gzip is +2.0%/+1.5%. These headline tradeoffs are below the 5% gate.
- Audit: 912 records, zero DNF, zero null medians, expected n=7 (ordinary), n=3 (storms), n=5 (startup), 48 bundle checksums verified.

## Run provenance

| Field | Value |
| --- | --- |
| Generated | 2026-08-11T05:44:21.157Z |
| Machine | 65160668d8d9 · Intel(R) Xeon(R) Platinum 8336C CPU @ 2.30GHz · 32 cores · 67 GiB |
| Node / Chromium | v22.22.2 · chromium-1228 |
| Calibration | probe v1, score 2329.5 |
| Harness | web · lynx-for-web |
| Repetitions | ordinary 7 · storms 3 · startup 5 |

| Entry | Exact commit | Benchmark tree | Lockfile SHA-256 |
| --- | --- | --- | --- |
| Hux1 | `4a53620fe811a016cb9966fab53ca181a89159c8` | `7de49ecb635b8bcf7b9498a20d7c191db65a23fc` | `9ba4aca7e3573499333be2647699c158bc1654feda2359b116fd45909778350d` |
| B0 | `1fbf224c36608067694d32c23d227291fec52d60` | `2122d98805d09dbf1e7719c496529bae650834cb` | `9bfa66384d7cd40cb59b589c777f176cc5f8dc6a3f17a865039e902402bea226` |
| P2 | `71e1b8a88a8c3e37cc005d37a8e6f75cf31088b4` | `7de49ecb635b8bcf7b9498a20d7c191db65a23fc` | `9bfa66384d7cd40cb59b589c777f176cc5f8dc6a3f17a865039e902402bea226` |
| P3 | `4a444b1b9665d8b4020d774a220bd0e21933cdb2` | `7de49ecb635b8bcf7b9498a20d7c191db65a23fc` | `9bfa66384d7cd40cb59b589c777f176cc5f8dc6a3f17a865039e902402bea226` |
| P6 | `68b2b0546b28d54b7cd8d44665f95d36b58e48b3` | `7de49ecb635b8bcf7b9498a20d7c191db65a23fc` | `9bfa66384d7cd40cb59b589c777f176cc5f8dc6a3f17a865039e902402bea226` |
| P7 / Hux2 | `ff7d2c71c2296b7936f17c809e46637a18963338` | `7de49ecb635b8bcf7b9498a20d7c191db65a23fc` | `9bfa66384d7cd40cb59b589c777f176cc5f8dc6a3f17a865039e902402bea226` |

Hux1 and P2–P7 use the same benchmark app tree. B0 differs only by the later profiling row-render counter, which is compile-time disabled in these default bundles. B0–P7 use the same lockfile and `pnpm@11.15.1`.

## Hux1 → Hux2 interaction latency

| Workload | Scale | Hux1 ms (CI95) | Hux2 ms (CI95) | Delta |
| --- | ---: | ---: | ---: | ---: |
| create | 1,000 | 307.1 ±11.5 | 262.0 ±7.9 | -14.7% |
| create | 10,000 | 3007.2 ±77.5 | 2632.4 ±41.2 | -12.5% |
| create | 30,000 | 9242.0 ±461.3 | 8100.6 ±428.2 | -12.3% |
| replace | 1,000 | 386.5 ±333.4 | 327.6 ±307.9 | -15.3% |
| append1k | 1,000 | 302.4 ±6.9 | 273.1 ±22.4 | -9.7% |
| update10th | 1,000 | 26.1 ±4.2 | 22.8 ±4.0 | -12.7% |
| update10th | 10,000 | 251.9 ±30.0 | 186.3 ±20.9 | -26.0% |
| select | 1,000 | 22.9 ±3.8 | 23.1 ±4.8 | +0.8% |
| select | 10,000 | 89.9 ±6.0 | 76.3 ±7.5 | -15.2% |
| swap | 1,000 | 50.1 ±51.8 | 47.6 ±49.4 | -5.1% |
| remove | 1,000 | 28.8 ±6.9 | 27.0 ±2.5 | -6.4% |
| clear | 10,000 | 752.1 ±18.8 | 751.2 ±13.1 | -0.1% |
| updateStorm | 1,000 | 139.1 ±9.5 | 107.3 ±12.0 | -22.8% |
| updateStorm | 10,000 | 912.8 ±67.1 | 679.3 ±190.5 | -25.6% |
| updateStorm | 30,000 | 2563.6 ±726.1 | 1889.7 ±87.8 | -26.3% |
| selectStorm | 1,000 | 48.0 ±15.5 | 37.1 ±24.7 | -22.7% |
| selectStorm | 10,000 | 303.9 ±65.1 | 250.4 ±23.5 | -17.6% |
| selectStorm | 30,000 | 936.9 ±685.6 | 699.4 ±496.1 | -25.4% |

## Startup

| Scale | Hux1 FCP ms | Hux2 FCP ms | Delta |
| ---: | ---: | ---: | ---: |
| 0 | 47.9 | 47.4 | -1.0% |
| 1,000 | 359.9 | 341.2 | -5.2% |
| 10,000 | 2376.1 | 2396.2 | +0.8% |
| 30,000 | 7126.5 | 7260.9 | +1.9% |

## Checkpoint decomposition

| Checkpoint | create@1k | create@10k | create@30k | BTS CPU@10k | MTS CPU@10k |
| --- | ---: | ---: | ---: | ---: | ---: |
| Hux1 | 307.1 | 3007.2 | 9242.0 | 1645.4 | 1997.3 |
| B0 | 315.5 | 3392.7 | 12061.4 | 1638.9 | 2610.7 |
| P2 | 335.5 | 3403.0 | 11361.7 | 1675.5 | 2654.0 |
| P3 | 328.3 | 3368.5 | 10639.9 | 1666.5 | 2460.7 |
| P6 | 296.2 | 2955.8 | 9283.3 | 1457.6 | 2073.1 |
| P7 / Hux2 | 262.0 | 2632.4 | 8100.6 | 957.9 | 2075.5 |

| Checkpoint | update10th@10k | select@10k | update storm@10k | select storm@10k | BTS heap@10k |
| --- | ---: | ---: | ---: | ---: | ---: |
| Hux1 | 251.9 | 89.9 | 912.8 | 303.9 | 530775.5 KiB |
| B0 | 508.7 | 426.3 | 1537.9 | 1017.8 | 266613.0 KiB |
| P2 | 290.9 | 158.1 | 801.0 | 399.1 | 194635.1 KiB |
| P3 | 285.1 | 124.9 | 880.4 | 344.8 | 449387.5 KiB |
| P6 | 207.9 | 89.8 | 767.5 | 274.6 | 276394.7 KiB |
| P7 / Hux2 | 186.3 | 76.3 | 679.3 | 250.4 | 284549.4 KiB |

Interpretation: P2 owns retained-update/select breadth; P3 owns compact protocol/wire and prepares the materialization contract; P4–P6 together lower create and large-update cost; P7 supplies the final large BTS/materialization win. Its exact Octane harness separately establishes the retained heap-slope win; this neutral harness records one indicative 10k snapshot. Individual noisy cells are not monotonic, so dependency and rollback boundaries—not microbenchmark sorting—should determine landing order.

## Resource and static deltas

| Metric | Hux1 | Hux2 | Delta |
| --- | ---: | ---: | ---: |
| create@10k BTS CPU | 1645.4 | 957.9 | -41.8% |
| create@10k MTS CPU | 1997.3 | 2075.5 | +3.9% |
| BTS heap with 10k rows | 530775.5 KiB | 284549.4 KiB | -46.4% |
| MTS heap with 10k rows | 186837.0 KiB | 149335.6 KiB | -20.1% |
| Web bundle gzip | 106.1 KiB | 108.2 KiB | +2.0% |
| Lynx bundle gzip | 128.9 KiB | 130.9 KiB | +1.5% |

## Adverse and mixed cells

- Primary latency: select@1k is +0.8% (22.9 → 23.1 ms), inside overlapping CI95 ranges; the other 17/18 interaction cells improve.
- Sampled MTS CPU: create@10k is +3.9%. Select@1k is +10.5% in relative terms but only 5.4 → 6.0 ms absolute, while its end-to-end latency is statistically flat.
- Startup: FCP@10k/@30k is +0.8%/+1.9%; both stay below the 5% acceptance threshold.
- Wire: ordinary operations are byte/message invariant except tiny storm-envelope differences. Select storm@10k adds one MTS message and 66 bytes; startup@0 adds 3.4 KiB to BTS, while startup@10k removes about 11.6 MiB.
- Indicative neutral BTS heap: P6 → P7 is +3.0% at 10k, below the 5% gate; Hux1 → Hux2 is -46.4%. Exact retained-slope/release evidence remains in the Octane P7 PR.
- Static cost: Web/Lynx gzip is +2.0%/+1.5% versus Hux1.

## Measurement-boundary audit

| Metric family | Boundary |
| --- | --- |
| latency | `pointerdown-to-dom-predicate` |
| btsCpu | `sampled-js-cpu-background-realm` |
| mtsCpu | `sampled-js-cpu-ui-thread` |
| wireToBtsBytes | `web-core-rpc-channel` |
| wireToBtsMsgs | `web-core-rpc-channel` |
| wireToMtsBytes | `web-core-rpc-channel` |
| wireToMtsMsgs | `web-core-rpc-channel` |
| fcp | `view-attach-to-first-content` |
| settled | `view-attach-to-dom-settled` |
| heapBts | `gc-heap-with-10k-rows` |
| heapMts | `gc-heap-with-10k-rows` |
| bundleWebGzip | `static` |
| bundleLynxGzip | `static` |

All entries were measured sequentially by one runner invocation on one machine with one preflight result. Every operation reached the shared DOM predicate; all startup scales reached first content and settled; all entries produced MTS/BTS heap snapshots.
