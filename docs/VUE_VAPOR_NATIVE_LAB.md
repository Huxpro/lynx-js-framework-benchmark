# Vue Vapor Native lab

This optional fourth unit extends the receipted Vue Vapor lab to the existing Native adapter
contract. It does not add a new device adapter or change the formal Native workflow.

## Run

```bash
pnpm bench run \
  --lab-root .tmp/vue-vapor-lab \
  --entry vue-vapor-baseline \
  --harness native \
  --adapter packages/runner/adapters/lynx-sandbox-android.mjs \
  --suite startup \
  --scale 10000 \
  --startup-reps 3 \
  --label native-a1
```

`--adapter` is required for a Native lab run. The runner verifies all selected manifests,
receipts, patches, and bundles before importing the adapter or doing device work. Table runs
require the `rows-0` Lynx bundle. Startup runs require a Lynx bundle for every explicitly
requested scale.

Unlike the formal Native defaults, a Native lab run uses exactly the requested table and startup
scales. For example, `--suite startup --scale 10000` loads only `rows-10000`. A rows=0-only entry
can therefore run table cases or `startup@0`, but cannot run nonzero startup scales.

After the adapter finishes and disposes the device, the runner re-verifies each pinned entry and
the live benchmark worktree before writing the run. The raw Native run is written below
`<lab-root>/results/runs/` with:

- `entryCommits`;
- `entryArtifacts` receipt cohorts;
- `benchmarkWorktree`;
- `harness: "native"` and the resolved adapter path.

The filename includes milliseconds, the machine/device ID, the `native` marker, and the optional
safe label. Creation is exclusive. Unless `--no-collect` is passed, collection writes only
`<lab-root>/results/latest.json`.

Lab collection preserves receipt cohorts and reuses the existing Native one-device selection:
split runs may combine only inside one machine/environment cohort, and current manifest commits
and receipt fingerprints must match. A Native-only lab result is allowed; formal collection
continues to require its existing Web featured comparison.

## Boundaries

- No device is leased or contacted by the tests. Native lab tests use the existing adapter
  contract with deterministic stubs.
- This unit does not make Web and Native records comparable.
- It does not add Native lab support to the A/B/B/A helper.
- Receipts remain auditable local records, not signed or hermetic attestations.
