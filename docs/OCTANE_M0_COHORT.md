# Octane roadmap M0 cohort recipe

This recipe freezes the source-built comparison cohort for
[Huxpro/octane#282](https://github.com/Huxpro/octane/issues/282). It is identity
and correctness evidence only; it contains no formal performance claim.

## Frozen identities

| Role | Entry | Source commit | Configuration |
| --- | --- | --- | --- |
| historical reference | `octane-history-0fc84da0` | `0fc84da02fd05403ac5e36d2aff631b31168d5ac` | archived upstream artifact |
| M0 current fork | `octane-m0-current` | `e82160fc0e663f52848e2181d83c6203d633bc86` | production default |
| latest upstream at campaign start | `octane-m0-upstream` | `184631809c8eb61f5bbf15fa23b2470c1d38eea6` | production default |
| ReactLynx default | `reactlynx-0-126-default` | `db60b3d32c4253400d0ae3b259ebf522ffdf859d` | ReactLynx 0.126.0, ET off |
| ReactLynx optimized | `reactlynx-0-126-et` | `db60b3d32c4253400d0ae3b259ebf522ffdf859d` | ReactLynx 0.126.0, ET on |
| Vue VDOM default / optimized | `vue-lynx-0-5-vdom-*` | `db60b3d32c4253400d0ae3b259ebf522ffdf859d` | Vue 3.6.0-beta.17 / vue-lynx 0.5.1, off or IFR+ET |
| Vue Vapor default / optimized | `vue-lynx-0-5-vapor-*` | `db60b3d32c4253400d0ae3b259ebf522ffdf859d` | Vue 3.6.0-beta.17 Vapor / vue-lynx 0.5.1, off or IFR |

The comparator source commit is merged into
`feat/unified-benchmark-framework-ui@8b8b81d374fdd680b664ead86c3ea240ba47c7eb`.
Every later optimization candidate gets a new entry and exact source commit;
the M0 baseline is not renamed into the candidate.

ReactLynx ET is Native-only. Its production Web bundle calls
`__CreateTypedElementTemplate`, which Lynx for Web 0.22.1 does not expose; the
same PAPI is also absent from the inspected 0.26.0 package. The manifest keeps
the Web artifact hash and the explicit unsupported reason. TASM 0.0.49 decode
confirms that the Native artifact contains the Element Template backend.

## Rebuild

Use clean detached worktrees at the commits above. Install each source with its
locked package manager, then build the exact row ladder:

```bash
BENCH_ROWS=0,1000,2000,3000,5000,10000 \
  node scripts/build-octane-upstream.mjs <octane-checkout>

BENCH_PROFILE=m0 BENCH_ROWS=0,1000,2000,3000,5000,10000 \
  node scripts/build-vue-featured.mjs <vue-lynx-checkout>

OCTANE_M0_CURRENT_BUILD=<current-checkout> \
OCTANE_M0_UPSTREAM_BUILD=<upstream-checkout> \
VUE_M0_BUILD=<vue-lynx-checkout> \
  node scripts/vendor-m0-entries.mjs
```

The 1k/2k/3k/5k/10k diagnostic bulk ladder is the production
`BENCH_AUTOROWS` mount-create path. It does not depend on a non-standard 2k
button and is not an extra interaction-score cell. The formal interaction
score still uses the exact nine frozen js-framework cells.

`vendor-m0-entries.mjs` rejects a dirty or wrong-commit source checkout and any
row-scale hash collision. Each manifest records source/merge commit, lockfile,
Node/pnpm/Rspeedy, configuration capability, build-driver and runner contract,
and all Web/Native bundle hashes.

## Verify

```bash
node scripts/verify-entries.mjs
pnpm bench collect
node scripts/verify-collect.mjs
pnpm test
pnpm site:build
pnpm bench preflight
```

The first Chromium correctness smoke is `create@1000` with one diagnostic
repetition for every Web-capable M0 entry. All seven entries completed with
row-count and memory observations. Those one-shot timings are not rankings and
must not enter an AB/BA claim. Formal M0 measurements use the frozen scorecard,
same-window order-balanced sessions, and raw run receipts.
