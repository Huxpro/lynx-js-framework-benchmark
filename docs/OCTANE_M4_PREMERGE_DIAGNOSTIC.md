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
