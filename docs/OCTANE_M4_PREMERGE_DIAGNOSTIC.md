# Octane M4 pre-merge Web diagnostic

This is an owner-finding run for
[Huxpro/octane#291](https://github.com/Huxpro/octane/issues/291), not a formal
M4 verdict. It intentionally precedes the merge of the final default-core
candidate and contains one fixed entry order rather than the required ten
balanced AB/BA pairs. Point ratios below must not be cited as confidence
intervals or release claims.

## Frozen inputs and execution

- Candidate: `octane-m4-final` at
  `cf1018a051cd14b2c384ed0541b0ee5ee1789970` (pre-merge PR head).
- Latest upstream at measurement start: `octane-m4-upstream` at
  `55a9aa3acd3ffad847d5604ffbdc4342a30a861d`, rebuilt from source with the
  same Node 22.22.2, pnpm 11.15.1, and Rspeedy 0.16.0 toolchain.
- Comparator producer: `Huxpro/vue-lynx@8e02c0e4e25cd216df080c339cf1ccab855d2c71`;
  ReactLynx 0.126, Vue VDOM 0.5, and Vue Vapor 0.5 are separate default and
  applicable optimized identities.
- Runner: clean `1d81c77a3ca314cc971a921d4f8a67654fff335f`.
- Machine: `65160668d8d9`, Chromium 149.0.7827.55, Web JIT, no throttle.
- Sampling: seven observations per interaction cell and five per startup
  cell, no outlier removal. All 909 records completed with zero DNF.
- Raw run:
  `results/runs/2026-09-11T11-32-34-65160668d8d9.json`, SHA-256
  `5a4c3c42745ef6dec95ef1b7edd36843fb9c77a67d58a6b7a1cfbb2f95477795`.

```bash
pnpm bench run --harness web \
  --entry octane-m4-final,octane-m4-upstream,reactlynx-m4-default,vue-lynx-m4-vdom-default,vue-lynx-m4-vdom-ifr-et,vue-lynx-m4-vapor-default,vue-lynx-m4-vapor-ifr \
  --suite table,startup --scale 1000,10000 \
  --startup-scale 0,1000,10000 --reps 7 --startup-reps 5 \
  --session-id issue291-premerge-diagnostic-all-web-jit --no-collect
```

## Diagnostic point estimates

Ratios are candidate/comparator. Interaction uses the frozen weighted
geometric mean; startup gives equal weight to FCP@0/1k/10k. These are medians
from one ordered diagnostic window, so no strict-win or non-inferiority
decision is made.

| Comparator | interaction | startup FCP | point-risk core cells above 1.05 |
| --- | ---: | ---: | --- |
| latest upstream | 0.716 | 0.749 | FCP@0 1.094 |
| ReactLynx default | 0.840 | 1.105 | replace 1.217; append1k 1.194; FCP@0 1.462 |
| Vue VDOM default | 0.834 | 0.715 | replace 1.239; remove 1.197 |
| Vue VDOM +IFR +ET | 0.837 | 0.810 | replace 1.213; remove 1.196; FCP@0 1.080 |
| Vue Vapor default | 0.848 | 0.684 | replace 1.132; update10th 1.109; remove 1.057; clear 1.082 |
| Vue Vapor +IFR | 0.806 | 0.719 | replace 1.086; clear 1.085 |

The run identifies three concrete owners for the next measurement/engineering
loop:

1. Empty-page startup versus ReactLynx, consistent with the large publication
   artifact gap (the candidate rows-0 Web bundle is about 433 kB versus about
   106 kB for ReactLynx).
2. Whole-table replace, which repeats against every peer despite strong bulk
   create results.
3. Short remove/clear and Vapor sparse-update cells close to or above the 1.05
   point boundary, where balanced pairs are required before choosing a code
   target.

The first owner was then checked in ten independent, order-balanced FCP@0-only
pairs (five AB and five BA). The same frozen paired bootstrap implementation
reports candidate/ReactLynx 1.6990, 95% CI [1.6050, 1.8011]. This is a
conclusive diagnostic failure for that cell, but still not a full-scorecard M4
verdict. The machine-readable result and all ten raw-run hashes are in
results/audits/2026-09-11-m4-premerge-react-fcp0-diagnostic.json.

## Compact candidate versus ReactLynx: failure retained

The later compact candidate `805fd9ed861eec7ca8d113039f6722699b6cce1c`
was measured against ReactLynx default at
`8e02c0e4e25cd216df080c339cf1ccab855d2c71`. Twenty complete combined
table-then-startup sessions (ten AB and ten BA, 4,920 records, zero DNF) passed
the interaction suite at 0.78979, 95% CI [0.77979, 0.79975]. The startup
aggregate also met the engineering target at 0.92091, 95% CI
[0.90224, 0.94060], but the run failed overall because FCP@0 was 1.04041,
95% CI [0.98890, 1.09704].

That combined order is not a cold-start isolation boundary: each framework's
startup pages follow its complete table campaign in the same browser process.
The benchmark therefore added a fail-closed M4 qualifier that accepts separate
prospective interaction and startup windows while still requiring every window
to be complete, same-machine, one-cohort, order-balanced, DNF-free, and exact
commit pinned. It also requires the candidate, comparator, harness, machine,
and source commits to match across windows.

Twenty new startup-only sessions (ten AB and ten BA, 1,400 records, zero DNF)
removed that cross-suite workload without changing the production bundles or
FCP endpoint. Combined with the original interaction window, the frozen 10,000
resample qualification result is:

| suite/cell | point ratio | 95% CI | gate |
| --- | ---: | ---: | --- |
| interaction aggregate | 0.78979 | [0.77979, 0.79975] | pass |
| startup aggregate | 0.90815 | [0.89481, 0.92092] | pass |
| FCP@0 | 1.01309 | [0.97181, 1.05098] | **fail** |
| FCP@1k | 0.88640 | [0.87313, 0.89982] | pass |
| FCP@10k | 0.83405 | [0.82735, 0.84092] | pass |

The exact machine-readable verdict, suite-specific cohort IDs, session IDs,
and all 40 raw-run SHA-256 hashes are in
`results/audits/2026-09-11-m4-premerge-react-web-jit-independent-windows.json`
(SHA-256 `18d4aab010e482f6a859908f976ccffd6d3b95c59cc1563c6d88ed799f919721`).
The FCP@0 upper bound misses the 1.05 non-inferiority gate by 0.00098, so this
remains a failure; no rounding, survivor reweighting, or post-hoc sample
extension changes that verdict.

An independent ten-sweep AB/BA CPU profile found no Octane-specific self-time
owner: sampled CPU geometric means were 30.684 ms for Octane and 30.866 ms for
ReactLynx, while observed FCP geometric means in that diagnostic were 30.243 ms
and 33.312 ms. Shared harness tree walking and Lynx WebCore dominated both
profiles. The raw profiles and top-self tables are retained in
`results/audits/2026-09-11-m4-premerge-react-fcp0-cpu-profile.json` (SHA-256
`ab86abf2c9c39c2ffbdf2de0ebf39584bb62d624a600145c6d718b15de57f98f`).
This profile explains why there is no justified cost-transfer change to make;
it does not override the failed scorecard. The final merged identity will use
a prospectively fixed higher-power cohort rather than appending samples to
this observed failure.

## Compact candidate versus Vue VDOM default: startup passes, interaction fails

The same compact candidate was next measured against Vue VDOM default at
`8e02c0e4e25cd216df080c339cf1ccab855d2c71`. Ten table-only sessions and ten
startup-only sessions (five AB and five BA in each independent window) produced
3,100 records with zero DNF. The frozen 10,000-resample result is:

| suite/cell | point ratio | 95% CI | gate |
| --- | ---: | ---: | --- |
| interaction aggregate | 0.78333 | [0.76956, 0.79916] | aggregate passes |
| select@1k | 1.18185 | [1.07808, 1.29643] | **fail** |
| remove@1k | 1.00618 | [0.95678, 1.05588] | **fail** |
| clear@1k | 1.00847 | [0.96162, 1.05529] | **fail** |
| startup aggregate | 0.55290 | [0.53922, 0.56462] | pass |
| FCP@0 | 0.48926 | [0.46241, 0.51599] | pass |
| FCP@1k | 0.59326 | [0.57806, 0.60850] | pass |
| FCP@10k | 0.58232 | [0.57258, 0.59206] | pass |

Every other interaction cell passes its 1.05 upper-bound gate, but the three
listed cells make the complete scorecard a failure. The exact verdict and all
20 formal raw-run hashes are in
`results/audits/2026-09-11-m4-premerge-vue-vdom-default-web-jit-independent-windows.json`
(SHA-256 `fdf650478ebad5e0d07af0db9559dc1bbe77fbe11fc45879f6800dcf24f5010a`).

Attribution does not support a semantics-changing runtime cut for this
pre-merge failure. Across the 70 formal select samples per arm, Octane used
1.11 ms mean BTS sampled CPU versus Vue's 4.60 ms, while MTS CPU was 4.45 ms
versus 4.46 ms. Octane's pooled select p95 was also lower (27.35 ms versus
29.43 ms), despite the adverse session-median ratio. A framework-neutral
two-order pipeline diagnostic made Octane select faster (14.22 ms mean versus
21.26 ms) and showed that remove/clear differences move between synchronous
PAPI work and outside-PAPI frame observation. Its raw runs are
`2026-09-11T22-41-29-65160668d8d9.json` (SHA-256
`dd5e003eda0a1fe0be9caeb5edb94f444a8896f1f5aeab41eaa7a10210c5e2f8`) and
`2026-09-11T22-42-47-65160668d8d9.json` (SHA-256
`c2fbf61819c01aea0f557b6f4d4a10eff7771d558004bf828f061aee76a0ecde`).

Two 20-repetition, uninstrumented focused table orders likewise moved remove
from slightly adverse to slightly favorable and left clear within about 3%,
while select remained frame-phase sensitive. An explicit-flush experiment was
then rejected: ten independent five-AB/five-BA select sessions gave
flush/baseline 1.07263, 95% CI [0.93504, 1.20269]. It did not improve the cell
and would add a new failure boundary. The source experiment was fully reverted;
the accepted candidate bundle and formal failure evidence are unchanged.

## Compact candidate versus Vue VDOM +IFR +ET: startup passes, interaction fails

The next prospectively fixed comparator was Vue VDOM with initial full render
and event-prop teardown enabled, still from commit
`8e02c0e4e25cd216df080c339cf1ccab855d2c71`. Its independent table-only and
startup-only windows each contain ten sessions with five AB and five BA orders.
All 3,100 observations completed with zero DNF. The frozen 10,000-resample
scorecard is:

| suite/cell | point ratio | 95% CI | gate |
| --- | ---: | ---: | --- |
| interaction aggregate | 0.79894 | [0.78324, 0.81584] | aggregate passes |
| select@1k | 1.06089 | [0.94695, 1.17013] | **fail** |
| swap@1k | 0.90884 | [0.76131, 1.08816] | **fail** |
| remove@1k | 1.05247 | [1.02286, 1.08249] | **fail** |
| clear@1k | 1.10437 | [1.05288, 1.15759] | **fail** |
| startup aggregate | 0.60470 | [0.59083, 0.61829] | pass |
| FCP@0 | 0.61883 | [0.58595, 0.65103] | pass |
| FCP@1k | 0.70106 | [0.68886, 0.71406] | pass |
| FCP@10k | 0.50968 | [0.49947, 0.51862] | pass |

Every other interaction cell passes. The formal verdict, exact commands, and
all 20 source-run hashes are retained in
`results/audits/2026-09-12-m4-premerge-vue-vdom-ifr-et-web-jit-independent-windows.json`
(SHA-256 `e7a0906a3a021d5093ff2f284a5f1104f73408ce40ca334f620fe815497df18a`).

The failed select and swap cells remain phase-sensitive rather than CPU-owner
regressions: across 70 samples per arm, Octane's pooled select mean/p95 was
20.91/27.43 ms versus Vue's 21.27/28.08 ms, with 1.07 versus 4.24 ms background
JS CPU and 4.52 versus 4.55 ms main-thread JS CPU. Swap was likewise faster in
pooled mean/p95 (19.12/25.72 ms versus 21.21/28.94 ms). Remove and clear are
different: Octane used 7.16 versus 5.86 ms background JS CPU for remove and
2.99 versus 2.38 ms for clear, so their adverse ratios were investigated as a
real Block listener-journal hypothesis.

That source hypothesis was rejected rather than shipped. Replacing the Block
root listener `Map` with dense indexed slots preserved acknowledgement and
synchronous teardown semantics, passed 100 focused tests, and was measured in
ten new five-AB/five-BA focused sessions with 20 repetitions per cell. The
patch/baseline aggregate was 0.99935, 95% CI [0.97192, 1.02608]; remove was
1.00454 [0.97192, 1.03710] and clear was 0.99658 [0.96860, 1.02391]. With no
stable benefit, the source was fully reverted and the experimental entry moved
to a recoverable temporary directory. The complete rejection receipt and ten
raw hashes are in
`results/audits/2026-09-12-m4-rejected-dense-listener-web-jit-focused.json`
(SHA-256 `938ecebcde3919375951d6d54fb2d802b3cd6f980d79f681361611f4181a46ce`).

## Compact candidate versus Vue Vapor default: startup passes, interaction fails

Vue Vapor default was measured next at the same comparator commit. Ten
table-only and ten startup-only sessions, independently balanced five AB and
five BA, again produced 3,100 observations with zero DNF:

| suite/cell | point ratio | 95% CI | gate |
| --- | ---: | ---: | --- |
| interaction aggregate | 0.76096 | [0.74755, 0.77430] | aggregate passes |
| swap@1k | 0.99710 | [0.87454, 1.13028] | **fail** |
| remove@1k | 1.08669 | [1.02482, 1.16219] | **fail** |
| startup aggregate | 0.53104 | [0.52319, 0.53890] | pass |
| FCP@0 | 0.47132 | [0.45737, 0.48449] | pass |
| FCP@1k | 0.55680 | [0.54363, 0.57239] | pass |
| FCP@10k | 0.57064 | [0.56124, 0.58102] | pass |

Every other frozen interaction cell passes. The formal scorecard and all raw
hashes are in
`results/audits/2026-09-12-m4-premerge-vue-vapor-default-web-jit-independent-windows.json`
(SHA-256 `e57a4d7a1d5c053fd8507cfe7a2f649e0c59b1f4d485cfad4ac282e2b5348e2e`).
Unlike the VDOM select variance, these structural cells have a real background
owner: pooled swap background JS CPU was 4.74 ms for Octane versus 1.62 ms for
Vapor, and remove was 7.32 versus 1.31 ms. Remove main-thread JS CPU was
effectively identical (4.56 versus 4.55 ms), locating the gap before transport.

An exact-listener-identity journal elision was tested because structural Block
renders rebind their survivor events. The implementation preserved attempt
ordering by refusing to elide any listener ID already written in that attempt,
passed 85 focused tests, and was measured in ten new five-AB/five-BA sessions
with 20 repetitions per cell. It did not explain the owner: patch/baseline was
1.02395 [0.96654, 1.07804] for swap and 0.98933 [0.96904, 1.01136] for remove,
with aggregate 1.00649 [0.97919, 1.03317]. The source was fully reverted. The
rejection receipt is
`results/audits/2026-09-12-m4-rejected-listener-identity-web-jit-focused.json`
(SHA-256 `65995fb6cc1dcd76f4040be8759452a64b29beb797f6fa2fd687ac4e9a154d39`).

## Memory snapshot is not the memory gate

The existing runner captured one GC-forced 10k snapshot and one after-clear
snapshot per entry. Candidate MTS+BTS used heap was 48,330,744 bytes with rows
and 7,141,200 bytes after clear, versus 76,807,236 and 9,553,080 bytes for
upstream. This is useful owner evidence only. It does not provide peak memory,
a confidence interval, or the required twenty create→clear→recreate cycles,
so it cannot satisfy #291's memory/leak gate.

## Required follow-up

The final campaign must rebuild the candidate from the exact `new-lynx` merge
SHA, re-check latest upstream, repeat every formal comparator in at least ten
balanced same-window AB/BA pairs, and apply the paired/session-aware bootstrap.
It must also supply the independent tail, memory-cycle, Native, list, floor,
and platform receipts. This diagnostic remains failure-preserving input to
owner analysis only.
