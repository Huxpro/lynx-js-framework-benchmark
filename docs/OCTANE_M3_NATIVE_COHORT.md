# Octane M3 Lynx 4.1 Native cohort

This is the immutable artifact and capability contract for Octane roadmap issue
`Huxpro/octane#289`. It does not contain a performance conclusion. Timings become
publishable only after the complete same-device campaign passes the runner's
matrix, lease, thermal, input, and producer-evidence gates.

## Frozen identities

| role                      | entry                  | source                                                | exact commit                               |
| ------------------------- | ---------------------- | ----------------------------------------------------- | ------------------------------------------ |
| candidate                 | `octane-m3-current`    | `Huxpro/octane:new-lynx`                              | `47c50db72a5ead917f145af259b2993cc4c97b0f` |
| latest upstream           | `octane-m3-upstream`   | `octanejs/octane:main`                                | `d5de04fb99a9a26ba9cd3844949e53d39622b5c5` |
| ReactLynx / Vue producers | six comparator entries | `Huxpro/vue-lynx:feat/unified-benchmark-framework-ui` | `8e02c0e4e25cd216df080c339cf1ccab855d2c71` |

The device lane is the official Lynx 4.1.0
`LynxExplorer-noasan-release.apk`: 173,293,606 bytes, SHA-256
`6ae29787a2166974c29c2f23d87f3b20a137abcf9a8c17903ad19f3fb7f00cb6`.
The adapter verifies all fields before installation and hashes them into the
environment and campaign identities. This lane never merges with the M0 Lynx
3.9 cohort.

M0 manifests and bundles remain byte-for-byte unchanged. M3 entries are global
`archive` entries with `tiers.native = featured`. The presence of an explicit
per-harness tier set atomically replaces only the Native cohort; Web continues
to use the existing global featured set. The M3 Native contract is eight
entries × 23 cells = 184 cells.

## Capability matrix

| entry                       | production path                                              | flags                                             | host/native-template status                                                                                                            | fallback / unsupported boundary                                                   |
| --------------------------- | ------------------------------------------------------------ | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `octane-m3-current`         | compiled JS resident program → typed direct PAPI             | universal core                                    | no Element Template backend; strict table ACK and startup receipts                                                                     | ordinary handle transport when a compact segment is live                          |
| `octane-m3-upstream`        | compiled JS PAPI                                             | upstream defaults                                 | intentionally unpatched; legacy public benchmark producer only                                                                         | missing strict cells become evidenced DNF/unsupported, never a patched “upstream” |
| `reactlynx-m3-default`      | React Compiler + normal ReactLynx renderer                   | `experimental_useElementTemplate=false`           | typed element creation, no ET protocol                                                                                                 | normal renderer                                                                   |
| `reactlynx-m3-et`           | React Compiler + ReactLynx ET runtime                        | `experimental_useElementTemplate=true`            | uses `__CreateElementTemplate`, `__CreateTypedElementTemplate`, attribute slots, element slots, refs/events, and typed-list operations | Native-only; Lynx for Web lacks typed ET PAPI                                     |
| `vue-lynx-m3-vdom-default`  | Vue VDOM → PAPI                                              | `enableIFR=false`, `enableElementTemplates=false` | no selected ET optimization                                                                                                            | background/runtime default                                                        |
| `vue-lynx-m3-vdom-ifr-et`   | Vue VDOM with main-thread IFR and generated template creator | `enableIFR=true`, `enableElementTemplates=true`   | eligible Vue ET comparator; runtime exposes whether engine-template probing is `native` or `stub`                                      | JS data/code-template path on incomplete native family                            |
| `vue-lynx-m3-vapor-default` | Vue Vapor default                                            | IFR off                                           | no selected ET optimization                                                                                                            | background/runtime default                                                        |
| `vue-lynx-m3-vapor-ifr`     | Vue Vapor IFR                                                | `enableIFR=true`, ET off                          | main-thread residual program, not an ET claim                                                                                          | IFR fallback rules remain framework-owned                                         |

On the official 4.1.0 Android lane, diagnostic probes observed both
`__CreateElementTemplate` and `__CreateTypedElementTemplate` as functions, and
ReactLynx ET completed the full semantic table protocol. That proves capability,
not speed. Vue's engine-template family additionally requires insert and
instantiate members and publishes `native` versus `stub`; formal attribution
must capture that status because a shipped symbol in a bundle is not a mechanism
hit.

## Artifact matrix and size receipt

Every entry vendors production Web and Native bundles for
`0, 1k, 2k, 3k, 5k, 10k, 20k, 30k` auto-row variants. Each manifest records the
source commit, dependency-lock digest, Node/pnpm/Rspeedy identity, configuration
capabilities, workload and build-driver hashes, platform lane, and every bundle
SHA-256. The verifier requires all row variants to encode distinct artifacts.

Uncompressed `rows-0` bundle bytes are source evidence, not a score:

| entry                       | Web bytes | Native bytes |
| --------------------------- | --------: | -----------: |
| `octane-m3-current`         |   595,514 |      578,085 |
| `octane-m3-upstream`        |   511,901 |      499,360 |
| `reactlynx-m3-default`      |   106,034 |      108,557 |
| `reactlynx-m3-et`           |    93,638 |       99,466 |
| `vue-lynx-m3-vdom-default`  |   120,943 |      124,815 |
| `vue-lynx-m3-vdom-ifr-et`   |   246,277 |      277,660 |
| `vue-lynx-m3-vapor-default` |   144,600 |      148,160 |
| `vue-lynx-m3-vapor-ifr`     |   271,206 |      308,874 |

The candidate's larger bundle is therefore an explicit cost, not hidden behind
runtime latency. Any Octane ET/default decision must improve complete create and
interaction cost while accounting for startup, GC, memory, and size; VM work
removed by shifting it to another thread or the host is not a win.

## Reproduction

```bash
BENCH_ROWS=0,1000,2000,3000,5000,10000,20000,30000 \
  node scripts/build-octane-upstream.mjs <exact-octane-checkout>

BENCH_ROWS=0,1000,2000,3000,5000,10000,20000,30000 \
  node scripts/build-vue-m3.mjs <exact-vue-lynx-checkout>

OCTANE_M3_CURRENT_BUILD=<candidate-checkout> \
OCTANE_M3_UPSTREAM_BUILD=<upstream-checkout> \
VUE_M3_BUILD=<comparator-checkout> \
  node scripts/vendor-m3-entries.mjs

node scripts/verify-entries.mjs
```

The formal Native run must use the pinned Explorer environment variables from
the root README and omit entry/case/scale filters. Checkpoints may span official
leases only through the validated same-device prefix chain. Partial probes,
DNF-as-zero, old-SDK comparators, or source-patched upstream bundles cannot
enter the M3 conclusion.
