import { LIST_CASES } from './list-workloads.mjs';

export const NATIVE_DIAGNOSTIC_ENTRY_ID = 'octane-native-diagnostic';
export const NATIVE_CAPACITY_BUILD_PROTOCOL = 'octane-native-diagnostic-build-v3';
export const NATIVE_CAPACITY_CONTRACT_VERSION = 'native-eager-capacity-v2';
export const NATIVE_CAPACITY_OUTCOME_PROTOCOL = 'native-capacity-outcomes-v1';
export const NATIVE_CAPACITY_SUITE = 'native-capacity';
export const REPORTABILITY_PROTOCOL = 'accepted-sample-minimum-v1';
export const DEFAULT_MIN_ACCEPTED_SAMPLES = 5;
export const NATIVE_DIAGNOSTIC_BUILD_RECEIPT_PATH =
  'benchmarks/lynx-list/app/dist/octane-native-diagnostic-build.json';
export const NATIVE_DIAGNOSTIC_TABLE_PROVENANCE_PATH = 'table/main.lynx.bundle';
export const NATIVE_DIAGNOSTIC_EMPTY_TABLE_BUNDLE =
  `dist/${NATIVE_DIAGNOSTIC_TABLE_PROVENANCE_PATH}`;
export const NATIVE_DIAGNOSTIC_BUILD_TABLE_PATH =
  'benchmarks/lynx-table/app/dist/main.lynx.bundle';
export const NATIVE_CAPACITY_FIXTURE_PROTOCOL = 'lynx-native-capacity-fixture-v1';
export const NATIVE_CAPACITY_FIXTURE_ROLE = 'eager-capacity-probe';
export const NATIVE_LIST_FIXTURE_ROLE = 'bounded-native-list';
export const NATIVE_LIST_FIXTURE_ID = 'octane-lynx-bounded-list-v1';
export const NATIVE_STARTUP_PROTOCOL = 'lynx-native-startup-v1';

export const NATIVE_CAPACITY_DEFAULT_SCALES = Object.freeze([1_000, 10_000]);
export const NATIVE_CAPACITY_THRESHOLD_SCALES = Object.freeze([6_000, 7_000, 7_500, 8_000]);
export const NATIVE_CAPACITY_SCALES = Object.freeze([
  ...NATIVE_CAPACITY_DEFAULT_SCALES,
  ...NATIVE_CAPACITY_THRESHOLD_SCALES,
].sort((left, right) => left - right));
export const NATIVE_LIST_SCALES = Object.freeze([...new Set(
  LIST_CASES.flatMap((kase) => kase.scales),
)].sort((left, right) => left - right));
export const NATIVE_CAPACITY_TOPOLOGY = Object.freeze({
  elementsPerRow: 7,
  chromeElements: 42,
});

export const nativeCapacityBundlePath = (scale) =>
  `dist/capacity/rows-${scale}/main.lynx.bundle`;
export const nativeCapacityProvenancePath = (scale) =>
  `capacity/rows-${scale}/main.lynx.bundle`;
export const nativeCapacityBuildPath = (scale) =>
  `benchmarks/lynx-table/app/dist-rows${scale}/main.lynx.bundle`;
export const nativeListBundlePath = (scale) =>
  `dist/list/rows-${scale}/main.lynx.bundle`;
export const nativeListProvenancePath = (scale) =>
  `list/rows-${scale}/main.lynx.bundle`;
export const nativeListBuildPath = (scale) =>
  `benchmarks/lynx-list/app/dist/rows-${scale}/main.lynx.bundle`;

/** Validate the shared, immutable manifest identity without reading mutable bytes. */
export function assertNativeDiagnosticManifest(manifest) {
  const receipt = manifest?.provenance?.buildReceipt;
  const checks = manifest?.provenance?.sha256;
  if (manifest?.id !== NATIVE_DIAGNOSTIC_ENTRY_ID
    || manifest.tier !== 'lab'
    || !Array.isArray(manifest.harnesses)
    || manifest.harnesses.length !== 1
    || manifest.harnesses[0] !== 'native'
    || manifest.bundles?.lynx !== NATIVE_DIAGNOSTIC_EMPTY_TABLE_BUNDLE
    || receipt?.protocol !== NATIVE_CAPACITY_BUILD_PROTOCOL
    || JSON.stringify(Object.keys(receipt?.artifacts ?? {}))
      !== JSON.stringify(['table', 'capacity', 'list'])
    || receipt.artifacts.table?.path !== NATIVE_DIAGNOSTIC_BUILD_TABLE_PATH
    || !/^[a-f0-9]{64}$/.test(receipt.artifacts.table?.sha256 ?? '')
    || checks?.[NATIVE_DIAGNOSTIC_TABLE_PROVENANCE_PATH] !== receipt.artifacts.table.sha256
    || JSON.stringify(Object.keys(receipt.artifacts.list ?? {}))
      !== JSON.stringify(NATIVE_LIST_SCALES.map(String))) {
    throw new Error(
      `capacity diagnostic entry must be ${NATIVE_DIAGNOSTIC_ENTRY_ID}, lab-tier, Native-only, `
      + `use ${NATIVE_DIAGNOSTIC_EMPTY_TABLE_BUNDLE}, and declare `
      + `${NATIVE_CAPACITY_BUILD_PROTOCOL}.`,
    );
  }
  for (const scale of NATIVE_LIST_SCALES) {
    const artifact = receipt.artifacts.list[String(scale)];
    if (artifact?.path !== nativeListBuildPath(scale)
      || !/^[a-f0-9]{64}$/.test(artifact?.sha256 ?? '')
      || checks?.[nativeListProvenancePath(scale)] !== artifact.sha256) {
      throw new Error(
        `capacity diagnostic entry has an invalid ${scale}-row Native list artifact.`,
      );
    }
  }
  const fixture = manifest.capacityFixture;
  if (fixture?.protocol !== NATIVE_CAPACITY_FIXTURE_PROTOCOL
    || fixture.fixtureRole !== NATIVE_CAPACITY_FIXTURE_ROLE
    || fixture.topology?.elementsPerRow !== NATIVE_CAPACITY_TOPOLOGY.elementsPerRow
    || fixture.topology?.chromeElements !== NATIVE_CAPACITY_TOPOLOGY.chromeElements
    || Object.keys(fixture.topology ?? {}).length !== Object.keys(NATIVE_CAPACITY_TOPOLOGY).length
    || JSON.stringify(Object.keys(fixture.scales ?? {}))
      !== JSON.stringify(NATIVE_CAPACITY_SCALES.map(String))
    || JSON.stringify(Object.keys(receipt.artifacts.capacity ?? {}))
      !== JSON.stringify(NATIVE_CAPACITY_SCALES.map(String))) {
    throw new Error('capacity diagnostic entry has an invalid capacityFixture contract.');
  }
  for (const scale of NATIVE_CAPACITY_SCALES) {
    const artifact = fixture.scales[String(scale)];
    const expectedSha256 = artifact?.sha256;
    if (artifact?.bundle !== nativeCapacityBundlePath(scale)
      || !/^[a-f0-9]{64}$/.test(expectedSha256 ?? '')
      || checks?.[nativeCapacityProvenancePath(scale)] !== expectedSha256
      || receipt.artifacts.capacity[String(scale)]?.path !== nativeCapacityBuildPath(scale)
      || receipt.artifacts.capacity[String(scale)]?.sha256 !== expectedSha256) {
      throw new Error(
        `capacity diagnostic entry has an invalid ${scale}-row capacity artifact or bundle checksum.`,
      );
    }
  }
  return manifest;
}
