// Whole-Chromium CPU throttling for the issue-42 calibration lane.
// Chromium must start inside the quota cgroup: attaching a limiter after
// launch races renderer forks and produces a mixed, invalid measurement.
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
  return { parent: path.join(mountPoint, relative) };
}

function cgroup1CpuMount() {
  const line = fs.readFileSync('/proc/self/mountinfo', 'utf8')
    .split('\n')
    .find((candidate) => {
      const [, tail = ''] = candidate.split(' - ');
      const [type, , options = ''] = tail.split(' ');
      return type === 'cgroup' && options.split(',').includes('cpu');
    });
  if (line == null) throw new Error('cgroup v1 cpu controller is unavailable');
  const mountPoint = line.split(' ')[4]?.replaceAll('\\040', ' ');
  if (!mountPoint) throw new Error('could not resolve cgroup v1 cpu mount point');
  return mountPoint;
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

function prepareCgroupV2(cpuThrottle, chromiumPath, quotaPercent) {
  const { parent } = cgroup2Location();
  const controllers = fs.readFileSync(path.join(parent, 'cgroup.controllers'), 'utf8').trim().split(/\s+/);
  if (!controllers.includes('cpu')) throw new Error('cpu controller is not delegated to this cgroup');
  const subtreeControlPath = path.join(parent, 'cgroup.subtree_control');
  const enabled = fs.readFileSync(subtreeControlPath, 'utf8').trim().split(/\s+/);
  if (!enabled.includes('cpu')) fs.writeFileSync(subtreeControlPath, '+cpu');
  const cgroupPath = path.join(parent, `lynx-bench-${process.pid}-${Date.now()}`);
  fs.mkdirSync(cgroupPath);
  try {
    const quotaUs = Math.round(CGROUP_PERIOD_US * quotaPercent / 100);
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
        inheritance: 'launch-cgroup',
        cpuThrottle,
        quotaPercent,
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

function sudoRun(args, { input = null } = {}) {
  const result = spawnSync('sudo', ['-n', ...args], {
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(`sudo ${args[0]} failed: ${(result.stderr ?? '').trim() || `exit ${result.status}`}`);
  }
}

function prepareCgroupV1(cpuThrottle, chromiumPath, quotaPercent, cgroupV2Failure) {
  const mountPoint = cgroup1CpuMount();
  const uid = process.getuid?.();
  const username = os.userInfo().username;
  const groupResult = spawnSync('id', ['-gn'], { encoding: 'utf8' });
  const groupNameForOwner = groupResult.status === 0 ? groupResult.stdout.trim() : '';
  if (!groupNameForOwner) throw new Error('could not resolve current group for cgroup v1 delegation');
  const groupName = `lynx-bench-${uid ?? 'user'}-${process.pid}-${Date.now()}`;
  const group = `/${groupName}`;
  const cgroupPath = path.join(mountPoint, groupName);
  const quotaUs = Math.round(CGROUP_PERIOD_US * quotaPercent / 100);
  let privileged = false;

  try {
    fs.mkdirSync(cgroupPath);
    fs.writeFileSync(path.join(cgroupPath, 'cpu.cfs_period_us'), String(CGROUP_PERIOD_US));
    fs.writeFileSync(path.join(cgroupPath, 'cpu.cfs_quota_us'), String(quotaUs));
  } catch (directError) {
    try { fs.rmdirSync(cgroupPath); } catch { /* best effort */ }
    try {
      sudoRun([
        'cgcreate', '-a', `${username}:${groupNameForOwner}`, '-t', `${username}:${groupNameForOwner}`,
        '-g', `cpu,cpuacct:${group}`,
      ]);
      fs.writeFileSync(path.join(cgroupPath, 'cpu.cfs_period_us'), String(CGROUP_PERIOD_US));
      fs.writeFileSync(path.join(cgroupPath, 'cpu.cfs_quota_us'), String(quotaUs));
      privileged = true;
    } catch (sudoError) {
      try { sudoRun(['cgdelete', '-g', `cpu,cpuacct:${group}`]); } catch { /* best effort */ }
      throw new Error(
        `cgroup v1 setup failed directly (${directError.message}) and via sudo (${sudoError.message}); `
        + `cgroup v2 was unavailable (${cgroupV2Failure.message})`,
      );
    }
  }

  const wrapper = writeWrapper([
    `exec cgexec -g ${shellQuote(`cpu,cpuacct:${group}`)} --sticky `
      + `${shellQuote(chromiumPath)} "$@"`,
  ]);

  return {
    executablePath: wrapper.executablePath,
    receipt: {
      scope: 'process-cgroup',
      backend: 'cgroup-v1-cgexec',
      inheritance: 'launch-cgroup',
      cpuThrottle,
      quotaPercent,
      cpuMax: `${quotaUs} ${CGROUP_PERIOD_US}`,
      cgroupPath: group,
      privilege: privileged ? 'sudo-create-user-owned-tasks' : 'delegated-user',
      cgroupV2FallbackReason: cgroupV2Failure.message,
    },
    async close() {
      wrapper.close();
      if (privileged) {
        try { sudoRun(['cgdelete', '-g', `cpu,cpuacct:${group}`]); } catch { /* best effort */ }
      } else {
        try { fs.rmdirSync(cgroupPath); } catch { /* best effort */ }
      }
    },
  };
}

/** Prepare an executable wrapper so every Chromium fork inherits one CPU quota from birth. */
export function prepareProcessThrottle(
  cpuThrottle,
  chromiumPath,
  quotaPercent = 100 / cpuThrottle,
) {
  if (!Number.isFinite(cpuThrottle) || cpuThrottle <= 1) {
    throw new Error(`whole-process throttling requires a finite rate > 1; received ${cpuThrottle}`);
  }
  if (!Number.isFinite(quotaPercent) || quotaPercent <= 0 || quotaPercent > 100) {
    throw new Error(`whole-process quota percent must be in (0, 100]; received ${quotaPercent}`);
  }
  try {
    return prepareCgroupV2(cpuThrottle, chromiumPath, quotaPercent);
  } catch (error) {
    return prepareCgroupV1(cpuThrottle, chromiumPath, quotaPercent, error);
  }
}
