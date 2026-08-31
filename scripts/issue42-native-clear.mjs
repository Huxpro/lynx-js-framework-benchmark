import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const readArg = (name) => {
  const index = args.indexOf(name);
  if (index === -1 || args[index + 1] === undefined) throw new Error(`missing ${name}`);
  return args[index + 1];
};

const serial = readArg('--serial');
const disableUrl = readArg('--disable-url');
const disableFile = path.resolve(readArg('--disable-file'));
const output = path.resolve(readArg('--out'));
const samples = Number(readArg('--samples'));
const timeoutMs = Number(readArg('--timeout-ms'));
const createPoint = {
  x: Number(readArg('--create-tap-x')),
  y: Number(readArg('--create-tap-y')),
};
const clearPoint = {
  x: Number(readArg('--clear-tap-x')),
  y: Number(readArg('--clear-tap-y')),
};
const cells = [];
for (let index = 0; index < args.length; index++) {
  if (args[index] !== '--cell') continue;
  const value = args[index + 1] ?? '';
  const split = value.indexOf('=');
  if (split < 1) throw new Error(`invalid --cell ${JSON.stringify(value)}`);
  cells.push({ label: value.slice(0, split), url: value.slice(split + 1) });
}
for (let index = 0; index < args.length; index++) {
  if (args[index] !== '--cell-file') continue;
  const value = args[index + 1] ?? '';
  const split = value.indexOf('=');
  if (split < 1) throw new Error(`invalid --cell-file ${JSON.stringify(value)}`);
  const cell = cells.find((candidate) => candidate.label === value.slice(0, split));
  if (cell === undefined) throw new Error(`--cell-file has no matching cell: ${value}`);
  cell.file = path.resolve(value.slice(split + 1));
}
if (!Number.isSafeInteger(samples) || samples < 1) throw new Error('--samples must be positive.');
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('--timeout-ms must be positive.');
if (cells.length !== 3 || cells.some((cell) => cell.file === undefined)) {
  throw new Error('exactly three cells and three --cell-file inputs are required.');
}
for (const point of [createPoint, clearPoint]) {
  if (!Number.isSafeInteger(point.x) || point.x < 0 || !Number.isSafeInteger(point.y) || point.y < 0) {
    throw new Error('tap coordinates must be non-negative integers.');
  }
}

const run = (command, commandArgs) => {
  const result = spawnSync(command, commandArgs, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(' ')} failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout ?? '';
};
const adb = (...commandArgs) => run('adb', ['-s', serial, ...commandArgs]);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function jsonAfterMarker(line, marker) {
  const start = line.indexOf(marker);
  if (start === -1) return null;
  const text = line.slice(start + marker.length);
  const objectStart = text.indexOf('{');
  if (objectStart === -1) return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = objectStart; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return JSON.parse(text.slice(objectStart, index + 1));
  }
  return null;
}

const epoch = (line) => {
  const match = line.match(/^\s*(\d+\.\d+)/);
  return match === null ? null : Number(match[1]) * 1000;
};

function parseLog(log) {
  const lines = log.split('\n');
  const native = [];
  const devtoolDisabledEvidence = [];
  const devtoolEnabledEvidence = [];
  const errors = [];
  let loadStartMs = null;
  let firstScreenMs = null;
  let loadEndMs = null;
  let engine = null;
  for (const line of lines) {
    if (/DevTool disabled\. Transitioning to ATTACHED\.|disable lynx debug/i.test(line)) {
      devtoolDisabledEvidence.push(line.trim());
    }
    if (/DevTool enabled\. Transitioning to ENABLED\.|\benable lynx debug/i.test(line)) {
      devtoolEnabledEvidence.push(line.trim());
    }
    if (line.includes('__NATIVE_BENCH_RESULT__')) {
      const value = jsonAfterMarker(line, '__NATIVE_BENCH_RESULT__');
      if (value !== null) native.push(value);
    }
    if (line.includes('__ISSUE194_NATIVE_RESULT__')) {
      const value = jsonAfterMarker(line, '__ISSUE194_NATIVE_RESULT__');
      if (value !== null) native.push({ ...value, name: value.workload });
    }
    if (line.includes('start TemplateAssembler::LoadTemplate')) loadStartMs ??= epoch(line);
    if (line.includes('LynxTemplateRender: onFirstScreen')) firstScreenMs ??= epoch(line);
    if (line.includes('end TemplateAssembler::LoadTemplate')) loadEndMs ??= epoch(line);
    const version = line.match(/App Bundle's engine version: ([^,]+), lynx sdk version:([^,]+)/);
    if (version !== null)
      engine = {
        appBundleEngine: version[1].trim(),
        lynxSdk: version[2].trim(),
      };
    if (
      /FATAL EXCEPTION|app::onAppJSError|main-thread\.js exception|loadCard failed|JNI ERROR|Abort message:|Fatal signal \d+|Process com\.lynx\.explorer .* has died/.test(
        line,
      )
    ) {
      errors.push(line.trim());
    }
  }
  return {
    lines,
    native,
    loadStartMs,
    firstScreenMs,
    loadEndMs,
    engine,
    errors,
    devtoolDisabledEvidence,
    devtoolEnabledEvidence,
  };
}

function thermalSnapshot() {
  const battery = adb('shell', 'dumpsys', 'battery');
  const thermal = adb('shell', 'dumpsys', 'thermalservice');
  const temperature = battery.match(/temperature:\s*(\d+)/)?.[1];
  const status = thermal.match(/Thermal Status:\s*(\d+)/i)?.[1] ?? thermal.match(/mStatus=(\d+)/)?.[1];
  return {
    batteryTemperatureTenthsC: temperature === undefined ? null : Number(temperature),
    thermalStatus: status === undefined ? null : Number(status),
    loadavg: adb('shell', 'cat', '/proc/loadavg').trim(),
  };
}

async function coolBeforeSample() {
  for (let attempt = 0; attempt < 15; attempt++) {
    const snapshot = thermalSnapshot();
    if (
      snapshot.batteryTemperatureTenthsC !== null &&
      snapshot.batteryTemperatureTenthsC <= 350 &&
      snapshot.thermalStatus === 0
    ) {
      return snapshot;
    }
    console.log(`[issue42] cooling: ${JSON.stringify(snapshot)}`);
    await delay(20_000);
  }
  throw new Error('device did not return to the <=35C / thermal-status-0 gate.');
}

async function ensureInteractive() {
  const stayAwake = Number(adb('shell', 'settings', 'get', 'global', 'stay_on_while_plugged_in').trim());
  if (!Number.isSafeInteger(stayAwake) || stayAwake === 0) {
    throw new Error('device stay-on-while-plugged gate is not enabled.');
  }
  adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
  run('adb', ['-s', serial, 'shell', 'wm', 'dismiss-keyguard']);
  await delay(250);
  const power = adb('shell', 'dumpsys', 'power');
  if (!/mWakefulness=Awake/.test(power) || !/Display Power: state=ON/.test(power)) {
    throw new Error('device did not reach the interactive display-on gate.');
  }
}

function bundleIdentity(file) {
  const bytes = fs.readFileSync(file);
  return {
    path: file,
    bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
}

function balancedSequence(count) {
  const sequence = [];
  const pattern = [0, 1, 2, 2, 1, 0];
  const accepted = [0, 0, 0];
  for (let index = 0; accepted.some((value) => value < count); index++) {
    const candidate = pattern[index % pattern.length];
    if (accepted[candidate] >= count) continue;
    accepted[candidate]++;
    sequence.push(candidate);
  }
  return sequence;
}

const populated = (state) =>
  state?.rowCount === 1000 &&
  Number.isInteger(state.firstId) &&
  Number.isInteger(state.secondId) &&
  Number.isInteger(state.thirdId) &&
  Number.isInteger(state.row998Id);

async function waitForResult({ workload, deadline, logMarker }) {
  while (Date.now() < deadline) {
    await delay(500);
    const fullLog = adb('logcat', '-d', '-v', 'epoch');
    const markerIndex = fullLog.lastIndexOf(logMarker);
    const log = markerIndex === -1 ? '' : fullLog.slice(markerIndex);
    const parsed = parseLog(log);
    const result = parsed.native.find(
      (entry) =>
        ['lynx-native-bench-v2', 'octane-issue194-native-v1'].includes(entry.protocol) && entry.name === workload,
    );
    if (result !== undefined) {
      console.log(`[issue42] observed ${workload} receipt (${result.protocol})`);
      return { result, parsed, log };
    }
    if (parsed.errors.length > 0) return { result: null, parsed, log };
  }
  const fullLog = adb('logcat', '-d', '-v', 'epoch');
  const markerIndex = fullLog.lastIndexOf(logMarker);
  const log = markerIndex === -1 ? '' : fullLog.slice(markerIndex);
  return { result: null, parsed: parseLog(log), log };
}

async function measure(cell, ordinal) {
  const thermalBefore = await coolBeforeSample();
  await ensureInteractive();
  adb('shell', 'am', 'force-stop', 'com.lynx.explorer');
  adb('logcat', '-c');
  const preflightMarker = `__ISSUE42_LOG_START__preflight-${ordinal}-${Date.now()}`;
  adb('shell', 'log', '-t', 'issue42-native', preflightMarker);
  adb('shell', 'am', 'start', '-n', 'com.lynx.explorer/.LynxViewShellActivity', '--es', 'lynx_initial_url', disableUrl);
  const disableDeadline = Date.now() + 30_000;
  let disableLog = '';
  while (Date.now() < disableDeadline) {
    await delay(250);
    const fullLog = adb('logcat', '-d', '-v', 'epoch');
    const markerIndex = fullLog.lastIndexOf(preflightMarker);
    disableLog = markerIndex === -1 ? '' : fullLog.slice(markerIndex);
    const disabledIndex = disableLog.lastIndexOf('DevTool disabled. Transitioning to ATTACHED.');
    const acknowledgementIndex = disableLog.lastIndexOf('__OCTANE_DEVTOOL_DISABLED__=true');
    if (disabledIndex !== -1 && acknowledgementIndex > disabledIndex) break;
  }
  const disabledIndex = disableLog.lastIndexOf('DevTool disabled. Transitioning to ATTACHED.');
  const acknowledgementIndex = disableLog.lastIndexOf('__OCTANE_DEVTOOL_DISABLED__=true');
  if (disabledIndex === -1 || acknowledgementIndex < disabledIndex) {
    throw new Error('DevTool preflight did not acknowledge a disabled lifecycle.');
  }
  if (/DevTool enabled\. Transitioning to ENABLED\./.test(disableLog.slice(disabledIndex))) {
    throw new Error('DevTool preflight re-enabled after the disable transition.');
  }
  const disableParsed = parseLog(disableLog);
  adb('logcat', '-c');
  const measurementMarker = `__ISSUE42_LOG_START__measurement-${ordinal}-${Date.now()}`;
  adb('shell', 'log', '-t', 'issue42-native', measurementMarker);
  adb(
    'shell',
    'am',
    'start',
    '-W',
    '-a',
    'android.intent.action.VIEW',
    '-d',
    `lynx://open?url=${encodeURIComponent(cell.url)}`,
    'com.lynx.explorer',
  );
  const deadline = Date.now() + timeoutMs;
  let parsed;
  let log = '';
  while (Date.now() < deadline) {
    await delay(500);
    const fullLog = adb('logcat', '-d', '-v', 'epoch');
    const markerIndex = fullLog.lastIndexOf(measurementMarker);
    log = markerIndex === -1 ? '' : fullLog.slice(markerIndex);
    parsed = parseLog(log);
    if (parsed.firstScreenMs !== null && parsed.loadEndMs !== null) break;
    if (parsed.errors.length > 0) break;
  }
  parsed ??= parseLog(log);
  const createIssuedAtMs = Date.now();
  adb('shell', 'input', 'tap', String(createPoint.x), String(createPoint.y));
  const createObserved = await waitForResult({
    workload: 'create',
    deadline,
    logMarker: measurementMarker,
  });
  console.log(`[issue42] ${cell.label} create receipt: ${createObserved.result !== null}`);
  let clearIssuedAtMs = null;
  if (createObserved.result !== null && createObserved.parsed.errors.length === 0) {
    // Keep input commits distinct. The native producer receipt is emitted on
    // the second frame, but Explorer can still be returning control to the
    // Android input queue at that exact instant.
    await delay(1_000);
    clearIssuedAtMs = Date.now();
    adb('shell', 'input', 'tap', String(clearPoint.x), String(clearPoint.y));
  }
  const clearObserved =
    createObserved.result === null
      ? { result: null, parsed: createObserved.parsed, log: createObserved.log }
      : await waitForResult({
          workload: 'clear',
          deadline,
          logMarker: measurementMarker,
        });
  console.log(`[issue42] ${cell.label} clear receipt: ${clearObserved.result !== null}`);
  adb('shell', 'am', 'force-stop', 'com.lynx.explorer');
  const thermalAfter = thermalSnapshot();
  const create = createObserved.result;
  const clear = clearObserved.result;
  const accepted =
    create !== null &&
    clear !== null &&
    create.source === 'native-tap' &&
    clear.source === 'native-tap' &&
    create.boundary === 'native-input-handler-to-second-native-frame' &&
    clear.boundary === 'native-input-handler-to-second-native-frame' &&
    create.renderEvidence?.frames === 2 &&
    clear.renderEvidence?.frames === 2 &&
    create.preState?.rowCount === 0 &&
    populated(create.postState) &&
    populated(clear.preState) &&
    clear.postState?.rowCount === 0 &&
    clearObserved.parsed.errors.length === 0 &&
    clearObserved.parsed.devtoolEnabledEvidence.length === 0;
  return {
    ordinal,
    cell: cell.label,
    accepted,
    thermalBefore,
    thermalAfter,
    engine: clearObserved.parsed.engine ?? createObserved.parsed.engine ?? parsed.engine,
    devtool: {
      preflightDisabledEvidence: disableParsed.devtoolDisabledEvidence,
      preflightAcknowledgement: disableLog
        .split('\n')
        .find((line) => line.includes('__OCTANE_DEVTOOL_DISABLED__=true'))
        ?.trim(),
      enabledEvidence: clearObserved.parsed.devtoolEnabledEvidence,
      stayedDisabled: clearObserved.parsed.devtoolEnabledEvidence.length === 0,
    },
    prepareCreate: {
      adbInput: { ...createPoint, issuedAtMs: createIssuedAtMs },
      result: create,
    },
    measuredClear: {
      adbInput: { ...clearPoint, issuedAtMs: clearIssuedAtMs, issued: clearIssuedAtMs !== null },
      result: clear,
    },
    errors: clearObserved.parsed.errors,
  };
}

const report = {
  protocol: 'lynx-benchmark-issue42-native-clear-v1',
  question: 'issue #42 B: clear @1k across post-fix Octane Hux, upstream Octane, and ReactLynx',
  createdAt: new Date().toISOString(),
  benchmarkCommit: run('git', ['rev-parse', 'HEAD']).trim(),
  serial,
  device: {
    model: adb('shell', 'getprop', 'ro.product.model').trim(),
    product: adb('shell', 'getprop', 'ro.product.name').trim(),
    android: adb('shell', 'getprop', 'ro.build.version.release').trim(),
    fingerprint: adb('shell', 'getprop', 'ro.build.fingerprint').trim(),
    abi: adb('shell', 'getprop', 'ro.product.cpu.abi').trim(),
    explorer: adb('shell', 'dumpsys', 'package', 'com.lynx.explorer').match(/versionName=([^\s]+)/)?.[1] ?? null,
  },
  controls: {
    devtool:
      'disabled by a background-only LynxDevToolSetModule.switchLynxDebug(false) preflight before each sample; no CDP/DevTool connection used',
    coldLaunchPerSample: true,
    display: 'ADB wake + dismiss-keyguard before every sample; stay-on-while-plugged gate required',
    thermalGate: 'battery <=35.0C and Android thermal status 0 before every accepted attempt',
    ordering: 'balanced ABC/CBA repeating',
    measuredBoundary: 'native-input-handler-to-second-native-frame',
    scale: 1000,
    prepare: 'real ADB tap create @1k; wait for producer state/frame receipt',
    measure: 'real ADB tap clear; wait for zero-row state and second native frame',
  },
  targetAcceptedSamplesPerCell: samples,
  disableDevToolBundle: {
    url: disableUrl,
    bundle: bundleIdentity(disableFile),
  },
  cells: Object.fromEntries(cells.map((cell) => [cell.label, { url: cell.url, bundle: bundleIdentity(cell.file) }])),
  samples: [],
  invalidAttempts: [],
};

const order = balancedSequence(samples);
for (const [index, cellIndex] of order.entries()) {
  const cell = cells[cellIndex];
  let accepted = false;
  for (let attempt = 1; attempt <= 2 && !accepted; attempt++) {
    console.log(`[issue42] ${index + 1}/${order.length} ${cell.label} attempt ${attempt}`);
    const sample = await measure(cell, index + 1);
    if (sample.accepted) {
      report.samples.push(sample);
      accepted = true;
      console.log(`[issue42] accepted ${cell.label}: clear ${sample.measuredClear.result.latencyMs} ms`);
    } else {
      report.invalidAttempts.push(sample);
      console.log(`[issue42] rejected ${cell.label}: ${JSON.stringify(sample.errors)}`);
    }
  }
  if (!accepted) throw new Error(`two invalid attempts for ${cell.label} at ordinal ${index + 1}.`);
}

fs.mkdirSync(path.dirname(output), { recursive: true });
const temporaryOutput = `${output}.tmp`;
fs.writeFileSync(temporaryOutput, `${JSON.stringify(report, null, 2)}\n`);
fs.renameSync(temporaryOutput, output);
console.log(`[issue42] wrote ${output}`);
