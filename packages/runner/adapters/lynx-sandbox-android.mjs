import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { TransformStream } from 'node:stream/web';

import { CREATE_BUTTON } from '@lynx-bench/shared/workloads';

const DEFAULT_PORT = 8765;
const DEFAULT_TIMEOUT_MS = Number(process.env.LYNX_SANDBOX_TIMEOUT_MS ?? 30_000);
const LONG_WORKLOAD_TIMEOUT_MS = Number(process.env.LYNX_SANDBOX_LONG_TIMEOUT_MS ?? 240_000);
if (!Number.isFinite(LONG_WORKLOAD_TIMEOUT_MS) || LONG_WORKLOAD_TIMEOUT_MS <= 0) {
  throw new Error(`invalid LYNX_SANDBOX_LONG_TIMEOUT_MS=${process.env.LYNX_SANDBOX_LONG_TIMEOUT_MS}.`);
}
const OCTANE_TRIGGER_MODE = process.env.LYNX_SANDBOX_OCTANE_TRIGGER ?? 'tap';
if (!['tap', 'driver'].includes(OCTANE_TRIGGER_MODE)) {
  throw new Error(`invalid LYNX_SANDBOX_OCTANE_TRIGGER=${JSON.stringify(OCTANE_TRIGGER_MODE)}; expected tap or driver.`);
}
const DEVTOOL_TRANSPORT_MODE = process.env.LYNX_SANDBOX_DEVTOOL_TRANSPORT ?? 'direct';
if (!['direct', 'daemon'].includes(DEVTOOL_TRANSPORT_MODE)) {
  throw new Error(
    `invalid LYNX_SANDBOX_DEVTOOL_TRANSPORT=${JSON.stringify(DEVTOOL_TRANSPORT_MODE)}; expected direct or daemon.`,
  );
}
const ROUTER_SETTLE_MS = Number(process.env.LYNX_SANDBOX_ROUTER_SETTLE_MS ?? 100);
if (!Number.isFinite(ROUTER_SETTLE_MS) || ROUTER_SETTLE_MS < 0) {
  throw new Error(`invalid LYNX_SANDBOX_ROUTER_SETTLE_MS=${process.env.LYNX_SANDBOX_ROUTER_SETTLE_MS}.`);
}
const EXPLORER_RECYCLE_EVERY_PAGES = Number(process.env.LYNX_SANDBOX_RECYCLE_EVERY_PAGES ?? 5);
if (!Number.isInteger(EXPLORER_RECYCLE_EVERY_PAGES) || EXPLORER_RECYCLE_EVERY_PAGES <= 0) {
  throw new Error(
    `invalid LYNX_SANDBOX_RECYCLE_EVERY_PAGES=${process.env.LYNX_SANDBOX_RECYCLE_EVERY_PAGES}.`,
  );
}
const MAX_BATTERY_TEMPERATURE_C = Number(process.env.LYNX_SANDBOX_MAX_BATTERY_TEMP_C ?? 40);
const THERMAL_GATE_TIMEOUT_MS = Number(process.env.LYNX_SANDBOX_THERMAL_GATE_TIMEOUT_MS ?? 300_000);
const EXPLORER_RECONNECT_TIMEOUT_MS = Number(process.env.LYNX_SANDBOX_RECONNECT_TIMEOUT_MS ?? 90_000);
if (!Number.isFinite(MAX_BATTERY_TEMPERATURE_C)) {
  throw new Error(`invalid LYNX_SANDBOX_MAX_BATTERY_TEMP_C=${process.env.LYNX_SANDBOX_MAX_BATTERY_TEMP_C}.`);
}
if (!Number.isFinite(THERMAL_GATE_TIMEOUT_MS) || THERMAL_GATE_TIMEOUT_MS <= 0) {
  throw new Error(`invalid LYNX_SANDBOX_THERMAL_GATE_TIMEOUT_MS=${process.env.LYNX_SANDBOX_THERMAL_GATE_TIMEOUT_MS}.`);
}
if (!Number.isFinite(EXPLORER_RECONNECT_TIMEOUT_MS) || EXPLORER_RECONNECT_TIMEOUT_MS <= 0) {
  throw new Error(`invalid LYNX_SANDBOX_RECONNECT_TIMEOUT_MS=${process.env.LYNX_SANDBOX_RECONNECT_TIMEOUT_MS}.`);
}

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
      'lynx sandbox adapter requires device-only @byted/agent-lynx@0.14.4; make it resolvable from packages/runner using the ByteDance registry before running --harness native.',
      { cause: error },
    );
  }
}

function adb(serial, ...args) {
  return execFileSync('adb', ['-s', serial, ...args], { encoding: 'utf8' }).trim();
}

function calibrateDeviceClock(serial) {
  let best = null;
  for (let index = 0; index < 7; index++) {
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
    await delay(5_000);
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

function startBundleServer(port, getBundlePath) {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
    if (url.pathname !== '/main.lynx.bundle') {
      response.writeHead(404).end('not found');
      return;
    }
    const bundlePath = getBundlePath();
    if (!bundlePath || !fs.existsSync(bundlePath)) {
      response.writeHead(503).end('bundle not ready');
      return;
    }
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/octet-stream',
      'Content-Length': fs.statSync(bundlePath).size,
    });
    fs.createReadStream(bundlePath).pipe(response);
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

export default async function createAdapter({ log = () => {} } = {}) {
  const serial = process.env.LYNX_SANDBOX_SERIAL;
  if (!serial) {
    throw new Error('lynx sandbox adapter requires LYNX_SANDBOX_SERIAL=<leased adb serial>.');
  }
  const leaseIdentity = process.env.LYNX_SANDBOX_LEASE_ID;
  if (!leaseIdentity) {
    throw new Error(
      'lynx sandbox adapter requires LYNX_SANDBOX_LEASE_ID=<unique lease issue/expiry identity>; '
      + 'a serial alone is reused across leases and cannot prove a same-lease cohort.',
    );
  }
  const port = Number(process.env.LYNX_SANDBOX_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid LYNX_SANDBOX_PORT: ${process.env.LYNX_SANDBOX_PORT}`);
  }
  const adbServerPort = Number.parseInt(process.env.ADB_SERVER_PORT ?? '5037', 10);
  if (!Number.isInteger(adbServerPort) || adbServerPort <= 0 || adbServerPort > 65535) {
    throw new Error(`invalid ADB_SERVER_PORT: ${process.env.ADB_SERVER_PORT}`);
  }

  let bundlePath = null;
  let session = null;
  let pageCount = 0;
  let currentEntryId = null;
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
  let startupEvents = [];
  let lastStartupProbe = null;
  let octanePipelineCapability = null;
  const timingWaiters = new Set();
  const unsupportedTableEntries = new Map();
  const unsupportedTableCells = new Map();
  const unsupportedPrestateScales = new Map();
  const unsupportedStartupEntries = new Map();
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
  const server = await startBundleServer(port, () => bundlePath);

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
    client = clients.find((candidate) =>
      candidate.id.startsWith(`${encodedSerial}:`)
      && candidate.info?.AppProcessName === 'com.lynx.explorer');
    if (!client) await delay(250);
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
  const deviceLeaseId = createHash('sha256')
    .update(`${serial}\0${leaseIdentity}`)
    .digest('hex')
    .slice(0, 12);
  const harnessConfigId = createHash('sha256')
    .update(JSON.stringify({
      devtoolTransport: DEVTOOL_TRANSPORT_MODE,
      debugRouterSettleMs: ROUTER_SETTLE_MS,
      explorerRecycleEveryPages: EXPLORER_RECYCLE_EVERY_PAGES,
      maxBatteryTemperatureC: MAX_BATTERY_TEMPERATURE_C,
      octaneTriggerMode: OCTANE_TRIGGER_MODE,
    }))
    .digest('hex')
    .slice(0, 8);
  const machine = {
    id: `${environment}-${deviceLeaseId}-${harnessConfigId}`,
    platform: 'android',
    osVersion,
    cpuModel: adb(serial, 'shell', 'getprop', 'ro.product.board') || model,
    cores: Number(adb(serial, 'shell', 'nproc')) || null,
    node: null,
    deviceModel: device.deviceModel ?? device.model ?? model,
    app: device.App,
    appVersion: device.AppVersion,
    explorerPackage,
    debugRouterVersion: device.debugRouterVersion,
    lynxSdkVersion: device.sdkVersion,
    agentLynxVersion: '0.14.4',
    devtoolTransport: DEVTOOL_TRANSPORT_MODE,
    debugRouterSettleMs: ROUTER_SETTLE_MS,
    explorerRecycleEveryPages: EXPLORER_RECYCLE_EVERY_PAGES,
    maxBatteryTemperatureC: MAX_BATTERY_TEMPERATURE_C,
    thermalGateTimeoutMs: THERMAL_GATE_TIMEOUT_MS,
    explorerReconnectTimeoutMs: EXPLORER_RECONNECT_TIMEOUT_MS,
    harnessConfigId,
    octaneTriggerMode: OCTANE_TRIGGER_MODE,
    deviceLeaseId,
    deviceLeaseIdentitySource: 'explicit-env',
    deviceClockOffsetMs: deviceClock.offsetMs,
    deviceClockCalibrationRttMs: deviceClock.rttMs,
    thermalStart,
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
      await delay(16);
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

  async function search(query) {
    const found = await cdp('DOM.performSearch', { query });
    try {
      if (!found.resultCount) return [];
      const result = await cdp('DOM.getSearchResults', {
        searchId: found.searchId,
        fromIndex: 0,
        toIndex: found.resultCount,
      });
      return result.nodeIds ?? [];
    } finally {
      await cdp('DOM.discardSearchResults', { searchId: found.searchId }).catch(() => {});
    }
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
    await delay(10);
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
      const index = timingEvents.findIndex((value) =>
        value?.name === expectedName && Number.isFinite(value.latencyMs));
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

  async function startConsoleStream() {
    await stopConsoleStream();
    consoleGeneration++;
    const generation = consoleGeneration;
    timingEvents = [];
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
          const startupMarker = args.findIndex((arg) => arg.value === '__NATIVE_BENCH_STARTUP__');
          if (startupMarker !== -1 && typeof args[startupMarker + 1]?.value === 'string') {
            try {
              startupEvents.push(JSON.parse(args[startupMarker + 1].value));
              notifyTimingWaiters();
            } catch {
              // Ignore malformed startup markers.
            }
          }
          if (marker === -1 || typeof args[marker + 1]?.value !== 'string') continue;
          try {
            timingEvents.push(JSON.parse(args[marker + 1].value));
            notifyTimingWaiters();
          } catch {
            // Ignore unrelated or malformed console output.
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
      const candidate = clients.find((next) => next.id === client.id);
      if (candidate && (!previousRouterId || candidate.info?.debugRouterId !== previousRouterId)) {
        ready = true;
        break;
      }
      await delay(250);
    }
    if (!ready) throw new Error(`Lynx Explorer did not reconnect on sandbox ${serial}.`);
    await connectorCall(
      'restart-enable-perf-metrics',
      () => connector.setGlobalSwitch(client.id, 'enable_perf_metrics', true),
    );
    session = null;
    await delay(500);
  }

  async function measuredTap(expectedName, trigger, timeoutMs) {
    timingEvents = [];
    await trigger();
    return waitForTiming(expectedName, timeoutMs);
  }

  function assertOctaneSnapshot(kase, scale, before, observed) {
    const snapshot = observed?.snapshot;
    if (!snapshot || !Number.isInteger(snapshot.rowCount)) {
      throw new Error(`Octane Native ${kase.name}@${scale} produced no post-ACK state snapshot.`);
    }
    let valid = false;
    switch (kase.name) {
      case 'create': valid = snapshot.rowCount === scale; break;
      case 'replace': valid = snapshot.rowCount === scale && snapshot.firstId !== before?.firstId; break;
      case 'append1k': valid = snapshot.rowCount === scale + 1000; break;
      case 'update10th': valid = snapshot.rowCount === scale && snapshot.firstLabel?.endsWith(' !!!'); break;
      case 'select': valid = snapshot.rowCount === scale && snapshot.selectedId === before?.secondId; break;
      case 'swap': valid = snapshot.rowCount === scale
        && snapshot.secondId === before?.row998Id && snapshot.row998Id === before?.secondId; break;
      case 'remove': valid = snapshot.rowCount === scale - 1 && snapshot.thirdId !== before?.thirdId; break;
      case 'clear': valid = snapshot.rowCount === 0; break;
      case 'updateStorm': valid = snapshot.rowCount === scale && snapshot.firstLabel === 'bench 50'; break;
      case 'selectStorm': valid = snapshot.rowCount === scale && snapshot.selectedId === snapshot.firstId; break;
      default: throw new Error(`no Octane Native predicate for ${kase.name}.`);
    }
    if (!valid) {
      throw new Error(
        `Octane Native post-ACK predicate failed for ${kase.name}@${scale}: `
        + JSON.stringify({ before, after: snapshot }),
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
    const trigger = currentEntryId === 'octane' && OCTANE_TRIGGER_MODE === 'driver'
      ? () => evaluateOctaneDriver('create', scale)
      : () => tapText(CREATE_BUTTON[scale]);
    const observed = await measuredTap('create', trigger, timeoutMs);
    if (currentEntryId === 'octane') {
      const expectedSource = OCTANE_TRIGGER_MODE === 'tap' ? 'native-tap' : 'devtool-driver';
      if (observed.source !== expectedSource) {
        throw new Error(`Octane Native create@${scale} used ${observed.source}; expected ${expectedSource}.`);
      }
      assertOctaneSnapshot({ name: 'create' }, scale, null, observed);
    }
  }

  const timeoutForTable = (kase) => currentEntryId === 'octane'
    ? Math.max(kase.timeoutMs ?? 0, LONG_WORKLOAD_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS;

  const timeoutForStartup = () => currentEntryId === 'octane'
    ? LONG_WORKLOAD_TIMEOUT_MS
    : DEFAULT_TIMEOUT_MS;

  async function waitForStartup(timeoutMs = DEFAULT_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    let timingInfoLogged = false;
    let nextFrameDebugAt = 0;
    let nextStartupPollAt = 0;
    while (Date.now() < deadline) {
      const shouldProbePipeline = currentEntryId !== 'octane' || octanePipelineCapability !== false;
      const result = shouldProbePipeline
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
        if (currentEntryId === 'octane') octanePipelineCapability = true;
        return { kind: 'pipeline', entry };
      }
      const timingInfo = currentEntryId === 'octane'
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
      let startup = currentEntryId === 'octane'
        ? startupEvents.findLast((candidate) => Number.isFinite(candidate?.secondFrameMs)) ?? null
        : null;
      if (currentEntryId === 'octane' && startup === null && Date.now() >= nextStartupPollAt) {
        nextStartupPollAt = Date.now() + 250;
        const startupResult = await cdp('Runtime.evaluate', {
          expression: `JSON.stringify(globalThis.__LYNX_BENCH_STARTUP__ ?? null)`,
          returnByValue: true,
        }, Math.max(1, deadline - Date.now()));
        startup = typeof startupResult.result?.value === 'string'
          ? JSON.parse(startupResult.result.value)
          : null;
      }
      const openTime = currentEntryId === 'octane'
        ? currentOpenTime
        : timingInfo?.extra_timing?.open_time;
      if (
        process.env.LYNX_SANDBOX_DEBUG_STARTUP === '1'
        && currentEntryId === 'octane'
        && Date.now() >= nextFrameDebugAt
      ) {
        nextFrameDebugAt = Date.now() + 1000;
        log(`  [sandbox:startup-frame-state] ${JSON.stringify({ openTime, startupEvents })}`);
      }
      if (
        Number.isFinite(openTime)
        && Number.isFinite(startup?.moduleStartMs)
        && Number.isFinite(startup?.commitAckMs)
        && Number.isFinite(startup?.firstFrameMs)
        && Number.isFinite(startup?.secondFrameMs)
        && startup.moduleStartMs >= openTime
        && startup.commitAckMs >= startup.moduleStartMs
        && startup.firstFrameMs >= openTime
        && startup.firstFrameMs >= startup.commitAckMs
        && startup.secondFrameMs >= startup.firstFrameMs
      ) {
        if (process.env.LYNX_SANDBOX_DEBUG_STARTUP === '1') {
          log(`  [sandbox:startup-frame] ${JSON.stringify({ openTime, startup })}`);
        }
        octanePipelineCapability = false;
        return {
          kind: 'octane-commit-fallback',
          openTime,
          timingInfo,
          startup,
        };
      }
      await delay(16);
    }
    const error = new Error('timeout waiting for the Native loadBundle timing pipeline.');
    error.evidence = { lastStartupProbe };
    throw error;
  }

  return {
    environment,
    machine,

    isTableUnsupported(entry, kase, scale) {
      return unsupportedTableEntries.has(entry.id)
        || unsupportedTableCells.has(`${entry.id}:${kase.name}:${scale}`)
        || (kase.pre !== 'empty' && unsupportedPrestateScales.has(`${entry.id}:${scale}`));
    },

    tableUnsupportedReason(entry, kase, scale) {
      return unsupportedTableEntries.get(entry.id)
        ?? unsupportedTableCells.get(`${entry.id}:${kase.name}:${scale}`)
        ?? (kase.pre !== 'empty' ? unsupportedPrestateScales.get(`${entry.id}:${scale}`) : null)
        ?? null;
    },

    isStartupUnsupported(entry, rows) {
      return unsupportedStartupEntries.has(entry.id)
        || unsupportedStartupCells.has(`${entry.id}:${rows}`);
    },

    startupUnsupportedReason(entry, rows) {
      const entryFailure = unsupportedStartupEntries.get(entry.id);
      if (entryFailure) {
        return rows === entryFailure.scale
          ? entryFailure
          : {
              ...entryFailure,
              category: 'performance-pipeline-unavailable-inherited',
              inheritedFromScale: entryFailure.scale,
              scale: rows,
            };
      }
      return unsupportedStartupCells.get(`${entry.id}:${rows}`) ?? null;
    },

    startupUnsupportedContracts(entry) {
      return entry.id === 'octane'
        ? [
            {
              name: 'octaneCommitAck', unit: 'ms',
              boundary: 'native-open-request-to-octane-transport-ack',
            },
            {
              name: 'octaneSecondFrame', unit: 'ms',
              boundary: 'native-open-request-to-second-frame-after-octane-transport-ack',
            },
          ]
        : [
            { name: 'fcp', unit: 'ms', boundary: 'native-open-to-fcp' },
            { name: 'settled', unit: 'ms', boundary: 'native-open-to-pipeline-end' },
          ];
    },

    async recoverTransient(error) {
      const message = String(error);
      if (
        !message.includes('No response found')
        && !message.includes('inactive hook')
        && !message.includes('Native CDP channel closed')
        && !message.includes('DevTool open-page failed: Error: closed')
        && !message.includes('CDP DOM.')
        && !message.includes('CDP Input.')
        && !message.includes('timeout waiting for the Octane Native background root')
      ) return false;
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
      const message = String(error);
      if (
        !message.includes('No response found')
        && !message.includes('inactive hook')
        && !message.includes('Native CDP channel closed')
        && !message.includes('DevTool open-page failed: Error: closed')
        && !message.includes('CDP DOM.')
        && !message.includes('CDP Input.')
      ) return null;
      const failure = {
        category: 'transport-retries-exhausted',
        entry: context.entry.id,
        workload: context.suite === 'startup' ? 'startup' : context.kase.name,
        scale: context.suite === 'startup' ? context.rows : context.scale,
        phase: context.suite,
        triggerMode: context.entry.id === 'octane' ? OCTANE_TRIGGER_MODE : 'tap',
        message,
        evidence: { transientRecoveries: machine.transientRecoveries.slice(-3) },
      };
      if (context.suite === 'startup') {
        unsupportedStartupCells.set(`${context.entry.id}:${context.rows}`, failure);
      } else {
        unsupportedTableCells.set(`${context.entry.id}:${context.kase.name}:${context.scale}`, failure);
      }
      return {
        dnf: true,
        failure,
        metricContracts: context.suite === 'startup'
          ? context.entry.id === 'octane'
            ? [
                {
                  name: 'octaneCommitAck', unit: 'ms',
                  boundary: 'native-open-request-to-octane-transport-ack',
                },
                {
                  name: 'octaneSecondFrame', unit: 'ms',
                  boundary: 'native-open-request-to-second-frame-after-octane-transport-ack',
                },
              ]
            : [
                { name: 'fcp', unit: 'ms', boundary: 'native-open-to-fcp' },
                { name: 'settled', unit: 'ms', boundary: 'native-open-to-pipeline-end' },
              ]
          : undefined,
      };
    },

    async loadBundle(entry, { rows, bundlePath: nextBundlePath, suite }) {
      if (pageCount > 0 && pageCount % EXPLORER_RECYCLE_EVERY_PAGES === 0) await restartExplorer();
      else if (session) await stopConsoleStream();
      bundlePath = nextBundlePath;
      if (currentEntryId !== entry.id) {
        buttonPoints.clear();
        cellGeometry.clear();
      }
      currentEntryId = entry.id;
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
        await delay(50);
      }
      if (!session) throw new Error(`Native session did not appear for ${entry.id} rows-${rows}.`);
      pageCount++;
      await startConsoleStream();
      if (entry.id === 'octane' && suite !== 'startup') await waitForOctaneReady();
      log(`  [sandbox] ${entry.id} rows-${rows} session=${session.session_id}`);
    },

    async driveCase(kase, scale) {
      if (unsupportedTableEntries.has(currentEntryId)) {
        lastObserved = { dnf: true, failure: unsupportedTableEntries.get(currentEntryId) };
        return;
      }
      let phase = 'operation';
      try {
        if ((currentEntryId !== 'octane' || OCTANE_TRIGGER_MODE === 'tap') && kase.trigger.button) {
          await ensureButtonPoint(kase.trigger.button(scale));
        }
        if (kase.pre !== 'empty') {
          phase = 'prestate';
          await createRows(scale, timeoutForTable(kase));
        }
        if (kase.pre === 'rows+preselect') {
          const preselect = currentEntryId === 'octane' && OCTANE_TRIGGER_MODE === 'driver'
            ? () => evaluateOctaneDriver('select', 5)
            : () => tapCell('col-label', 5);
          const preselected = await measuredTap('select', preselect, DEFAULT_TIMEOUT_MS);
          if (currentEntryId === 'octane' && preselected.snapshot?.selectedId == null) {
            throw new Error(`Octane Native preselect@${scale} did not select a row.`);
          }
        }

        const expectedName = timingName(kase);
        phase = 'operation';
        const before = currentEntryId === 'octane' ? await octaneSnapshot() : null;
        const trigger = currentEntryId === 'octane'
          ? octaneTrigger(kase, scale)
          : kase.trigger.button
            ? () => tapText(kase.trigger.button(scale))
            : () => tapCell(kase.trigger.cell.cls, kase.trigger.cell.rowIndex);
        lastObserved = await measuredTap(
          expectedName,
          trigger,
          timeoutForTable(kase),
        );
        if (currentEntryId === 'octane') {
          const expectedSource = OCTANE_TRIGGER_MODE === 'tap' ? 'native-tap' : 'devtool-driver';
          if (lastObserved.source !== expectedSource) {
            throw new Error(
              `Octane Native ${kase.name}@${scale} used ${lastObserved.source}; expected ${expectedSource}.`,
            );
          }
          assertOctaneSnapshot(kase, scale, before, lastObserved);
        }
      } catch (error) {
        if (String(error).includes('timeout')) {
          const evidence = currentEntryId === 'octane' ? await octaneTimeoutEvidence() : null;
          const timeoutMs = timeoutForTable(kase);
          const failure = {
            category: 'timeout',
            entry: currentEntryId,
            workload: kase.name,
            scale,
            timeoutMs,
            phase,
            triggerMode: currentEntryId === 'octane' ? OCTANE_TRIGGER_MODE : 'tap',
            message: String(error),
            evidence,
          };
          if ((phase === 'prestate' || kase.name === 'create') && scale > 1000) {
            unsupportedPrestateScales.set(`${currentEntryId}:${scale}`, {
              ...failure,
              category: 'unreachable-prestate',
              originatingWorkload: kase.name,
            });
          }
          if (kase.name === 'create' && scale === 1000) {
            unsupportedTableEntries.set(currentEntryId, failure);
            log(`  [sandbox] ${currentEntryId} table interactions unsupported; remaining table cells are DNF`);
          } else {
            unsupportedTableCells.set(`${currentEntryId}:${kase.name}:${scale}`, failure);
            log(`  [sandbox] ${currentEntryId} ${kase.name}@${scale} unsupported; remaining reps are DNF`);
          }
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
            detail: { kind: observed.kind, pipeline: entry },
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
        const message = String(error);
        if (message.includes('No response found')) throw error;
        if (message.includes('timeout')) {
          log(`  [sandbox] ${currentEntryId} startup@${currentRows} unsupported: ${message}`);
          const entryCapabilityMissing = currentEntryId !== 'octane' && currentRows === 0;
          const failure = {
            category: entryCapabilityMissing ? 'performance-pipeline-unavailable' : 'timeout',
            entry: currentEntryId,
            workload: 'startup',
            scale: currentRows,
            timeoutMs: timeoutForStartup(),
            message,
            capabilityScope: entryCapabilityMissing ? 'entry' : 'cell',
            evidence: error.evidence ?? { lastStartupProbe },
          };
          if (entryCapabilityMissing) unsupportedStartupEntries.set(currentEntryId, failure);
          else unsupportedStartupCells.set(`${currentEntryId}:${currentRows}`, failure);
          return {
            dnf: true,
            failure,
            metricContracts: currentEntryId === 'octane'
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
                ],
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
