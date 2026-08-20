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
- record identity: suite, harness, environment, entry, workload, scale, metric, boundary, unit;
- repeated observations: `samples`;
- one-shot observations: `value`;
- failures: `dnfCount` plus optional per-repetition structured `failures` evidence (category,
  phase, timeout, trigger mode, message, and observed device state);
- per-repetition wire endpoint observations: `detailSamples`;
- sampling accounting: prospective records retain `attemptedCount` and `acceptedCount`; rejected
  incomplete storms keep their measured latency/CPU/wire evidence in the structured failure.

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
- featured cohort selection, Lab source selection, calibration ratios and calibrated samples;
- comparability/work classification. Incomplete or unverified work and prospective
  sampling-account mismatches (including accepted/attempted/DNF underflow or overflow) remain in
  the archive and exact timeline snapshots, but site data selectors and collector comparison
  cohorts keep them out of ranked views. Prospective Lab estimates must match the selected Web
  cohort exactly;
- separately selected Native observations for current featured entries measured outside the
  published cohort; each observation comes from one source run and is never merged across leases
  or included in cross-entry rankings;
- the four checked timeline snapshots. Each historical position names exact source run files and
  remaps that run's upstream-main Octane source to the stable public `octane` identity; dragging
  the site slider swaps the complete record/comparison/machine context rather than filtering the
  newest-per-cell archive;
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

The checked-in `results/latest.json` is useful for review diffs and static consumers, but deleting
and regenerating it from the source files must reproduce the same data.
