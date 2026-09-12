# Octane M0 scorecard contract

This is the prospective measurement contract for
[Huxpro/octane#282](https://github.com/Huxpro/octane/issues/282), frozen before
the M0 cohort is measured. The machine-readable source is
`packages/shared/src/scorecard.mjs`; the runner and site consume the same
js-framework weights from that module.

This file contains no new performance result. Existing checked-in runs remain
history and cannot satisfy the contract merely because they contain similarly
named cells.

## Comparison identities

Every campaign pins four separate Octane identities: the historical reference,
the M0 `new-lynx` baseline, latest upstream at the campaign start, and the
candidate. ReactLynx, Vue VDOM, and Vue Vapor are rebuilt as separately named
comparators. Default production and explicit optimized configurations are
different cells; a fast experimental configuration cannot stand in for a
default build.

Latest upstream is built from source at its pinned SHA with the same toolchain
as the candidate. Every identity requires the source commit and patch, lockfile,
engine/toolchain, capability configuration, bundle SHA-256, and workload-contract
SHA-256. A published artifact built by an unknown toolchain is not substituted.

## Correctness and engagement preflight

Before timing, each entry must pass startup/adoption/native tap, create,
replace, append, remove, select, update, swap, clear, recreate, and dispose.
The shared oracle checks row count, visible text, native events, survivor
identity, and host structure. A smaller host census is a benefit only when the
same semantic/layout/accessibility contract passes.

Every timed cell also records the wire operation that actually ran and the
presence of the loadBundle pipeline entry. A missing engagement receipt becomes
DNF with its reason; it is neither zero nor a reason to remove the cell.

## Frozen timing matrices

There is no cross-suite global score.

- Interaction uses the exact nine js-framework CPU cells and weights already
  published by this benchmark: create 1k, replace 1k, update every tenth 1k,
  select 1k, swap 1k, remove 1k, create 10k, append 1k to 1k, and clear 1k.
- Startup is a separate equal-weight geometric mean of FCP at 0, 1k, and 10k.
- Diagnostic startup scales are 0/1k/10k. The 1k/2k/3k/5k/10k diagnostic
  bulk ladder is the production `BENCH_AUTOROWS` mount-create path, so it does
  not depend on a framework app exposing a non-standard 2k button. It is a
  capacity/attribution ladder, not an extra interaction-score cell. Capacity
  failure at 10k is retained as DNF; it does not rewrite the frozen scorecard.
- Ready, cold first hit, and steady interaction p95 are independent
  non-inferiority gates, split into cold and warm groups.
- Peak, settled, and after-clear memory are independent gates. Cleanup repeats
  create→clear→recreate at least twenty times.

Web JIT, Web diagnostic interpreter, Android LepusNG, and the pinned iOS native
runtime are separate platforms. The interpreter lane explains ownership and
never supplies a missing production rank on another platform.

## Frozen statistical decision

All ratios are candidate/comparator. Formal means use at least ten independent,
uniquely identified same-window pairs, with order balanced across AB/BA. No
outlier is removed. The session is the bootstrap unit: both arms and every cell
from a sampled window stay together through 10,000 deterministic bootstrap
resamples.

For each ranking platform and suite:

- the weighted-geomean ratio's 95% CI upper bound must be below 1.0 to claim a
  win;
- its point estimate target is at most 0.95;
- every core cell's ratio CI upper bound must be at most 1.05.

Tail gates require at least 100 valid interactions and the same 1.05
non-inferiority upper bound. Memory relative to the M0 baseline uses 1.05, and
after-clear retained memory must also not exceed current upstream. Missing or
DNF cells fail completeness without reweighting the survivors.

`qualifyPairedScorecard()` implements the paired aggregate and per-cell gates.
It rejects duplicate session identities, unbalanced order, an incomplete cell,
a non-positive observation, or too few pairs before producing a verdict.

Formal raw runs are qualified directly, never through `latest.json` or stored
aggregate fields:

```bash
pnpm bench:qualify:m0 --candidate <candidate-id> --comparator <comparator-id> \
  results/runs/<session-01>.json ... results/runs/<session-10>.json
```

The ingest gate also requires a clean runner checkout, one exact machine and
comparability cohort, consistent source commits, auditable two-arm order, and
complete DNF-free source samples for every repetition and frozen cell.

M4 may use independent prospective windows for interaction and startup so a
full table campaign cannot warm or otherwise contaminate a later startup
measurement. Each suite still independently requires its own complete,
order-balanced, same-machine, same-cohort raw run set, while candidate,
comparator, harness, machine, and exact source commits must match across the two
windows:

```bash
pnpm bench:qualify:m4 --candidate <candidate-id> --comparator <comparator-id> \
  --interaction-run results/runs/<table-session-01>.json \
  --startup-run results/runs/<startup-session-01>.json \
  --output results/audits/<qualification.json>
```

## Execution sequence

1. Vendor and verify newly named comparator bundles without overwriting old
   artifacts.
2. Run the shared correctness and engagement preflight. The Web correctness
   receipt is produced with `pnpm bench:preflight:m0:web --entry <ids>
   --output results/audits/<receipt>.json`; it uses real pointer input and
   records row/text, survivor-identity, host-census, recreate, and dispose
   evidence from one shared black-box sequence.
3. Measure the M0 fork and latest upstream in one production AB/BA window.
4. Integrate applicable upstream changes in a separate Octane PR.
5. Rebuild and repeat the identical window; do not compare a pre-sync run with a
   post-sync run as if only one mechanism changed.
6. Preserve raw observations and receipts. Profile/DevTool runs explain owners;
   only uninstrumented production bundles supply headline results.
