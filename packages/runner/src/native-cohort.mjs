import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function required(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Native machine.${label} is required`);
  }
  return value;
}

export function validateNativeMachine(machine) {
  if (!machine || typeof machine !== 'object' || Array.isArray(machine)) {
    throw new Error('Native adapter must provide a device-stable machine identity');
  }
  const validated = {
    ...machine,
    id: required(machine.id, 'id'),
    platform: required(machine.platform, 'platform'),
    osVersion: required(machine.osVersion, 'osVersion'),
    deviceModel: required(machine.deviceModel, 'deviceModel'),
    cpuModel: required(machine.cpuModel, 'cpuModel'),
    cores: machine.cores,
    app: required(machine.app, 'app'),
    appVersion: required(machine.appVersion, 'appVersion'),
    sdkVersion: required(machine.sdkVersion, 'sdkVersion'),
    debugRouterVersion: required(machine.debugRouterVersion, 'debugRouterVersion'),
    agentLynxVersion: required(machine.agentLynxVersion, 'agentLynxVersion'),
    physicalDeviceId: required(machine.physicalDeviceId, 'physicalDeviceId'),
    leaseId: required(machine.leaseId, 'leaseId'),
  };
  if (!Number.isSafeInteger(validated.cores) || validated.cores <= 0) {
    throw new Error('Native machine.cores must be a positive safe integer');
  }
  for (const raw of [machine.did, machine.serial, machine.deviceSerial]) {
    if (raw != null) throw new Error('Native machine must not persist raw device identifiers');
  }
  return Object.freeze(validated);
}

export function createNativeCohort({
  machine,
  environment,
  adapterFingerprint,
  artifactFingerprint,
  benchmarkFingerprint,
}) {
  const value = {
    schemaVersion: 1,
    environment: required(environment, 'environment'),
    machine: validateNativeMachine(machine),
    adapterFingerprint: required(adapterFingerprint, 'adapterFingerprint'),
    artifactFingerprint: required(artifactFingerprint, 'artifactFingerprint'),
    benchmarkFingerprint: required(benchmarkFingerprint, 'benchmarkFingerprint'),
  };
  return Object.freeze({
    ...value,
    fingerprint: sha256(Buffer.from(JSON.stringify(value))),
  });
}

export function captureNativeBenchmarkFingerprint(root) {
  const checkout = fs.realpathSync(path.resolve(root));
  let files;
  try {
    files = execFileSync('git', ['ls-files', '-z'], { cwd: checkout })
      .toString().split('\0').filter(Boolean);
  } catch {
    files = [];
    const visit = (directory, prefix = '') => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === '.git' || entry.name === 'results' || entry.name === '.tmp') continue;
        const relative = path.posix.join(prefix, entry.name);
        if (entry.isDirectory()) visit(path.join(directory, entry.name), relative);
        else if (entry.isFile()) files.push(relative);
      }
    };
    visit(checkout);
  }
  files = files
    .filter((file) => !file.startsWith('results/'))
    .filter((file) => !file.startsWith('.tmp/'))
    .sort();
  const entries = files.map((file) => {
    const bytes = fs.readFileSync(path.join(checkout, file));
    return { path: file, bytes: bytes.length, sha256: sha256(bytes) };
  });
  return {
    schemaVersion: 1,
    files: entries.length,
    sha256: sha256(Buffer.from(JSON.stringify(entries))),
    exclusions: ['results/', '.tmp/'],
  };
}
