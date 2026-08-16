// Machine fingerprint embedded in every run file. `id` is stable per host so
// collect can group records by machine.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';

function cpuGovernors() {
  const root = '/sys/devices/system/cpu';
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .filter((name) => /^cpu\d+$/.test(name))
    .map((name) => {
      const file = `${root}/${name}/cpufreq/scaling_governor`;
      if (!fs.existsSync(file)) return null;
      return fs.readFileSync(file, 'utf8').trim();
    })
    .filter(Boolean)
    .sort();
}

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
    loadAverage: os.loadavg(),
    cpuGovernors: [...new Set(cpuGovernors())],
  };
}
