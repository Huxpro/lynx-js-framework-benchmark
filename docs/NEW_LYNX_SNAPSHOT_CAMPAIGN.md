# Dated `new-lynx` block-core campaign

This campaign publishes one immutable `Huxpro/octane:new-lynx` HEAD as a normal featured entry,
for example `octane-new-2026-08-22` / `Octane (new-2026-08-22)`. It is not a Lab estimate or a
single-entry Lab observation: its Web numbers enter rankings only through one complete physical
run containing every featured entry.

## Freeze and build

1. Resolve `refs/heads/new-lynx` from the remote and record its full SHA.
2. Check out that SHA detached.
3. Require a clean checkout. Benchmark app and framework-runtime patches are forbidden.
4. Build the scoped-write Block core for every auto-row bundle:

   ```sh
   BENCH_CORE=block node scripts/build-octane-upstream.mjs <clean-new-lynx-checkout>
   ```

The upstream build script passes `BENCH_CORE=block` to
`pluginOctane({ core: 'block' })` and emits `dist-block[-rowsN]`. The vendor reads only those
directories and records `BENCH_CORE=block` plus `BENCH_BLOCK_MODE=scoped` in the manifest receipt;
universal-core `dist[-rowsN]` output cannot satisfy this entry.

Vendor and verify:

```sh
VENDOR_ONLY=octane-new-2026-08-22 \
  OCTANE_NEW_BUILD=<clean-new-lynx-checkout> \
  node scripts/vendor-entries.mjs
node scripts/verify-entries.mjs
```

## Web campaign

Run every featured entry together with the formal repetition counts:

```sh
pnpm bench run --harness web \
  --entry react,octane,octane-new-2026-08-22,vue-vdom,vue-vdom-ifr-et,vue-vapor,vue-vapor-ifr \
  --label octane-new-2026-08-22-block-web
```

The collector admits this run only if it covers one complete, balanced featured matrix from that
source run. A future featured entry does not retroactively invalidate an older complete cohort.
Storm experiments are excluded until all entries share one black-box scheduling contract. The
snapshot is explicitly Web-only; Native is not inferred from the Web result.
