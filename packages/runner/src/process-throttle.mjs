// Whole-Chromium CPU throttling for the issue-42 calibration lane.
// Prefer a delegated cgroup-v2 cpu.max quota. Runners without a writable
// cgroup fall back to cpulimit, which applies one shared quota to the target
// process, all of its threads, and its monitored descendants.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CGROUP_PERIOD_US = 100_000;

function cgroup2Location() {
  const membership = fs.readFileSync('/proc/self/cgroup', 'utf8')
    .split('\n')
    .find((line) => line.startsWith('0::'));
  if (membership == null) throw new Error('host is not using cgroup v2');
  const relative = membership.slice(3);
  const mount = fs.readFileSync('/proc/self/mountinfo', 'utf8')
    .split('\n')
    .find((line) => line.includes(' - cgroup2 '));
  if (mount == null) throw new Error('cgroup v2 mount is unavailable');
  const mountPoint = mount.split(' ')[4]?.replaceAll('\\040', ' ');
  if (!mountPoint) throw new Error('could not resolve cgroup v2 mount point');
  return { mountPoint, relative, parent: path.join(mountPoint, relative) };
}

function resolveCpulimit() {
  const explicit = process.env.LYNX_BENCH_CPULIMIT_PATH;
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error(`LYNX_BENCH_CPULIMIT_PATH does not exist: ${explicit}`);
    return explicit;
  }
  const result = spawnSync('sh', ['-c', 'command -v cpulimit'], { encoding: 'utf8' });
  const executable = result.status === 0 ? result.stdout.trim() : '';
  if (!executable) {
    throw new Error(
      'cgroup v2 is unavailable or not writable and cpulimit was not found; '
      + 'install cpulimit or set LYNX_BENCH_CPULIMIT_PATH',
    );
  }
  return executable;
}

const shellQuote = (value) => `'${String(value).replaceAll("'", "'\"'\"'")}'`;

function writeWrapper(lines) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynx-bench-throttle-'));
  const wrapperPath = path.join(tempDir, 'chromium');
  fs.writeFileSync(wrapperPath, `#!/bin/sh\nset -eu\n${lines.join('\n')}\n`, { mode: 0o700 });
  return {
    executablePath: wrapperPath,
    close() { fs.rmSync(tempDir, { recursive: true, force: true }); },
  };
}

function prepareCgroupV2(cpuThrottle, chromiumPath) {
  const { parent } = cgroup2Location();
  const controllers = fs.readFileSync(path.join(parent, 'cgroup.controllers'), 'utf8').trim().split(/\s+/);
  if (!controllers.includes('cpu')) throw new Error('cpu controller is not delegated to this cgroup');
  const subtreeControlPath = path.join(parent, 'cgroup.subtree_control');
  const enabled = fs.readFileSync(subtreeControlPath, 'utf8').trim().split(/\s+/);
  if (!enabled.includes('cpu')) fs.writeFileSync(subtreeControlPath, '+cpu');
  const cgroupPath = path.join(parent, `lynx-bench-${process.pid}-${Date.now()}`);
  fs.mkdirSync(cgroupPath);
  try {
    const quotaUs = Math.round(CGROUP_PERIOD_US / cpuThrottle);
    fs.writeFileSync(path.join(cgroupPath, 'cpu.max'), `${quotaUs} ${CGROUP_PERIOD_US}`);
    const wrapper = writeWrapper([
      `printf '%s' "$$" > ${shellQuote(path.join(cgroupPath, 'cgroup.procs'))}`,
      `exec ${shellQuote(chromiumPath)} "$@"`,
    ]);
    return {
      executablePath: wrapper.executablePath,
      receipt: {
        scope: 'process-cgroup',
        backend: 'cgroup-v2',
        cpuThrottle,
        quotaPercent: 100 / cpuThrottle,
        cpuMax: `${quotaUs} ${CGROUP_PERIOD_US}`,
      },
      async close() {
        wrapper.close();
        try { fs.rmdirSync(cgroupPath); } catch { /* best effort after Chromium exits */ }
      },
    };
  } catch (error) {
    try { fs.rmdirSync(cgroupPath); } catch { /* best effort */ }
    throw error;
  }
}

function prepareCpulimit(cpuThrottle, chromiumPath, cgroupFailure) {
  const executable = resolveCpulimit();
  const quotaPercent = 100 / cpuThrottle;
  if (!Number.isInteger(quotaPercent) || quotaPercent < 1) {
    throw new Error(`cpulimit fallback needs an integer percentage; received ${quotaPercent}`);
  }
  const wrapper = writeWrapper([
    `exec ${shellQuote(executable)} --limit=${quotaPercent} --monitor-forks --foreground --quiet -- ${shellQuote(chromiumPath)} "$@"`,
  ]);
  const version = spawnSync(executable, ['--version'], { encoding: 'utf8' });
  return {
    executablePath: wrapper.executablePath,
    receipt: {
      scope: 'process-cgroup',
      backend: 'cpulimit',
      cpuThrottle,
      quotaPercent,
      version: `${version.stdout ?? ''}${version.stderr ?? ''}`.trim().split('\n')[0] || null,
      cgroupFallbackReason: cgroupFailure.message,
    },
    async close() { wrapper.close(); },
  };
}

/** Prepare an executable wrapper so every Chromium fork inherits one CPU quota from birth. */
export function prepareProcessThrottle(cpuThrottle, chromiumPath) {
  if (!Number.isFinite(cpuThrottle) || cpuThrottle <= 1) {
    throw new Error(`whole-process throttling requires a finite rate > 1; received ${cpuThrottle}`);
  }
  try {
    return prepareCgroupV2(cpuThrottle, chromiumPath);
  } catch (error) {
    return prepareCpulimit(cpuThrottle, chromiumPath, error);
  }
}
