import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const script = new URL('./new-lynx-snapshot-window.mjs', import.meta.url).pathname;

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

test('snapshot window reads the remote at both boundaries and enforces two elapsed hours', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'new-lynx-window-'));
  const source = path.join(dir, 'source');
  const remote = path.join(dir, 'remote.git');
  const stateFile = path.join(dir, 'window.json');
  const receiptFile = path.join(dir, 'receipt.json');
  try {
    fs.mkdirSync(source);
    git(source, 'init', '-b', 'new-lynx');
    git(source, 'config', 'user.name', 'Snapshot Test');
    git(source, 'config', 'user.email', 'snapshot@example.test');
    fs.writeFileSync(path.join(source, 'marker'), 'one');
    git(source, 'add', 'marker');
    git(source, 'commit', '-m', 'one');
    git(dir, 'init', '--bare', remote);
    git(source, 'remote', 'add', 'origin', remote);
    git(source, 'push', 'origin', 'new-lynx');

    const env = { ...process.env, OCTANE_NEW_LYNX_REMOTE: remote };
    const started = spawnSync(process.execPath, [script, 'start', stateFile], { encoding: 'utf8', env });
    assert.equal(started.status, 0, started.stderr);
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(state.deadlineEpochMs - state.startedAtEpochMs, 2 * 60 * 60 * 1000);
    assert.match(state.deadlineSystemdCalendar, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC$/);
    assert.equal(state.new1Commit, git(source, 'rev-parse', 'HEAD'));

    const early = spawnSync(process.execPath, [script, 'check', stateFile, receiptFile], {
      encoding: 'utf8', env,
    });
    assert.notEqual(early.status, 0);
    assert.match(early.stderr, /new2 check is early/);
    assert.equal(fs.existsSync(receiptFile), false);

    fs.writeFileSync(path.join(source, 'marker'), 'two');
    git(source, 'add', 'marker');
    git(source, 'commit', '-m', 'two');
    git(source, 'push', 'origin', 'new-lynx');
    const startedAtEpochMs = Date.now() - 2 * 60 * 60 * 1000 - 1;
    const elapsedStatePayload = {
      ...state,
      startedAtEpochMs,
      startedAtUtc: new Date(startedAtEpochMs).toISOString(),
      deadlineEpochMs: startedAtEpochMs + 2 * 60 * 60 * 1000,
      deadlineUtc: new Date(startedAtEpochMs + 2 * 60 * 60 * 1000).toISOString(),
      deadlineSystemdCalendar: new Date(startedAtEpochMs + 2 * 60 * 60 * 1000)
        .toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC'),
    };
    delete elapsedStatePayload.stateSha256;
    const elapsedState = {
      ...elapsedStatePayload,
      stateSha256: crypto.createHash('sha256')
        .update(JSON.stringify(elapsedStatePayload))
        .digest('hex'),
    };
    fs.writeFileSync(stateFile, JSON.stringify(elapsedState));
    const checked = spawnSync(
      process.execPath,
      [script, 'check', stateFile, receiptFile],
      { encoding: 'utf8', env },
    );
    assert.equal(checked.status, 0, checked.stderr);
    const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
    assert.equal(receipt.observedNew2Commit, git(source, 'rev-parse', 'HEAD'));
    assert.notEqual(receipt.observedNew2Commit, receipt.new1Commit);
    assert.equal(receipt.headChanged, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
