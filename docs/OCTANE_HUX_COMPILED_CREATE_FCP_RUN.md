# Octane Hux compiled-create + FCP run (2026-09-01)

This is the execution receipt for the featured `octane-hux` refresh. The tested source is the
two-parent composite `d7d2117a227685ceeffcb4659631b8f70853be02` over `new-lynx`, with these
immutable PR-head inputs:

- PR #269: `b166e43f9a59864c1c887f24e8448d6014542631`;
- PR #272 stack head, including #270/#271:
  `66ff34a3f50d6b53fdb7b55e594c4fa11e4bfe6f`.

Web bundles came from the clean composite. Native bundles came from the same composite plus the
checksum-verified benchmark-app instrumentation in
`entries/_patches/octane-hux-native-bench.patch`; no Octane runtime source was changed.

## Web

The formal run is
[`2026-09-01T13-18-29-65160668d8d9-octane-hux-compiled-create-fcp-web-isolated-pages.json`](../results/runs/2026-09-01T13-18-29-65160668d8d9-octane-hux-compiled-create-fcp-web-isolated-pages.json).
It contains all seven featured entries, all scales, 2,540 source records, seven table/pipeline
samples, three storm samples per policy, and five startup samples. There are no DNF cells.

Table and pipeline repetitions used an identical isolated-page lifecycle for every entry: open a
fresh page, perform two untimed create/clear warmups, prepare the workload state, measure once, and
close it. This was necessary because cumulative repeated operations could remove the static
toolbar in both clean and instrumented composite builds. The lifecycle change keeps that state
outside the formal sample instead of adding an Octane-specific workaround.

Selected `octane-hux` Web medians (ms):

| workload | scale | median |
| --- | ---: | ---: |
| create | 1k | 115.3 |
| create | 10k | 1,152.4 |
| replace | 1k | 244.3 |
| append 1k | 1k | 165.8 |
| update every 10th | 1k / 10k | 31.3 / 179.2 |
| select | 1k / 10k | 23.5 / 68.6 |
| startup FCP | 0 / 1k / 10k / 30k | 55.5 / 234.8 / 1,420.4 / 4,425.3 |

## Native

The completed run is
[`2026-09-01T13-21-37-lynx-native-android-aries_10-10-devtool-direct-recycle5-8144b5f980a7-6d00918a8d18-native-octane-hux-compiled-create-fcp-native-bounded.json`](../results/runs/2026-09-01T13-21-37-lynx-native-android-aries_10-10-devtool-direct-recycle5-8144b5f980a7-6d00918a8d18-native-octane-hux-compiled-create-fcp-native-bounded.json).
It completed the exact six-entry, 138-cell matrix
`5d398f4cf7975b3d8cce81310b4723ef4c11f65ca3029bc7b1d503d94184b115` on one
Android 10 `aries_10` physical-device cohort across two official leases. The raw ADB serial is not
persisted; the run retains its SHA-256, ordered lease receipts, and per-cell lease attribution.

The deliberately bounded formal policy used 15s control, 60s long-workload, 30s reconnect, and
120s thermal-gate timeouts with two transport attempts. It is versioned in the campaign receipt
rather than being silently treated as the default policy.

Coverage is complete even though successful Native data is sparse:

| entry | measured | measured + DNF | DNF only | samples | DNF attempts |
| --- | ---: | ---: | ---: | ---: | ---: |
| Octane (Hux) | 2 | 0 | 21 | 6 | 93 |
| ReactLynx | 7 | 4 | 12 | 39 | 60 |
| Vue Vapor | 2 | 2 | 19 | 12 | 87 |
| Vue Vapor + IFR | 7 | 3 | 13 | 40 | 59 |
| Vue VDOM | 7 | 2 | 14 | 40 | 59 |
| Vue VDOM + IFR + ET | 12 | 0 | 11 | 60 | 39 |
| **Total** | **37** | **11** | **90** | **197** | **397** |

For `octane-hux`, rows=0 startup produced three valid samples for both custom metrics:
`octaneCommitAck` median 180.5ms and `octaneSecondFrame` median 201.5ms. All 15 table cells ended
as `transport-retries-exhausted`; startup at 1k/10k/30k failed strict producer validation and is
`producer-protocol-invalid`. These are explicit DNF records—no Web result, interpolation, or
extrapolation fills them.
