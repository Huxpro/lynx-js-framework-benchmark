# Dated `new-lynx` block-core campaign

This campaign publishes one immutable `Huxpro/octane:new-lynx` HEAD as a normal featured entry,
for example `octane-new-2026-08-21` / `Octane (new-2026-08-21)`. It is not a Lab estimate or a
single-entry Lab observation: its Web numbers enter rankings only through one complete physical
run containing every featured entry.

## Freeze and build

1. Resolve `refs/heads/new-lynx` from the remote and record its full SHA.
2. Check out that SHA detached.
3. Apply the checked-in one-file block-storm patch. It waits for each `context.commit()` before
   scheduling the next tick, preserving the neutral contract's 50/30 complete publications.
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
VENDOR_ONLY=octane-new-2026-08-21 \
  OCTANE_NEW_BUILD=<clean-new-lynx-checkout> \
  OCTANE_NEW_PATCH=entries/_patches/octane-new-2026-08-21-block-storm.patch \
  node scripts/vendor-entries.mjs
node scripts/verify-entries.mjs
```

## Web campaign

Run every featured entry together with the formal repetition counts:

```sh
pnpm bench run --harness web \
  --entry react,octane,octane-new-2026-08-21,vue-vdom,vue-vdom-ifr-et,vue-vapor,vue-vapor-ifr \
  --label octane-new-2026-08-21-block-web
```

The collector admits this run only if it covers the complete current featured matrix. Native is a
separate later campaign and is not inferred from the Web result.
