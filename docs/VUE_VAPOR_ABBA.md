# Vue Vapor A/B/B/A helper

This optional helper sits on top of verified Vue Vapor Web lab entries. It verifies both
receipts and prints four isolated single-entry commands by default. It does not launch a browser
unless `--execute` is present, and it never computes a statistical conclusion.

```bash
node scripts/lab/vue-vapor-abba.mjs \
  --a vue-vapor-baseline \
  --b vue-vapor-candidate \
  -- \
  --suite startup \
  --scale 10000 \
  --startup-reps 10
```

After reviewing the printed plan, add `--execute` before the `--` separator:

```bash
node scripts/lab/vue-vapor-abba.mjs \
  --a vue-vapor-baseline \
  --b vue-vapor-candidate \
  --execute \
  -- \
  --suite startup \
  --scale 10000 \
  --startup-reps 10
```

The sequence is `A1, B1, B2, A2`, with a separate raw run file for each step. Analyze the raw
observations separately; the helper deliberately makes no winner or regression claim. `--a`
and `--b` each accept exactly one lowercase entry ID token; commas are rejected. With
`--execute`, the helper re-verifies the pinned entry fingerprint immediately before and after
every step and stops if an entry was replaced while the sequence was running.

The helper and its test are a separately stageable optional unit:

- `scripts/lab/vue-vapor-abba.mjs`
- `scripts/lab/vue-vapor-abba.test.mjs`
- `docs/VUE_VAPOR_ABBA.md`

## Formal manifest analysis

Formal analysis never scans `results/runs`, reads `latest.json`, trusts filenames, or infers a
leg from argv. It accepts one complete schema-v1 manifest whose sequences explicitly list four
distinct regular raw files, SHA256 values, exact run labels, variant, phase, harness, and
A1/B1/B2/A2 positions:

```bash
node scripts/lab/analyze-vue-vapor-abba.mjs \
  --manifest /path/to/complete-manifest.json \
  --out /path/to/analysis.json
```

Raw bytes are hashed before JSON parsing. Every input must carry campaign-v1 metadata and
lossless attempts. The analyzer verifies receipt and artifact identity, resolved matrices,
machine/runtime/browser cohort, strict time order, and exact attempt positions.
Authority-metric DNF invalidates its companion metrics. Integrity status is reported separately
from performance status.

The expected baseline-to-tip surface is fixed at 508 logical keys: Web 438 and Native 70 across
Vapor and IFR. Missing, extra, duplicate, DNF, attempt-misaligned, or incomparable keys block a
performance conclusion. Statistics pair B1/A1 and B2/A2 by logical attempt index, weight the two
order strata equally, use R7 quantiles, and run a deterministic 50,000-replicate paired
stratified bootstrap seeded from comparison ID and canonical metric key. Bundle sizes are
bit-exact within each arm and are not bootstrapped. Heap consumes only dedicated memory
sequences and requires at least five observations per arm.
