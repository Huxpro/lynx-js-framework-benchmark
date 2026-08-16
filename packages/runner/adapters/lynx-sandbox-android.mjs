import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { TransformStream } from 'node:stream/web';

import { CREATE_BUTTON } from '@lynx-bench/shared/workloads';
import {
  assertNativePostState,
  captureNativePreState,
  collectValidatedNativeStartup,
  createNativeDomOracle,
} from '../src/native-dom-oracle.mjs';

const DEFAULT_PORT = 8765;
const DEFAULT_TIMEOUT_MS = Number(process.env.LYNX_SANDBOX_TIMEOUT_MS ?? 30_000);
const OCTANE_STARTUP_MODE = process.env.LYNX_SANDBOX_OCTANE_STARTUP === '1';
const ROUTER_SETTLE_MS = Number(process.env.LYNX_SANDBOX_ROUTER_SETTLE_MS ?? 100);
export const NATIVE_TABLE_RESULT_MARKER = '__NATIVE_BENCH_RESULT__';
export const NATIVE_TABLE_PROTOCOL = 'vue-lynx-native-bench-v1';
const TIMING_TOLERANCE_MS = 0.001;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function nativeRenderGraceMs(rows, timeoutMs, env = process.env) {
  const fallback = rows >= 30000 ? 15_000 : rows >= 10000 ? 5_000 : 500;
  const raw = rows >= 30000 ? env.LYNX_SANDBOX_RENDER_GRACE_30K_MS : undefined;
  const graceMs = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(graceMs) || graceMs < 0) {
    throw new Error(`invalid LYNX_SANDBOX_RENDER_GRACE_30K_MS: ${raw}`);
  }
  return Math.min(graceMs, timeoutMs);
}

async function loadConnectorFactory() {
  try {
    const connector = await import('@byted/agent-lynx/connector');
    if (typeof connector.Connector !== 'function'
      || typeof connector.AndroidTransport !== 'function') {
      throw new TypeError('module does not export Connector and AndroidTransport.');
    }
    return () => new connector.Connector([new connector.AndroidTransport()]);
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

export function installedPackageSha256(serial, packageName, runAdb = adb) {
  const packagePaths = String(
    runAdb(serial, 'shell', 'pm', 'path', packageName) ?? '',
  ).split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.startsWith('package:') ? line.slice('package:'.length) : null);
  if (packagePaths.length !== 1 || !packagePaths[0]) {
    throw new Error(
      `expected exactly one installed APK for ${packageName}, found ${packagePaths.length}.`,
    );
  }
  const output = String(
    runAdb(serial, 'shell', 'sha256sum', packagePaths[0]) ?? '',
  ).trim();
  const sha256 = output.split(/\s+/, 1)[0]?.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error(`could not verify installed APK SHA-256 for ${packageName}.`);
  }
  return sha256;
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

function startBundleServer(port, getBundleBytes) {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
    if (url.pathname !== '/main.lynx.bundle') {
      response.writeHead(404).end('not found');
      return;
    }
    const bundleBytes = getBundleBytes();
    if (!Buffer.isBuffer(bundleBytes)) {
      response.writeHead(503).end('bundle not ready');
      return;
    }
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/octet-stream',
      'Content-Length': bundleBytes.length,
    });
    response.end(bundleBytes);
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

export function validateNativeTimingPayload(payload, {
  currentEntryId,
  expectedName,
}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Native timing payload must be an object.');
  }
  const legacyOctane = currentEntryId === 'octane'
    && !Object.hasOwn(payload, 'protocol');
  if (payload.protocol !== NATIVE_TABLE_PROTOCOL && !legacyOctane) {
    throw new Error(
      `Native timing payload must declare protocol ${NATIVE_TABLE_PROTOCOL}.`,
    );
  }
  if (payload.name !== expectedName) {
    throw new Error(
      `Native timing payload name ${JSON.stringify(payload.name)} `
      + `does not match expected ${JSON.stringify(expectedName)}.`,
    );
  }
  for (const field of ['startMs', 'endMs', 'latencyMs']) {
    if (!Number.isFinite(payload[field])) {
      throw new Error(`Native timing payload has invalid ${field}.`);
    }
  }
  if (payload.startMs < 0 || payload.endMs < payload.startMs || payload.latencyMs < 0) {
    throw new Error('Native timing payload has invalid timestamp ordering.');
  }
  if (Math.abs((payload.endMs - payload.startMs) - payload.latencyMs)
    > TIMING_TOLERANCE_MS) {
    throw new Error('Native timing payload has inconsistent timestamps.');
  }
  return payload;
}

export function parseNativeTimingConsoleArgs(args, context) {
  if (args[0]?.value !== NATIVE_TABLE_RESULT_MARKER) return null;
  const encoded = args[1]?.value;
  if (typeof encoded !== 'string') {
    throw new Error('Native timing console marker is missing its JSON payload.');
  }
  let payload;
  try {
    payload = JSON.parse(encoded);
  } catch (error) {
    throw new Error('Native timing console marker has malformed JSON.', { cause: error });
  }
  return validateNativeTimingPayload(payload, context);
}

export function physicalDeviceFingerprint(device, serial, runAdb = adb) {
  const did = typeof device?.did === 'string' ? device.did.trim() : '';
  if (did) return createHash('sha256').update(did).digest('hex');
  for (const property of ['ro.serialno', 'ro.boot.serialno']) {
    const value = String(runAdb(serial, 'shell', 'getprop', property) ?? '').trim();
    if (value) {
      return createHash('sha256')
        .update(`android-property:${property}:${value}`)
        .digest('hex');
    }
  }
  throw new Error('Lynx Explorer client and Android device lack a stable physical identity.');
}

export async function createLynxSandboxAndroidAdapter(
  { log = () => {} } = {},
  {
    env = process.env,
    loadConnector = loadConnectorFactory,
    runAdb = adb,
    calibrateClock = calibrateDeviceClock,
    startServer = startBundleServer,
    wait = delay,
    now = Date.now,
  } = {},
) {
  const serial = env.LYNX_SANDBOX_SERIAL;
  if (!serial) {
    throw new Error('lynx sandbox adapter requires LYNX_SANDBOX_SERIAL=<leased adb serial>.');
  }
  const port = Number(env.LYNX_SANDBOX_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid LYNX_SANDBOX_PORT: ${env.LYNX_SANDBOX_PORT}`);
  }

  let bundleBytes = null;
  let server = null;
  let reverseInstalled = false;
  let session = null;
  let pageCount = 0;
  let currentEntryId = null;
  let currentRows = null;
  let currentSuite = null;
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
  let timingError = null;
  let pendingTimingName = null;
  let pageGeneration = 0;
  let startupEvents = [];
  const timingWaiters = new Set();
  const unsupportedTableEntries = new Set();
  const unsupportedTableCells = new Set();
  const unsupportedStartupCells = new Set();
  const buttonPoints = new Map();
  const cellGeometry = new Map();
  let disposed = false;
  let cdpEventDeliverySuppressed = false;
  let cleanupPromise = null;
  function cleanup() {
    if (cleanupPromise) return cleanupPromise;
    disposed = true;
    cleanupPromise = (async () => {
      const errors = [];
      if (cdpEventDeliverySuppressed) {
        try {
          await restoreCDPEventDelivery({ bestEffort: true });
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        await stopConsoleStream();
      } catch (error) {
        errors.push(error);
      }
      for (const resolve of timingWaiters) resolve();
      timingWaiters.clear();
      if (server) {
        const activeServer = server;
        server = null;
        try {
          await new Promise((resolve, reject) => {
            activeServer.close((error) => error ? reject(error) : resolve());
          });
        } catch (error) {
          errors.push(error);
        }
      }
      if (reverseInstalled) {
        reverseInstalled = false;
        try {
          runAdb(serial, 'reverse', '--remove', `tcp:${port}`);
        } catch {
          // Best effort: the lease may already be gone.
        }
      }
      if (errors.length > 0) throw new AggregateError(errors, 'lynx sandbox cleanup failed');
    })();
    return cleanupPromise;
  }

  let connector;
  let createConnector;
  let connectorCall;
  let client;
  let deviceClock;
  let environment;
  let machine;
  try {
    createConnector = await loadConnector();
    connector = createConnector();
    connectorCall = async (action) => {
      try {
        return await action();
      } finally {
        if (ROUTER_SETTLE_MS > 0) await wait(ROUTER_SETTLE_MS);
      }
    };
    server = await startServer(port, () => bundleBytes);

    reverseInstalled = true;
    runAdb(serial, 'reverse', `tcp:${port}`, `tcp:${port}`);
    runAdb(serial, 'shell', 'am', 'force-stop', 'com.lynx.explorer');
    runAdb(
      serial,
      'shell',
      'am',
      'start',
      '-n',
      'com.lynx.explorer/.LynxViewShellActivity',
    );

    const encodedSerial = encodeURIComponent(serial);
    const clientDeadline = now() + 30_000;
    while (!client && now() < clientDeadline) {
      const clients = await connectorCall(() => connector.listClients());
      client = clients.find((candidate) =>
        candidate.id.startsWith(`${encodedSerial}:`)
        && candidate.info?.AppProcessName === 'com.lynx.explorer');
      if (!client) await wait(250);
    }
    if (!client) {
      throw new Error('Lynx Explorer client was not found for the leased device.');
    }
    await connectorCall(
      () => connector.setGlobalSwitch(client.id, 'enable_perf_metrics', true),
    );

    const device = client.info;
    deviceClock = calibrateClock(serial);
    const model = String(device.model ?? device.deviceModel ?? 'android').replace(/\s+/g, '-').toLowerCase();
    const osVersion = String(device.osVersion ?? runAdb(serial, 'shell', 'getprop', 'ro.build.version.release'));
    environment = `lynx-native-android-${model}-${osVersion}`;
    const leaseId = createHash('sha256').update(serial).digest('hex');
    const physicalDeviceId = physicalDeviceFingerprint(device, serial, runAdb);
    const appApkSha256 = installedPackageSha256(
      serial,
      'com.lynx.explorer',
      runAdb,
    );
    machine = {
      id: physicalDeviceId,
      platform: 'android',
      osVersion,
      cpuModel: runAdb(serial, 'shell', 'getprop', 'ro.product.board') || model,
      cores: Number(runAdb(serial, 'shell', 'nproc')) || null,
      node: null,
      deviceModel: device.deviceModel ?? device.model ?? model,
      app: device.App,
      appVersion: device.AppVersion,
      sdkVersion: device.sdkVersion,
      debugRouterVersion: device.debugRouterVersion,
      agentLynxVersion: '0.14.4',
      appApkSha256,
      physicalDeviceId,
      leaseId,
      deviceClockOffsetMs: deviceClock.offsetMs,
      deviceClockCalibrationRttMs: deviceClock.rttMs,
    };
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'lynx sandbox adapter initialization and cleanup failed',
      );
    }
    throw error;
  }

  async function cdp(method, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (!session) throw new Error(`cannot call ${method} before a page is loaded.`);
    if (!consoleWriter) {
      return createConnector().sendCDPMessage(
        client.id,
        session.session_id,
        method,
        params,
      );
    }
    const id = ++nextCDPId;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingCDP.delete(id);
        reject(new Error(`timeout waiting ${timeoutMs}ms for ${method}`));
      }, timeoutMs);
      pendingCDP.set(id, { resolve, reject, timer });
    });
    try {
      await consoleWriter.write({ id, method, params });
    } catch (error) {
      clearTimeout(pendingCDP.get(id)?.timer);
      pendingCDP.delete(id);
      throw error;
    }
    return response;
  }

  async function setCDPEventDelivery(enabled, targetSession = session) {
    if (!targetSession) {
      throw new Error('cannot configure Native CDP event delivery without a session.');
    }
    await createConnector().sendCDPMessage(
      client.id,
      targetSession.session_id,
      'DOM.setEventDelivery',
      { enabled },
    );
    cdpEventDeliverySuppressed = !enabled;
  }

  async function waitForSession(url, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const sessions = await connectorCall(
        () => createConnector().sendListSessionMessage(client.id),
      );
      const matching = sessions.find((candidate) => candidate.url === url);
      if (matching) return matching;
      await wait(50);
    }
    return null;
  }

  async function restoreCDPEventDelivery({ bestEffort = false } = {}) {
    if (!cdpEventDeliverySuppressed) return;
    try {
      if (session && consoleWriter) {
        await cdp('DOM.setEventDelivery', { enabled: true });
        cdpEventDeliverySuppressed = false;
        return;
      }
      if (session) {
        await setCDPEventDelivery(true);
        return;
      }
      const sessions = await connectorCall(
        () => createConnector().sendListSessionMessage(client.id),
      );
      const targetSession = sessions.find((candidate) =>
        candidate.type === 'lynx') ?? null;
      await setCDPEventDelivery(true, targetSession);
    } catch (error) {
      if (!bestEffort) throw error;
      cdpEventDeliverySuppressed = false;
      log(`  [sandbox] best-effort CDP event restore skipped: ${error.message}`);
    }
  }

  const oracle = createNativeDomOracle(cdp);

  async function evaluateOctaneDriver(name, argument) {
    const expression = `globalThis.__LYNX_BENCH_DRIVER__.drive(${JSON.stringify(name)}, ${JSON.stringify(argument)})`;
    const result = await cdp('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: false,
    });
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
          if (!${OCTANE_STARTUP_MODE ? 'true' : 'false'} && globalThis.__LYNX_BENCH_COMMITTED__ !== true) {
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

  async function waitForOctaneRowCount(expected, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await cdp('Runtime.evaluate', {
        expression: `JSON.stringify(globalThis.__LYNX_BENCH_DRIVER__.drive('rowCount'))`,
        returnByValue: true,
      });
      const count = typeof result.result?.value === 'string'
        ? JSON.parse(result.result.value)
        : null;
      if (count === expected) return;
      await delay(16);
    }
    throw new Error(`timeout waiting for Octane Native rowCount=${expected}.`);
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
      if (timingError) {
        const error = timingError;
        timingError = null;
        throw error;
      }
      const index = timingEvents.findIndex((value) =>
        value.name === expectedName && value.adapterGeneration === pageGeneration);
      if (index !== -1) return timingEvents.splice(index, 1)[0];
      await new Promise((resolve) => {
        timingWaiters.add(resolve);
        setTimeout(() => {
          timingWaiters.delete(resolve);
          resolve();
        }, Math.min(250, Math.max(0, deadline - Date.now())));
      });
    }
    if (timingError) {
      const error = timingError;
      timingError = null;
      throw error;
    }
    throw new Error(`timeout waiting for Native timing ${expectedName}.`);
  }

  async function startConsoleStream({
    streamConnector = createConnector(),
    enableRuntime = true,
  } = {}) {
    await stopConsoleStream();
    consoleGeneration++;
    const generation = consoleGeneration;
    timingEvents = [];
    timingError = null;
    pendingTimingName = null;
    startupEvents = [];
    const input = new TransformStream();
    const stream = await streamConnector.sendCDPStream(
      client.id,
      session.session_id,
      input.readable,
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
              pending.reject(
                new Error(`CDP request error: ${value.error.message ?? JSON.stringify(value.error)}`),
              );
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
          const startupMarker = args.findIndex((arg) => arg.value === '__NATIVE_BENCH_STARTUP__');
          if (startupMarker !== -1 && typeof args[startupMarker + 1]?.value === 'string') {
            try {
              startupEvents.push(JSON.parse(args[startupMarker + 1].value));
              notifyTimingWaiters();
            } catch {
              // Ignore malformed startup markers.
            }
          }
          if (pendingTimingName == null) continue;
          try {
            const timing = parseNativeTimingConsoleArgs(args, {
              currentEntryId,
              expectedName: pendingTimingName,
            });
            if (timing) {
              timingEvents.push({
                ...timing,
                adapterGeneration: pageGeneration,
              });
              notifyTimingWaiters();
            }
          } catch (error) {
            timingError = error;
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
    if (enableRuntime) {
      await cdp('Page.enable');
      await cdp('Page.getResourceTree');
      await cdp('Debugger.enable');
      await cdp('Runtime.enable');
    }
  }

  async function stopConsoleStream() {
    consoleGeneration++;
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
    await output?.[Symbol.asyncDispose]?.().catch(() => {});
    if ((writer || reader || output) && ROUTER_SETTLE_MS > 0) {
      await delay(ROUTER_SETTLE_MS);
    }
  }

  async function restartExplorer(initialUrl = null) {
    await stopConsoleStream();
    const before = (await connectorCall(() => createConnector().listClients()))
      .find((candidate) => candidate.id === client.id);
    const previousRouterId = before?.info?.debugRouterId;
    runAdb(serial, 'shell', 'am', 'force-stop', 'com.lynx.explorer');
    const launchArgs = [
      'shell',
      'am',
      'start',
      '-n',
      'com.lynx.explorer/.LynxViewShellActivity',
    ];
    if (initialUrl) launchArgs.push('--es', 'url', initialUrl);
    runAdb(serial, ...launchArgs);
    const deadline = Date.now() + 30_000;
    let ready = false;
    while (Date.now() < deadline) {
      const clients = await connectorCall(() => createConnector().listClients());
      const candidate = clients.find((next) => next.id === client.id);
      if (candidate && (!previousRouterId || candidate.info?.debugRouterId !== previousRouterId)) {
        client = candidate;
        ready = true;
        break;
      }
      await delay(250);
    }
    if (!ready) throw new Error('Lynx Explorer did not reconnect on the leased device.');
    await connectorCall(
      () => createConnector().setGlobalSwitch(client.id, 'enable_perf_metrics', true),
    );
    session = null;
    await delay(500);
  }

  async function measuredTap(expectedName, trigger, timeoutMs) {
    timingEvents = [];
    timingError = null;
    pendingTimingName = expectedName;
    try {
      await trigger();
      return await waitForTiming(expectedName, timeoutMs);
    } finally {
      if (pendingTimingName === expectedName) pendingTimingName = null;
    }
  }

  async function createRows(scale) {
    const trigger = currentEntryId === 'octane'
      ? () => evaluateOctaneDriver('create', scale)
      : () => tapText(CREATE_BUTTON[scale]);
    await measuredTap('create', trigger, DEFAULT_TIMEOUT_MS);
    if (currentEntryId === 'octane') await waitForOctaneRowCount(scale);
    else await oracle.assertRenderedRows(scale);
  }

  async function waitForStartup(timeoutMs = DEFAULT_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    let timingInfoLogged = false;
    let startupCaptureRequested = false;
    let nextFrameDebugAt = 0;
    let nextStartupPollAt = 0;
    while (Date.now() < deadline) {
      // Octane's custom renderer does not publish a pipeline entry, and asking
      // this Explorer build for the empty cache can tear down DevTool on large
      // initial trees. Its fallback below uses getAllTimingInfo + frame markers.
      const result = currentEntryId === 'octane'
        ? { entries: [] }
        : await cdp('Performance.getAllPerformanceEntries');
      if (process.env.LYNX_SANDBOX_DEBUG_STARTUP === '1' && !startupPayloadLogged) {
        startupPayloadLogged = true;
        log(`  [sandbox:startup-payload] ${JSON.stringify(result)}`);
      }
      const entry = result.entries?.find((candidate) =>
        candidate.entryType === 'pipeline'
        && candidate.name === 'loadBundle'
        && Number.isFinite(candidate.pipelineEnd));
      if (entry?.lynxFcp && Number.isFinite(entry.openTime)) return entry;
      if (currentEntryId === 'octane' && !startupCaptureRequested) {
        startupCaptureRequested = true;
        await evaluateOctaneDriver('captureStartup');
      }
      const timingInfo = currentEntryId === 'octane'
        ? null
        : await cdp('Performance.getAllTimingInfo').catch(() => null);
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
        });
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
        && Number.isFinite(startup?.firstFrameMs)
        && Number.isFinite(startup?.secondFrameMs)
        && startup.firstFrameMs >= openTime
        && startup.secondFrameMs >= startup.firstFrameMs
      ) {
        if (process.env.LYNX_SANDBOX_DEBUG_STARTUP === '1') {
          log(`  [sandbox:startup-frame] ${JSON.stringify({ openTime, startup })}`);
        }
        return {
          entryType: 'pipeline',
          name: 'loadBundle',
          openTime,
          pipelineEnd: startup.secondFrameMs,
          lynxFcp: { duration: startup.firstFrameMs - openTime },
          totalFcp: { duration: startup.firstFrameMs - openTime },
          benchmarkFrameFallback: true,
          timingInfo,
          startup,
        };
      }
      await delay(16);
    }
    throw new Error('timeout waiting for the Native loadBundle timing pipeline.');
  }

  return {
    environment,
    machine,

    isTableUnsupported(entry, kase, scale) {
      return unsupportedTableEntries.has(entry.id)
        || unsupportedTableCells.has(`${entry.id}:${kase.name}:${scale}`);
    },

    isStartupUnsupported(entry, rows) {
      return unsupportedStartupCells.has(`${entry.id}:${rows}`);
    },

    async assertRenderedRows(rows, timeoutMs = DEFAULT_TIMEOUT_MS) {
      await wait(nativeRenderGraceMs(rows, timeoutMs, env));
      if (!consoleWriter) {
        await startConsoleStream({
          streamConnector: createConnector(),
          enableRuntime: false,
        });
      }
      if (currentSuite === 'count-only') {
        try {
          const found = await cdp(
            'DOM.performSearch',
            { query: 'col-id', countOnly: true },
            timeoutMs,
          );
          if (!Number.isSafeInteger(found?.resultCount) || found.resultCount < 0) {
            throw new Error('Native count-only search returned an invalid resultCount.');
          }
          if (found.resultCount !== rows) {
            throw new Error(
              `Native rendered row count mismatch: expected ${rows}, got ${found.resultCount}`,
            );
          }
          return found.resultCount;
        } finally {
          await restoreCDPEventDelivery({ bestEffort: true });
        }
      }
      return oracle.assertRenderedRows(rows);
    },

    async recoverTransient(error) {
      const message = String(error);
      if (
        !message.includes('No response found')
        && !(OCTANE_STARTUP_MODE && message.includes('inactive hook'))
      ) return false;
      log(`  [sandbox] transient transport failure; restarting Explorer and retrying sample`);
      await restartExplorer();
      return true;
    },

    async loadBundle(entry, { rows, bundleBytes: nextBundleBytes, suite }) {
      if (pageCount > 0 && pageCount % 5 === 0) await restartExplorer();
      else if (session) await stopConsoleStream();
      if (!Buffer.isBuffer(nextBundleBytes)) {
        throw new Error('Sandbox adapter requires immutable bundleBytes.');
      }
      bundleBytes = Buffer.from(nextBundleBytes);
      if (currentEntryId !== entry.id) {
        buttonPoints.clear();
        cellGeometry.clear();
      }
      currentEntryId = entry.id;
      currentRows = rows;
      currentSuite = suite;
      pageGeneration++;
      startupPayloadLogged = false;
      lastObserved = null;
      const nonce = `${entry.id}-${rows}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const url = `http://127.0.0.1:${port}/main.lynx.bundle?run=${encodeURIComponent(nonce)}`;
      currentOpenTime = Date.now() + deviceClock.offsetMs;
      await restartExplorer(url);
      session = await waitForSession(url);
      if (!session) {
        throw new Error(`Native session did not appear for ${entry.id} rows-${rows}.`);
      }
      if (suite === 'count-only') {
        await setCDPEventDelivery(false);
        pageCount++;
        log(`  [sandbox] ${entry.id} rows-${rows} session=${session.session_id}`);
        return;
      }
      pageCount++;
      if (suite === 'table') {
        await startConsoleStream();
        await cdp('DOM.setEventDelivery', { enabled: false });
        cdpEventDeliverySuppressed = true;
      }
      if (entry.id === 'octane') await waitForOctaneReady();
      log(`  [sandbox] ${entry.id} rows-${rows} session=${session.session_id}`);
    },

    async driveCase(kase, scale) {
      if (unsupportedTableEntries.has(currentEntryId)) {
        lastObserved = { dnf: true };
        return;
      }
      try {
        if (currentEntryId !== 'octane' && kase.trigger.button) {
          await ensureButtonPoint(kase.trigger.button(scale));
        }
        if (kase.pre !== 'empty') await createRows(scale);
        if (kase.pre === 'rows+preselect') {
          const preselect = currentEntryId === 'octane'
            ? () => evaluateOctaneDriver('select', 5)
            : () => tapCell('col-label', 5);
          await measuredTap('select', preselect, DEFAULT_TIMEOUT_MS);
          if (currentEntryId !== 'octane') await oracle.assertUniqueDanger(5);
        }

        const preState = currentEntryId === 'octane'
          ? null
          : await captureNativePreState(oracle, kase, scale);
        const expectedName = timingName(kase);
        let trigger;
        if (currentEntryId === 'octane') {
          const operation = kase.name === 'replace' ? 'create' : kase.name;
          const argument = kase.name === 'create' || kase.name === 'replace'
            ? scale
            : kase.trigger.cell?.rowIndex;
          trigger = () => evaluateOctaneDriver(operation, argument);
        } else {
          trigger = kase.trigger.button
            ? () => tapText(kase.trigger.button(scale))
            : () => tapCell(kase.trigger.cell.cls, kase.trigger.cell.rowIndex);
        }
        lastObserved = await measuredTap(
          expectedName,
          trigger,
          Math.min(kase.timeoutMs ?? DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
        );
        if (currentEntryId !== 'octane') {
          await assertNativePostState(oracle, kase, scale, preState);
        }
      } catch (error) {
        if (String(error).includes('timeout')) {
          if (kase.name === 'create' && scale === 1000) {
            unsupportedTableEntries.add(currentEntryId);
            log(`  [sandbox] ${currentEntryId} table interactions unsupported; remaining table cells are DNF`);
          } else {
            unsupportedTableCells.add(`${currentEntryId}:${kase.name}:${scale}`);
            log(`  [sandbox] ${currentEntryId} ${kase.name}@${scale} unsupported; remaining reps are DNF`);
          }
          await restartExplorer();
          lastObserved = { dnf: true };
          return;
        }
        throw error;
      }
    },

    async collect() {
      if (lastObserved?.dnf) return { dnf: true };
      if (!Number.isFinite(lastObserved?.latencyMs)) {
        throw new Error('Native timing was not collected after driveCase().');
      }
      return { latencyMs: lastObserved.latencyMs };
    },

    async collectStartup() {
      let entry;
      try {
        entry = await collectValidatedNativeStartup({
          acquireTiming: () => waitForStartup(),
          oracle,
          rows: currentRows,
          requireReady: currentEntryId !== 'octane' && currentRows === 0,
        });
      } catch (error) {
        const message = String(error);
        if (message.includes('No response found')) throw error;
        if (message.includes('timeout')) {
          log(`  [sandbox] ${currentEntryId} startup@${currentRows} unsupported: ${message}`);
          unsupportedStartupCells.add(`${currentEntryId}:${currentRows}`);
          return { dnf: true };
        }
        throw error;
      }
      return {
        fcpMs: entry.totalFcp?.duration ?? entry.lynxFcp.duration,
        settledMs: entry.pipelineEnd - entry.openTime,
        metrics: { pipeline: entry },
      };
    },

    async dispose() {
      await cleanup();
    },
  };
}

export default createLynxSandboxAndroidAdapter;
