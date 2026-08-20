import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

const script = new URL('./run-sandbox-lab.mjs', import.meta.url).pathname;

function executable(file, body) {
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
}

function run(binary, args, options) {
  return new Promise((resolve) => {
    const child = spawn(binary, args, options);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

test('Sandbox Lab wrapper acquires one lease and releases it before disconnect on runner failure', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-lab-'));
  const evidence = path.join(dir, 'evidence');
  const events = path.join(dir, 'events');
  const adb = path.join(dir, 'adb');
  const pnpm = path.join(dir, 'pnpm');
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, headers: request.headers });
    if (request.method === 'POST') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({
        acquired: 'sandbox.example:4321',
        expiredAt: Date.now() + 60_000,
      }));
    } else {
      fs.appendFileSync(events, 'release\n');
      response.end(JSON.stringify({ released: true }));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    executable(adb, `printf 'adb:%s\n' "$*" >> '${events}'\nexit 0`);
    executable(pnpm, `printf 'pnpm:%s|%s|%s\n' "$*" "$LYNX_SANDBOX_SERIAL" "$LYNX_SANDBOX_LEASE_RECEIPT" >> '${events}'\nexit 7`);
    const address = server.address();
    const result = await run(process.execPath, [script, 'octane-new-2026-08-20', evidence], {
      env: {
        ...process.env,
        SANDBOX_BASE_URL: `http://127.0.0.1:${address.port}`,
        SANDBOX_ISSUER: 'benchmark@example.test',
        SANDBOX_ISSUE_ID: 'octane-new-2026-08-20-test',
        ADB_BIN: adb,
        PNPM_BIN: pnpm,
      },
    });
    assert.notEqual(result.status, 0);
    const lines = fs.readFileSync(events, 'utf8').trim().split('\n');
    assert.equal(lines[0], 'adb:connect sandbox.example:4321');
    assert.equal(lines[1], 'adb:-s sandbox.example:4321 wait-for-device');
    assert.match(lines[2], /^pnpm:bench run --harness native --lab-native --entry octane-new-2026-08-20/);
    assert.equal(lines[3], 'release');
    assert.equal(lines[4], 'adb:disconnect sandbox.example:4321');
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].headers['x-issuer'], 'benchmark@example.test');
    assert.equal(requests[0].headers['x-issue-id'], 'octane-new-2026-08-20-test');
    assert.equal(requests[1].method, 'DELETE');
    assert.equal(requests[1].url, '/pool/lease?serial=sandbox.example%3A4321');
    const receipt = JSON.parse(fs.readFileSync(path.join(evidence, 'lease-receipt.json'), 'utf8'));
    assert.equal(receipt.issueId, 'octane-new-2026-08-20-test');
    assert.equal(receipt.serial, 'sandbox.example:4321');
    assert.equal(JSON.parse(fs.readFileSync(path.join(evidence, 'outcome.json'), 'utf8')).runnerStatus, 7);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Sandbox Lab wrapper succeeds only after release and disconnect both succeed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-lab-success-'));
  const evidence = path.join(dir, 'evidence');
  const events = path.join(dir, 'events');
  const adb = path.join(dir, 'adb');
  const pnpm = path.join(dir, 'pnpm');
  const targetReceipt = path.join(dir, 'target-receipt.json');
  const runFile = path.join(dir, 'complete-run.json');
  let leaseBody = null;
  const server = http.createServer((request, response) => {
    if (request.method === 'POST') {
      let body = '';
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        leaseBody = body;
        response.end(JSON.stringify({ acquired: 'sandbox.success:1234', expiredAt: Date.now() + 60_000 }));
      });
    } else {
      fs.appendFileSync(events, 'release\n');
      response.end('{}');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    executable(adb, `printf 'adb:%s\n' "$*" >> '${events}'\nexit 0`);
    fs.writeFileSync(runFile, JSON.stringify({ meta: { checkpointComplete: true } }));
    fs.writeFileSync(targetReceipt, JSON.stringify({ serial: 'sandbox.success:1234' }));
    executable(pnpm, `printf 'pnpm:%s\n' "$*" >> '${events}'\nprintf '35 records → ${runFile}\n'\nexit 0`);
    const result = await run(process.execPath, [script, 'octane-new-2026-08-20', evidence], {
      env: {
        ...process.env,
        SANDBOX_BASE_URL: `http://127.0.0.1:${server.address().port}`,
        SANDBOX_ISSUER: 'benchmark@example.test',
        SANDBOX_ISSUE_ID: 'octane-new-2026-08-20-test',
        SANDBOX_TARGET_LEASE_RECEIPT: targetReceipt,
        ADB_BIN: adb,
        PNPM_BIN: pnpm,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(leaseBody, JSON.stringify({ serial: 'sandbox.success:1234' }));
    assert.deepEqual(fs.readFileSync(events, 'utf8').trim().split('\n').slice(-2), [
      'release', 'adb:disconnect sandbox.success:1234',
    ]);
    const outcome = JSON.parse(fs.readFileSync(path.join(evidence, 'outcome.json'), 'utf8'));
    assert.equal(outcome.runnerStatus, 0);
    assert.equal(outcome.runPath, runFile);
    assert.equal(outcome.checkpointComplete, true);
    assert.deepEqual(outcome.cleanupErrors, []);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Sandbox Lab wrapper cleans up and fails closed on an exit-zero incomplete checkpoint', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-lab-incomplete-'));
  const evidence = path.join(dir, 'evidence');
  const events = path.join(dir, 'events');
  const adb = path.join(dir, 'adb');
  const pnpm = path.join(dir, 'pnpm');
  const runFile = path.join(dir, 'checkpoint.json');
  const server = http.createServer((request, response) => {
    if (request.method === 'POST') {
      response.end(JSON.stringify({ acquired: 'sandbox.partial:1234', expiredAt: Date.now() + 60_000 }));
    } else {
      fs.appendFileSync(events, 'release\n');
      response.end('{}');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    fs.writeFileSync(runFile, JSON.stringify({ meta: { checkpointComplete: false } }));
    executable(adb, `printf 'adb:%s\n' "$*" >> '${events}'\nexit 0`);
    executable(pnpm, `printf '12 records → ${runFile}\n'\nexit 0`);
    const result = await run(process.execPath, [script, 'octane-new-2026-08-20', evidence], {
      env: {
        ...process.env,
        SANDBOX_BASE_URL: `http://127.0.0.1:${server.address().port}`,
        SANDBOX_ISSUER: 'benchmark@example.test',
        SANDBOX_ISSUE_ID: 'octane-new-2026-08-20-partial',
        ADB_BIN: adb,
        PNPM_BIN: pnpm,
      },
    });
    assert.notEqual(result.status, 0);
    assert.deepEqual(fs.readFileSync(events, 'utf8').trim().split('\n').slice(-2), [
      'release', 'adb:disconnect sandbox.partial:1234',
    ]);
    const outcome = JSON.parse(fs.readFileSync(path.join(evidence, 'outcome.json'), 'utf8'));
    assert.equal(outcome.runnerStatus, 0);
    assert.equal(outcome.runPath, runFile);
    assert.equal(outcome.checkpointComplete, false);
    assert.match(outcome.primaryError, /incomplete checkpoint/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Sandbox Lab wrapper performs no device action when lease acquisition fails', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-lab-no-lease-'));
  const evidence = path.join(dir, 'evidence');
  const events = path.join(dir, 'events');
  const fake = path.join(dir, 'should-not-run');
  const server = http.createServer((_request, response) => {
    response.statusCode = 503;
    response.end('unavailable');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    executable(fake, `printf 'unexpected\n' >> '${events}'\nexit 0`);
    const result = await run(process.execPath, [script, 'octane-new-2026-08-20', evidence], {
      env: {
        ...process.env,
        SANDBOX_BASE_URL: `http://127.0.0.1:${server.address().port}`,
        SANDBOX_ISSUER: 'benchmark@example.test',
        SANDBOX_ISSUE_ID: 'octane-no-lease-test',
        ADB_BIN: fake,
        PNPM_BIN: fake,
      },
    });
    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(events), false);
    assert.equal(fs.existsSync(path.join(evidence, 'lease-release.json')), false);
    assert.match(
      JSON.parse(fs.readFileSync(path.join(evidence, 'outcome.json'), 'utf8')).primaryError,
      /HTTP 503/,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
