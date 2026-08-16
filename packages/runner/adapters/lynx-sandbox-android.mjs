import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { ReadableStream } from 'node:stream/web';

import { CREATE_BUTTON } from '@lynx-bench/shared/workloads';

const DEFAULT_PORT = 8765;
const DEFAULT_TIMEOUT_MS = Number(process.env.LYNX_SANDBOX_TIMEOUT_MS ?? 30_000);
const OCTANE_STARTUP_MODE = process.env.LYNX_SANDBOX_OCTANE_STARTUP === '1';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function loadConnectorFactory() {
  try {
    const connector = await import('@byted/agent-lynx/connector');
    if (typeof connector.createDefaultConnector !== 'function') {
      throw new TypeError('module does not export createDefaultConnector().');
    }
    return connector.createDefaultConnector;
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
  const port = Number(process.env.LYNX_SANDBOX_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid LYNX_SANDBOX_PORT: ${process.env.LYNX_SANDBOX_PORT}`);
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
  let consoleGeneration = 0;
  let timingEvents = [];
  let startupEvents = [];
  const timingWaiters = new Set();
  const unsupportedTableEntries = new Set();
  const unsupportedTableCells = new Set();
  const unsupportedStartupCells = new Set();
  const buttonPoints = new Map();
  const cellGeometry = new Map();
  let disposed = false;
  const createDefaultConnector = await loadConnectorFactory();
  const connector = createDefaultConnector();
  const server = await startBundleServer(port, () => bundlePath);

  adb(serial, 'reverse', `tcp:${port}`, `tcp:${port}`);
  adb(serial, 'shell', 'monkey', '-p', 'com.lynx.explorer', '-c', 'android.intent.category.LAUNCHER', '1');

  const encodedSerial = encodeURIComponent(serial);
  let client = null;
  const clientDeadline = Date.now() + 30_000;
  while (!client && Date.now() < clientDeadline) {
    const clients = await connector.listClients();
    client = clients.find((candidate) =>
      candidate.id.startsWith(`${encodedSerial}:`)
      && candidate.info?.AppProcessName === 'com.lynx.explorer');
    if (!client) await delay(250);
  }
  if (!client) {
    server.close();
    throw new Error(`Lynx Explorer client not found for sandbox ${serial}.`);
  }
  await connector.setGlobalSwitch(client.id, 'enable_perf_metrics', true);

  const device = client.info;
  const deviceClock = calibrateDeviceClock(serial);
  const model = String(device.model ?? device.deviceModel ?? 'android').replace(/\s+/g, '-').toLowerCase();
  const osVersion = String(device.osVersion ?? adb(serial, 'shell', 'getprop', 'ro.build.version.release'));
  const environment = `lynx-native-android-${model}-${osVersion}`;
  const deviceLeaseId = createHash('sha256').update(serial).digest('hex').slice(0, 12);
  const machine = {
    id: `${environment}-${deviceLeaseId}`,
    platform: 'android',
    osVersion,
    cpuModel: adb(serial, 'shell', 'getprop', 'ro.product.board') || model,
    cores: Number(adb(serial, 'shell', 'nproc')) || null,
    node: null,
    deviceModel: device.deviceModel ?? device.model ?? model,
    app: device.App,
    appVersion: device.AppVersion,
    debugRouterVersion: device.debugRouterVersion,
    agentLynxVersion: '0.14.4',
    deviceLeaseId,
    deviceClockOffsetMs: deviceClock.offsetMs,
    deviceClockCalibrationRttMs: deviceClock.rttMs,
  };

  async function cdp(method, params = {}) {
    if (!session) throw new Error(`cannot call ${method} before a page is loaded.`);
    return connector.sendCDPMessage(client.id, session.session_id, method, params);
  }

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
    const output = await connector.sendCDPStream(
      client.id,
      session.session_id,
      ReadableStream.from(['mousePressed', 'mouseReleased'].map((type, index) => ({
        method: 'Input.emulateTouchFromMouseEvent',
        params: {
          type,
          ...point,
          timestamp: timestamp + index,
          button: 'left',
          clickCount: 1,
        },
      }))),
    );
    await output.inputClosed;
    await delay(10);
    await output[Symbol.asyncDispose]();
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
    consoleGeneration++;
    const generation = consoleGeneration;
    if (consoleReader) {
      await consoleReader.cancel().catch(() => {});
      consoleReader.releaseLock();
      consoleReader = null;
    }
    timingEvents = [];
    startupEvents = [];
    const stream = await connector.sendCDPStream(
      client.id,
      session.session_id,
      ReadableStream.from([{ method: 'Runtime.enable' }]),
    );
    const reader = stream.getReader();
    consoleReader = reader;
    void (async () => {
      try {
        while (generation === consoleGeneration) {
          const { done, value } = await reader.read();
          if (done || generation !== consoleGeneration) break;
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
      }
    })();
  }

  async function stopConsoleStream() {
    consoleGeneration++;
    if (!consoleReader) return;
    await consoleReader.cancel().catch(() => {});
    consoleReader.releaseLock();
    consoleReader = null;
  }

  async function restartExplorer() {
    await stopConsoleStream();
    const before = (await connector.listClients()).find((candidate) => candidate.id === client.id);
    const previousRouterId = before?.info?.debugRouterId;
    adb(serial, 'shell', 'am', 'force-stop', 'com.lynx.explorer');
    adb(serial, 'shell', 'monkey', '-p', 'com.lynx.explorer', '-c', 'android.intent.category.LAUNCHER', '1');
    const deadline = Date.now() + 30_000;
    let ready = false;
    while (Date.now() < deadline) {
      const clients = await connector.listClients();
      const candidate = clients.find((next) => next.id === client.id);
      if (candidate && (!previousRouterId || candidate.info?.debugRouterId !== previousRouterId)) {
        ready = true;
        break;
      }
      await delay(250);
    }
    if (!ready) throw new Error(`Lynx Explorer did not reconnect on sandbox ${serial}.`);
    await connector.setGlobalSwitch(client.id, 'enable_perf_metrics', true);
    session = null;
    await delay(500);
  }

  async function measuredTap(expectedName, trigger, timeoutMs) {
    timingEvents = [];
    await trigger();
    return waitForTiming(expectedName, timeoutMs);
  }

  async function createRows(scale) {
    const trigger = currentEntryId === 'octane'
      ? () => evaluateOctaneDriver('create', scale)
      : () => tapText(CREATE_BUTTON[scale]);
    await measuredTap('create', trigger, DEFAULT_TIMEOUT_MS);
    if (currentEntryId === 'octane') await waitForOctaneRowCount(scale);
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

    async loadBundle(entry, { rows, bundlePath: nextBundlePath }) {
      if (pageCount > 0 && pageCount % 5 === 0) await restartExplorer();
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
        await connector.openPage(client.id, url);
      } catch (error) {
        if (!String(error).includes('No response found')) throw error;
        await restartExplorer();
        currentOpenTime = Date.now() + deviceClock.offsetMs;
        await connector.openPage(client.id, url);
      }
      const deadline = Date.now() + DEFAULT_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const sessions = await connector.sendListSessionMessage(client.id);
        session = sessions.find((candidate) => candidate.url === url) ?? null;
        if (session) break;
        await delay(50);
      }
      if (!session) throw new Error(`Native session did not appear for ${entry.id} rows-${rows}.`);
      pageCount++;
      await startConsoleStream();
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
        }

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
      try {
        const entry = await waitForStartup();
        return {
          fcpMs: entry.totalFcp?.duration ?? entry.lynxFcp.duration,
          settledMs: entry.pipelineEnd - entry.openTime,
          metrics: { pipeline: entry },
        };
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
    },
  };
}
