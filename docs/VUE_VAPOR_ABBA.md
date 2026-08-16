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
