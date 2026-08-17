# Vue Vapor lab review staging

The implementation is split into three ordered, non-overlapping units.

## Unit 1: Runner Web lab root

- `packages/runner/src/path-safety.mjs`
- `packages/runner/src/run-files.mjs`
- `packages/runner/src/lab-artifacts.mjs`
- `packages/runner/src/cli.mjs`
- `packages/runner/src/collect.mjs`
- `packages/runner/src/harness-web.mjs`
- `packages/runner/src/lab.test.mjs`
- `docs/VUE_VAPOR_LAB_REVIEW.md`

This unit owns safe paths and labels, exclusive run-file creation, reusable lab artifact and
live-runner verification, receipt-cohort metadata, exact lab startup scales, and
commit/fingerprint-aware collection.

## Unit 2: Vue build, receipt, and verifier

- `scripts/vue-featured-plan.mjs`
- `scripts/build-vue-featured.mjs`
- `scripts/lab/vue-vapor-entry.mjs`
- `scripts/lab/verify-vue-vapor-lab.mjs`
- `scripts/lab/vue-vapor-lab.test.mjs`
- `docs/VUE_VAPOR_LAB.md`
- `README.md`
- `package.json`

This unit depends on unit 1. It creates the Vue-specific receipt and manifest, provides the thin
verifier CLI wrapper, documents the core Web workflow, and wires the Vue tests into `pnpm test`.

## Unit 3: Optional A/B/B/A helper

- `scripts/lab/vue-vapor-abba.mjs`
- `scripts/lab/vue-vapor-abba.test.mjs`
- `docs/VUE_VAPOR_ABBA.md`

This unit depends on units 1 and 2. It can be omitted without changing entry generation,
verification, runner behavior, or collection.

## Unit 4: Optional Native lab execution

- `packages/runner/src/native-run.mjs`
- `packages/runner/src/harness-native.mjs`
- `packages/runner/src/native-lab.test.mjs`
- `packages/runner/src/cli.mjs`
- `packages/runner/src/collect.mjs`
- `docs/VUE_VAPOR_LAB.md`
- `docs/VUE_VAPOR_NATIVE_LAB.md`
- `docs/VUE_VAPOR_LAB_REVIEW.md`

This unit applies after the reviewed three-unit Web stack. It reuses the existing adapter
contract, receipt verifier, run-file writer, and collector. It adds no adapter and can be
reviewed without leasing a device.
