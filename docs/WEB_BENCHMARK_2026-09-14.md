# Web benchmark campaign · 2026-09-14

This campaign refreshes the current seven-entry Web comparison. Measurements ran on
`65160668d8d9` with Chromium 149.0.7827.55 and Node 22.22.2 from 2026-09-14 through
2026-09-15 UTC. Native measurements were intentionally not refreshed.

## Source identities

| Entry | Version | Source identity |
| --- | --- | --- |
| ReactLynx | `@lynx-js/react@0.126.1`, `@lynx-js/react-rsbuild-plugin@0.20.2` | Huxpro/vue-lynx `feat/unified-benchmark-framework-ui` at `0da216caf3b474347423a8cd694d5449fa4e4215`, with the dependency-only patch in `entries/_patches/reactlynx-latest.patch` |
| Octane | 0.2.10 | octanejs/octane `main` at `8e5ca22a6e17582b4293232406a2c0420509f4a4` |
| Octane (Huxpro) | 0.1.47 | Huxpro/octane `new-lynx` at `7a523bf20d04578c39fe0b5fe532cdef6dab3e9e` |
| Vue comparators | existing current cohort | `28f7acbab990b3b574f04944e0d21c769719cc68` |

All vendored entry manifests contain the exact bundle hashes used by the receipts.

## Runs and scale coverage

Every lane used the same ordered cohort:
`react, octane, octane-hux, vue-vdom, vue-vdom-ifr-et, vue-vapor, vue-vapor-ifr`.

| Lane | Formal receipt | Extra-scale receipt | Execution |
| --- | --- | --- | --- |
| JIT | `2026-09-14T11-23-34-65160668d8d9-web-2026-09-14-jit.json` (2,540) | `2026-09-14T11-41-14-65160668d8d9-web-2026-09-14-jit-extra-scales.json` (412) | V8 JIT, unthrottled |
| Interp | `2026-09-14T13-15-36-65160668d8d9-web-2026-09-14-interp.json` (2,540) | `2026-09-14T13-38-54-65160668d8d9-web-2026-09-14-interp-extra-scales.json` (412) | Ignition-only, unthrottled |
| Interp 4x | `2026-09-15T06-20-27-65160668d8d9-web-2026-09-14-interp-4x.json` (2,540) | `2026-09-15T08-36-18-65160668d8d9-web-2026-09-14-interp-4x-extra-scales.json` (412) | Ignition-only, inherited process cgroup |

The formal runs cover table, pipeline, storm, startup, memory, and static bundle metrics at their
default scales. The supplemental runs add `create` at 3k, 5k, 20k, and 30k. The resulting current
dataset therefore exposes create at 1k, 3k, 5k, 10k, 20k, and 30k in all three lanes; startup covers
0, 1k, 10k, and 30k.

The two Interp 4x runs used adaptive cgroup quotas of 29.79% and 31.02%. Those physical settings
remain in their execution receipts. Each entry independently passed the required 3.5–4.5x
slowdown gate: 3.74–4.18x in the formal run and 3.65–3.84x in the supplemental run. Adaptive quota
is excluded from the logical cohort hash because the nominal lane, process-cgroup scope, and
per-record verified slowdown already define and prove the comparison environment.

## Selected medians

Milliseconds, lower is better:

| Entry | Lane | create 30k | startup FCP 30k |
| --- | --- | ---: | ---: |
| ReactLynx 0.126.1 | JIT | 3,598.8 | 3,153.8 |
| ReactLynx 0.126.1 | Interp | 7,742.2 | 6,127.8 |
| ReactLynx 0.126.1 | Interp 4x | 43,198.4 | 32,695.4 |
| Octane | JIT | 3,832.8 | 4,979.6 |
| Octane | Interp | 6,646.7 | 9,876.9 |
| Octane | Interp 4x | 40,878.4 | 50,812.1 |
| Octane (Huxpro) | JIT | 3,111.4 | 2,796.1 |
| Octane (Huxpro) | Interp | 5,506.9 | 4,647.8 |
| Octane (Huxpro) | Interp 4x | 33,976.2 | 26,604.9 |

## Integrity notes

- All six retained receipts have zero dynamic execution DNFs. Every table cell has seven accepted
  samples and every startup cell has five.
- Storm `final-state` passed 3/3. The `every-tick` rows observed 0/3 contract passes, an explicit
  coalescing outcome retained as descriptive evidence rather than an execution DNF.
- The Interp formal receipts exposed a runner metadata bug: pipeline and storm emitters defaulted
  their record environment to JIT. Their 1,596 affected records in each formal Interp receipt were
  normalized from the authoritative run-level environment and per-entry throttle verification;
  no samples, values, or outcomes changed. The CLI now canonicalizes every dynamic Web record from
  the authoritative run environment, with a regression test that covers emitter defaults.
- `results/latest.json` was regenerated from the source receipts. The current comparison contains
  all seven Web entries and preserves the prior Native campaign unchanged; the refreshed
  Web-only Octane entries intentionally have no new Native measurements.
