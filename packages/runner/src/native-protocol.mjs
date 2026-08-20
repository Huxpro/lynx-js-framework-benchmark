import crypto from 'node:crypto';
import fs from 'node:fs';

export const NATIVE_SANDBOX_CAMPAIGN_VERSION = 'native-sandbox-campaign-v2';
export const NATIVE_SANDBOX_ADAPTER_PROTOCOL = 'native-sandbox-adapter-v3';
export const NATIVE_LEASE_RECEIPT_PROTOCOL = 'lynx-sandbox-lease-receipt-v1';
export const NATIVE_LEASE_CHAIN_PROTOCOL = 'lynx-sandbox-lease-chain-v1';
export const NATIVE_DEVICE_COHORT_PROTOCOL = 'native-device-cohort-v1';
export const NATIVE_METHOD_REVISION_PROTOCOL = 'native-method-revision-v1';
export const NATIVE_METHOD_REVISION_CHAIN_PROTOCOL = 'native-method-revision-chain-v1';
export const NATIVE_METHOD_REVISION_BASE_REASON = 'campaign-base';

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const sha256Json = (value) => sha256(JSON.stringify(value));

function object(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function nonempty(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

export function nativeSerialSha256(serial) {
  return sha256(nonempty(serial, 'Native Sandbox serial'));
}

export function assertNativeLeaseReceipt(receipt) {
  object(receipt, 'Native lease receipt');
  if (receipt.protocol !== NATIVE_LEASE_RECEIPT_PROTOCOL) {
    throw new Error(`Native lease receipt protocol must be ${NATIVE_LEASE_RECEIPT_PROTOCOL}.`);
  }
  nonempty(receipt.issueId, 'Native lease receipt issueId');
  nonempty(receipt.serialSha256, 'Native lease receipt serialSha256');
  nonempty(receipt.deviceLeaseId, 'Native lease receipt deviceLeaseId');
  if (!/^[a-f0-9]{64}$/.test(receipt.serialSha256)) {
    throw new Error('Native lease receipt serialSha256 must be a SHA-256 digest.');
  }
  if (!Number.isSafeInteger(receipt.expiredAt) || receipt.expiredAt <= 0) {
    throw new Error('Native lease receipt expiredAt must be a positive epoch-millisecond integer.');
  }
  const expectedLeaseId = sha256Json({
    protocol: NATIVE_LEASE_RECEIPT_PROTOCOL,
    issueId: receipt.issueId,
    expiredAt: receipt.expiredAt,
    serialSha256: receipt.serialSha256,
  }).slice(0, 12);
  if (receipt.deviceLeaseId !== expectedLeaseId) {
    throw new Error('Native lease receipt deviceLeaseId does not match its structured fields.');
  }
  return receipt;
}

/**
 * Parse the explicit receipt supplied by the lease acquirer. The raw ADB
 * serial is required for equality checking but is never retained in result
 * metadata; only its SHA-256 digest crosses the provenance boundary.
 */
export function parseNativeLeaseReceipt(value, { serial, now = Date.now() } = {}) {
  let raw = value;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.length === 0) throw new Error('Native lease receipt input is empty.');
    raw = trimmed.startsWith('{') ? JSON.parse(trimmed) : JSON.parse(fs.readFileSync(trimmed, 'utf8'));
  }
  object(raw, 'Native lease receipt input');
  const rawSerial = nonempty(raw.serial ?? raw.acquired, 'Native lease receipt serial');
  if (rawSerial !== nonempty(serial, 'Native Sandbox serial')) {
    throw new Error('Native lease receipt serial does not match LYNX_SANDBOX_SERIAL.');
  }
  const payload = {
    protocol: NATIVE_LEASE_RECEIPT_PROTOCOL,
    issueId: nonempty(raw.issueId, 'Native lease receipt issueId'),
    expiredAt: Number(raw.expiredAt),
    serialSha256: nativeSerialSha256(serial),
  };
  if (!Number.isSafeInteger(payload.expiredAt) || payload.expiredAt <= now) {
    throw new Error('Native lease receipt is expired or has an invalid expiredAt.');
  }
  return assertNativeLeaseReceipt({
    ...payload,
    deviceLeaseId: sha256Json(payload).slice(0, 12),
  });
}

export function assertNativeLeaseChain(chain, { requireNonempty = true } = {}) {
  object(chain, 'Native lease chain');
  if (chain.protocol !== NATIVE_LEASE_CHAIN_PROTOCOL || !Array.isArray(chain.receipts)) {
    throw new Error('Native lease chain has an invalid protocol or receipts list.');
  }
  if (requireNonempty && chain.receipts.length === 0) {
    throw new Error('Native lease chain must contain at least one receipt.');
  }
  const leaseIds = new Set();
  let serialSha256 = null;
  let priorExpiry = 0;
  for (const receipt of chain.receipts) {
    assertNativeLeaseReceipt(receipt);
    if (serialSha256 !== null && receipt.serialSha256 !== serialSha256) {
      throw new Error('Native lease chain crosses physical serial hashes.');
    }
    if (leaseIds.has(receipt.deviceLeaseId)) {
      throw new Error(`Native lease chain repeats deviceLeaseId ${receipt.deviceLeaseId}.`);
    }
    if (receipt.expiredAt <= priorExpiry) {
      throw new Error('Native lease chain receipts must have strictly increasing expiries.');
    }
    serialSha256 = receipt.serialSha256;
    priorExpiry = receipt.expiredAt;
    leaseIds.add(receipt.deviceLeaseId);
  }
  if (chain.serialSha256 !== (serialSha256 ?? null)) {
    throw new Error('Native lease chain serialSha256 does not match its receipts.');
  }
  const payload = {
    protocol: NATIVE_LEASE_CHAIN_PROTOCOL,
    serialSha256: chain.serialSha256,
    receipts: chain.receipts,
  };
  if (chain.sha256 !== sha256Json(payload)) {
    throw new Error('Native lease chain digest does not match its receipts.');
  }
  return chain;
}

export function appendNativeLeaseReceipt(chain, receipt) {
  assertNativeLeaseReceipt(receipt);
  const receipts = chain == null ? [] : assertNativeLeaseChain(chain, { requireNonempty: false }).receipts;
  if (receipts.some((candidate) => candidate.deviceLeaseId === receipt.deviceLeaseId)) {
    throw new Error(`Native lease ${receipt.deviceLeaseId} is already present in the lease chain.`);
  }
  const payload = {
    protocol: NATIVE_LEASE_CHAIN_PROTOCOL,
    serialSha256: receipt.serialSha256,
    receipts: [...receipts, receipt],
  };
  return assertNativeLeaseChain({ ...payload, sha256: sha256Json(payload) });
}

function assertMethodInputReceipt(receipt) {
  object(receipt, 'Native method revision input receipt');
  if (!/^[a-f0-9]{64}$/.test(nonempty(receipt.sha256, 'Native input receipt sha256'))) {
    throw new Error('Native input receipt sha256 must be a SHA-256 digest.');
  }
  object(receipt.sources, 'Native input receipt sources');
  const { sha256: claimedSha256, ...payload } = receipt;
  if (sha256Json(payload) !== claimedSha256) {
    throw new Error('Native method revision input receipt digest does not match its payload.');
  }
  return receipt;
}

function methodInvariantReceipt(receipt) {
  const { sources: _sources, sha256: _sha256, ...invariant } = receipt;
  return invariant;
}

function buildNativeMethodRevision(inputReceipt, { parentId, reason }) {
  assertMethodInputReceipt(inputReceipt);
  if (parentId !== null) nonempty(parentId, 'Native method revision parentId');
  const payload = {
    protocol: NATIVE_METHOD_REVISION_PROTOCOL,
    parentId,
    reason: nonempty(reason, 'Native method revision reason'),
    inputReceipt,
  };
  return { ...payload, id: sha256Json(payload).slice(0, 16), sha256: sha256Json(payload) };
}

export function assertNativeMethodRevisionChain(chain) {
  object(chain, 'Native method revision chain');
  if (chain.protocol !== NATIVE_METHOD_REVISION_CHAIN_PROTOCOL || !Array.isArray(chain.revisions)) {
    throw new Error('Native method revision chain has an invalid protocol or revisions list.');
  }
  if (chain.revisions.length === 0) {
    throw new Error('Native method revision chain must contain its campaign-base revision.');
  }
  const ids = new Set();
  let priorId = null;
  let invariant = null;
  for (const [index, revision] of chain.revisions.entries()) {
    object(revision, `Native method revision ${index}`);
    if (revision.protocol !== NATIVE_METHOD_REVISION_PROTOCOL) {
      throw new Error(`Native method revision ${index} has an invalid protocol.`);
    }
    const rebuilt = buildNativeMethodRevision(revision.inputReceipt, {
      parentId: revision.parentId,
      reason: revision.reason,
    });
    if (revision.id !== rebuilt.id || revision.sha256 !== rebuilt.sha256) {
      throw new Error(`Native method revision ${index} digest does not match its payload.`);
    }
    if (revision.parentId !== priorId) {
      throw new Error(`Native method revision ${index} does not extend the exact chain prefix.`);
    }
    if (ids.has(revision.id)) {
      throw new Error(`Native method revision chain repeats revision ${revision.id}.`);
    }
    const candidateInvariant = methodInvariantReceipt(revision.inputReceipt);
    if (invariant !== null && JSON.stringify(candidateInvariant) !== JSON.stringify(invariant)) {
      throw new Error('Native method revisions may change runner sources only.');
    }
    if (index === 0 && revision.reason !== NATIVE_METHOD_REVISION_BASE_REASON) {
      throw new Error('Native method revision chain must begin with campaign-base.');
    }
    invariant = candidateInvariant;
    priorId = revision.id;
    ids.add(revision.id);
  }
  const payload = {
    protocol: NATIVE_METHOD_REVISION_CHAIN_PROTOCOL,
    revisions: chain.revisions,
  };
  if (chain.sha256 !== sha256Json(payload)) {
    throw new Error('Native method revision chain digest does not match its revisions.');
  }
  return chain;
}

export function createNativeMethodRevisionChain(inputReceipt) {
  const revision = buildNativeMethodRevision(inputReceipt, {
    parentId: null,
    reason: NATIVE_METHOD_REVISION_BASE_REASON,
  });
  const payload = {
    protocol: NATIVE_METHOD_REVISION_CHAIN_PROTOCOL,
    revisions: [revision],
  };
  return assertNativeMethodRevisionChain({ ...payload, sha256: sha256Json(payload) });
}

export function appendNativeMethodRevision(chain, inputReceipt, reason) {
  const current = assertNativeMethodRevisionChain(chain);
  const last = current.revisions.at(-1);
  if (last.inputReceipt.sha256 === inputReceipt.sha256) {
    throw new Error(`Native method input ${inputReceipt.sha256} is already the active revision.`);
  }
  const revision = buildNativeMethodRevision(inputReceipt, { parentId: last.id, reason });
  const payload = {
    protocol: NATIVE_METHOD_REVISION_CHAIN_PROTOCOL,
    revisions: [...current.revisions, revision],
  };
  return assertNativeMethodRevisionChain({ ...payload, sha256: sha256Json(payload) });
}

export function shouldStopBeforeLeaseExpiry(receipt, {
  now = Date.now(),
  safetyMs,
} = {}) {
  assertNativeLeaseReceipt(receipt);
  if (!Number.isFinite(safetyMs) || safetyMs <= 0) {
    throw new Error('lease safetyMs must be a positive derived expiry envelope.');
  }
  return now + safetyMs >= receipt.expiredAt;
}

export function deriveNativeLeaseExpirySafety(policy, { reps, startupReps }) {
  object(policy, 'Native Sandbox policy');
  for (const [name, value] of Object.entries({ reps, startupReps })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Native lease expiry ${name} must be a positive integer.`);
    }
  }
  const repetitions = Math.max(reps, startupReps);
  const attemptCount = policy.transientAttempts;
  const attemptEnvelopeMs = policy.thermalGateTimeoutMs
    + policy.defaultTimeoutMs
    + policy.longWorkloadTimeoutMs;
  const recoveryEnvelopeMs = Math.max(0, attemptCount - 1)
    * policy.explorerReconnectTimeoutMs;
  const minimumSafetyMs = repetitions
    * ((attemptCount * attemptEnvelopeMs) + recoveryEnvelopeMs)
    + policy.leaseCleanupMarginMs;
  const overrideMs = policy.leaseStopSafetyOverrideMs;
  if (overrideMs != null && overrideMs < minimumSafetyMs) {
    throw new Error(
      `LYNX_SANDBOX_LEASE_STOP_SAFETY_MS=${overrideMs} is below the derived minimum `
      + `${minimumSafetyMs}ms worst-cell envelope.`,
    );
  }
  return Object.freeze({
    protocol: 'native-lease-expiry-safety-v1',
    repetitions,
    attemptCount,
    thermalGateTimeoutMs: policy.thermalGateTimeoutMs,
    pageSessionTimeoutMs: policy.defaultTimeoutMs,
    longWorkloadTimeoutMs: policy.longWorkloadTimeoutMs,
    reconnectAttempts: Math.max(0, attemptCount - 1),
    explorerReconnectTimeoutMs: policy.explorerReconnectTimeoutMs,
    cleanupMarginMs: policy.leaseCleanupMarginMs,
    minimumSafetyMs,
    overrideMs,
    effectiveSafetyMs: overrideMs ?? minimumSafetyMs,
  });
}

export function buildNativeDeviceCohort({
  serialSha256,
  environment,
  hardware,
  campaignId,
  matrixContractSha256,
  inputReceiptSha256,
  connectorPackageTreesSha256,
  harnessConfigId,
}) {
  if (!/^[a-f0-9]{64}$/.test(nonempty(serialSha256, 'device cohort serialSha256'))) {
    throw new Error('device cohort serialSha256 must be a SHA-256 digest.');
  }
  const payload = {
    protocol: NATIVE_DEVICE_COHORT_PROTOCOL,
    serialSha256,
    environment: nonempty(environment, 'device cohort environment'),
    hardware: object(hardware, 'device cohort hardware'),
    campaignId: nonempty(campaignId, 'device cohort campaignId'),
    matrixContractSha256: nonempty(matrixContractSha256, 'device cohort matrixContractSha256'),
    inputReceiptSha256: nonempty(inputReceiptSha256, 'device cohort inputReceiptSha256'),
    connectorPackageTreesSha256: nonempty(
      connectorPackageTreesSha256, 'device cohort connectorPackageTreesSha256',
    ),
    harnessConfigId: nonempty(harnessConfigId, 'device cohort harnessConfigId'),
  };
  return { ...payload, id: sha256Json(payload).slice(0, 16), sha256: sha256Json(payload) };
}

export function assertNativeDeviceCohort(cohort) {
  object(cohort, 'Native device cohort');
  const rebuilt = buildNativeDeviceCohort(cohort);
  if (cohort.id !== rebuilt.id || cohort.sha256 !== rebuilt.sha256) {
    throw new Error('Native device cohort digest does not match its identity fields.');
  }
  return cohort;
}

function finite(env, name, fallback, { positive = false, integer = false } = {}) {
  const value = Number(env[name] ?? fallback);
  const valid = Number.isFinite(value)
    && (!positive || value > 0)
    && (!integer || Number.isInteger(value));
  if (!valid) throw new Error(`invalid ${name}=${env[name]}.`);
  return value;
}

function choice(env, name, fallback, choices) {
  const value = env[name] ?? fallback;
  if (!choices.includes(value)) {
    throw new Error(`invalid ${name}=${JSON.stringify(value)}; expected ${choices.join(' or ')}.`);
  }
  return value;
}

function optionalPositive(env, name) {
  if (env[name] == null || env[name] === '') return null;
  return finite(env, name, null, { positive: true });
}

/**
 * Every value that can change scheduling, lifecycle, retry, timeout, render,
 * or thermal behaviour belongs in this object. It is hashed into both the
 * campaign ID and adapter harnessConfigId, so two methods cannot silently
 * become one comparison cohort.
 */
export function resolveNativeSandboxPolicy(env = process.env) {
  const policy = {
    protocol: NATIVE_SANDBOX_ADAPTER_PROTOCOL,
    defaultTimeoutMs: finite(env, 'LYNX_SANDBOX_TIMEOUT_MS', 30_000, { positive: true }),
    longWorkloadTimeoutMs: finite(
      env, 'LYNX_SANDBOX_LONG_TIMEOUT_MS', 240_000, { positive: true },
    ),
    renderGraceFrames: finite(
      env, 'LYNX_SANDBOX_RENDER_GRACE_FRAMES', 2, { positive: true, integer: true },
    ),
    debugRouterSettleMs: finite(env, 'LYNX_SANDBOX_ROUTER_SETTLE_MS', 100),
    explorerRecycleEveryPages: finite(
      env, 'LYNX_SANDBOX_RECYCLE_EVERY_PAGES', 5, { positive: true, integer: true },
    ),
    explorerLaunchSettleMs: finite(env, 'LYNX_SANDBOX_EXPLORER_LAUNCH_SETTLE_MS', 500),
    explorerReconnectTimeoutMs: finite(
      env, 'LYNX_SANDBOX_RECONNECT_TIMEOUT_MS', 90_000, { positive: true },
    ),
    clientDiscoveryPollMs: 250,
    sessionDiscoveryPollMs: 50,
    octaneReadyPollMs: 16,
    startupPollMs: finite(env, 'LYNX_SANDBOX_STARTUP_POLL_MS', 16),
    producerProbePollMs: 250,
    tapSettleMs: finite(env, 'LYNX_SANDBOX_TAP_SETTLE_MS', 10),
    maxBatteryTemperatureC: finite(env, 'LYNX_SANDBOX_MAX_BATTERY_TEMP_C', 40),
    thermalGateTimeoutMs: finite(
      env, 'LYNX_SANDBOX_THERMAL_GATE_TIMEOUT_MS', 300_000, { positive: true },
    ),
    thermalPollMs: finite(env, 'LYNX_SANDBOX_THERMAL_POLL_MS', 5_000),
    thermalGateScope: 'before-every-bundle-load',
    transientAttempts: finite(
      env, 'LYNX_SANDBOX_TRANSIENT_ATTEMPTS', 3, { positive: true, integer: true },
    ),
    leaseCleanupMarginMs: finite(
      env, 'LYNX_SANDBOX_LEASE_CLEANUP_MARGIN_MS', 30_000, { positive: true },
    ),
    leaseStopSafetyOverrideMs: optionalPositive(env, 'LYNX_SANDBOX_LEASE_STOP_SAFETY_MS'),
    semanticDnfRetries: 0,
    retryScope: 'transport-only-within-repetition',
    deviceClockCalibrationSamples: 7,
    explorerLifecycle: 'force-stop-at-start-and-recycle-cadence',
    octaneTriggerMode: choice(env, 'LYNX_SANDBOX_OCTANE_TRIGGER', 'tap', ['tap', 'driver']),
    devtoolTransport: choice(
      env, 'LYNX_SANDBOX_DEVTOOL_TRANSPORT', 'direct', ['direct', 'daemon'],
    ),
  };
  for (const [name, value] of Object.entries(policy)) {
    if (typeof value === 'number' && value < 0) throw new Error(`invalid Native policy ${name}=${value}.`);
  }
  if (policy.renderGraceFrames !== 2) {
    throw new Error(
      'LYNX_SANDBOX_RENDER_GRACE_FRAMES must be 2 for the versioned producer protocol.',
    );
  }
  return Object.freeze(policy);
}

export const NATIVE_SANDBOX_POLICY = resolveNativeSandboxPolicy();
