#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { assertCompleteLabNativeRun } from '../packages/runner/src/lab-native.mjs';
import { assertCompleteLabWebRun } from '../packages/runner/src/lab-web.mjs';
import { assertNativeCoverage, classifyNativeCoverage } from '../packages/runner/src/native-coverage.mjs';
import { nativeCohortIdentity } from '../packages/runner/src/collect.mjs';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const campaignDir = path.resolve(process.argv[2] ?? path.join(root, 'results/campaigns/octane-new'));
const errors = [];
const check = (condition, message) => { if (!condition) errors.push(message); };
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const rel = (file) => path.relative(root, file);

function requiredJson(name) {
  const file = path.join(campaignDir, name);
  if (!fs.existsSync(file)) {
    errors.push(`missing ${rel(file)}`);
    return null;
  }
  try {
    return read(file);
  } catch (error) {
    errors.push(`invalid ${rel(file)}: ${error}`);
    return null;
  }
}

function manifest(id) {
  const file = path.join(root, 'entries', id, 'entry.json');
  if (!fs.existsSync(file)) {
    errors.push(`missing ${rel(file)}`);
    return null;
  }
  const entry = read(file);
  entry.dir = path.dirname(file);
  entry.distDir = path.join(entry.dir, 'dist');
  check(entry.id === id, `${id}: manifest ID mismatch`);
  check(entry.tier === 'lab', `${id}: tier must be lab`);
  check(entry.provenance?.source === 'https://github.com/Huxpro/octane', `${id}: wrong source`);
  check(entry.provenance?.ref === 'new-lynx', `${id}: ref must be new-lynx`);
  check(entry.provenance?.patched === false, `${id}: snapshot must be unpatched`);
  check(entry.webLab?.contract === 'web-lab-entry-v1', `${id}: missing Web Lab contract`);
  check(entry.nativeLab?.contract === 'native-lab-entry-v1', `${id}: missing Native Lab contract`);
  const checksums = entry.provenance?.sha256 ?? {};
  check(Object.keys(checksums).length === 8, `${id}: expected exactly eight bundle checksums`);
  for (const [bundle, expected] of Object.entries(checksums)) {
    const filePath = path.join(entry.distDir, bundle);
    check(fs.existsSync(filePath), `${id}: missing ${bundle}`);
    if (fs.existsSync(filePath)) check(sha256(filePath) === expected, `${id}: checksum mismatch ${bundle}`);
  }
  return entry;
}

function sourceRun(name, entry, assertion) {
  const run = requiredJson(name);
  if (run && entry) check(assertion(run, entry) != null, `${name}: formal contract/provenance incomplete`);
  return run;
}

function nativeSourceRun(name, entry) {
  const run = requiredJson(name);
  if (!run || !entry) return run;
  const complete = assertCompleteLabNativeRun(run, entry);
  check(complete != null, `${name}: formal contract/provenance incomplete`);
  if (complete == null) return run;
  const coverage = classifyNativeCoverage({
    entries: [entry], contract: complete.contract, sourceRecords: complete.records,
  });
  try {
    assertNativeCoverage(coverage);
  } catch (error) {
    errors.push(`${name}: coverage incomplete: ${error}`);
  }
  check(JSON.stringify(run.nativeCoverage) === JSON.stringify(coverage),
    `${name}: stored coverage does not match source observations`);
  const environments = new Set(complete.records.map((record) => record.environment));
  check(environments.size === 1, `${name}: expected one Native environment`);
  if (environments.size === 1) {
    check(nativeCohortIdentity(run, [...environments][0]) != null,
      `${name}: campaign/input/connector/device/lease identity invalid`);
  }
  return run;
}

const windowState = requiredJson('window.json');
const new2Receipt = requiredJson('new2-head-receipt.json');
if (windowState && new2Receipt) {
  check(windowState.deadlineEpochMs - windowState.startedAtEpochMs === 7_200_000,
    'window.json: deadline is not exactly two hours');
  check(new2Receipt.elapsedMs >= 7_200_000, 'new2 receipt: less than two hours elapsed');
  check(new2Receipt.new1Commit === windowState.new1Commit, 'new2 receipt: new1 commit mismatch');
  check(new2Receipt.remote === windowState.remote && new2Receipt.ref === windowState.ref,
    'new2 receipt: remote/ref mismatch');
  check(/^[0-9a-f]{40}$/.test(new2Receipt.observedNew2Commit ?? ''),
    'new2 receipt: invalid observed commit');
}

const new1 = manifest('octane-new1');
const new2 = manifest('octane-new2');
if (windowState && new1) check(new1.provenance.commit === windowState.new1Commit,
  'octane-new1: commit does not match window');
if (new2Receipt && new2) check(new2.provenance.commit === new2Receipt.observedNew2Commit,
  'octane-new2: commit does not match deadline receipt');

sourceRun('new1-web-run.json', new1, assertCompleteLabWebRun);
nativeSourceRun('new1-native-run.json', new1);
sourceRun('new2-web-run.json', new2, assertCompleteLabWebRun);
nativeSourceRun('new2-native-run.json', new2);

const latestPath = path.join(root, 'results/latest.json');
if (!fs.existsSync(latestPath)) {
  errors.push('missing results/latest.json');
} else {
  const latest = read(latestPath);
  for (const id of ['octane-new1', 'octane-new2']) {
    check(latest.labComparisonRecords?.some((record) => record.entry === id),
      `${id}: missing from labComparisonRecords`);
    check(latest.nativeLabRuns?.some((run) => run.entryId === id), `${id}: missing Native Lab run`);
    check(latest.nativeLabRecords?.some((record) => record.entry === id),
      `${id}: missing Native Lab records`);
    check(!latest.comparisonRecords?.some((record) => record.entry === id),
      `${id}: leaked into featured comparisonRecords`);
  }
}

try {
  const tracked = execFileSync('git', ['ls-files', 'results/local-evidence'], { cwd: root, encoding: 'utf8' });
  check(tracked.trim().length === 0, 'raw local Sandbox evidence is tracked by git');
} catch (error) {
  errors.push(`could not audit git evidence boundary: ${error}`);
}

if (errors.length > 0) {
  console.error(`[audit:new-lynx] FAIL (${errors.length})`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
console.log('[audit:new-lynx] PASS: both immutable Web + Native Lab snapshots and two-hour window verified');
