// Machine fingerprint embedded in every run file. `id` is stable per host so
// collect can group records by machine.
import crypto from 'node:crypto';
import os from 'node:os';

export function machineFingerprint() {
  const cpus = os.cpus();
  const cpuModel = cpus[0]?.model ?? 'unknown';
  const raw = `${os.hostname()}|${os.platform()}|${os.arch()}|${cpuModel}|${cpus.length}`;
  return {
    id: crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12),
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    cpuModel,
    cores: cpus.length,
    memGB: Math.round(os.totalmem() / 1e9),
    node: process.version,
  };
}
