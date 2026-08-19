#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const DEFAULT_REMOTE = 'https://github.com/Huxpro/octane.git';
const REF = 'refs/heads/new-lynx';

function usage() {
  throw new Error(
    'usage: node scripts/new-lynx-snapshot-window.mjs start <state.json> '
    + '| check <state.json> <receipt.json>',
  );
}

function readRemoteHead(remote) {
  const output = execFileSync('git', ['ls-remote', '--exit-code', remote, REF], {
    encoding: 'utf8',
  }).trim();
  const [commit, ref, ...extra] = output.split(/\s+/);
  if (!/^[0-9a-f]{40}$/.test(commit ?? '') || ref !== REF || extra.length !== 0) {
    throw new Error(`could not resolve exactly one ${REF} at ${remote}: ${JSON.stringify(output)}`);
  }
  return commit;
}

function writeExclusive(file, value) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
}

function stateHash(state) {
  const { stateSha256: _ignored, ...payload } = state;
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function systemdCalendar(epochMs) {
  return new Date(epochMs).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

const [command, first, second] = process.argv.slice(2);
if (command === 'start') {
  if (!first || second) usage();
  const remote = process.env.OCTANE_NEW_LYNX_REMOTE ?? DEFAULT_REMOTE;
  const new1Commit = readRemoteHead(remote);
  const startedAtEpochMs = Date.now();
  const statePayload = {
    version: 1,
    remote,
    ref: REF,
    new1Commit,
    startedAtEpochMs,
    startedAtUtc: new Date(startedAtEpochMs).toISOString(),
    deadlineEpochMs: startedAtEpochMs + TWO_HOURS_MS,
    deadlineUtc: new Date(startedAtEpochMs + TWO_HOURS_MS).toISOString(),
    deadlineSystemdCalendar: systemdCalendar(startedAtEpochMs + TWO_HOURS_MS),
  };
  const state = { ...statePayload, stateSha256: stateHash(statePayload) };
  writeExclusive(first, state);
  console.log(JSON.stringify(state, null, 2));
} else if (command === 'check') {
  if (!first || !second) usage();
  const state = JSON.parse(fs.readFileSync(first, 'utf8'));
  if (state.deadlineEpochMs - state.startedAtEpochMs !== TWO_HOURS_MS) {
    throw new Error('window state does not contain an exact two-hour deadline.');
  }
  if (state.stateSha256 !== stateHash(state)) {
    throw new Error('window state integrity hash does not match.');
  }
  if (state.deadlineSystemdCalendar !== systemdCalendar(state.deadlineEpochMs)) {
    throw new Error('window state systemd calendar does not match its deadline.');
  }
  const observedAtEpochMs = Date.now();
  if (observedAtEpochMs < state.deadlineEpochMs) {
    throw new Error(
      `new2 check is early by ${state.deadlineEpochMs - observedAtEpochMs} ms; `
      + `deadline is ${state.deadlineUtc}.`,
    );
  }
  const observedNew2Commit = readRemoteHead(state.remote);
  const receipt = {
    ...state,
    observedNew2Commit,
    observedAtEpochMs,
    observedAtUtc: new Date(observedAtEpochMs).toISOString(),
    elapsedMs: observedAtEpochMs - state.startedAtEpochMs,
    headChanged: observedNew2Commit !== state.new1Commit,
  };
  writeExclusive(second, receipt);
  console.log(JSON.stringify(receipt, null, 2));
} else {
  usage();
}
