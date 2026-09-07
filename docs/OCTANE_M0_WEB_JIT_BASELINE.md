# Octane M0 Web JIT baseline

This is the first formal same-window baseline for
[Huxpro/octane#283](https://github.com/Huxpro/octane/issues/283). It is a
failed M0 acceptance result, not a final performance claim: the current fork
has a statistically strict aggregate win over the pinned latest upstream, but
it misses the engineering target and several frozen core-cell gates.

## Frozen identities and execution

- Candidate: `octane-m0-current`, source
  `e82160fc0e663f52848e2181d83c6203d633bc86`.
- Comparator: `octane-m0-upstream`, source
  `184631809c8eb61f5bbf15fa23b2470c1d38eea6`.
- Runner: clean `main@926c1e800b13b984031430bff073e577dc86d668`.
- Cohort: `sha256:db51a1d24f7c7686815409e65f85d61d9a14fdbe3800d51a548adf44b03198c6`.
- Machine: `65160668d8d9`, Intel Xeon Platinum 8336C, Linux x64, Node 22.22.2.
- Harness: production Lynx for Web, Chromium JIT, no CPU throttle.
- Sampling: ten independent same-run pairs, five AB and five BA; seven raw
  observations per interaction cell and five per startup cell; no outlier
  removal.
- Completeness: ten 238-record source files, 2,380 records total, zero DNF.

Each run used the exact frozen table and startup window:

```bash
pnpm bench run --harness web \
  --entry <candidate,comparator-or-reverse> \
  --suite table,startup --scale 1000,10000 \
  --startup-scale 0,1000,10000 --reps 7 --startup-reps 5 \
  --session-id <unique-id> --no-collect
```

The ten raw files are checked in beside this report. Their names encode pair
number and order. The machine-readable verdict and every input SHA-256 are in
[`2026-09-07-m0-web-jit-baseline-qualification.json`](../results/audits/2026-09-07-m0-web-jit-baseline-qualification.json),
whose SHA-256 is
`75004757752aaf33d6d0e92702976261896931c202a6a128ca58007151f44e57`.

## Frozen scorecard verdict

All ratios are current fork / upstream; lower is better.

| Suite | point | 95% paired bootstrap CI | strict win | engineering target | suite pass |
| --- | ---: | ---: | --- | --- | --- |
| Interaction | 0.9575 | [0.9406, 0.9744] | yes | no (`> 0.95`) | no |
| Startup FCP | 0.9692 | [0.9580, 0.9811] | yes | no (`> 0.95`) | no |

The following core cells fail the independent 1.05 upper-bound gate:

| Cell | point | 95% paired bootstrap CI |
| --- | ---: | ---: |
| update10th@1000 | 1.0438 | [0.9573, 1.1314] |
| swap@1000 | 1.0530 | [0.9346, 1.1763] |
| remove@1000 | 1.0589 | [0.9775, 1.2033] |
| fcp@0 | 1.0457 | [1.0180, 1.0701] |

The interaction aggregate therefore cannot pass despite strong replace and
append behavior, and startup cannot pass despite better 1k/10k FCP. No failed
cell is removed or reweighted.

## Scope and next evidence

This run establishes the M0 Web JIT baseline only. It does not satisfy the
diagnostic interpreter, Android LepusNG, pinned iOS, tail, twenty-cycle memory
cleanup, bundle, or ReactLynx/Vue final gates. The failing cells and the raw
dual-thread CPU/wire observations now define the Web owner-analysis targets;
Native transport/BTS ownership remains a separate #278 campaign.
