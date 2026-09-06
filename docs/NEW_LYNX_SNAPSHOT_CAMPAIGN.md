# Hux compiled-create + FCP composite campaign

This campaign publishes one immutable composite of `Huxpro/octane` PR heads as the featured
`octane-hux` entry:

- `pull/269/head`: compiled create / mount-program execution;
- `pull/272/head`: FCP and create-prop stack head, including PRs #270 and #271.

The manifest records both full input SHAs and the local merge commit. The composite is a dated
PR-head attempt, not an inference about either branch independently.

## Freeze and build

1. Fetch both PR refs and create a two-parent merge commit on top of `new-lynx`.
2. Keep one clean checkout of that composite for Web artifacts.
3. In a second checkout, apply only the reviewed Native benchmark-app patch at
   `entries/_patches/octane-hux-native-bench.patch`.
4. Build universal-core bundles at every auto-row scale in both checkouts:

   ```sh
   node scripts/build-octane-upstream.mjs <clean-composite-checkout>
   node scripts/build-octane-upstream.mjs <native-instrumented-composite-checkout>
   ```

The vendor requires both PR SHAs as direct parents in both checkouts. It requires the Web checkout
to be clean, rejects any Native-checkout dirty source outside the two instrumentation files, and
byte-compares that working diff with the checked-in patch. `main.web.bundle` is copied from the
clean composite and `main.lynx.bundle` from the reviewed instrumentation checkout. The resulting
manifest records this split, `BENCH_CORE=universal`, both Native producer protocol versions, every
bundle hash, and both input commits.

Vendor and verify:

```sh
VENDOR_ONLY=octane-hux \
  OCTANE_HUX_BUILD=<native-instrumented-composite-checkout> \
  OCTANE_HUX_WEB_BUILD=<clean-composite-checkout> \
  node scripts/vendor-entries.mjs
node scripts/verify-entries.mjs
```

## Web and Native campaigns

Run the full featured matrix without entry, case, or scale filters:

```sh
pnpm bench run --harness web --label octane-hux-compiled-create-fcp-web

LYNX_SANDBOX_SERIAL='<leased-adb-serial>' \
LYNX_SANDBOX_LEASE_RECEIPT='<official-receipt>' \
pnpm bench run --harness native \
  --adapter packages/runner/adapters/lynx-sandbox-android.mjs \
  --label octane-hux-compiled-create-fcp-native
```

The Web collector requires one complete balanced featured cohort. Native schedules six eligible
entries and 138 contract cells. For `octane-hux`, a real Native touch starts the table boundary;
startup and table payloads use device-clock renderer acknowledgements and second-frame evidence.
DNF remains explicit and is never replaced with an inferred timing. The 2026-09-01 execution and
its outcomes are summarized in
[`docs/OCTANE_HUX_COMPILED_CREATE_FCP_RUN.md`](./OCTANE_HUX_COMPILED_CREATE_FCP_RUN.md).
