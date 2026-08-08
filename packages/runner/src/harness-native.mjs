// Native-engine harness: the preserved capability, explicitly separated from
// the web harness (docs/DESIGN.md "Harnesses").
//
// Every entry ships `main.lynx.bundle` alongside its web bundle, and the
// result schema carries `harness: "native"` end to end, so native numbers can
// flow through collect/site the moment an adapter exists. What does NOT exist
// yet is an automated device driver — the unified benchmark this repo
// descends from validated native behavior manually (LynxExplorer + traces)
// and never had one either.
//
// An adapter implements:
//   loadBundle(entry, {rows})   install/launch main.lynx.bundle on the device
//   driveCase(kase, scale)      dispatch the same workload contract (taps by
//                               label/cell, storms in-app) — e.g. via
//                               lynx-devtool CDP (Input domain) or agent-device
//   collect()                   per-op timing from the Lynx timing API
//                               (markTiming pipelines), plus native wire stats
//                               if the engine exposes them
//
// Records emitted by an adapter MUST use harness:"native" and an environment
// naming the device class (e.g. "lynx-native-ios-sim"). They are never
// comparable with web records — COMPARABILITY_KEYS enforces this.

export async function runNativeHarness() {
  throw new Error(
    'native harness: no device adapter is wired yet. Entries keep main.lynx.bundle '
    + 'and the schema reserves harness:"native"; see packages/runner/src/harness-native.mjs '
    + 'for the adapter contract.',
  );
}
