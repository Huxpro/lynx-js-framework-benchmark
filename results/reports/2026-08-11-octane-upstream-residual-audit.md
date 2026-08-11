# Octane live-upstream residual performance audit

## Verdict

- Live upstream `main` already contains the structural ceiling raisers from #693/#696/#700. The old Hux2 P3/P4/P5/P7 layers must not be replayed.
- P6 alone, P1+P6, both #693-inspired fusion variants, and the final P1-only isolation each failed at least one required performance gate.
- Therefore there is **no honest mergeable upstream product PR** left in this stack. Opening one would turn entry-order/JIT sensitivity into a performance claim.
- The correct delivery is the neutral benchmark/report PR plus this negative-result ledger; a future product attempt needs a new owner signal, preferably real-device frame data or an explicitly opt-in pacing policy.
- Audit: 2626 raw records, zero DNF/null medians, 56 exact bundle checksums, one machine, and exact clean source SHAs.

## Residual decision matrix

| Candidate | Expanded cell | Baseline | Candidate | Delta | Decision |
| --- | --- | ---: | ---: | ---: | --- |
| P6 alone | selectStorm@10,000 | 195.2 ±15.0 ms | 234.5 ±17.1 ms | +20.2% | Blocked: deterministic select-storm regression despite static bundle savings. |
| P1 alone | updateStorm@30,000 | 2001.8 ±134.5 ms | 1799.9 ±91.9 ms | -10.1% | Owner appeared, but ordinary commits paid an unconditional pulse. |
| P1 → P6 | clear@10,000 | 979.1 ±19.9 ms | 1041.0 ±41.9 ms | +6.3% | Blocked: P6 added a repeatable clear-path MTS cost. |
| Fusion v1 | selectStorm@1,000 | 33.3 ±2.2 ms | 49.9 ±4.2 ms | +50.0% | Blocked: demand pacing raised the small-storm latency by one request round trip. |
| Fusion v2 | updateStorm@30,000 | 2115.5 ±134.2 ms | 2115.9 ±182.6 ms | +0.0% | Safe small-root path, but the 30k owner became a wash. |
| Pacing only | updateStorm@30,000 | 2103.3 ±167.6 ms | 2108.2 ±112.5 ms | +0.2% | Final isolation: the forward win did not survive reverse order. |

The strongest attempted fusion made large update storms faster in one expanded order (-12.8%) but made the 1k select storm +50.0% slower. Adding the host-count gate removed that small-root regression, but also removed the owner win. Removing P6 produced -6.3% forward and +0.2% reverse at updateStorm@30k: an order-sensitive wash, not a shippable improvement.

## What #693 and Hux2 teach each other

- [Upstream #693](https://github.com/octanejs/octane/pull/693) wins structurally: shared compiled host programs, compact acknowledgements, lazy public handles/selectors, and capability negotiation remove work rather than reschedule it. Its own report makes 10k mount/update faster than ReactLynx, while disclosing about 39% gzip growth.
- Hux2 P6 contributes the opposite lever: lazy-load the worklet bridge and recover roughly 1–3% compressed main-bundle cost, but the neutral runtime gate shows that static shrink alone is not enough to justify the current implementation.
- P1 contributes a scheduling lever for burst folding. Applying #693's “pay only on demand” principle removed ordinary frame-pulse messages; applying negotiated host count removed the small-root storm regression. The remaining large-root win was not stable under entry reversal.
- The combined ceiling is therefore not another transplant of the old stack. It is a future design that keeps #693's structural fast path, makes optional bridges genuinely cold, and derives pacing from a real frame/backpressure signal rather than a benchmark-scale heuristic.

## Upstream reorganization

| Old layer | Live-upstream treatment |
| --- | --- |
| P0 | Keep as Huxpro diagnostic provenance; no product runtime PR. |
| P1 | Reimplemented three ways and isolated without P6; blocked because the owner is order-sensitive or paid by another cell. |
| P2 | Already landed independently as upstream #696. |
| P3/P4/P5/P7 | Superseded by #693/#700; do not cherry-pick or restack. |
| P6 | Static bundle owner is real, but its standalone and combined runtime gates fail; do not submit in the current form. |

If work resumes, start from live `main`, not any old Hux branch. Keep one product PR with small rollback commits only after one final tree passes forward and reverse neutral gates; until then, no PR ordering or squashing strategy can make the current residuals mergeable.

## Reproducibility

- p6: `results/runs/2026-08-11T07-07-07-65160668d8d9-upstream-p6.json` · SHA-256 `069f5a9cc851eaf87370c7ab6f3e70b3f2a650c6de957d6ff325015ee1cfdcd6`
- p6Reverse: `results/runs/2026-08-11T07-12-07-65160668d8d9-upstream-p6-adverse-reverse.json` · SHA-256 `c88ddfa2839d26c86a4a5480da2e4e2993da1a6927c534391c43619a078bbfe6`
- p1: `results/runs/2026-08-11T07-49-53-65160668d8d9-upstream-p1.json` · SHA-256 `db77591adc5e1be06ab693ebf8861813c29ae626224defffb0b230bdc727c0e1`
- p1Reverse: `results/runs/2026-08-11T08-02-23-65160668d8d9-upstream-p1-adverse-reverse.json` · SHA-256 `2e6a80b65a25890e80a8f33a27c24e237af3cf7a28e49b5f082242ecfa9ee57f`
- combined: `results/runs/2026-08-11T08-23-27-65160668d8d9-upstream-p1-p6.json` · SHA-256 `3ed394fb707027a8a9d163110822a97ba1344e0b42be3ade0961c944d89a6769`
- combinedReverse: `results/runs/2026-08-11T08-37-59-65160668d8d9-upstream-p1-p6-adverse-reverse.json` · SHA-256 `3e7766ad839c4600fdd53c30d3e539417d0b45ab8798a5af56c7b648a8f51e18`
- fusion: `results/runs/2026-08-11T09-43-38-65160668d8d9-upstream-fusion-vs-main.json` · SHA-256 `e3a5e153729fff2ca628a7223706db6aad484d991644544ade924f787c688f0d`
- fusionReverse: `results/runs/2026-08-11T09-57-48-65160668d8d9-upstream-fusion-main-adverse-reverse.json` · SHA-256 `4143071a7d68c2adcf2050e8627c9da0adde63ac57affa394f5a973a4b16e4bb`
- fusionV2: `results/runs/2026-08-11T10-14-57-65160668d8d9-upstream-fusion-v2-vs-main.json` · SHA-256 `dd47dda0d43f81680ff4071da497bc7ab8df1e32e7fe731f8a5aa7999c987e31`
- fusionV2Reverse: `results/runs/2026-08-11T10-41-20-65160668d8d9-upstream-fusion-v2-main-adverse-reverse.json` · SHA-256 `159319b31d8a3869aa9f7c43bd141e4bbf47cd6017fd7d28215cb5063fd9e3bc`
- pacingOnly: `results/runs/2026-08-11T10-59-00-65160668d8d9-upstream-pacing-only-main.json` · SHA-256 `a30aeda64826ea2541d0686c5dd135981f8fd67ff94228d8712427181b441af8`
- pacingOnlyReverse: `results/runs/2026-08-11T11-13-25-65160668d8d9-upstream-pacing-only-main-reverse.json` · SHA-256 `ebff534fc60f52cc10db08c290be6c3927a31cc349274d69f187dd9e3bb3fb1d`
