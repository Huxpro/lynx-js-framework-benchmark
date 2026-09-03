import {
  NATIVE_CAPACITY_ANDROID_ART_GLOBAL_REF_FAILURE_CATEGORY,
  NATIVE_CAPACITY_SUITE,
  NATIVE_STARTUP_PROTOCOL,
} from '@lynx-bench/shared/native-diagnostic-contract';

export const ANDROID_ART_CAPACITY_CLASSIFIER_PROTOCOL = 'android-art-global-ref-capacity-v1';
export const ANDROID_ART_CAPACITY_PACKAGE = 'com.lynx.explorer';
export const ANDROID_ART_CAPACITY_ACTIVITY =
  `${ANDROID_ART_CAPACITY_PACKAGE}/.LynxViewShellActivity`;
export const DEVTOOL_DISABLED_LIFECYCLE_PROTOCOL = 'lynx-devtool-disabled-lifecycle-v1';
export const ANDROID_ART_GLOBAL_REF_OVERFLOW =
  'JNI ERROR (app bug): global reference table overflow (max=51200)';
export const NATIVE_CAPACITY_STARTUP_MARKER = '__NATIVE_BENCH_STARTUP__';

const LAST_ENTRIES = 'Last 10 entries';
const SUMMARY = 'Summary:';

function finite(value, label) {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite.`);
  return value;
}

function positivePid(value, label = 'capacity attempt pid') {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

export function androidLogEpochMs(line) {
  const match = /^\s*(\d+(?:\.\d+)?)/.exec(line);
  return match === null ? null : Number(match[1]) * 1_000;
}

export function androidLogPid(line) {
  const match = /^\s*\d+(?:\.\d+)?\s+(\d+)\s+\d+\s+/.exec(line);
  return match === null ? null : Number(match[1]);
}

function jsonAfterMarker(line, marker) {
  const markerIndex = line.indexOf(marker);
  if (markerIndex === -1) return null;
  const objectStart = line.indexOf('{', markerIndex + marker.length);
  if (objectStart === -1) throw new Error('startup marker has no JSON object.');
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = objectStart; index < line.length; index++) {
    const char = line[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) {
      return JSON.parse(line.slice(objectStart, index + 1));
    }
  }
  throw new Error('startup marker has truncated JSON.');
}

export function sliceAndroidAttemptLog(log, marker) {
  if (typeof log !== 'string') throw new Error('Android capacity log must be a string.');
  if (typeof marker !== 'string' || marker.length === 0) {
    throw new Error('Android capacity attempt marker must be a non-empty string.');
  }
  const markerIndex = log.lastIndexOf(marker);
  if (markerIndex === -1) {
    return { markerFound: false, text: '', lines: [] };
  }
  const lineStart = log.lastIndexOf('\n', markerIndex) + 1;
  const text = log.slice(lineStart);
  return { markerFound: true, text, lines: text.split('\n').filter(Boolean) };
}

export function validateDevtoolDisabledLifecycle(log, marker) {
  const attempt = sliceAndroidAttemptLog(log, marker);
  const disabledIndex = attempt.text.indexOf('DevTool disabled. Transitioning to ATTACHED.');
  const acknowledgementIndex = attempt.text.indexOf('__OCTANE_DEVTOOL_DISABLED__=true');
  const reenabledIndex = attempt.text.indexOf('DevTool enabled. Transitioning to ENABLED.');
  const valid = attempt.markerFound
    && disabledIndex !== -1
    && acknowledgementIndex > disabledIndex
    && (reenabledIndex === -1 || reenabledIndex < disabledIndex);
  return {
    protocol: DEVTOOL_DISABLED_LIFECYCLE_PROTOCOL,
    valid,
    markerFound: attempt.markerFound,
    disabledAcknowledged: disabledIndex !== -1 && acknowledgementIndex > disabledIndex,
    reenabledAfterDisable: reenabledIndex > disabledIndex,
    evidence: attempt.lines.filter((line) =>
      line.includes('DevTool disabled. Transitioning to ATTACHED.')
      || line.includes('__OCTANE_DEVTOOL_DISABLED__=true')
      || line.includes('DevTool enabled. Transitioning to ENABLED.')),
  };
}

function validateStartupPayload(payload, expectedRows) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('startup receipt must be an object.');
  }
  if (payload.protocol !== NATIVE_STARTUP_PROTOCOL) {
    throw new Error('startup receipt has the wrong protocol.');
  }
  for (const key of ['moduleStartMs', 'commitAckMs', 'firstFrameMs', 'secondFrameMs']) {
    finite(payload[key], `startup receipt ${key}`);
  }
  if (!(payload.moduleStartMs <= payload.commitAckMs
    && payload.commitAckMs <= payload.firstFrameMs
    && payload.firstFrameMs <= payload.secondFrameMs)) {
    throw new Error('startup receipt timestamps are not monotonic.');
  }
  if (payload.renderEvidence?.kind !== 'native-animation-frame'
    || payload.renderEvidence?.frames !== 2) {
    throw new Error('startup receipt lacks the two-frame render boundary.');
  }
  if (payload.transportEvidence?.kind !== 'octane-root.render'
    || payload.transportEvidence?.acknowledged !== true
    || payload.transportEvidence?.ackMs !== payload.commitAckMs) {
    throw new Error('startup receipt lacks the Octane root-render acknowledgement.');
  }
  if (payload.postState?.rowCount !== expectedRows) {
    throw new Error(`startup receipt rowCount does not match rows-${expectedRows}.`);
  }
  return payload;
}

export function parseCapacityStartupReceipts(log, {
  marker,
  pid,
  launchedAtMs,
  expectedRows,
} = {}) {
  positivePid(pid);
  finite(launchedAtMs, 'capacity attempt launchedAtMs');
  const attempt = sliceAndroidAttemptLog(log, marker);
  const receipts = [];
  for (const [index, line] of attempt.lines.entries()) {
    if (!line.includes(NATIVE_CAPACITY_STARTUP_MARKER)) continue;
    const atMs = androidLogEpochMs(line);
    const linePid = androidLogPid(line);
    let payload = null;
    let error = null;
    try {
      payload = jsonAfterMarker(line, NATIVE_CAPACITY_STARTUP_MARKER);
      validateStartupPayload(payload, expectedRows);
      if (linePid !== pid) throw new Error(`startup receipt pid ${linePid} does not match ${pid}.`);
      if (!Number.isFinite(atMs) || atMs < launchedAtMs) {
        throw new Error('startup receipt predates the measured launch.');
      }
      if (payload.moduleStartMs < launchedAtMs) {
        throw new Error('startup receipt moduleStartMs predates the measured launch.');
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    receipts.push({ index, atMs, pid: linePid, payload, valid: error === null, error, raw: line });
  }
  return { markerFound: attempt.markerFound, receipts };
}

function deathLineMatches(line, packageName, pid) {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`Process\\s+${escaped}\\s+\\((?:pid\\s+)?${pid}\\)\\s+has died`).test(line)
    || (line.includes(`Process ${packageName}`)
      && line.includes('has died')
      && new RegExp(`\\bpid[=: ]+${pid}\\b`).test(line));
}

function observedLines(log, { marker, launchedAtMs }) {
  const attempt = sliceAndroidAttemptLog(log, marker);
  return {
    ...attempt,
    lines: attempt.lines.map((raw, index) => ({
      raw,
      index,
      atMs: androidLogEpochMs(raw),
      pid: androidLogPid(raw),
    })).filter((line) => Number.isFinite(line.atMs) && line.atMs >= launchedAtMs),
  };
}

function findDeath(lines, packageName, pid) {
  return lines.find((line) => deathLineMatches(line.raw, packageName, pid)) ?? null;
}

/**
 * Choose the first externally observable terminal event. The returned event is
 * intentionally provisional: classification happens only after the adapter
 * closes its short finalization window and supplies the final log snapshot.
 */
export function selectAndroidCapacityTerminal({
  log,
  marker,
  packageName = ANDROID_ART_CAPACITY_PACKAGE,
  pid,
  launchedAtMs,
  expectedRows,
  nowMs,
  deadlineMs,
  currentPids = [],
} = {}) {
  positivePid(pid);
  finite(nowMs, 'capacity observation nowMs');
  finite(deadlineMs, 'capacity observation deadlineMs');
  const observed = observedLines(log, { marker, launchedAtMs });
  const { receipts } = parseCapacityStartupReceipts(log, {
    marker, pid, launchedAtMs, expectedRows,
  });
  const receipt = receipts[0] ?? null;
  const death = findDeath(observed.lines, packageName, pid);
  const events = [
    ...(receipt === null ? [] : [{ kind: 'receipt', atMs: receipt.atMs, receipt }]),
    ...(death === null ? [] : [{ kind: 'death', atMs: death.atMs, death }]),
  ].filter((event) => Number.isFinite(event.atMs)).sort((left, right) =>
    left.atMs - right.atMs || (left.kind === 'death' ? -1 : 1));
  if (events.length > 0) return events[0];
  if (!currentPids.includes(pid)) {
    return {
      kind: currentPids.length === 0 ? 'process-exit' : 'pid-restart',
      atMs: nowMs,
      currentPids: [...currentPids],
    };
  }
  if (nowMs >= deadlineMs) return { kind: 'deadline', atMs: deadlineMs };
  return null;
}

function findCapacityEvidence(lines, { packageName, pid }) {
  const overflow = lines.find((line) =>
    line.pid === pid && line.raw.includes(ANDROID_ART_GLOBAL_REF_OVERFLOW)) ?? null;
  const lastEntries = lines.find((line) => line.pid === pid && line.raw.includes(LAST_ENTRIES)) ?? null;
  const summaryStart = lines.findIndex((line) => line.pid === pid && line.raw.includes(SUMMARY));
  const fatal = lines.find((line) =>
    line.pid === pid
    && line.raw.includes('Fatal signal 6 (SIGABRT), code -1 (SI_QUEUE)')) ?? null;
  const death = findDeath(lines, packageName, pid);
  const tableTotalIndex = summaryStart === -1 ? -1 : lines.findIndex((line, index) =>
    index > summaryStart
    && line.pid === pid
    && /\b51200 global references \(\d+ unique instances\)/.test(line.raw));
  const summaryLines = summaryStart === -1 || tableTotalIndex === -1
    ? []
    : lines.slice(summaryStart, tableTotalIndex + 1);
  const summaryRaw = summaryLines.map((line) => line.raw).join('\n');
  return {
    overflow,
    lastEntries,
    summaryStart: summaryStart === -1 ? null : lines[summaryStart],
    summaryRaw,
    paintingContext:
      /\b30026 of com\.lynx\.tasm\.behavior\.PaintingContext\$a \(30026 unique instances\)/
        .test(summaryRaw),
    platformWrapper: /\b20444 of m7\.w \(20444 unique instances\)/.test(summaryRaw),
    tableTotal: tableTotalIndex === -1 ? null : lines[tableTotalIndex],
    fatal,
    death,
  };
}

function failure(category, attempt, evidence, detail = {}) {
  return {
    dnf: true,
    failure: {
      category,
      phase: NATIVE_CAPACITY_SUITE,
      entry: attempt.entryId,
      workload: 'create',
      scale: attempt.scale,
      message: detail.message ?? category,
      evidence: {
        protocol: ANDROID_ART_CAPACITY_CLASSIFIER_PROTOCOL,
        marker: attempt.marker,
        packageName: attempt.packageName,
        pid: attempt.pid,
        launchedAtMs: attempt.launchedAtMs,
        bundleSha256: attempt.bundleSha256,
        fixtureRole: attempt.fixtureRole,
        ...evidence,
      },
      ...detail,
    },
  };
}

/** Classify a finalized attempt log. No device access or mutable state occurs here. */
export function classifyAndroidArtCapacity({
  log,
  marker,
  packageName = ANDROID_ART_CAPACITY_PACKAGE,
  pid,
  launchedAtMs,
  deadlineMs,
  terminal,
  entryId,
  scale,
  bundleSha256,
  fixtureRole,
  bundleServed,
} = {}) {
  positivePid(pid);
  finite(launchedAtMs, 'capacity attempt launchedAtMs');
  finite(deadlineMs, 'capacity attempt deadlineMs');
  const attempt = {
    marker, packageName, pid, launchedAtMs, entryId, scale, bundleSha256, fixtureRole,
  };
  const observed = observedLines(log, { marker, launchedAtMs });
  if (!observed.markerFound) {
    return failure('process-failure', attempt, { markerFound: false }, {
      message: 'capacity attempt marker is absent from the finalized log window.',
    });
  }
  const parsed = parseCapacityStartupReceipts(log, {
    marker, pid, launchedAtMs, expectedRows: scale,
  });
  const startupReceipts = parsed.receipts.map((receipt) =>
    terminal?.kind !== 'receipt' && Number.isFinite(terminal?.atMs) && receipt.atMs > terminal.atMs
      ? { ...receipt, valid: false, error: `startup receipt arrived after ${terminal.kind}.` }
      : receipt);
  const enabled = observed.lines.filter((line) =>
    line.raw.includes('DevTool enabled. Transitioning to ENABLED.'));
  const otherFailureEvidence = observed.lines.filter((line) =>
    /FATAL EXCEPTION|\bANR in com\.lynx\.explorer\b|OutOfMemoryError|Fatal signal (?!6 \(SIGABRT\), code -1 \(SI_QUEUE\))|app::onAppJSError|main-thread\.js exception|loadCard failed/.test(
      line.raw,
    ));
  if (enabled.length > 0) {
    return failure('process-failure', attempt, {
      devtoolEnabledEvidence: enabled.map((line) => line.raw),
    }, { message: 'DevTool re-enabled during a no-CDP capacity attempt.' });
  }
  if (!Number.isSafeInteger(bundleServed) || bundleServed < 1) {
    return failure('process-failure', attempt, {
      bundleServed: bundleServed ?? null,
      startupReceipts,
    }, { message: 'the measured process did not fetch the pinned capacity bundle.' });
  }
  if (terminal?.kind === 'receipt') {
    if (startupReceipts.length !== 1 || startupReceipts[0].valid !== true) {
      return failure('process-failure', attempt, {
        startupReceipts,
      }, {
        message: startupReceipts.length > 1
          ? 'duplicate startup receipts invalidate the capacity attempt.'
          : `invalid startup receipt: ${startupReceipts[0]?.error ?? 'missing'}`,
        producerProtocol: NATIVE_STARTUP_PROTOCOL,
      });
    }
    const receipt = startupReceipts[0];
    return {
      latencyMs: receipt.payload.secondFrameMs - launchedAtMs,
      detail: {
        protocol: ANDROID_ART_CAPACITY_CLASSIFIER_PROTOCOL,
        outcome: 'completed',
        terminal: { kind: terminal.kind, atMs: terminal.atMs },
        packageName,
        pid,
        launchedAtMs,
        bundleSha256,
        bundleServed,
        fixtureRole,
        startupReceipt: receipt.payload,
      },
    };
  }

  if (terminal?.kind === 'deadline') {
    if (otherFailureEvidence.length > 0) {
      return failure('process-failure', attempt, {
        deadlineMs,
        startupReceipts,
        processAliveAtCutoff: true,
        otherFailureEvidence: otherFailureEvidence.map((line) => line.raw),
      }, { message: 'Explorer reported a non-capacity process/application failure.' });
    }
    return failure('timeout', attempt, {
      deadlineMs,
      startupReceipts,
      processAliveAtCutoff: true,
    }, {
      timeoutMs: deadlineMs - launchedAtMs,
      message: 'Explorer remained alive without a valid startup receipt until the cutoff.',
    });
  }

  const capacity = findCapacityEvidence(observed.lines, { packageName, pid });
  const completeCapacitySignature = capacity.overflow !== null
    && capacity.lastEntries !== null
    && capacity.summaryStart !== null
    && capacity.summaryRaw.length > 0
    && capacity.paintingContext
    && capacity.platformWrapper
    && capacity.tableTotal !== null
    && capacity.fatal !== null
    && capacity.death !== null
    && capacity.overflow.index < capacity.lastEntries.index
    && capacity.lastEntries.index < capacity.summaryStart.index
    && capacity.summaryStart.index < capacity.tableTotal.index
    && capacity.tableTotal.index < capacity.fatal.index
    && capacity.fatal.atMs <= capacity.death.atMs;
  if (completeCapacitySignature) {
    return failure(NATIVE_CAPACITY_ANDROID_ART_GLOBAL_REF_FAILURE_CATEGORY, attempt, {
      terminal: { kind: terminal?.kind ?? 'death', atMs: terminal?.atMs ?? capacity.death.atMs },
      loadToCrashMs: capacity.death.atMs - launchedAtMs,
      exactOverflow: capacity.overflow.raw,
      lastEntries: capacity.lastEntries.raw,
      summary: capacity.summaryRaw,
      fatalSignal: capacity.fatal.raw,
      processDeath: capacity.death.raw,
      startupReceipts,
    }, {
      message: ANDROID_ART_GLOBAL_REF_OVERFLOW,
      loadToCrashMs: capacity.death.atMs - launchedAtMs,
    });
  }
  return failure('process-failure', attempt, {
    terminal: terminal ?? null,
    overflow: capacity.overflow?.raw ?? null,
    lastEntries: capacity.lastEntries?.raw ?? null,
    summary: capacity.summaryRaw || null,
    paintingContextHolder: capacity.paintingContext,
    platformWrapperHolder: capacity.platformWrapper,
    tableCapacity: capacity.tableTotal?.raw ?? null,
    fatalSignal: capacity.fatal?.raw ?? null,
    processDeath: capacity.death?.raw ?? null,
    startupReceipts,
    otherFailureEvidence: otherFailureEvidence.map((line) => line.raw),
  }, {
    message: terminal?.kind === 'pid-restart'
      ? 'Explorer restarted with a new PID before semantic completion.'
      : 'Explorer terminated without the complete ART global-reference capacity signature.',
  });
}
