# Data model: source vs derived

The benchmark has one strict rule: **observations are source; everything computed from them is
derived and must be reproducible**. A derived field may be materialized for inspection or faster
loading, but no collector, score, chart, or table may trust that stored snapshot.

## Source data

These are the only files/fields that require an update when their real-world input changes.

### After every benchmark run

`results/runs/*.json` is the immutable observation log:

- run identity and environment: `schemaVersion`, `meta.generatedAt`, machine, Chromium,
  calibration probe, CLI arguments, and entry commits. Prospective runs also retain a receipt for
  benchmark-repository commit/dirty digest, runtime lockfile versions and integrities, browser
  version, workload-contract hashes, every entry bundle hash, and sampling policy;
- Native campaign identity: versioned 115-cell matrix hash, immutable input-receipt and connector
  tree hashes, stable device-cohort identity, ordered structured lease-receipt chain, harness
  configuration, and the complete runtime policy;
- Native continuation evidence: every lease receipt retains its issue ID, expiry, anonymized serial
  hash, and derived lease ID; `cellLeaseIds` attributes every observation to one receipt without
  persisting the raw ADB serial;
- record identity: suite, harness, entry, workload, scale, metric, boundary, unit, plus nullable
  contract version / commit policy dimensions. Schema v4 stores the Web execution regime as
  `environment: { jsRegime, jsFlags, cpuThrottle, throttleScope, verifiedSlowdown? }`; Native keeps
  its device-environment string and cannot carry Web regime fields;
- repeated observations: `samples`;
- one-shot observations: `value`;
- failures: `dnfCount` plus optional per-repetition structured `failures` evidence (category,
  phase, timeout, trigger mode, message, and observed device state);
- per-repetition wire endpoint observations: `detailSamples`;
- per-repetition pipeline controls in `detailSamples`: requested/committed rows, the complete
  ElementPAPI call multiset, and the intercepted host-surface receipt;
- per-repetition storm controls in `detailSamples`: the versioned declared stimulus, actual pointer
  issue offsets, rAF-observed state transitions, and terminal state;
- sampling accounting: prospective records retain `attemptedCount` and `acceptedCount`; rejected
  incomplete storms keep their measured latency/CPU/wire evidence in the structured failure.

Schema v4 extends the Web JS-execution regime to
`environment: { jsRegime: "jit" | "interp", jsFlags: string, cpuThrottle: number,
throttleScope: "none" | "page-cdp" | "process-cgroup", verifiedSlowdown?: number }`.
`jsFlags` is the exact V8 payload; the scope distinguishes page-target CDP throttling from a
whole-process OS quota. `verifiedSlowdown` is required for newly produced `process-cgroup` records
and must be within 0.5× of the declared throttle. Native records
keep their schema-v2 environment string byte-for-byte and never gain Web regime fields. Schema-v2
Web records default to `{ jsRegime: "jit", jsFlags: "--expose-gc", cpuThrottle: 1,
throttleScope: "none" }`, except the historical `lynx-for-web-interp` label, which remains in the
interpreter lane; throttled schema-v3 records normalize to `"page-cdp"`.
That normalization is archival compatibility, not a runnable or public lane: new 4× runs must use
`"process-cgroup"`, while the old page-CDP records remain available only as historical calibration
evidence.
The physical machine fingerprint is unchanged, while derived archives and comparison cohorts are
keyed by machine × regime so the Web lanes cannot overwrite, average, or rank together.

Older schema-v2 run files did not retain `value` or `detailSamples`. The collector treats an
`n=1`/`samples=null` median as a labelled legacy scalar source and treats `detail` as a labelled
legacy final endpoint sample. The schema-v2 `lynx-for-web-interp` label is normalized to the
interpreter lane; all other legacy Web labels default to JIT 1×. It never treats stored aggregate
statistics as authoritative.

Historical attribution campaigns that cannot be expressed as current runner invocations live in
`results/axis-runs/*.json`. These compact, immutable Lab sources retain the artifact/blob pointer,
the exact per-cell sample arrays, and the controls captured by that campaign. They do not contain
statistics or residuals: the collector derives both, including `outsidePapiTime`, from aligned raw
samples. Axis-run observations feed only the axis-effect view; they never enter the ordinary run
archive, comparison cohorts, history checkpoints, or rankings.

`results/axis-evidence/*.json` is a second, deliberately smaller source class: a cited backfill
ledger. It retains typed historical point coordinates, the comparison shape and controls, and only
the key published values transcribed from the linked issue/PR effect table. It does not pretend that
those aggregate values are raw samples. Historical points here are not runnable entries and do not
appear under `entries/`; the collector can use them only to classify the Lab evidence ledger and to
join a cited comparison to an immutable `axis-runs` pair where one exists.

### When an entry is built or vendored

- `entries/*/entry.json`: runnable entry identity, tier, presentation color, provenance, commit, optional
  six-axis coordinates/ablation/ceiling relation, and bundle checksums. Coordinate relations are
  claims about source configuration; whether they pass control validation is always derived. An
  optional versioned `listFixture` capability declaration records list-suite support;
- `entries/*/dist/**`: the actual web/native bundles.

Bundle byte/gzip/section metrics are **not** benchmark observations. They are recalculated from
the current bundle files whenever collection runs.

Current-entry eligibility is artifact-aware but fail-closed. A Web observation matches its current
manifest when either the source commit is identical or the run's complete set of Web bundle
receipts is byte-identical to every manifest Web bundle checksum. This permits a source-only or
Native-only commit change to retain the same measured Web artifact without relabelling changed
bytes. A missing or different Web checksum remains stale. Native eligibility stays commit-exact;
Web artifact equivalence never crosses the harness boundary.

## Derived data

Everything else is derived, including:

- `n`, min/max, mean, median, standard deviation, p95, and 95% confidence interval;
- `outsidePapiTime`, materialized only by `collect` by subtracting the six synchronous
  ElementPAPI self-time series from each aligned `operationTime` source sample;
- storm `contractPass`, `coalescingRatio`, and wire-per-tick metrics, materialized only by `collect`
  from aligned raw schedules, transitions, counts, and wire totals. A semantic every-tick miss is
  descriptive `contract-failed` data with `dnfCount: 0`; timeouts and driver failures are DNF;
- scale-indexed `bundle-scale` records, recalculated from each exact `rows-N` artifact. They retain
  artifact path/SHA-256/flavor/section receipts and are always descriptive/non-ranking. Total gzip
  uses the selected harness artifact; MTS gzip exists only for a structurally readable
  `lepusCode.root`. Pareto membership and FCP error-bar coordinates are site derivatives. The FCP
  side is selected from exactly one execution regime (Web JIT 1× by default), never pooled;
- the complete `axisEffects` view: coordinate classification, ablation-control verdicts,
  descriptive and attributable effect tables, direction consistency, #200 instrument readiness,
  ceiling-to-ceiling axis effects, point-to-own-ceiling implementation residue, and the six-item
  first-cohort evidence ledger;
- the endpoint sample selected for display;
- normalized legacy entry IDs and source annotations;
- newest-per-cell archives and latest-machine metadata;
- featured cohort selection, Lab source selection, calibration ratios and calibrated samples;
- comparability/work classification. Incomplete or unverified work and prospective
  sampling-account mismatches (including accepted/attempted/DNF underflow or overflow) remain in
  the source archive and audit index, but do not become Dataset Time Machine checkpoints or enter
  ranked views. The same applies to `btsCpu` from `cpuThrottle > 1` with
  `throttleScope: "page-cdp"`: CDP throttling is target-scoped and the page setting does not cover
  `lynx-bg`, so those samples are classified
  `invalid-measurement`. A `process-cgroup` source without an accepted per-entry
  `verifiedSlowdown` is invalid for the same reason: an OS-limiter receipt alone does not prove the
  entry's renderer inherited it. Pipeline control identities and cross-entry committed-tree
  eligibility are also
  derived here; unstable call multisets or mismatched trees cannot enter comparisons. Prospective
  Lab estimates must match the selected Web cohort exactly;
- separately selected Native observations for current featured entries measured outside the
  published cohort; each observation comes from one source run and is never merged outside an
  explicitly validated lease chain or included in cross-entry rankings;
- the Native 115-cell coverage classification and totals. Each cell is derived as measured,
  measured-with-DNF, DNF, unsupported, unscheduled, invalid/incomparable, or a
  display/derivation bug;
- the list-workload capability ledger. Its 7 featured entries × 2 isolated harnesses × 4
  startup/recycle/fling cases are derived from manifest declarations, contract hashes, fixture
  artifacts, and list-suite source records. An absent fixture is `unsupported`; it is never a
  table proxy or DNF. Per-cell recycle costs/rates and fling p50/p99/materialized-per-second values
  are derived from aligned raw elapsed/count/wire/materialization observations. Blank frames remain
  source data regardless of value;
- the editorial exact-source history index. Every valid run has a source audit row, but only the
  small explicit checkpoint list becomes Dataset Time Machine stops. A Web checkpoint additionally
  requires one unscoped physical run and publishes only the complete intersection of eligible cells
  across its declared entry identities; framework-specific and incomparable cells remain source
  evidence instead of producing an incomplete matrix. Entries introduced by later runs do not
  invalidate that checkpoint. Native
  checkpoints rank only within an exact validated campaign, device, environment, lease-chain, and
  method identity. Each checkpoint carries a linked commit or version pointer for every framework.
  Upstream-main `octane-main` observations map to the stable public `octane` identity without losing
  their source ID or commit; Hux1, Hux2, and dated `new-lynx` identities remain explicit Huxpro
  branch-head attempts. Records are materialized once
  and checkpoints reference them by index, so finer history does not duplicate full snapshots;
- rank-over-time points. A point exists only inside its exact eligible cohort. Missing cells, DNF,
  isolated observations, incompatible cohorts, and historical storms without enough transport
  evidence remain explicit gaps and are never carried forward, interpolated, or cross-ranked;
- `results/latest.json` in its entirety (a checked-in materialized cache);
- entry lists, available scales/cases, rankings, baselines, ratios, interactive scores, geomeans,
  trend exponents, plot domains, bar widths, totals, sorting, and every table shown by the site.

## Freshness invariants

1. `deriveRecord()` rebuilds record statistics from `samples`/`value` on every collection. Stored
   aggregate fields in run files are ignored.
2. `bench run` writes its source run and immediately refreshes the materialized dataset.
3. `site dev` and `site build` run collection before Vite reads any data.
4. CI regenerates `results/latest.json` and requires exact equality, including its deterministic
   newest-source timestamp.
5. Site aggregate scores use one complete matrix across all scored entries; missing cells cannot
   silently change one entry's denominator.
6. Site entry discovery and available scales/cases come from current manifests/records rather
   than duplicated lists of result data.
7. A publishable Native checkpoint materializes exactly 23 cells per eligible featured entry / 115 total.
   `unscheduled`, `invalid-incomparable`, and `display-derivation-bug` fail collection; DNF stays
   DNF, while `unsupported` requires affirmative scoped capability evidence.
8. Native bundle bytes are snapshotted before adapter creation and served from memory. Runner
   source, entry manifests, provenance patches, disk bundles, and in-memory bundles are hashed in
   one receipt and reverified before a checkpoint is marked complete.
9. An incomplete Native checkpoint may resume only with a new official receipt for the same serial
   hash and the same stable device cohort. Campaign, matrix, input, connector, hardware, environment,
   and method identities must match exactly; existing cells are skipped, overlaps and partial
   startup pairs are rejected, and every new cell is attributed to its producing lease.
10. Publication may combine explicit split checkpoints only when their immutable identities match,
    their cell keys do not overlap, and one ordered receipt chain is an exact receipt-for-receipt
    prefix of the other. The longer chain is published; same-serial forks remain archive-only.
    Missing, unavailable, malformed, or mismatched connector/lease evidence is archive-only.
    Web split checkpoints likewise require the same machine, normalized execution regime, and
    prospective comparability receipt; a matching machine/regime cannot bridge different control
    receipts.
11. The pre-cell expiry boundary is derived from the configured worst single-cell envelope: formal
    repetitions, thermal gate, page/session plus long-workload timeouts, all transport attempts and
    reconnect windows, and cleanup margin. An override can only increase this derived minimum.
12. Incomplete checkpoints from pre-resume Native protocols are diagnostic source archives only and
    are omitted from `results/latest.json`; only v2 checkpoints can participate in explicit
    prefix-compatible multi-lease continuation.
13. History source coverage equals the full valid run-file list, and each checkpoint references
   exact source records rather than a date cutoff or newest-per-cell archive.
14. List records never enter table/startup rankings. Web and Native use separate observers and
    remain separate cohorts; missing fixture capability is explicit `unsupported`, while DNF is
    reserved for an attempted fixture whose driver or capture failed.
15. `bundle-scale` records never enter benchmark-matrix selection or any score. A Pareto point must
    join the same entry, harness, scale, and one normalized execution regime; a frontier containing
    more than one regime fails closed. Historical checkpoints cannot reuse a current artifact when
    their exact per-scale bytes were not retained (retroactive only where those bytes exist).
16. Axis attribution is Lab-only and append-only with respect to published measurements. Its source
    observations may create only `axisEffects`; deleting that derived view cannot remove or change
    a comparison record, history record, ranking input, or source sample.
17. Manifest-declared ablations are never trusted as effects. Only a same-codebase, same-fixture,
    same-build-matrix pair observed in one controlled run and changing exactly one coordinate can
    enter an axis-effect table. Coupled, cross-framework, and failed-control pairs remain visible
    evidence but are non-attributable.

The checked-in `results/latest.json` is useful for review diffs and static consumers, but deleting
and regenerating it from the source files must reproduce the same data.
