# Dated `new-lynx` Lab campaign

This campaign publishes one immutable `Huxpro/octane:new-lynx` HEAD as a dated Lab entry, for
example `octane-new-2026-08-20` / `Octane (new-2026-08-20)`. Web and Native results are complete
single-entry observations and are never mixed into featured rankings or cross-entry ratios.

## Freeze, build, and vendor

1. Resolve `refs/heads/new-lynx` from the remote and record its full SHA.
2. Fetch that SHA into a clean detached checkout and verify `HEAD` matches it exactly.
3. Build all auto-row bundles, then vendor only the dated entry:

   ```sh
   node scripts/build-octane-upstream.mjs <clean-checkout>
   git apply --unidiff-zero --include='benchmarks/lynx-table/app/src/**' \
     entries/_patches/octane-new-2026-08-20-bench.patch
   VENDOR_ONLY=octane-new-2026-08-20 OCTANE_NEW_BUILD=<checkout> \
     OCTANE_NEW_PATCH=entries/_patches/octane-new-2026-08-20-bench.patch \
     node scripts/vendor-entries.mjs
   node scripts/verify-entries.mjs
   ```

The only allowed source diff is the exact, published five-file Native compatibility patch: three
benchmark-app producer files plus the main/background ContextProxy string transport and readiness
retry required by the tested production Explorer. The manifest must contain the exact commit,
`ref: new-lynx`, that patch path, eight Web/Lynx bundle checksums, and both formal Lab contracts.
Any source change outside those exact files or bytes is rejected.

## Complete Web campaign

Run without matrix or repetition overrides:

```sh
pnpm bench run --harness web --lab-web --entry octane-new-2026-08-20
```

The immutable source run must be completed and contain the exact 35-cell contract with fixed
7/3/5 table/storm/startup repetitions.

## Complete Sandbox campaign

Use a fresh traceable lease and evidence directory:

```sh
SANDBOX_ISSUER=<owner> SANDBOX_ISSUE_ID=<unique-issue> \
  node scripts/run-sandbox-lab.mjs octane-new-2026-08-20 \
    results/local-evidence/octane-new-2026-08-20/lease-01
```

The wrapper connects only the leased serial and always releases the exact URL-encoded serial before
disconnecting. Raw serial evidence is gitignored. If the lease safety floor stops an incomplete
checkpoint, acquire another lease with a new issue ID and resume that exact checkpoint via
`SANDBOX_RESUME_CHECKPOINT`; the runner rejects a different physical device. When the pool supports
targeted reacquisition, set `SANDBOX_TARGET_LEASE_RECEIPT` to the prior local lease receipt so the
wrapper requests that exact serial without copying it into the command, logs, or repository.

## Completion audit

- manifest SHA and all eight bundle hashes verify;
- Web and Native source runs each match the manifest commit and complete 35-cell contract;
- lease acquisition, release, disconnect, and outcome evidence exists locally but is not committed;
- collector emits separate `webLabRuns/webLabRecords` and `nativeLabRuns/nativeLabRecords`;
- neither formal Lab run appears in featured comparisons, calibrated estimates, heatmaps, geomeans,
  rankings, or ratios;
- tests, entry verification, derived-cache verification, and production site build pass.
