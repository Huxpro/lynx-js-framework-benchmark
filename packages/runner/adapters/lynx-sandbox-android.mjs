import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { TransformStream } from 'node:stream/web';

import {
  CREATE_BUTTON,
  STORM_SELECT_TICKS,
  STORM_UPDATE_TICKS,
} from '@lynx-bench/shared/workloads';
import {
  NATIVE_STARTUP_PROTOCOL,
  NATIVE_COMPATIBLE_TABLE_PROTOCOLS,
  NATIVE_DRIVER_TABLE_BOUNDARY,
  NATIVE_TABLE_BOUNDARY,
  NATIVE_TABLE_PROTOCOL,
  NATIVE_TABLE_SETTLEMENT_CONTRACT,
} from '../src/native-inputs.mjs';
import {
  NATIVE_SANDBOX_POLICY,
  assertNativeLeaseReceipt,
  buildNativeDeviceCohort,
  nativeSerialSha256,
} from '../src/native-protocol.mjs';
import {
  assertConnectorPackageTrees,
  assertConnectorPackageTreesMatch,
  resolveConnectorPackageTrees,
} from '../src/connector-receipt.mjs';

const DEFAULT_PORT = 8765;
const {
  defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
  longWorkloadTimeoutMs: LONG_WORKLOAD_TIMEOUT_MS,
  renderGraceFrames: RENDER_GRACE_FRAMES,
  thermalPollMs: THERMAL_POLL_MS,
  tapSettleMs: TAP_SETTLE_MS,
  explorerLaunchSettleMs: EXPLORER_LAUNCH_SETTLE_MS,
  startupPollMs: STARTUP_POLL_MS,
  octaneTriggerMode: OCTANE_TRIGGER_MODE,
  devtoolTransport: DEVTOOL_TRANSPORT_MODE,
  debugRouterSettleMs: ROUTER_SETTLE_MS,
  explorerRecycleEveryPages: EXPLORER_RECYCLE_EVERY_PAGES,
  maxBatteryTemperatureC: MAX_BATTERY_TEMPERATURE_C,
  thermalGateTimeoutMs: THERMAL_GATE_TIMEOUT_MS,
  explorerReconnectTimeoutMs: EXPLORER_RECONNECT_TIMEOUT_MS,
} = NATIVE_SANDBOX_POLICY;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function loadConnectorModule() {
  try {
    const connector = await import('@byted/agent-lynx/connector');
    if (typeof connector.createDefaultConnector !== 'function') {
      throw new TypeError('module does not export createDefaultConnector().');
    }
    if (typeof connector.AndroidTransport !== 'function') {
      throw new TypeError('module does not export AndroidTransport.');
    }
    return connector;
  } catch (error) {
    throw new Error(
      'lynx sandbox adapter requires device-only @byted/agent-lynx; make it resolvable from packages/runner using the ByteDance registry before running --harness native.',
      { cause: error },
    );
  }
}

function adb(serial, ...args) {
  return execFileSync('adb', ['-s', serial, ...args], { encoding: 'utf8' }).trim();
}

function calibrateDeviceClock(serial) {
  let best = null;
  for (let index = 0; index < NATIVE_SANDBOX_POLICY.deviceClockCalibrationSamples; index++) {
    const before = Date.now();
    const deviceNow = Number(adb(serial, 'shell', 'date', '+%s%3N'));
    const after = Date.now();
    if (!Number.isFinite(deviceNow)) continue;
    const sample = {
      rttMs: after - before,
      offsetMs: deviceNow - (before + after) / 2,
    };
    if (best === null || sample.rttMs < best.rttMs) best = sample;
  }
  if (best === null) throw new Error('could not calibrate Sandbox device clock.');
  return best;
}

function readThermalState(serial) {
  const battery = adb(serial, 'shell', 'dumpsys', 'battery');
  const thermal = adb(serial, 'shell', 'dumpsys', 'thermalservice');
  const batteryTemperature = /\btemperature:\s*(-?\d+)/.exec(battery);
  const thermalStatus = /\bThermal Status:\s*(\d+)/.exec(thermal);
  const temperatureRows = [...thermal.matchAll(
    /Temperature\{mValue=(-?\d+(?:\.\d+)?), mType=(\d+), mName=([^,}]+), mStatus=(\d+)\}/g,
  )].map((match) => ({
    valueC: Number(match[1]),
    type: Number(match[2]),
    name: match[3],
    status: Number(match[4]),
  }));
  const temperatures = [...new Map(temperatureRows.map((temperature) => [
    `${temperature.type}\0${temperature.name}`,
    temperature,
  ])).values()];
  return {
    capturedAt: new Date().toISOString(),
    batteryTemperatureC: batteryTemperature ? Number(batteryTemperature[1]) / 10 : null,
    thermalStatus: thermalStatus ? Number(thermalStatus[1]) : null,
    temperatures,
  };
}

async function waitForThermalReady(serial) {
  const deadline = Date.now() + THERMAL_GATE_TIMEOUT_MS;
  let state;
  do {
    state = readThermalState(serial);
    const statusReady = state.thermalStatus === null || state.thermalStatus === 0;
    const temperatureReady = state.batteryTemperatureC === null
      || state.batteryTemperatureC <= MAX_BATTERY_TEMPERATURE_C;
    if (statusReady && temperatureReady) return state;
    await delay(THERMAL_POLL_MS);
  } while (Date.now() < deadline);
  throw new Error(
    `Sandbox thermal gate timed out after ${THERMAL_GATE_TIMEOUT_MS}ms: ${JSON.stringify(state)}`,
  );
}

function readExplorerPackageVersion(serial) {
  const output = adb(serial, 'shell', 'dumpsys', 'package', 'com.lynx.explorer');
  return {
    versionName: /\bversionName=([^\s]+)/.exec(output)?.[1] ?? null,
    versionCode: Number(/\bversionCode=(\d+)/.exec(output)?.[1] ?? NaN) || null,
  };
}

function startBundleServer(port, getBundle) {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
    if (url.pathname !== '/main.lynx.bundle') {
      response.writeHead(404).end('not found');
      return;
    }
    const bundle = getBundle();
    if (!bundle?.bytes) {
      response.writeHead(503).end('bundle not ready');
      return;
    }
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/octet-stream',
      'Content-Length': bundle.bytes.length,
      'X-Lynx-Bench-Sha256': bundle.sha256,
    });
    response.end(bundle.bytes);
    bundle.served = (bundle.served ?? 0) + 1;
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function center(quad) {
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  return {
    x: (Math.min(...xs) + Math.max(...xs)) / 2,
    y: (Math.min(...ys) + Math.max(...ys)) / 2,
  };
}

function bounds(quad) {
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  return {
    left: Math.min(...xs),
    right: Math.max(...xs),
    top: Math.min(...ys),
    bottom: Math.max(...ys),
  };
}

function timingName(kase) {
  return kase.name === 'replace' ? 'create' : kase.name;
}

export function nativePostStateMatches(kase, scale, before, snapshot, {
  allowAnySelection = false,
} = {}) {
  if (!snapshot || !Number.isInteger(snapshot.rowCount)) return false;
  switch (kase.name) {
    case 'create': return snapshot.rowCount === scale;
    case 'replace': return snapshot.rowCount === scale && snapshot.firstId !== before?.firstId;
    case 'append1k': return snapshot.rowCount === scale + 1000;
    case 'update10th': return snapshot.rowCount === scale && snapshot.firstLabel?.endsWith(' !!!');
    case 'select': return snapshot.rowCount === scale
      && snapshot.selectedId != null
      && (allowAnySelection || snapshot.selectedId === before?.secondId);
    case 'swap': return snapshot.rowCount === scale
      && snapshot.secondId === before?.row998Id
      && snapshot.row998Id === before?.secondId;
    case 'remove': return snapshot.rowCount === scale - 1 && snapshot.thirdId !== before?.thirdId;
    case 'clear': return snapshot.rowCount === 0;
    case 'updateStorm': return snapshot.rowCount === scale && snapshot.firstLabel === 'bench 50';
    case 'selectStorm': return snapshot.rowCount === scale && snapshot.selectedId === snapshot.firstId;
    default: throw new Error(`no Native post-action predicate for ${kase.name}.`);
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function assertFinite(value, label) {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite.`);
}

function validateState(state, label) {
  assertObject(state, label);
  if (!Number.isInteger(state.rowCount) || state.rowCount < 0) {
    throw new Error(`${label}.rowCount must be a non-negative integer.`);
  }
  for (const key of ['firstId', 'secondId', 'thirdId', 'row998Id', 'selectedId']) {
    if (state[key] !== null && !Number.isInteger(state[key])) {
      throw new Error(`${label}.${key} must be an integer or null.`);
    }
  }
  if (state.firstLabel !== null && typeof state.firstLabel !== 'string') {
    throw new Error(`${label}.firstLabel must be a string or null.`);
  }
  return state;
}

function expectedStormTicks(name) {
  if (name === 'updateStorm') return STORM_UPDATE_TICKS;
  if (name === 'selectStorm') return STORM_SELECT_TICKS;
  return null;
}

function validateNativeTablePayloadUnchecked(payload, {
  entryId,
  expectedName,
  expectedSource,
  renderGraceFrames = RENDER_GRACE_FRAMES,
  allowProducerReceipt = false,
} = {}) {
  assertObject(payload, 'Native table payload');
  const legacyTwoFrameProducer = payload.protocol === 'lynx-native-bench-v2'
    && entryId !== 'octane';
  if (payload.protocol !== NATIVE_TABLE_PROTOCOL && !legacyTwoFrameProducer) {
    throw new Error(
      `Native table payload protocol ${JSON.stringify(payload.protocol)} is not compatible with ${NATIVE_COMPATIBLE_TABLE_PROTOCOLS.join(', ')}.`,
    );
  }
  if (payload.name !== expectedName) {
    throw new Error(`Native table payload name ${JSON.stringify(payload.name)} does not match ${expectedName}.`);
  }
  if (payload.source !== expectedSource) {
    throw new Error(
      `Native table payload source ${JSON.stringify(payload.source)} does not match ${expectedSource}.`,
    );
  }
  const expectedBoundary = expectedSource === 'native-tap'
    ? NATIVE_TABLE_BOUNDARY
    : NATIVE_DRIVER_TABLE_BOUNDARY;
  const legacyProducerBoundary = expectedSource === 'native-tap'
    ? 'native-input-handler-to-second-native-frame'
    : 'native-devtool-driver-handler-to-second-native-frame';
  if (payload.boundary !== expectedBoundary
    && !(allowProducerReceipt && payload.boundary === legacyProducerBoundary)) {
    throw new Error(`Native table payload boundary ${JSON.stringify(payload.boundary)} is invalid.`);
  }
  if (!legacyTwoFrameProducer
    && payload.settlementContract !== NATIVE_TABLE_SETTLEMENT_CONTRACT) {
    throw new Error(
      `Native table payload settlement contract ${JSON.stringify(payload.settlementContract)} is invalid.`,
    );
  }
  for (const key of ['startMs', 'firstFrameMs', 'endMs', 'latencyMs']) {
    assertFinite(payload[key], `Native table payload.${key}`);
  }
  if (!(payload.startMs <= payload.firstFrameMs && payload.firstFrameMs <= payload.endMs)) {
    throw new Error('Native table payload timestamps are not monotonic.');
  }
  if (payload.latencyMs !== payload.endMs - payload.startMs || payload.latencyMs < 0) {
    throw new Error('Native table payload latency does not equal endMs - startMs.');
  }
  const renderEvidence = assertObject(payload.renderEvidence, 'Native table payload.renderEvidence');
  if (renderEvidence.kind !== 'native-animation-frame' || renderEvidence.frames !== renderGraceFrames) {
    throw new Error(
      `Native table payload render evidence must contain exactly ${renderGraceFrames} native frames.`,
    );
  }
  if (!allowProducerReceipt) {
    const settlementEvidence = assertObject(
      payload.settlementEvidence,
      'Native table payload.settlementEvidence',
    );
    if (settlementEvidence.kind !== 'native-dom-workload-predicate'
      || settlementEvidence.passed !== true) {
      throw new Error('Native table payload lacks a passing external Native DOM predicate.');
    }
  }
  validateState(payload.preState, 'Native table payload.preState');
  validateState(payload.postState, 'Native table payload.postState');
  const stormTicks = expectedStormTicks(expectedName);
  if (stormTicks !== null) {
    const storm = assertObject(payload.stormEvidence, 'Native table payload.stormEvidence');
    if (storm.expectedTicks !== stormTicks || storm.completedTicks !== stormTicks) {
      throw new Error(`Native ${expectedName} payload did not complete all ${stormTicks} ticks.`);
    }
    if (!Number.isInteger(storm.renderBarriers) || storm.renderBarriers < stormTicks) {
      throw new Error(`Native ${expectedName} payload lacks one render barrier per tick.`);
    }
  }
  const transport = assertObject(payload.transportEvidence, 'Native table payload.transportEvidence');
  const expectedTransportKind = entryId === 'octane' ? 'excluded-from-latency' : 'not-exposed';
  if (transport.kind !== expectedTransportKind || transport.acknowledged !== false) {
    throw new Error(
      'Native table payload must exclude framework-specific transport acknowledgements from latency.',
    );
  }
  return payload;
}

function validateNativeStartupPayloadUnchecked(payload, {
  entryId,
  expectedRows,
  renderGraceFrames = RENDER_GRACE_FRAMES,
} = {}) {
  assertObject(payload, 'Native startup payload');
  if (payload.protocol !== NATIVE_STARTUP_PROTOCOL) {
    throw new Error(
      `Native startup payload protocol ${JSON.stringify(payload.protocol)} does not match ${NATIVE_STARTUP_PROTOCOL}.`,
    );
  }
  for (const key of ['moduleStartMs', 'firstFrameMs', 'secondFrameMs']) {
    assertFinite(payload[key], `Native startup payload.${key}`);
  }
  if (!(payload.moduleStartMs <= payload.firstFrameMs && payload.firstFrameMs <= payload.secondFrameMs)) {
    throw new Error('Native startup payload timestamps are not monotonic.');
  }
  const renderEvidence = assertObject(payload.renderEvidence, 'Native startup payload.renderEvidence');
  if (renderEvidence.kind !== 'native-animation-frame' || renderEvidence.frames !== renderGraceFrames) {
    throw new Error(
      `Native startup payload render evidence must contain exactly ${renderGraceFrames} native frames.`,
    );
  }
  const postState = validateState(payload.postState, 'Native startup payload.postState');
  if (postState.rowCount !== expectedRows) {
    throw new Error(
      `Native startup payload rowCount ${postState.rowCount} does not match rows-${expectedRows}.`,
    );
  }
  if (entryId === 'octane') {
    assertFinite(payload.commitAckMs, 'Native startup payload.commitAckMs');
    if (!(payload.moduleStartMs <= payload.commitAckMs && payload.commitAckMs <= payload.firstFrameMs)) {
      throw new Error('Octane startup transport acknowledgement is outside the render interval.');
    }
    const transport = assertObject(payload.transportEvidence, 'Native startup payload.transportEvidence');
    if (
      transport.kind !== 'octane-root.render'
      || transport.acknowledged !== true
      || transport.ackMs !== payload.commitAckMs
    ) {
      throw new Error('Octane Native startup payload lacks a root-render acknowledgement.');
    }
  } else if (payload.transportEvidence != null) {
    throw new Error('Non-Octane startup payload must not claim an Octane transport acknowledgement.');
  }
  return payload;
}

export const NATIVE_PRODUCER_PROTOCOL_ERROR = 'ERR_NATIVE_PRODUCER_PROTOCOL_INVALID';

function asProducerProtocolError(error, evidence) {
  if (error?.code === NATIVE_PRODUCER_PROTOCOL_ERROR) return error;
  const wrapped = new Error(error?.message ?? String(error), { cause: error });
  wrapped.code = NATIVE_PRODUCER_PROTOCOL_ERROR;
  wrapped.evidence = evidence;
  return wrapped;
}

export function isNativeProducerProtocolError(error) {
  return error?.code === NATIVE_PRODUCER_PROTOCOL_ERROR;
}

export function nativeStartupPayloadIsComplete(payload) {
  return payload !== null
    && typeof payload === 'object'
    && Number.isFinite(payload.secondFrameMs);
}

const startupMetricContracts = (entryId) => entryId === 'octane'
  ? [
      {
        name: 'octaneCommitAck',
        unit: 'ms',
        boundary: 'native-open-request-to-octane-transport-ack',
      },
      {
        name: 'octaneSecondFrame',
        unit: 'ms',
        boundary: 'native-open-request-to-second-frame-after-octane-transport-ack',
      },
    ]
  : [
      { name: 'fcp', unit: 'ms', boundary: 'native-open-to-fcp' },
      { name: 'settled', unit: 'ms', boundary: 'native-open-to-pipeline-end' },
    ];

export function nativeProducerProtocolDnf(error, { suite, entry, kase, scale, rows } = {}) {
  if (!isNativeProducerProtocolError(error)) return null;
  const entryId = entry?.id ?? entry;
  const failure = {
    category: 'producer-protocol-invalid',
    entry: entryId,
    workload: suite === 'startup' ? 'startup' : kase?.name ?? kase,
    scale: suite === 'startup' ? rows : scale,
    phase: suite,
    message: error.message,
    capabilityScope: 'cell',
    evidence: {
      producerProtocolValidation: { attempted: true, passed: false },
      validation: error.evidence ?? null,
    },
  };
  return {
    dnf: true,
    failure,
    metricContracts: suite === 'startup' ? startupMetricContracts(entryId) : undefined,
  };
}

export function isNativeTransientTransportFailure(error) {
  const message = String(error);
  return message.includes('No response found')
    || message.includes('inactive hook')
    || message.includes('Native CDP channel closed')
    || message.includes('Native CDP channel stopped')
    || message.includes('DevTool open-page')
    || message.includes('DevTool open-persistent-cdp-channel failed:')
    || message.includes('DevTool list-session-after-open failed:')
    || message.includes('DevTool restart-')
    || message.includes('CDP Runtime.enable')
    || message.includes('CDP DOM.')
    || message.includes('CDP Input.')
    || message.includes('Native session did not appear')
    || message.includes('Lynx Explorer did not reconnect on sandbox')
    || message.includes('timeout waiting for the Octane Native background root');
}

export function nativeTransportFailureDnf(
  error,
  { suite, entry, kase, scale, rows, stage = null } = {},
  { transientRecoveries = [] } = {},
) {
  if (!isNativeTransientTransportFailure(error)) return null;
  const entryId = entry?.id ?? entry;
  const failure = {
    category: 'transport-retries-exhausted',
    entry: entryId,
    workload: suite === 'startup' ? 'startup' : kase?.name ?? kase,
    scale: suite === 'startup' ? rows : scale,
    phase: suite,
    stage,
    triggerMode: entryId === 'octane' ? OCTANE_TRIGGER_MODE : 'tap',
    message: String(error),
    capabilityScope: 'cell',
    evidence: {
      failureStage: stage,
      transientRecoveries: transientRecoveries.slice(-3),
    },
  };
  return {
    dnf: true,
    failure,
    // Once the direct DebugRouter transport is exhausted, the connector can
    // remain permanently closed even though the exact failed cell is known.
    // Persist that cell, dispose this adapter, and resume with a fresh process
    // instead of cascading synthetic transport DNFs across the matrix.
    checkpointAfterCell: true,
    metricContracts: suite === 'startup' ? startupMetricContracts(entryId) : undefined,
  };
}

export function validateNativeTablePayload(payload, expectations = {}) {
  try {
    return validateNativeTablePayloadUnchecked(payload, expectations);
  } catch (error) {
    throw asProducerProtocolError(error, {
      suite: 'table',
      expectations,
      payload: payload ?? null,
    });
  }
}

export function validateNativeStartupPayload(payload, expectations = {}) {
  try {
    return validateNativeStartupPayloadUnchecked(payload, expectations);
  } catch (error) {
    throw asProducerProtocolError(error, {
      suite: 'startup',
      expectations,
      payload: payload ?? null,
    });
  }
}

export function findExplorerClient(clients, encodedSerial) {
  return clients.find((candidate) =>
    candidate.id.startsWith(`${encodedSerial}:`)
    && candidate.info?.AppProcessName === 'com.lynx.explorer');
}

export function assertRuntimeConnectorPackageTrees(expected, actual = resolveConnectorPackageTrees({
  fromPath: import.meta.url,
})) {
  return assertConnectorPackageTreesMatch(expected, actual);
}

export default async function createAdapter({ log = () => {}, campaignIdentity = null } = {}) {
  const serial = process.env.LYNX_SANDBOX_SERIAL;
  if (!serial) {
    throw new Error('lynx sandbox adapter requires LYNX_SANDBOX_SERIAL=<leased adb serial>.');
  }
  const leaseReceipt = assertNativeLeaseReceipt(campaignIdentity?.leaseReceipt);
  if (leaseReceipt.serialSha256 !== nativeSerialSha256(serial)) {
    throw new Error('campaign lease receipt does not match LYNX_SANDBOX_SERIAL.');
  }
  const port = Number(process.env.LYNX_SANDBOX_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid LYNX_SANDBOX_PORT: ${process.env.LYNX_SANDBOX_PORT}`);
  }
  const adbServerPort = Number.parseInt(process.env.ADB_SERVER_PORT ?? '5037', 10);
  if (!Number.isInteger(adbServerPort) || adbServerPort <= 0 || adbServerPort > 65535) {
    throw new Error(`invalid ADB_SERVER_PORT: ${process.env.ADB_SERVER_PORT}`);
  }
  if (
    !campaignIdentity
    || typeof campaignIdentity.campaignId !== 'string'
    || typeof campaignIdentity.matrixContractSha256 !== 'string'
    || typeof campaignIdentity.inputReceiptSha256 !== 'string'
    || typeof campaignIdentity.connectorPackageTreesSha256 !== 'string'
  ) {
    throw new Error(
      'lynx sandbox adapter requires campaignIdentity with campaignId, matrixContractSha256, '
      + 'inputReceiptSha256, connectorPackageTreesSha256, and connectorPackageTrees.',
    );
  }
  assertConnectorPackageTrees(campaignIdentity.connectorPackageTrees);
  if (
    campaignIdentity.connectorPackageTrees.sha256
    !== campaignIdentity.connectorPackageTreesSha256
  ) {
    throw new Error('campaign connector package-tree digest does not match its receipt.');
  }
  const connectorPackageTrees = assertRuntimeConnectorPackageTrees(
    campaignIdentity.connectorPackageTrees,
  );

  let activeBundle = null;
  let session = null;
  let pageCount = 0;
  let currentEntryId = null;
  let currentEntryFramework = null;
  const isCurrentOctane = () => currentEntryFramework === 'octane';
  let currentRows = null;
  let currentOpenTime = null;
  let lastObserved = null;
  let startupPayloadLogged = false;
  let consoleReader = null;
  let consoleWriter = null;
  let consoleOutput = null;
  let consoleGeneration = 0;
  let nextCDPId = 50_000;
  const pendingCDP = new Map();
  let timingEvents = [];
  let finalFrameEvents = [];
  let startupEvents = [];
  let lastStartupProbe = null;
  const timingWaiters = new Set();
  const unsupportedTableCells = new Map();
  const unsupportedPrestateScales = new Map();
  const unsupportedStartupCells = new Map();
  const buttonPoints = new Map();
  const cellGeometry = new Map();
  let disposed = false;
  const connectorModule = await loadConnectorModule();
  const directTransport = DEVTOOL_TRANSPORT_MODE === 'direct'
    ? new connectorModule.AndroidTransport({
      host: process.env.ADB_SERVER_HOST ?? '127.0.0.1',
      port: adbServerPort,
    })
    : null;
  const connector = directTransport
    ? connectorModule.createDefaultConnector([directTransport])
    : connectorModule.createDefaultConnector();
  const connectorCall = async (phase, action, { settle = true } = {}) => {
    try {
      return await action();
    } catch (error) {
      throw new Error(`DevTool ${phase} failed: ${String(error)}`, { cause: error });
    } finally {
      // One-shot connector calls close their USB socket on the host before the
      // device worker has necessarily completed teardown. Without this gap the
      // next request can replace the closing client and lose its response.
      if (settle && ROUTER_SETTLE_MS > 0) await delay(ROUTER_SETTLE_MS);
    }
  };
  const server = await startBundleServer(port, () => activeBundle);

  adb(serial, 'reverse', `tcp:${port}`, `tcp:${port}`);
  // DebugRouter accepts a single USB connector. A previous interrupted run can
  // leave Explorer alive with that channel in a failed protocol state, so each
  // adapter process must start from a new router process before discovery.
  adb(serial, 'shell', 'am', 'force-stop', 'com.lynx.explorer');
  adb(serial, 'shell', 'monkey', '-p', 'com.lynx.explorer', '-c', 'android.intent.category.LAUNCHER', '1');

  const encodedSerial = encodeURIComponent(serial);
  let client = null;
  const clientDeadline = Date.now() + EXPLORER_RECONNECT_TIMEOUT_MS;
  while (!client && Date.now() < clientDeadline) {
    const clients = await connectorCall('initial-client-discovery', () => connector.listClients());
    client = findExplorerClient(clients, encodedSerial);
    if (!client) await delay(NATIVE_SANDBOX_POLICY.clientDiscoveryPollMs);
  }
  if (!client) {
    server.close();
    throw new Error(`Lynx Explorer client not found for sandbox ${serial}.`);
  }
  await connectorCall(
    'initial-enable-perf-metrics',
    () => connector.setGlobalSwitch(client.id, 'enable_perf_metrics', true),
  );

  const device = client.info;
  const deviceClock = calibrateDeviceClock(serial);
  const thermalStart = await waitForThermalReady(serial);
  const explorerPackage = readExplorerPackageVersion(serial);
  const model = String(device.model ?? device.deviceModel ?? 'android').replace(/\s+/g, '-').toLowerCase();
  const osVersion = String(device.osVersion ?? adb(serial, 'shell', 'getprop', 'ro.build.version.release'));
  const environment = `lynx-native-android-${model}-${osVersion}`
    + `-devtool-${DEVTOOL_TRANSPORT_MODE}-recycle${EXPLORER_RECYCLE_EVERY_PAGES}`;
  const deviceLeaseId = leaseReceipt.deviceLeaseId;
  const harnessConfig = {
    ...NATIVE_SANDBOX_POLICY,
    tableProtocol: NATIVE_TABLE_PROTOCOL,
    startupProtocol: NATIVE_STARTUP_PROTOCOL,
    campaignId: campaignIdentity.campaignId,
    matrixContractSha256: campaignIdentity.matrixContractSha256,
    inputReceiptSha256: campaignIdentity.inputReceiptSha256,
    connectorPackageTreesSha256: campaignIdentity.connectorPackageTreesSha256,
  };
  const harnessConfigId = createHash('sha256')
    .update(JSON.stringify(harnessConfig))
    .digest('hex')
    .slice(0, 12);
  const cpuModel = adb(serial, 'shell', 'getprop', 'ro.product.board') || model;
  const cores = Number(adb(serial, 'shell', 'nproc')) || null;
  const deviceCohort = buildNativeDeviceCohort({
    serialSha256: leaseReceipt.serialSha256,
    environment,
    hardware: {
      platform: 'android',
      osVersion,
      cpuModel,
      cores,
      deviceModel: device.deviceModel ?? device.model ?? model,
      app: device.App,
      appVersion: device.AppVersion,
      explorerPackage,
      debugRouterVersion: device.debugRouterVersion,
      lynxSdkVersion: device.sdkVersion,
    },
    campaignId: campaignIdentity.campaignId,
    matrixContractSha256: campaignIdentity.matrixContractSha256,
    inputReceiptSha256: campaignIdentity.inputReceiptSha256,
    connectorPackageTreesSha256: campaignIdentity.connectorPackageTreesSha256,
    harnessConfigId,
  });
  const machine = {
    id: `${environment}-${deviceLeaseId}-${harnessConfigId}`,
    platform: 'android',
    osVersion,
    cpuModel,
    cores,
    node: null,
    deviceModel: device.deviceModel ?? device.model ?? model,
    app: device.App,
    appVersion: device.AppVersion,
    explorerPackage,
    debugRouterVersion: device.debugRouterVersion,
    lynxSdkVersion: device.sdkVersion,
    connectorPackageTrees,
    ...harnessConfig,
    harnessConfigId,
    serialSha256: leaseReceipt.serialSha256,
    deviceLeaseId,
    leaseReceipt,
    deviceCohort,
    deviceCohortId: deviceCohort.id,
    deviceLeaseIdentitySource: 'structured-receipt-v1',
    deviceClockOffsetMs: deviceClock.offsetMs,
    deviceClockCalibrationRttMs: deviceClock.rttMs,
    thermalStart,
    servedInputs: [],
    transientRecoveries: [],
  };

  async function cdp(method, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (!session) throw new Error(`cannot call ${method} before a page is loaded.`);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error(`invalid CDP timeout ${timeoutMs}ms for ${method}.`);
    }
    try {
      if (!consoleWriter) {
        let timer;
        try {
          return await Promise.race([
            connector.sendCDPMessage(client.id, session.session_id, method, params),
            new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(new Error(`timeout waiting ${timeoutMs}ms for ${method}`)),
                timeoutMs,
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      }
      nextCDPId++;
      const id = nextCDPId;
      const response = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingCDP.delete(id);
          reject(new Error(`timeout waiting ${timeoutMs}ms for ${method}`));
        }, timeoutMs);
        pendingCDP.set(id, { resolve, reject, method, timer });
      });
      try {
        await consoleWriter.write({ id, method, params });
      } catch (error) {
        clearTimeout(pendingCDP.get(id)?.timer);
        pendingCDP.delete(id);
        throw error;
      }
      return await response;
    } catch (error) {
      throw new Error(`CDP ${method} failed: ${String(error)}`, { cause: error });
    }
  }

  async function evaluateOctaneDriver(name, argument) {
    const expression = `globalThis.__LYNX_BENCH_DRIVER__.drive(${JSON.stringify(name)}, ${JSON.stringify(argument)})`;
    const result = await cdp('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }, LONG_WORKLOAD_TIMEOUT_MS);
    if (process.env.LYNX_SANDBOX_DEBUG_CONSOLE === '1') {
      log(`  [sandbox:octane-driver] ${name}(${String(argument)}) => ${JSON.stringify(result)}`);
    }
    if (result.exceptionDetails) {
      throw new Error(`Octane Native benchmark driver failed: ${JSON.stringify(result.exceptionDetails)}`);
    }
    if (result.result?.subtype === 'error') {
      throw new Error(`Octane Native benchmark driver failed: ${result.result.description ?? result.result.className}`);
    }
    return result;
  }

  async function waitForOctaneReady(timeoutMs = DEFAULT_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    let nextDebugAt = 0;
    while (Date.now() < deadline) {
      const result = await cdp('Runtime.evaluate', {
        expression: `JSON.stringify((() => {
          if (globalThis.__LYNX_BENCH_ERROR__) {
            return { ready: false, fatal: globalThis.__LYNX_BENCH_ERROR__ };
          }
          if (globalThis.__LYNX_BENCH_COMMITTED__ !== true) {
            return { ready: false, error: 'root commit pending' };
          }
          try {
            globalThis.__LYNX_BENCH_DRIVER__.drive('probe');
            return { ready: true };
          } catch (error) {
            return { ready: false, error: String(error) };
          }
        })())`,
        returnByValue: true,
      });
      const status = typeof result.result?.value === 'string'
        ? JSON.parse(result.result.value)
        : null;
      if (process.env.LYNX_SANDBOX_DEBUG_CONSOLE === '1' && Date.now() >= nextDebugAt) {
        nextDebugAt = Date.now() + 1000;
        log(`  [sandbox:octane-ready] ${JSON.stringify({ status, result })}`);
      }
      if (status?.fatal) throw new Error(`Octane Native root failed: ${status.fatal}`);
      if (status?.ready) return;
      await delay(NATIVE_SANDBOX_POLICY.octaneReadyPollMs);
    }
    throw new Error('timeout waiting for the Octane Native background root.');
  }

  async function octaneSnapshot() {
    const result = await cdp('Runtime.evaluate', {
      expression: `JSON.stringify(globalThis.__LYNX_BENCH_DRIVER__.drive('snapshot'))`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails || result.result?.subtype === 'error') {
      throw new Error(`Octane Native snapshot failed: ${JSON.stringify(result.exceptionDetails ?? result.result)}`);
    }
    return typeof result.result?.value === 'string' ? JSON.parse(result.result.value) : null;
  }

  async function octaneTimeoutEvidence() {
    const evidence = {
      backgroundSnapshot: null,
      mainLabelNodeCount: null,
      timingEvents: timingEvents.slice(),
      errors: [],
    };
    try {
      evidence.backgroundSnapshot = await octaneSnapshot();
    } catch (error) {
      evidence.errors.push(`background snapshot: ${String(error)}`);
    }
    try {
      const found = await cdp('DOM.performSearch', { query: 'col-label' });
      evidence.mainLabelNodeCount = found.resultCount ?? null;
      await cdp('DOM.discardSearchResults', { searchId: found.searchId }).catch(() => {});
    } catch (error) {
      evidence.errors.push(`main DOM row search: ${String(error)}`);
    }
    return evidence;
  }

  async function searchCount(query, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const found = await cdp('DOM.performSearch', { query }, timeoutMs);
    try {
      return found.resultCount ?? 0;
    } finally {
      await cdp('DOM.discardSearchResults', { searchId: found.searchId }, timeoutMs).catch(() => {});
    }
  }

  async function search(query, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const found = await cdp('DOM.performSearch', { query }, timeoutMs);
    try {
      if (!found.resultCount) return [];
      const result = await cdp('DOM.getSearchResults', {
        searchId: found.searchId,
        fromIndex: 0,
        toIndex: found.resultCount,
      }, timeoutMs);
      return result.nodeIds ?? [];
    } finally {
      await cdp('DOM.discardSearchResults', { searchId: found.searchId }, timeoutMs).catch(() => {});
    }
  }

  async function nodeInnerText(nodeId, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (!nodeId) return null;
    const result = await cdp('DOM.innerText', { nodeId }, timeoutMs);
    const innerText = result.innerText ?? result.result?.innerText;
    if (typeof innerText === 'string') return innerText;
    if (Array.isArray(result.rawTextValues)) {
      return result.rawTextValues.map((value) => value.text ?? '').join('');
    }
    return null;
  }

  async function pointForNode(nodeId) {
    await cdp('DOM.scrollIntoViewIfNeeded', { nodeId }).catch(() => {});
    const box = await cdp('DOM.getBoxModel', { nodeId });
    const border = bounds(box.model.border);
    const content = bounds(box.model.content ?? box.model.border);
    const point = center(box.model.content ?? box.model.border);
    if (content.left - border.left >= 2) point.x = (border.left + content.left) / 2;
    else if (border.right - content.right >= 2) point.x = (content.right + border.right) / 2;
    if (content.top - border.top >= 2) point.y = (border.top + content.top) / 2;
    else if (border.bottom - content.bottom >= 2) point.y = (content.bottom + border.bottom) / 2;
    const hit = await cdp('DOM.getNodeForLocation', point);
    if (!hit?.nodeId) throw new Error(`no Native hit target at ${point.x},${point.y}.`);
    return point;
  }

  async function tapPoint(point) {
    const timestamp = Date.now();
    for (const [index, type] of ['mousePressed', 'mouseReleased'].entries()) {
      await cdp('Input.emulateTouchFromMouseEvent', {
        type,
        ...point,
        timestamp: timestamp + index,
        button: 'left',
        clickCount: 1,
      });
    }
    if (TAP_SETTLE_MS > 0) await delay(TAP_SETTLE_MS);
  }

  async function clickableAncestor(nodeId) {
    let current = nodeId;
    for (let depth = 0; depth < 8 && current; depth++) {
      const described = await cdp('DOM.describeNode', { nodeId: current, depth: 0 });
      const node = described.node;
      const attributes = node?.attributes ?? [];
      if (attributes.includes('bindtap')) return current;
      current = node?.parentId ?? 0;
    }
    return nodeId;
  }

  async function ensureButtonPoint(text) {
    if (buttonPoints.has(text)) return buttonPoints.get(text);
    const nodes = await search(text);
    if (nodes.length !== 1) {
      throw new Error(`expected one Native node for ${JSON.stringify(text)}, found ${nodes.length}.`);
    }
    const point = await pointForNode(await clickableAncestor(nodes[0]));
    buttonPoints.set(text, point);
    return point;
  }

  async function tapText(text) {
    await tapPoint(await ensureButtonPoint(text));
  }

  async function tapCell(className, rowIndex) {
    const cached = cellGeometry.get(className);
    if (cached) {
      await tapPoint({ x: cached.x, y: cached.y + cached.step * rowIndex });
      return;
    }
    const nodes = await search(className);
    if (nodes.length <= Math.max(rowIndex, 1)) {
      throw new Error(`Native cell .${className}[${rowIndex}] missing; found ${nodes.length}.`);
    }
    const first = await pointForNode(await clickableAncestor(nodes[0]));
    const second = await pointForNode(await clickableAncestor(nodes[1]));
    const geometry = { x: first.x, y: first.y, step: second.y - first.y };
    cellGeometry.set(className, geometry);
    await tapPoint({ x: geometry.x, y: geometry.y + geometry.step * rowIndex });
  }

  function notifyTimingWaiters() {
    for (const resolve of timingWaiters) resolve();
    timingWaiters.clear();
  }

  async function waitForTiming(expectedName, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const index = timingEvents.findIndex((value) => value?.name === expectedName);
      if (index !== -1) return timingEvents.splice(index, 1)[0];
      await new Promise((resolve) => {
        timingWaiters.add(resolve);
        setTimeout(() => {
          timingWaiters.delete(resolve);
          resolve();
        }, Math.min(250, Math.max(0, deadline - Date.now())));
      });
    }
    throw new Error(`timeout waiting for Native timing ${expectedName}.`);
  }

  async function waitForFinalFrames(token, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const index = finalFrameEvents.findIndex((value) => value?.token === token);
      if (index !== -1) return finalFrameEvents.splice(index, 1)[0];
      await new Promise((resolve) => {
        timingWaiters.add(resolve);
        setTimeout(() => {
          timingWaiters.delete(resolve);
          resolve();
        }, Math.min(250, Math.max(0, deadline - Date.now())));
      });
    }
    throw new Error(`timeout waiting for final Native frames ${token}.`);
  }

  async function startConsoleStream() {
    await stopConsoleStream();
    consoleGeneration++;
    const generation = consoleGeneration;
    timingEvents = [];
    finalFrameEvents = [];
    startupEvents = [];
    const input = new TransformStream();
    const stream = await connectorCall(
      'open-persistent-cdp-channel',
      () => connector.sendCDPStream(client.id, session.session_id, input.readable),
      { settle: false },
    );
    const reader = stream.getReader();
    consoleWriter = input.writable.getWriter();
    consoleOutput = stream;
    consoleReader = reader;
    void (async () => {
      try {
        while (generation === consoleGeneration) {
          const { done, value } = await reader.read();
          if (done || generation !== consoleGeneration) break;
          if (Number.isInteger(value.id) && pendingCDP.has(value.id)) {
            const pending = pendingCDP.get(value.id);
            pendingCDP.delete(value.id);
            clearTimeout(pending.timer);
            if (value.error) {
              pending.reject(new Error(`CDP request error: ${value.error.message ?? JSON.stringify(value.error)}`));
            } else {
              pending.resolve(value.result ?? {});
            }
            continue;
          }
          if (value.method !== 'Runtime.consoleAPICalled') continue;
          const args = value.params?.args ?? [];
          if (process.env.LYNX_SANDBOX_DEBUG_CONSOLE === '1') {
            log(`  [sandbox:console] ${JSON.stringify(value.params)}`);
          }
          const marker = args.findIndex((arg) => arg.value === '__NATIVE_BENCH_RESULT__');
          const finalFrameMarker = args.findIndex(
            (arg) => arg.value === '__NATIVE_BENCH_FINAL_FRAMES__',
          );
          const startupMarker = args.findIndex((arg) => arg.value === '__NATIVE_BENCH_STARTUP__');
          if (startupMarker !== -1 && typeof args[startupMarker + 1]?.value === 'string') {
            try {
              startupEvents.push(JSON.parse(args[startupMarker + 1].value));
              notifyTimingWaiters();
            } catch (error) {
              startupEvents.push({ malformedPayload: args[startupMarker + 1].value, error: String(error) });
              notifyTimingWaiters();
            }
          }
          if (finalFrameMarker !== -1 && typeof args[finalFrameMarker + 1]?.value === 'string') {
            try {
              finalFrameEvents.push(JSON.parse(args[finalFrameMarker + 1].value));
              notifyTimingWaiters();
            } catch (error) {
              finalFrameEvents.push({
                malformedPayload: args[finalFrameMarker + 1].value,
                error: String(error),
              });
              notifyTimingWaiters();
            }
          }
          if (marker === -1 || typeof args[marker + 1]?.value !== 'string') continue;
          try {
            timingEvents.push(JSON.parse(args[marker + 1].value));
            notifyTimingWaiters();
          } catch (error) {
            timingEvents.push({ malformedPayload: args[marker + 1].value, error: String(error) });
            notifyTimingWaiters();
          }
        }
      } catch (error) {
        if (generation === consoleGeneration && !disposed) {
          log(`  [sandbox] console stream ended: ${error.message}`);
        }
      } finally {
        if (generation === consoleGeneration) {
          const error = new Error('Native CDP channel closed before pending commands completed.');
          for (const pending of pendingCDP.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
          }
          pendingCDP.clear();
        }
      }
    })();
    await cdp('Runtime.enable');
  }

  async function stopConsoleStream() {
    consoleGeneration++;
    const hadChannel = consoleReader !== null || consoleWriter !== null || consoleOutput !== null;
    const error = new Error('Native CDP channel stopped.');
    for (const pending of pendingCDP.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    pendingCDP.clear();
    const writer = consoleWriter;
    consoleWriter = null;
    await writer?.close().catch(() => {});
    writer?.releaseLock();
    const reader = consoleReader;
    consoleReader = null;
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
    const output = consoleOutput;
    consoleOutput = null;
    await output?.[Symbol.asyncDispose]().catch(() => {});
    // Explorer's DebugRouter owns one USB connector and tears it down on a
    // device worker. Give that close a short, unmeasured quiescence window
    // before opening the next ListSession/OpenCard connection.
    if (hadChannel && ROUTER_SETTLE_MS > 0) await delay(ROUTER_SETTLE_MS);
  }

  async function restartExplorer() {
    await stopConsoleStream();
    const before = (await connectorCall('restart-client-before', () => connector.listClients()))
      .find((candidate) => candidate.id === client.id);
    const previousRouterId = before?.info?.debugRouterId;
    adb(serial, 'shell', 'am', 'force-stop', 'com.lynx.explorer');
    adb(serial, 'shell', 'monkey', '-p', 'com.lynx.explorer', '-c', 'android.intent.category.LAUNCHER', '1');
    const deadline = Date.now() + EXPLORER_RECONNECT_TIMEOUT_MS;
    let ready = false;
    while (Date.now() < deadline) {
      const clients = await connectorCall('restart-client-after', () => connector.listClients());
      const candidate = findExplorerClient(clients, encodedSerial);
      if (candidate && (!previousRouterId || candidate.info?.debugRouterId !== previousRouterId)) {
        client = candidate;
        ready = true;
        break;
      }
      await delay(NATIVE_SANDBOX_POLICY.clientDiscoveryPollMs);
    }
    if (!ready) throw new Error(`Lynx Explorer did not reconnect on sandbox ${serial}.`);
    await connectorCall(
      'restart-enable-perf-metrics',
      () => connector.setGlobalSwitch(client.id, 'enable_perf_metrics', true),
    );
    session = null;
    if (EXPLORER_LAUNCH_SETTLE_MS > 0) await delay(EXPLORER_LAUNCH_SETTLE_MS);
  }

  const remainingMs = (deadline, label) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`timeout waiting for ${label}.`);
    return remaining;
  };

  async function benchmarkSnapshot(timeoutMs) {
    const result = await cdp('Runtime.evaluate', {
      expression: 'JSON.stringify(globalThis.__LYNX_BENCH_SNAPSHOT__?.() ?? null)',
      returnByValue: true,
    }, timeoutMs);
    if (result.exceptionDetails || result.result?.subtype === 'error') {
      throw new Error(
        `Native benchmark snapshot failed: ${JSON.stringify(result.exceptionDetails ?? result.result)}`,
      );
    }
    return typeof result.result?.value === 'string'
      ? JSON.parse(result.result.value)
      : null;
  }

  async function inspectNativeDom(kase, scale, before, snapshot, timeoutMs) {
    const expectedRowCount = kase.name === 'append1k'
      ? scale + 1000
      : kase.name === 'remove'
        ? scale - 1
        : kase.name === 'clear'
          ? 0
          : scale;
    const rowCount = await searchCount('col-label', timeoutMs);
    const evidence = {
      predicate: kase.name,
      expectedRowCount,
      observedRowCount: rowCount,
      passed: rowCount === expectedRowCount,
    };
    if (!evidence.passed) return evidence;

    if (kase.name === 'replace') {
      const idNodes = await search('col-id', timeoutMs);
      const firstIdText = await nodeInnerText(idNodes[0], timeoutMs);
      evidence.expectedFirstId = snapshot.firstId;
      evidence.observedFirstId = Number(firstIdText);
      evidence.passed = evidence.observedFirstId === snapshot.firstId
        && snapshot.firstId !== before?.firstId;
    } else if (kase.name === 'update10th') {
      const labelNodes = await search('col-label', timeoutMs);
      const firstLabel = await nodeInnerText(labelNodes[0], timeoutMs);
      evidence.expectedFirstLabel = snapshot.firstLabel;
      evidence.observedFirstLabel = firstLabel;
      evidence.passed = firstLabel === snapshot.firstLabel && firstLabel?.endsWith(' !!!');
    } else if (kase.name === 'select' || kase.name === 'selectStorm') {
      const selectedNodes = await search('danger', timeoutMs);
      const selectedText = await nodeInnerText(selectedNodes[0], timeoutMs);
      const observedSelectedId = Number(/^\s*(\d+)/.exec(selectedText ?? '')?.[1]);
      evidence.expectedSelectedId = snapshot.selectedId;
      evidence.observedSelectedId = Number.isFinite(observedSelectedId)
        ? observedSelectedId
        : null;
      evidence.passed = evidence.observedSelectedId === snapshot.selectedId;
    } else if (kase.name === 'swap') {
      const idNodes = await search('col-id', timeoutMs);
      const [secondText, row998Text] = await Promise.all([
        nodeInnerText(idNodes[1], timeoutMs),
        nodeInnerText(idNodes[998], timeoutMs),
      ]);
      evidence.expectedSecondId = snapshot.secondId;
      evidence.expectedRow998Id = snapshot.row998Id;
      evidence.observedSecondId = Number(secondText);
      evidence.observedRow998Id = Number(row998Text);
      evidence.passed = evidence.observedSecondId === snapshot.secondId
        && evidence.observedRow998Id === snapshot.row998Id;
    } else if (kase.name === 'updateStorm') {
      const labelNodes = await search('col-label', timeoutMs);
      const firstLabel = await nodeInnerText(labelNodes[0], timeoutMs);
      evidence.expectedFirstLabel = snapshot.firstLabel;
      evidence.observedFirstLabel = firstLabel;
      evidence.passed = firstLabel === snapshot.firstLabel;
    }
    return evidence;
  }

  async function twoNativeFrames(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    const token = `final-frames-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const result = await cdp('Runtime.evaluate', {
      expression: `(() => {
        if (typeof globalThis.__LYNX_BENCH_REQUEST_FINAL_FRAMES__ !== 'function') {
          throw new Error('Native final-frame producer is unavailable.');
        }
        globalThis.__LYNX_BENCH_REQUEST_FINAL_FRAMES__(${JSON.stringify(token)});
        return ${JSON.stringify(token)};
      })()`,
      returnByValue: true,
    }, timeoutMs);
    if (result.exceptionDetails || result.result?.subtype === 'error') {
      throw new Error(
        `Native final-frame barrier failed: ${JSON.stringify(result.exceptionDetails ?? result.result)}`,
      );
    }
    return waitForFinalFrames(token, remainingMs(deadline, 'final Native frames'));
  }

  async function waitForNativeSettlement(kase, scale, receipt, deadline, {
    allowAnySelection = false,
  } = {}) {
    let lastSnapshot = null;
    let lastDomEvidence = null;
    while (Date.now() < deadline) {
      lastSnapshot = await benchmarkSnapshot(remainingMs(deadline, 'Native state predicate'));
      if (nativePostStateMatches(kase, scale, receipt.preState, lastSnapshot, {
        allowAnySelection,
      })) {
        lastDomEvidence = await inspectNativeDom(
          kase,
          scale,
          receipt.preState,
          lastSnapshot,
          remainingMs(deadline, 'Native DOM predicate'),
        );
        if (lastDomEvidence.passed) {
          const observedAtHostMs = Date.now();
          const frames = await twoNativeFrames(remainingMs(deadline, 'final Native frames'));
          const expectedSource = receipt.source;
          const boundary = expectedSource === 'native-tap'
            ? NATIVE_TABLE_BOUNDARY
            : NATIVE_DRIVER_TABLE_BOUNDARY;
          return {
            ...receipt,
            boundary,
            settlementContract: NATIVE_TABLE_SETTLEMENT_CONTRACT,
            firstFrameMs: frames?.firstFrameMs,
            endMs: frames?.endMs,
            latencyMs: frames?.endMs - receipt.startMs,
            renderEvidence: {
              kind: 'native-animation-frame',
              frames: RENDER_GRACE_FRAMES,
              after: 'native-dom-workload-predicate',
            },
            settlementEvidence: {
              kind: 'native-dom-workload-predicate',
              passed: true,
              observedAtHostMs,
              ...lastDomEvidence,
            },
            postState: lastSnapshot,
            producerReceipt: receipt,
          };
        }
      }
      await delay(Math.min(STARTUP_POLL_MS, Math.max(0, deadline - Date.now())));
    }
    throw new Error(
      `timeout waiting for Native settlement ${kase.name}@${scale}: `
      + JSON.stringify({ lastSnapshot, lastDomEvidence, producerReceipt: receipt }),
    );
  }

  async function measuredTap(kase, scale, trigger, timeoutMs, options = {}) {
    timingEvents = [];
    const deadline = Date.now() + timeoutMs;
    await trigger();
    const expectedName = options.expectedName ?? timingName(kase);
    const receipt = await waitForTiming(
      expectedName,
      remainingMs(deadline, `Native timing receipt ${expectedName}`),
    );
    const expectedSource = isCurrentOctane() && OCTANE_TRIGGER_MODE === 'driver'
      ? 'devtool-driver'
      : 'native-tap';
    validateNativeTablePayload(receipt, {
      entryId: currentEntryId,
      expectedName,
      expectedSource,
      allowProducerReceipt: true,
    });
    const observed = await waitForNativeSettlement(kase, scale, receipt, deadline, options);
    return validateNativeTablePayload(observed, {
      entryId: currentEntryId,
      expectedName,
      expectedSource,
    });
  }

  function assertPostState(kase, scale, observed, options = {}) {
    if (!nativePostStateMatches(kase, scale, observed?.preState, observed?.postState, options)) {
      throw new Error(
        `Native post-action predicate failed for ${kase.name}@${scale}: `
        + JSON.stringify({ before: observed?.preState, after: observed?.postState }),
      );
    }
  }

  function octaneTrigger(kase, scale) {
    if (OCTANE_TRIGGER_MODE === 'driver') {
      const operation = kase.name === 'replace' ? 'create' : kase.name;
      const argument = kase.name === 'create' || kase.name === 'replace'
        ? scale
        : kase.trigger.cell?.rowIndex;
      return () => evaluateOctaneDriver(operation, argument);
    }
    return kase.trigger.button
      ? () => tapText(kase.trigger.button(scale))
      : () => tapCell(kase.trigger.cell.cls, kase.trigger.cell.rowIndex);
  }

  async function createRows(scale, timeoutMs = LONG_WORKLOAD_TIMEOUT_MS) {
    const trigger = isCurrentOctane() && OCTANE_TRIGGER_MODE === 'driver'
      ? () => evaluateOctaneDriver('create', scale)
      : () => tapText(CREATE_BUTTON[scale]);
    const observed = await measuredTap({ name: 'create' }, scale, trigger, timeoutMs);
    assertPostState({ name: 'create' }, scale, observed);
  }

  const timeoutForTable = (kase) => isCurrentOctane()
    ? LONG_WORKLOAD_TIMEOUT_MS
    : DEFAULT_TIMEOUT_MS;

  const timeoutForStartup = () => isCurrentOctane()
    ? LONG_WORKLOAD_TIMEOUT_MS
    : DEFAULT_TIMEOUT_MS;

  async function waitForStartup(timeoutMs = DEFAULT_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    let timingInfoLogged = false;
    let nextFrameDebugAt = 0;
    let nextStartupPollAt = 0;
    let pipelineEntry = null;
    while (Date.now() < deadline) {
      const result = !isCurrentOctane()
        ? await cdp(
          'Performance.getAllPerformanceEntries',
          {},
          Math.max(1, deadline - Date.now()),
        )
        : { entries: [] };
      if (process.env.LYNX_SANDBOX_DEBUG_STARTUP === '1' && !startupPayloadLogged) {
        startupPayloadLogged = true;
        log(`  [sandbox:startup-payload] ${JSON.stringify(result)}`);
      }
      const entry = result.entries?.find((candidate) =>
        candidate.entryType === 'pipeline'
        && candidate.name === 'loadBundle'
        && Number.isFinite(candidate.pipelineEnd));
      if (entry?.lynxFcp && Number.isFinite(entry.openTime)) {
        const fcpDuration = entry.totalFcp?.duration ?? entry.lynxFcp?.duration;
        if (
          !Number.isFinite(fcpDuration)
          || !Number.isFinite(entry.pipelineEnd)
          || entry.pipelineEnd < entry.openTime
          || fcpDuration < 0
        ) {
          throw new Error('invalid Native loadBundle pipeline payload: ' + JSON.stringify(entry));
        }
        pipelineEntry = entry;
      }
      const timingInfo = isCurrentOctane()
        ? null
        : await cdp(
          'Performance.getAllTimingInfo',
          {},
          Math.max(1, deadline - Date.now()),
        ).catch(() => null);
      lastStartupProbe = {
        capturedAt: new Date().toISOString(),
        performanceEntryCount: result.entries?.length ?? 0,
        pipelineEntries: (result.entries ?? [])
          .filter((candidate) => candidate.entryType === 'pipeline')
          .map((candidate) => ({
            name: candidate.name ?? null,
            openTime: candidate.openTime ?? null,
            pipelineEnd: candidate.pipelineEnd ?? null,
            hasLynxFcp: Boolean(candidate.lynxFcp),
            hasTotalFcp: Boolean(candidate.totalFcp),
          })),
        timingInfo: timingInfo == null ? null : {
          extraTiming: timingInfo.extra_timing ?? null,
        },
      };
      if (process.env.LYNX_SANDBOX_DEBUG_STARTUP === '1' && !timingInfoLogged) {
        timingInfoLogged = true;
        log(`  [sandbox:startup-timing-info] ${JSON.stringify(timingInfo)}`);
      }
      let startup = startupEvents.findLast((candidate) => candidate?.protocol != null) ?? null;
      if (startup === null && Date.now() >= nextStartupPollAt) {
        nextStartupPollAt = Date.now() + NATIVE_SANDBOX_POLICY.producerProbePollMs;
        const startupResult = await cdp('Runtime.evaluate', {
          expression: `JSON.stringify(globalThis.__LYNX_BENCH_STARTUP__ ?? null)`,
          returnByValue: true,
        }, Math.max(1, deadline - Date.now()));
        const polledStartup = typeof startupResult.result?.value === 'string'
          ? JSON.parse(startupResult.result.value)
          : null;
        // Producers publish a mutable startup receipt before render begins so the
        // host can observe progress. Do not validate that in-flight object as if
        // it were the final two-frame receipt; console events are emitted only
        // after completion, while this polling fallback can see every phase.
        startup = nativeStartupPayloadIsComplete(polledStartup) ? polledStartup : null;
      }
      const openTime = isCurrentOctane()
        ? currentOpenTime
        : timingInfo?.extra_timing?.open_time ?? currentOpenTime;
      if (
        process.env.LYNX_SANDBOX_DEBUG_STARTUP === '1'
        && isCurrentOctane()
        && Date.now() >= nextFrameDebugAt
      ) {
        nextFrameDebugAt = Date.now() + 1000;
        log(`  [sandbox:startup-frame-state] ${JSON.stringify({ openTime, startupEvents })}`);
      }
      if (startup != null) {
        validateNativeStartupPayload(startup, {
          entryId: currentEntryId,
          expectedRows: currentRows,
        });
        if (!Number.isFinite(openTime) || startup.moduleStartMs < openTime) {
          throw new Error('Native startup payload predates the adapter open request.');
        }
        if (process.env.LYNX_SANDBOX_DEBUG_STARTUP === '1') {
          log(`  [sandbox:startup-frame] ${JSON.stringify({ openTime, startup })}`);
        }
        if (isCurrentOctane()) {
          return { kind: 'octane-commit-fallback', openTime, timingInfo, startup };
        }
        if (pipelineEntry != null) {
          return {
            kind: 'pipeline',
            entry: pipelineEntry,
            producer: { openTime, timingInfo, startup },
          };
        }
      }
      await delay(STARTUP_POLL_MS);
    }
    const error = new Error('timeout waiting for the Native loadBundle timing pipeline.');
    error.evidence = { lastStartupProbe };
    throw error;
  }

  return {
    environment,
    machine,

    isTableUnsupported(entry, kase, scale) {
      return unsupportedTableCells.has(`${entry.id}:${kase.name}:${scale}`)
        || (kase.pre !== 'empty' && unsupportedPrestateScales.has(`${entry.id}:${scale}`));
    },

    tableUnsupportedReason(entry, kase, scale) {
      return unsupportedTableCells.get(`${entry.id}:${kase.name}:${scale}`)
        ?? (kase.pre !== 'empty' ? unsupportedPrestateScales.get(`${entry.id}:${scale}`) : null)
        ?? null;
    },

    isStartupUnsupported(entry, rows) {
      return unsupportedStartupCells.has(`${entry.id}:${rows}`);
    },

    startupUnsupportedReason(entry, rows) {
      return unsupportedStartupCells.get(`${entry.id}:${rows}`) ?? null;
    },

    startupUnsupportedContracts(entry) {
      return startupMetricContracts(entry.id);
    },

    async recoverTransient(error) {
      const message = String(error);
      if (!isNativeTransientTransportFailure(error)) return false;
      machine.transientRecoveries.push({
        at: new Date().toISOString(),
        category: message.includes('timeout waiting for the Octane Native background root')
          ? 'octane-root-readiness-timeout'
          : 'devtool-transport-disconnect',
        message,
      });
      log(`  [sandbox] transient transport failure; restarting Explorer and retrying sample`);
      await restartExplorer();
      return true;
    },

    async classifyFailure(error, context) {
      const producerDnf = nativeProducerProtocolDnf(error, context);
      if (producerDnf != null) {
        if (context.suite === 'startup') {
          unsupportedStartupCells.set(`${context.entry.id}:${context.rows}`, producerDnf.failure);
        } else {
          unsupportedTableCells.set(
            `${context.entry.id}:${context.kase.name}:${context.scale}`, producerDnf.failure,
          );
        }
        return producerDnf;
      }
      const transportDnf = nativeTransportFailureDnf(error, context, {
        transientRecoveries: machine.transientRecoveries,
      });
      if (transportDnf == null) return null;
      await stopConsoleStream();
      session = null;
      const { failure } = transportDnf;
      if (context.suite === 'startup') {
        unsupportedStartupCells.set(`${context.entry.id}:${context.rows}`, failure);
      } else {
        unsupportedTableCells.set(`${context.entry.id}:${context.kase.name}:${context.scale}`, failure);
      }
      return transportDnf;
    },

    async loadBundle(entry, { rows, bundleBytes, bundleSha256, suite }) {
      const thermal = await waitForThermalReady(serial);
      machine.thermalGates ??= [];
      machine.thermalGates.push({ entry: entry.id, rows, suite, ...thermal });
      if (pageCount > 0 && pageCount % EXPLORER_RECYCLE_EVERY_PAGES === 0) await restartExplorer();
      else if (session) await stopConsoleStream();
      if (!Buffer.isBuffer(bundleBytes) || typeof bundleSha256 !== 'string') {
        throw new Error(`${entry.id} rows-${rows}: adapter requires immutable bundleBytes and bundleSha256.`);
      }
      const actualBundleSha256 = sha256(bundleBytes);
      if (actualBundleSha256 !== bundleSha256) {
        throw new Error(
          `${entry.id} rows-${rows}: in-memory bundle sha256 ${actualBundleSha256} `
          + `does not match receipt ${bundleSha256}.`,
        );
      }
      activeBundle = {
        entryId: entry.id,
        rows,
        bytes: bundleBytes,
        sha256: bundleSha256,
        served: 0,
      };
      if (currentEntryId !== entry.id) {
        buttonPoints.clear();
        cellGeometry.clear();
      }
      currentEntryId = entry.id;
      currentEntryFramework = entry.framework;
      currentRows = rows;
      startupPayloadLogged = false;
      lastObserved = null;
      const nonce = `${entry.id}-${rows}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const url = `http://127.0.0.1:${port}/main.lynx.bundle?run=${encodeURIComponent(nonce)}`;
      try {
        currentOpenTime = Date.now() + deviceClock.offsetMs;
        await connectorCall('open-page', () => connector.openPage(client.id, url));
      } catch (error) {
        if (!String(error).includes('No response found')) throw error;
        machine.transientRecoveries.push({
          at: new Date().toISOString(),
          category: 'open-page-no-response',
          message: String(error),
        });
        await restartExplorer();
        currentOpenTime = Date.now() + deviceClock.offsetMs;
        await connectorCall('open-page-after-restart', () => connector.openPage(client.id, url));
      }
      const deadline = Date.now() + DEFAULT_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const sessions = await connectorCall(
          'list-session-after-open',
          () => connector.sendListSessionMessage(client.id),
        );
        session = sessions.find((candidate) => candidate.url === url) ?? null;
        if (session) break;
        await delay(NATIVE_SANDBOX_POLICY.sessionDiscoveryPollMs);
      }
      if (!session) throw new Error(`Native session did not appear for ${entry.id} rows-${rows}.`);
      if (activeBundle.served < 1) {
        throw new Error(`Native session opened without fetching pinned ${entry.id} rows-${rows} bytes.`);
      }
      machine.servedInputs.push({
        entry: entry.id,
        rows,
        suite,
        sha256: bundleSha256,
        bytes: bundleBytes.length,
        served: activeBundle.served,
      });
      pageCount++;
      await startConsoleStream();
      if (entry.framework === 'octane' && suite !== 'startup') await waitForOctaneReady();
      log(`  [sandbox] ${entry.id} rows-${rows} session=${session.session_id}`);
    },

    async driveCase(kase, scale) {
      let phase = 'operation';
      try {
        if ((!isCurrentOctane() || OCTANE_TRIGGER_MODE === 'tap') && kase.trigger.button) {
          await ensureButtonPoint(kase.trigger.button(scale));
        }
        if (kase.pre !== 'empty') {
          phase = 'prestate';
          await createRows(scale, timeoutForTable(kase));
        }
        if (kase.pre === 'rows+preselect') {
          phase = 'preselect';
          const preselect = isCurrentOctane() && OCTANE_TRIGGER_MODE === 'driver'
            ? () => evaluateOctaneDriver('select', 5)
            : () => tapCell('col-label', 5);
          const preselected = await measuredTap(
            { name: 'select' },
            scale,
            preselect,
            DEFAULT_TIMEOUT_MS,
            { expectedName: 'select', allowAnySelection: true },
          );
          assertPostState(
            { name: 'select' },
            scale,
            preselected,
            { allowAnySelection: true },
          );
        }

        const expectedName = timingName(kase);
        phase = 'operation';
        const trigger = isCurrentOctane()
          ? octaneTrigger(kase, scale)
          : kase.trigger.button
            ? () => tapText(kase.trigger.button(scale))
            : () => tapCell(kase.trigger.cell.cls, kase.trigger.cell.rowIndex);
        lastObserved = await measuredTap(
          kase,
          scale,
          trigger,
          timeoutForTable(kase),
          { expectedName },
        );
        assertPostState(kase, scale, lastObserved);
      } catch (error) {
        const producerDnf = nativeProducerProtocolDnf(error, {
          suite: 'table', entry: currentEntryId, kase, scale,
        });
        if (producerDnf != null) {
          unsupportedTableCells.set(
            `${currentEntryId}:${kase.name}:${scale}`, producerDnf.failure,
          );
          log(`  [sandbox] ${currentEntryId} ${kase.name}@${scale} DNF: ${error.message}`);
          lastObserved = producerDnf;
          return;
        }
        if (String(error).includes('timeout')) {
          const evidence = isCurrentOctane() ? await octaneTimeoutEvidence() : null;
          const timeoutMs = timeoutForTable(kase);
          const failure = {
            category: 'timeout',
            entry: currentEntryId,
            workload: kase.name,
            scale,
            timeoutMs,
            phase,
            triggerMode: isCurrentOctane() ? OCTANE_TRIGGER_MODE : 'tap',
            message: String(error),
            evidence,
          };
          if (phase === 'prestate') {
            unsupportedPrestateScales.set(`${currentEntryId}:${scale}`, {
              ...failure,
              category: 'unreachable-prestate',
              originatingWorkload: kase.name,
            });
          }
          unsupportedTableCells.set(`${currentEntryId}:${kase.name}:${scale}`, failure);
          log(`  [sandbox] ${currentEntryId} ${kase.name}@${scale} DNF; remaining reps for this cell are DNF`);
          await restartExplorer();
          lastObserved = { dnf: true, failure };
          return;
        }
        throw error;
      }
    },

    async collect() {
      if (lastObserved?.dnf) return { dnf: true, failure: lastObserved.failure };
      if (!Number.isFinite(lastObserved?.latencyMs)) {
        throw new Error('Native timing was not collected after driveCase().');
      }
      return {
        latencyMs: lastObserved.latencyMs,
        boundary: lastObserved.boundary,
        settlementContract: NATIVE_TABLE_SETTLEMENT_CONTRACT,
        detail: lastObserved,
      };
    },

    async collectStartup() {
      try {
        const startupTimeoutMs = timeoutForStartup();
        const observed = await waitForStartup(startupTimeoutMs);
        if (observed.kind === 'pipeline') {
          const { entry } = observed;
          return {
            fcpMs: entry.totalFcp?.duration ?? entry.lynxFcp.duration,
            settledMs: entry.pipelineEnd - entry.openTime,
            detail: {
              kind: observed.kind,
              pipeline: entry,
              producer: observed.producer,
            },
          };
        }
        const { openTime, startup } = observed;
        return {
          metrics: {
            octaneCommitAck: {
              value: startup.commitAckMs - openTime,
              unit: 'ms',
              boundary: 'native-open-request-to-octane-transport-ack',
            },
            octaneSecondFrame: {
              value: startup.secondFrameMs - openTime,
              unit: 'ms',
              boundary: 'native-open-request-to-second-frame-after-octane-transport-ack',
            },
          },
          detail: observed,
        };
      } catch (error) {
        const producerDnf = nativeProducerProtocolDnf(error, {
          suite: 'startup', entry: currentEntryId, rows: currentRows,
        });
        if (producerDnf != null) {
          unsupportedStartupCells.set(
            `${currentEntryId}:${currentRows}`, producerDnf.failure,
          );
          log(`  [sandbox] ${currentEntryId} startup@${currentRows} DNF: ${error.message}`);
          return producerDnf;
        }
        const message = String(error);
        if (message.includes('No response found')) throw error;
        if (message.includes('timeout')) {
          log(`  [sandbox] ${currentEntryId} startup@${currentRows} DNF: ${message}`);
          const failure = {
            category: 'timeout',
            entry: currentEntryId,
            workload: 'startup',
            scale: currentRows,
            timeoutMs: timeoutForStartup(),
            message,
            capabilityScope: 'cell',
            evidence: {
              ...(error.evidence ?? { lastStartupProbe }),
              capabilityProven: false,
              producerProtocolExpected: NATIVE_STARTUP_PROTOCOL,
            },
          };
          unsupportedStartupCells.set(`${currentEntryId}:${currentRows}`, failure);
          return {
            dnf: true,
            failure,
            metricContracts: startupMetricContracts(currentEntryId),
          };
        }
        throw error;
      }
    },

    async dispose() {
      if (disposed) return;
      disposed = true;
      await stopConsoleStream();
      notifyTimingWaiters();
      await new Promise((resolve) => server.close(resolve));
      try {
        adb(serial, 'reverse', '--remove', `tcp:${port}`);
      } catch {
        // The lease may have expired; server cleanup is still complete.
      }
      try {
        machine.thermalEnd = readThermalState(serial);
      } catch (error) {
        machine.thermalEnd = { capturedAt: new Date().toISOString(), error: String(error) };
      }
      await directTransport?.close().catch(() => {});
    },
  };
}
