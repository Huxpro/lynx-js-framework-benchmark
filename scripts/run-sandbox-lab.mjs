#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function usage() {
  throw new Error(
    'usage: node scripts/run-sandbox-lab.mjs <entry-id> <evidence-dir> '
    + '(use entry-id "ranking-cohort" for every ranked entry; '
    + 'requires SANDBOX_ISSUER and SANDBOX_ISSUE_ID)',
  );
}

function required(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is required.`);
  return value;
}

function write(file, value) {
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
}

function command(binary, args, { env = process.env } = {}) {
  const result = spawnSync(binary, args, { encoding: 'utf8', env });
  return {
    command: [binary, ...args],
    status: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error == null ? null : String(result.error),
  };
}

const [entryId, evidenceInput, ...extra] = process.argv.slice(2);
if (!entryId || !evidenceInput || extra.length > 0) usage();
if (entryId !== 'ranking-cohort' && !/^octane-new-\d{4}-\d{2}-\d{2}$/.test(entryId)) {
  throw new Error(
    'Sandbox runner accepts "ranking-cohort" or a dated octane-new-YYYY-MM-DD entry.',
  );
}
const issuer = required(process.env.SANDBOX_ISSUER, 'SANDBOX_ISSUER');
const issueId = required(process.env.SANDBOX_ISSUE_ID, 'SANDBOX_ISSUE_ID');
const baseUrl = new URL(process.env.SANDBOX_BASE_URL ?? 'https://lynx-sandbox.byted.org');
const evidenceDir = path.resolve(evidenceInput);
fs.mkdirSync(path.dirname(evidenceDir), { recursive: true });
fs.mkdirSync(evidenceDir, { recursive: false });
const adbBinary = process.env.ADB_BIN ?? 'adb';
const pnpmBinary = process.env.PNPM_BIN ?? 'pnpm';
const resumeCheckpoint = process.env.SANDBOX_RESUME_CHECKPOINT == null
  ? null
  : path.resolve(process.env.SANDBOX_RESUME_CHECKPOINT);
if (resumeCheckpoint != null && !fs.existsSync(resumeCheckpoint)) {
  throw new Error(`SANDBOX_RESUME_CHECKPOINT does not exist: ${resumeCheckpoint}`);
}
const targetLeaseReceipt = process.env.SANDBOX_TARGET_LEASE_RECEIPT == null
  ? null
  : path.resolve(process.env.SANDBOX_TARGET_LEASE_RECEIPT);
if (targetLeaseReceipt != null && !fs.existsSync(targetLeaseReceipt)) {
  throw new Error(`SANDBOX_TARGET_LEASE_RECEIPT does not exist: ${targetLeaseReceipt}`);
}
const targetSerial = targetLeaseReceipt == null
  ? null
  : required(
      JSON.parse(fs.readFileSync(targetLeaseReceipt, 'utf8')).serial,
      'target lease receipt serial',
    );
let serial = null;
let connected = false;
let primaryError = null;
let runResult = null;
let runPath = null;
let checkpointComplete = null;
const cleanupErrors = [];

try {
  const leaseResponse = await fetch(new URL('/pool/lease', baseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Issuer': issuer,
      'X-Issue-Id': issueId,
    },
    body: JSON.stringify(targetSerial == null ? {} : { serial: targetSerial }),
  });
  const leaseText = await leaseResponse.text();
  write(path.join(evidenceDir, 'lease-response.json'), {
    status: leaseResponse.status,
    ok: leaseResponse.ok,
    body: leaseText,
  });
  if (!leaseResponse.ok) throw new Error(`Sandbox lease POST failed with HTTP ${leaseResponse.status}.`);
  const lease = JSON.parse(leaseText);
  serial = required(lease.acquired, 'lease response acquired');
  const expiredAt = Number(lease.expiredAt);
  if (!Number.isSafeInteger(expiredAt) || expiredAt <= Date.now()) {
    throw new Error('lease response expiredAt must be a future epoch-millisecond integer.');
  }
  const receipt = { serial, acquired: serial, issueId, expiredAt };
  const receiptPath = path.join(evidenceDir, 'lease-receipt.json');
  write(receiptPath, receipt);

  const connect = command(adbBinary, ['connect', serial]);
  write(path.join(evidenceDir, 'adb-connect.json'), connect);
  if (connect.status !== 0) throw new Error(`adb connect failed with status ${connect.status}.`);
  connected = true;
  const wait = command(adbBinary, ['-s', serial, 'wait-for-device']);
  write(path.join(evidenceDir, 'adb-wait.json'), wait);
  if (wait.status !== 0) throw new Error(`adb wait-for-device failed with status ${wait.status}.`);

  const runnerEnv = {
    ...process.env,
    LYNX_SANDBOX_SERIAL: serial,
    LYNX_SANDBOX_LEASE_ID: `${issueId}:${expiredAt}`,
    LYNX_SANDBOX_LEASE_RECEIPT: receiptPath,
  };
  const runnerArgs = [
    'bench', 'run', '--harness', 'native',
    ...(entryId === 'ranking-cohort' ? [] : ['--lab-native', '--entry', entryId]),
    '--adapter', 'packages/runner/adapters/lynx-sandbox-android.mjs',
    ...(resumeCheckpoint == null ? [] : ['--resume', resumeCheckpoint]),
  ];
  runResult = command(pnpmBinary, runnerArgs, { env: runnerEnv });
  write(path.join(evidenceDir, 'runner.json'), runResult);
  process.stdout.write(runResult.stdout);
  process.stderr.write(runResult.stderr);
  if (runResult.status !== 0) throw new Error(`Native Lab runner failed with status ${runResult.status}.`);
  const outputPaths = [...runResult.stdout.matchAll(/records → ([^\n]+\.json)/g)];
  const reportedPath = outputPaths.at(-1)?.[1];
  if (reportedPath == null) throw new Error('Native Lab runner reported no checkpoint path.');
  runPath = path.resolve(reportedPath);
  const run = JSON.parse(fs.readFileSync(runPath, 'utf8'));
  checkpointComplete = run.meta?.checkpointComplete === true;
  if (!checkpointComplete) {
    throw new Error(
      `Native Lab lease ended with an incomplete checkpoint: ${runPath}; `
      + 'acquire another official lease and set SANDBOX_RESUME_CHECKPOINT to this path.',
    );
  }
} catch (error) {
  primaryError = error;
} finally {
  if (serial !== null) {
    try {
      const releaseUrl = new URL('/pool/lease', baseUrl);
      releaseUrl.searchParams.set('serial', serial);
      const releaseResponse = await fetch(releaseUrl, { method: 'DELETE' });
      const releaseText = await releaseResponse.text();
      write(path.join(evidenceDir, 'lease-release.json'), {
        status: releaseResponse.status,
        ok: releaseResponse.ok,
        body: releaseText,
      });
      if (!releaseResponse.ok) {
        cleanupErrors.push(new Error(`Sandbox lease DELETE failed with HTTP ${releaseResponse.status}.`));
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (connected && serial !== null) {
    const disconnect = command(adbBinary, ['disconnect', serial]);
    write(path.join(evidenceDir, 'adb-disconnect.json'), disconnect);
    if (disconnect.status !== 0) {
      cleanupErrors.push(new Error(`adb disconnect failed with status ${disconnect.status}.`));
    }
  }
  write(path.join(evidenceDir, 'outcome.json'), {
    entryId,
    issueId,
    runnerStatus: runResult?.status ?? null,
    runPath,
    checkpointComplete,
    primaryError: primaryError == null ? null : String(primaryError),
    cleanupErrors: cleanupErrors.map(String),
    finishedAt: new Date().toISOString(),
  });
}

if (primaryError != null || cleanupErrors.length > 0) {
  throw new AggregateError(
    [primaryError, ...cleanupErrors].filter(Boolean),
    'Sandbox Lab campaign or cleanup failed.',
  );
}
