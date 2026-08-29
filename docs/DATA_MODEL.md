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
- record identity: suite, harness, Web `environment: { jsRegime, jsFlags, cpuThrottle }` or the unchanged
  Native device-environment string, entry,
  workload, scale, metric, boundary, unit;
- repeated observations: `samples`;
- one-shot observations: `value`;
- failures: `dnfCount` plus optional per-repetition structured `failures` evidence (category,
  phase, timeout, trigger mode, message, and observed device state);
- per-repetition wire endpoint observations: `detailSamples`;
- sampling accounting: prospective records retain `attemptedCount` and `acceptedCount`; rejected
  incomplete storms keep their measured latency/CPU/wire evidence in the structured failure.

Schema v3 adds the Web JS-execution regime as
`environment: { jsRegime: "jit" | "interp", jsFlags: string, cpuThrottle: number }`, where
`jsFlags` is the exact V8 payload and the throttle is a finite
multiplier ≥1. Native records keep their schema-v2 environment string byte-for-byte and never gain
Web regime fields. Schema-v2 Web records normalize to
`{ jsRegime: "jit", jsFlags: "--expose-gc", cpuThrottle: 1 }`.
The physical machine fingerprint is unchanged, while derived archives and comparison cohorts are
keyed by machine × regime so the three Web lanes cannot overwrite, average, or rank together.

Older schema-v2 run files did not retain `value` or `detailSamples`. The collector treats an
`n=1`/`samples=null` median as a labelled legacy scalar source and treats `detail` as a labelled
legacy final endpoint sample. It never treats stored aggregate statistics as authoritative.

### When an entry is built or vendored

- `entries/*/entry.json`: entry identity, tier, presentation color, provenance, commit, and bundle
  checksums;
- `entries/*/dist/**`: the actual web/native bundles.

Bundle byte/gzip/section metrics are **not** benchmark observations. They are recalculated from
the current bundle files whenever collection runs.

## Derived data

Everything else is derived, including:

- `n`, min/max, mean, median, standard deviation, p95, and 95% confidence interval;
- the endpoint sample selected for display;
- normalized legacy entry IDs and source annotations;
- newest-per-cell archives and latest-machine metadata;
- newest-per-cell archives and calibration metadata grouped by physical machine × Web regime;
- featured cohort selection, Lab source selection, calibration ratios and calibrated samples;
- comparability/work classification. Incomplete or unverified work and prospective
  sampling-account mismatches (including accepted/attempted/DNF underflow or overflow) remain in
  the source archive and audit index, but do not become Dataset Time Machine checkpoints or enter
  ranked views. Prospective Lab estimates must match the selected Web cohort exactly;
- separately selected Native observations for current featured entries measured outside the
  published cohort; each observation comes from one source run and is never merged outside an
  explicitly validated lease chain or included in cross-entry rankings;
- the Native 115-cell coverage classification and totals. Each cell is derived as measured,
  measured-with-DNF, DNF, unsupported, unscheduled, invalid/incomparable, or a
  display/derivation bug;
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
11. The pre-cell expiry boundary is derived from the configured worst single-cell envelope: formal
    repetitions, thermal gate, page/session plus long-workload timeouts, all transport attempts and
    reconnect windows, and cleanup margin. An override can only increase this derived minimum.
12. Incomplete checkpoints from pre-resume Native protocols are diagnostic source archives only and
    are omitted from `results/latest.json`; only v2 checkpoints can participate in explicit
    prefix-compatible multi-lease continuation.
13. History source coverage equals the full valid run-file list, and each checkpoint references
   exact source records rather than a date cutoff or newest-per-cell archive.

The checked-in `results/latest.json` is useful for review diffs and static consumers, but deleting
and regenerating it from the source files must reproduce the same data.
