# Vue Vapor A/B lab

This workflow builds and runs reviewable Vue-Lynx Vapor experiments without writing to the
published `entries/`, `results/runs/`, or `results/latest.json`. All generated artifacts live
below the ignored `.tmp/vue-vapor-lab/` root:

```text
.tmp/vue-vapor-lab/
  entries/<entry-id>/
    entry.json                      # runner manifest, always tier=lab
    receipt.json                    # machine-readable build receipt
    artifact-hashes.json            # SHA256 of entry.json and receipt.json
    build-metadata.json             # canonical per-cell Rspeedy identity
    build-tools/<fingerprint>/      # Rspeedy evidence plus canonical compiler graph
    source.patch                    # only for an explicitly allowed dirty source
    benchmark.patch                 # when this benchmark worktree is dirty
    dist/rows-<n>/main.{web,lynx}.bundle
    dist/rows-<n>/artifact-assertions.json
  results/runs/*.json               # isolated raw observations
  results/latest.json               # isolated derived cache
  locks/                            # fail-closed per-entry locks
  work/                             # unique transient build/staging dirs, empty after cleanup
```

The formal builder and runner keep their existing behavior unless `--lab` or `--lab-root` is
passed explicitly.

## Build two experiment entries

Use a distinct experiment ID for each checkout. `--suffix candidate` expands to
`vue-vapor-candidate` or `vue-vapor-ifr-candidate`; `--id` sets the complete ID. The formal IDs
`vue-vapor` and `vue-vapor-ifr` are rejected.

```bash
node scripts/lab/vue-vapor-entry.mjs \
  --source /path/to/vue-lynx-a \
  --variant vapor \
  --suffix baseline \
  --rows 0,1k,10k,30k

node scripts/lab/vue-vapor-entry.mjs \
  --source /path/to/vue-lynx-b \
  --variant vapor \
  --id vue-vapor-candidate \
  --rows 0,1k,10k,30k
```

The builder requires the repository's declared `packageManager` version. By default it invokes
`corepack pnpm`; a campaign may pass a portable explicit executable with `--pnpm <path>` or
`VUE_VAPOR_PNPM=<path>`. The receipt records the command, resolved override path, actual version,
and declaration. A missing executable or version mismatch fails before build work.

Use `--variant ifr` for the Vapor + IFR app. Rows may be any non-empty subset of
`0,1k,10k,30k`. The shared Vue-Lynx packages are still built once per invocation, but the
explicit lab path runs `rspeedy` and vendors bundles only for the selected Vapor variant and
rows. It does not duplicate the existing builder core.

Nonzero rows require the source checkout to implement the benchmark's autoRows build contract
(`BENCH_AUTOROWS`, `__BENCH_AUTOROWS__`, or `autoRows`). The lab builder fails before building
when that contract is absent; such a checkout can still build `--rows 0` for table or zero-row
startup smoke coverage.

The source checkout must be clean. `--allow-dirty` is an explicit lab-only escape hatch: the
receipt then records the complete porcelain status, writes `source.patch`, and records its
SHA256. `--replace` is required to replace an existing experiment ID.

Builds acquire deterministic fail-closed locks for the real source worktree and target entry.
Each invocation uses unique build and staging directories outside `entries/`. Known ignored
Vue package outputs, app outputs, and caches are snapshotted before the build and restored in
`finally`; failed replacement keeps the previous entry byte-for-byte. A complete staged entry
is verified before atomic publication, and transient work is removed on success or failure.

## Audit the artifacts

```bash
node scripts/lab/verify-vue-vapor-lab.mjs
# or one entry:
node scripts/lab/verify-vue-vapor-lab.mjs --entry vue-vapor-candidate
```

For each entry, `receipt.json` records:

- source checkout, remote, symbolic ref (or `HEAD`), source HEAD, dirty status, and patch SHA256;
- benchmark checkout/ref/HEAD, dirty status, and benchmark patch SHA256;
- build start/end timestamps and the exact argv;
- the exact source app, `BENCH_CELL`, mode, row/IFR/ET flags, and selected output path per row;
- receipt schema v3 build metadata: the planned Rspeedy root, source-relative install shim,
  invoked package-binary/package paths, installed package version, package/binary SHA256 values,
  the complete published package-tree SHA256/file count, and a canonical graph of every actually
  resolved dependency, optional dependency, and installed peer package. Every graph package
  binds name/version/content-tree hash; the graph also binds platform, architecture, and Node
  ABI. React is pinned to its app-local tool root; Vue cells are pinned to the benchmark-level
  tool root;
- actual Node and pnpm versions, pnpm invocation/path, and the benchmark's declared version;
- SHA256, raw bytes, and level-9 gzip bytes for every web and Lynx bundle;
- the verified static metadata assertion for both bundles in every row.

The verifier recomputes both patch hashes, copied Rspeedy evidence hashes/version/fingerprint,
every bundle hash/size, `entry.json` SHA256, and `receipt.json` SHA256. It also re-reads both
bundle byte streams and requires exactly one complete static BannerPlugin byte sequence
`/*! vue-lynx-bench-artifact-v1|mode=<mode>|rows=<N>|ifr=<0|1>|et=<0|1> */` and exactly one
`vue-lynx-bench-artifact-v1|` prefix in each. The builder snapshots both git worktrees before
the build and refuses to issue a receipt if either state changes during the build. The receipt
is an auditable local record; it is not a signed attestation or a hermetic-build guarantee.
The copied canonical compiler graph proves exactly what issuance bound into the receipt and
detects graph-evidence tampering offline. Only the Rspeedy package itself is copied in full;
offline verification cannot independently re-read every dependency package that was installed
at issuance. Issuance therefore re-resolves and rehashes the live complete graph both before
and after the build.

Receipt schema v1/v2 and earlier schema-v3 entries without the compiler graph are rejected.
Remove and rebuild those ignored `.tmp/vue-vapor-lab/entries/*` artifacts; there is no
best-effort migration because missing build identity cannot be reconstructed.

## Run one isolated entry

These commands are examples only; they execute benchmark timing and are not part of artifact
generation:

```bash
pnpm bench list --lab-root .tmp/vue-vapor-lab

pnpm bench run \
  --lab-root .tmp/vue-vapor-lab \
  --entry vue-vapor-baseline \
  --suite startup \
  --scale 10000 \
  --startup-reps 10 \
  --label a1
```

With `--lab-root`, entry discovery, raw run output, collection, and `latest.json` are all rooted
under `.tmp/vue-vapor-lab`. Before launching Chromium, the runner re-verifies each selected
entry's receipt, patches, manifest, bundle hashes, producer cell, and exact bundle marker bytes,
and proves that the live benchmark runner worktree matches the benchmark HEAD and patch captured
by every receipt. Requested rows must be present in the receipt before browser launch. The runner
repeats the artifact and worktree checks after measurement and before
writing a run, so artifacts or runner code changed in flight cannot produce a mixed receipt.
Every raw run records `entryCommits`, the live benchmark-worktree identity, and a receipt cohort
fingerprint covering the receipt SHA, source/benchmark patch SHAs, and complete bundle SHA set.
Lab collection archives by that fingerprint, so the same ID and source commit with different
artifacts do not collapse, and only runs matching the current manifest can enter the comparison
cohort.

`--label` accepts only letters, digits, dot, underscore, and hyphen; empty values, `.`/`..`,
slashes, backslashes, and control characters are rejected for both Web and Native runs. Run
filenames include milliseconds and use exclusive creation. Existing symlinks in the lab output
path, including `results/runs` and `results/latest.json`, are rejected.

Startup scale selection is intentionally exact in lab mode: `--scale 10000` runs only startup
at 10k. Interactive table workloads always use the `rows-0` bundle, so include row 0 when running
the table suite.

## Boundaries

- Lab output roots must be inside this benchmark worktree's `.tmp/`; symlinked output roots and
  formal entry IDs are rejected.
- The workflow above uses the Web harness.
- The normal `scripts/vendor-entries.mjs`, formal manifests, published run files, and
  `results/latest.json` are never inputs or outputs of this workflow.
- Receipts make build inputs and artifacts auditable; they do not certify benchmark methodology
  or turn an A/B sequence into a statistical conclusion.
