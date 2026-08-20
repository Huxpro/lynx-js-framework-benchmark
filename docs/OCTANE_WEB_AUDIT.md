# Octane Web metric audit

This audit explains why the early Octane Web storm numbers cannot be compared with the current
numbers, and separately checks the ordinary `update10th` and `select` paths without relying on
`results/latest.json`. The raw controlled replay is
[`results/audits/2026-08-17-octane-web-immutable-bundle-replay.json`](../results/audits/2026-08-17-octane-web-immutable-bundle-replay.json).
The generated Git-object inventory is
[`results/audits/octane-web-update-select-run-inventory.json`](../results/audits/octane-web-update-select-run-inventory.json):
it scans all 75 distinct raw run blobs reachable from refs, with 39 matching Octane-family Web
runs, 615 entry/operation/scale cells, and 4,305 raw metric records. The cells cover 18 Octane
entry identities, 22 recorded app commits, and three machines.
`scripts/inventory-octane-runs.mjs` reproduces it without using the derived latest dataset. It keeps
the original samples, boundaries, units, DNF evidence, message counts, collection form, and any
explicit repetition policy. Historical fields that were never recorded stay `null`; they are not
backfilled from the current checkout. In particular, none of these 39 legacy runs recorded a
harness Git state, browser version, runtime lock receipt, workload/warmup policy, or bundle digest.
Across the inventory, 334 storm cells are `incomplete-work`, eight are
`legacy-complete-work`, and the remaining ordinary cells are `legacy-unverified`.

## Controlled replay

Session `631b123c-fd40-483b-b35e-775ebe4250c2` ran four immutable Git blobs through one current
Web harness on machine `65160668d8d9`, Chromium `149.0.7827.55`, scale 1,000. Each ordinary case
has 12 repetitions in forward and reverse bundle order; each storm has three fresh-page attempts
per order. No samples were removed. The two preflight scores were 2320 and 2346.8.

| bundle | source | patch state | rows-0 SHA-256 |
| --- | --- | --- | --- |
| clean 6079a680 | app `6079a680`, benchmark repo `a1df1f8` | clean | `86b9538a05f7689e7583735077f8e8152b81d1393c7142b97f65a4ef671f13f9` |
| clean 63eb7888 | app `63eb7888`, benchmark repo `4e1bd005` | clean | `b33dbb58bdee4bb2ee97dec435b1bdfc258d4c9d19cde980154f02d5ec69885e` |
| patched 63eb7888 | app `63eb7888`, benchmark repo `bb0f1d2` | dirty/patched | `b7277540e5a346aaddae1b69aaf4fb8e33e39d1ecddb9f60e5a2f72229a27048` |
| current patched 0fc84da0 | app `0fc84da0`, benchmark repo `b350ff9` | dirty/patched | `3e4d5bc3c0a38e1a0303738b78fb5ce6889b0b0a88fcedde365d992f01d9ffe7` |

Ordinary cases performed equal observable work in every bundle: 2 BTS→MTS and 4 MTS→BTS
messages per accepted sample. Medians below are forward / reverse order.

| bundle | update10th latency | update BTS CPU | select latency | select BTS CPU |
| --- | ---: | ---: | ---: | ---: |
| clean 6079a680 | 23.76 / 23.33 ms | 8.41 / 7.47 ms | 22.95 / 14.44 ms | 5.70 / 4.68 ms |
| clean 63eb7888 | 23.50 / 22.70 ms | 7.53 / 8.41 ms | 20.43 / 20.63 ms | 4.87 / 4.83 ms |
| patched 63eb7888 | 29.48 / 34.53 ms | 20.70 / 22.07 ms | 29.27 / 27.30 ms | 18.67 / 18.26 ms |
| current patched 0fc84da0 | 32.21 / 32.37 ms | 21.68 / 22.01 ms | 22.29 / 23.51 ms | 15.24 / 15.68 ms |

The clean 6079 and 63eb bundles are stable for update, and clean 63eb is stable for select. The
patched bundle at the *same 63eb app commit* is slower and increases update wire payload from
9,498/25,459 to 10,724/29,493 bytes and select from 411/1,258 to 461/1,372 bytes. This is a real
instrumented-bundle cost, not an app-commit regression. The current source recovers some select
latency but retains the larger wire payload and elevated BTS CPU. No Octane algorithm optimization
is claimed: removing or Web-special-casing the instrumentation was not demonstrated safe for the
shared Web/Native benchmark artifact, and would exceed this measurement-correctness change.

## Storm work is not comparable

All 36 storm attempts from the three historical bundles reached the final DOM predicate but failed
the existing transport-completeness gate. Their ranges were:

| bundle | update latency and traffic | select latency and traffic | classification |
| --- | --- | --- | --- |
| clean 6079a680 | 78.72–98.28 ms, 9–13 / 16–23 messages | 30.63–39.06 ms, 3–7 / 10–16 | incomplete work |
| clean 63eb7888 | 84.30–101.96 ms, 9–12 / 19–23 messages | 33.34–42.87 ms, 4–7 / 13–17 | incomplete work |
| patched 63eb7888 | 141.04–258.65 ms, 9–17 / 16–29 messages | 102.52–140.15 ms, 5–8 / 11–17 | incomplete work |
| current patched 0fc84da0 | 988.62 / 1098.38 ms median, 100 / 152 messages | 556.25 / 555.34 ms median, 60 / 92 messages | complete work |

Traffic is written BTS→MTS / MTS→BTS. The current bundle's per-tick
`root.flushTransport()` acknowledgement is the causal contract change: it prevents multiple state
ticks from collapsing behind an in-flight asynchronous render. The large storm slowdown is
therefore primarily 50 or 30 complete publications replacing a handful of collapsed publications,
not a same-work Octane implementation regression.

## Prospective controls

New raw runs now retain the benchmark-repository commit plus dirty-tree digest, exact lockfile
package versions and integrities, browser version/path, workload and page-instrument hashes, every
entry bundle hash, warmup/repetition/acceptance/aggregation/outlier policy, and per-record attempted
and accepted counts. The collector derives explicit comparability classifications. Incomplete or
unverified storm work and malformed prospective sampling remain in the archive and exact timeline
snapshots, but are excluded from `comparisonRecords`, Lab rankings, ratios, and geomeans. Complete
legacy storms remain labelled as legacy because their old runs cannot be assigned current
provenance retroactively. The existing fail-closed `incomplete-storm-transport` guard is unchanged.
