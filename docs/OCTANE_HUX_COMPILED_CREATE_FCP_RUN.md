# Octane Hux compiled-create + FCP run (Web 2026-09-01, Native 2026-09-03)

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

The replacement formal run is
[`2026-09-03T01-07-30-lynx-native-android-aries_10-10-devtool-direct-recycle5-29c31bcb2d85-c3300d1168b0-native-octane-hux-compiled-create-fcp-native-formal-v2-recovered.json`](../results/runs/2026-09-03T01-07-30-lynx-native-android-aries_10-10-devtool-direct-recycle5-29c31bcb2d85-c3300d1168b0-native-octane-hux-compiled-create-fcp-native-formal-v2-recovered.json).
It completed the exact six-entry, 138-cell matrix
`5d398f4cf7975b3d8cce81310b4723ef4c11f65ca3029bc7b1d503d94184b115` on one
Android 10 `aries_10` physical-device cohort across four official leases. The raw ADB serial is not
persisted; the run retains its SHA-256, ordered lease receipts, per-cell lease attribution, and the
complete method-revision chain.

The formal policy used 15s control, 240s long-workload, 30s reconnect, and 60s thermal-gate
timeouts with one transport attempt. It is versioned in the campaign receipt rather than being
silently treated as the default policy.

The first 69 cells exposed a runner defect: after a DevTool transport failure closed the direct
Connector, later cells inherited the same closed object and failed immediately. The adapter now
disposes that transport and builds a fresh Connector/AndroidTransport stack before the next bundle.
The checkpoint transition is explicitly pinned as method revision
`connector-reset-after-transport-dnf-20260903`; the base and replacement input receipts, the exact
69-cell prefix, and both revision IDs remain in the run artifact. No measured cell was rewritten.

Coverage is complete, and the new run materially improves usable Native data:

| entry | measured | measured + DNF | DNF only | samples | DNF attempts |
| --- | ---: | ---: | ---: | ---: | ---: |
| Octane (Hux) | 9 | 2 | 12 | 40 | 59 |
| ReactLynx | 16 | 0 | 7 | 72 | 27 |
| Vue Vapor | 11 | 1 | 11 | 57 | 42 |
| Vue Vapor + IFR | 11 | 1 | 11 | 59 | 40 |
| Vue VDOM | 3 | 2 | 18 | 21 | 78 |
| Vue VDOM + IFR + ET | 10 | 2 | 11 | 56 | 43 |
| **Total** | **60** | **8** | **70** | **305** | **289** |

For `octane-hux`, the Native table now has ranked measurements instead of blanket transport DNF:

| workload | scale | median | valid / attempts | rank |
| --- | ---: | ---: | ---: | ---: |
| create | 1k | 15,941ms | 5 / 5 | 6 / 6 |
| create | 3k | 137,776ms | 5 / 5 | 6 / 6 |
| create | 5k | 226,777ms | 1 / 5 | 6 / 6 |
| replace | 1k | 16,141ms | 5 / 5 | 5 / 5 |
| update every 10th | 1k | 224ms | 5 / 5 | 5 / 5 |
| select | 1k | 109ms | 5 / 5 | 4 / 5 |
| swap | 1k | 189ms | 2 / 5 | 5 / 5 |

Startup also measures `octaneCommitAck` / `octaneSecondFrame` at 0 rows (161 / 186ms) and 1k rows
(43,365 / 43,384ms), three valid samples each. These Octane-specific boundaries are displayed as
measurements, not cross-framework FCP ranks. Create at 10k/20k/30k timed out; append reported a
producer runtime error; dependent large-state operations are explicit `unreachable-prestate` DNF.
No Web result, interpolation, or extrapolation fills them.

### Ranking takeaway

Web ranking is unchanged because the already-complete formal Web run and all of its inputs are
unchanged. Native now has a publishable complete cohort. Its complete seven-operation 1k aggregate
expands from two eligible entries to four: Vue Vapor + IFR remains first (1.185x), Vue Vapor enters
second (1.197x), Vue VDOM + IFR + ET moves from second to third (1.966x), and ReactLynx enters
fourth (3.280x). Octane and Vue VDOM remain outside that aggregate because each lacks at least one
required 1k operation; the 10k aggregate remains unavailable for every entry. Octane's seven cell
ranks above are nevertheless formal same-cohort ranks.

The comparison remains black-box at the framework boundary: the runner drives and observes every
bundle through the same Native adapter. The bundles do expose a benchmark completion protocol;
React/Vue already carried it through their shared benchmark-app patch, while Octane's checksum-
verified patch adds it to the benchmark app without modifying the Octane runtime. The prior all-
Octane failure pattern was therefore not evidence that black-box comparison was impossible: the
closed-Connector cascade was a harness defect, while the remaining timeouts and producer failures
are real measured limitations of this Octane head on the selected device and policy.
