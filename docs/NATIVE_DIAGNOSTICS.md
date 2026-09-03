# Octane Native capacity and list diagnostics

This document defines the non-ranking Android evidence used to investigate
[octanejs/octane#888](https://github.com/octanejs/octane/issues/888). It does not change the
featured Native matrix. The `octane-native-diagnostic` entry is a reserved, Native-only Lab entry,
and its observations must never enter rankings, ratios, heatmaps, geomeans, or scores.

## Two fixtures, two questions

The eager table and bounded list are intentionally different workloads:

- The **eager capacity probe** renders the same seven native elements per logical row plus 42
  fixed chrome elements at 1k and 10k. Optional 6k, 7k, 7.5k, and 8k probes locate a device-specific
  transition. This answers whether an eagerly materialized tree completes or reaches a native
  process limit. It is not an application benchmark.
- The **bounded list** renders 1k or 10k logical rows through real Lynx `list`/`list-item`
  recycling. It answers whether the number of live native list items remains bounded by the
  viewport plus declared buffers while startup, recycle, fling, and teardown semantics remain
  correct.

An eager-table bundle cannot stand in for the list fixture. A `scroll-view`, a Web composed-tree
observer, Octane's deterministic fake-PAPI benchmark, and a calculated element count are also not
Native list-allocation evidence. They remain useful source-level controls, but cannot establish an
Android allocation claim.

## Outcome vocabulary

Every diagnostic cell resolves to one of these states:

- **Measured**: the runner accepted the complete semantic and evidence envelope for the attempt.
  Timing records become reportable only after at least five accepted samples under
  `accepted-sample-minimum-v1`. One to four accepted samples remain visible source observations but
  are `not-reportable`; their aggregate statistics, rankings, scores, and ratios are suppressed at
  the public boundary.
- **DNF**: the attempt started, but did not reach valid semantic completion. The record retains the
  typed failure category and attempt evidence. Capacity, timeout, and process failures are distinct
  DNF reasons; they are never converted to slow or successful timing samples.
- **Not measured**: no credible attempt could be made for a required observation boundary. A
  missing compatible list adapter or Native allocation observer is `not-measured`, not DNF and not
  zero allocation. Semantic list metrics may be measured while observer-owned allocation metrics
  remain not measured.

`measured-with-dnf` is the mixed source state when a cell has accepted attempts and evidenced DNF
attempts. It does not waive the five-accepted-sample reportability minimum.

Threshold capacity probes are outcome-only. A completion receipt or evidenced failure is retained,
but threshold cells have no timing samples. Likewise, `loadToCrashMs` is diagnostic chronology for
a failed attempt. It is not latency, is not accepted into statistics, and must not be compared with
load-to-semantic-completion timing.

## Strict ART capacity classification

The public failure category `capacity/android-art-global-ref-table` is assigned only when one cold
attempt contains all of the following, in order, after its unique attempt marker and for the same
`com.lynx.explorer` PID:

1. `JNI ERROR (app bug): global reference table overflow (max=51200)`;
2. the `Last 10 entries` section;
3. the complete `Summary:` through the 51,200-global-reference total, including exactly
   `30026 of com.lynx.tasm.behavior.PaintingContext$a (30026 unique instances)` and
   `20444 of m7.w (20444 unique instances)`;
4. `Fatal signal 6 (SIGABRT), code -1 (SI_QUEUE)`; and
5. the matching Explorer process-death event.

Every line must fall inside the attempt's post-launch log window. Missing, truncated, duplicated,
late, pre-launch, wrong-PID, PID-restart, or differently ordered evidence is `process-failure`, not
the capacity category. A process that stays alive without a valid completion receipt until the
cutoff is `timeout`. Other application, ANR, OOM, or signal evidence is a process failure.

The completion side is equally strict: one startup receipt must match the expected logical row
count, prove the Octane root-render acknowledgement, and then prove two Native animation frames.
Duplicate or late receipts invalidate the attempt.

## Immutable identity and device protocol

Before adapter creation, the runner snapshots and hashes the benchmark commit and runner sources,
the Octane source commit, entry manifest and build receipt, exact per-scale bundle bytes, workload
and fixture contracts, adapter, runtime policy, and the operator-supplied DevTool-disable preflight
bundle. The same bytes are rechecked after the run. A mutation creates a different campaign; it
cannot resume or merge into the first one.

The capacity lane uses no DevTool connector or CDP session. Its preflight must observe
`DevTool disabled. Transitioning to ATTACHED.` followed by
`__OCTANE_DEVTOOL_DISABLED__=true`, and must reject any later DevTool re-enable. Every repetition
force-stops Explorer before launch, requires an interactive/stay-awake display, waits for Android
thermal status 0 and battery temperature at or below 35 °C, and identifies the process from ADB
after launch. Capacity evidence comes only from the pinned bundle, process state, epoch-stamped
logcat stream, and completion receipt.

Every capacity ADB command has a 30-second default timeout
(`LYNX_SANDBOX_CAPACITY_ADB_TIMEOUT_MS`). Before each probe, the adapter derives a worst-case
lease envelope from the thermal, preflight, PID-discovery, capacity, finalization, command, and
cleanup windows. A probe does not start inside that envelope. The cleanup margin defaults to 30
seconds (`LYNX_SANDBOX_CAPACITY_LEASE_CLEANUP_MARGIN_MS`); an optional
`LYNX_SANDBOX_CAPACITY_LEASE_STOP_SAFETY_MS` may increase, but never reduce, the derived bound.

The list lane requires a real Native adapter capability and an allocation observer using
`lynx-native-list-allocation-observer-v1`. The campaign identity includes the observer's non-empty
method revision and measured enable-through-disable overhead in milliseconds. A valid observer
reports peak live list items, cumulative list-item creations, observed reuse, and zero remaining
live list items after teardown. No observer means those allocation metrics are `not-measured`.

For issue #888, closure evidence uses the reported Android cohort: aries_10, Android 10,
LynxExplorer 1.0, Lynx Engine 3.9, SDK 4.0, DevTool disabled. Run the eager (A) and bounded-list (B)
fixtures in both A→B and B→A order, with a cold Explorer process for every repetition and at least
five accepted attempts per timing cell. Record the immutable campaign identities rather than
combining results from different source, artifact, observer, device, or policy revisions.

## Commands

Verify the repository-owned contracts without a device:

```bash
pnpm test
pnpm bench list-coverage
node scripts/verify-entries.mjs
```

Run the eager capacity campaign on a leased device. The preflight path must name a local bundle
that emits the required DevTool-disabled acknowledgement; it is pinned by byte hash in the result:

```bash
LYNX_SANDBOX_SERIAL='<leased-adb-serial>' \
LYNX_SANDBOX_LEASE_RECEIPT='<json-or-path-containing-serial-issueId-expiredAt>' \
pnpm bench run \
  --harness native \
  --entry octane-native-diagnostic \
  --adapter packages/runner/adapters/lynx-sandbox-android.mjs \
  --native-capacity \
  --capacity-disable-file '/absolute/path/to/devtool-disabled/main.lynx.bundle' \
  --capacity-thresholds \
  --reps 5 \
  --label issue-888
```

Omit `--capacity-thresholds` for the required 1k/10k pair. The bounded-list device campaign is
valid only through an adapter that declares the exact Native list capability and the real
allocation-observer receipt described above. Save the observer declaration as, for example,
`/absolute/path/to/native-list-observer.json`:

```json
{
  "protocol": "lynx-native-list-allocation-observer-v1",
  "methodRevision": "<non-empty-method-revision>",
  "measurementOverhead": {
    "boundary": "observer-enable-through-disable-per-attempt",
    "unit": "ms",
    "value": 12.5
  }
}
```

Replace the illustrative `12.5` with the finite, non-negative observed cost for that method
revision; it must not be a placeholder in a real campaign. Run the list campaign with the observer
and an adapter implementing the versioned
`runListCase()` contract:

```bash
pnpm bench run \
  --harness native \
  --native-list \
  --entry octane-native-diagnostic \
  --adapter '/absolute/path/to/native-list-adapter.mjs' \
  --native-list-observer '/absolute/path/to/native-list-observer.json' \
  --reps 5 \
  --campaign-id issue-888-list-ab \
  --label issue-888
```

The adapter must declare `lynx-native-list-capability-v1`, the
`lynx-list-fixture-v2` fixture, the `native-visible-list-cell-tree-v1` observation boundary, and
support for the observer protocol above. Omitting `--native-list-observer` can still produce
semantic source observations, but allocation metrics are `not-measured` and cannot close the
issue. A missing list-capable adapter likewise remains not measured.

## Closure gate

Issue #888 is not closed by a fixture, classifier, unit test, Web run, or old crash log alone.
Closure requires all three:

1. the Octane repository change that owns the eager and bounded-list fixtures and their semantic
   tests;
2. the benchmark repository change that vendors those exact artifacts and owns classification,
   outcome accounting, immutable receipts, and presentation; and
3. a fresh Android campaign satisfying the device protocol above, including both fixture orders
   and the real list-allocation observer.

The first two source lanes are implemented. The fresh Android campaign is currently pending; no
connected device evidence was produced with these changes. Until that campaign exists, the issue
must remain open and all Native allocation/capacity conclusions remain diagnostic rather than a
release or ranking claim.
