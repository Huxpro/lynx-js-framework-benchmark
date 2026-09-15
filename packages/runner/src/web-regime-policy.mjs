export function resolveThrottleScope(args, cpuThrottle) {
  const scope = args['throttle-scope'] ?? (cpuThrottle > 1 ? 'process-cgroup' : 'none');
  if (scope === 'page-cdp') {
    throw new Error(
      '--throttle-scope=page-cdp is retired: it throttles only the page/MTS target. '
      + 'Use --throttle-scope=process-cgroup for Interp 4×.',
    );
  }
  if (!['none', 'process-cgroup'].includes(scope)) {
    throw new Error(`unknown throttle scope: ${scope}`);
  }
  if ((cpuThrottle === 1) !== (scope === 'none')) {
    throw new Error(`--throttle-scope=${scope} is incompatible with --cpu-throttle=${cpuThrottle}`);
  }
  return scope;
}

export function attachWebExecutionEnvironment(records, {
  jsRegime,
  jsFlags,
  cpuThrottle,
  throttleScope,
  verifiedSlowdownByEntry = {},
}) {
  return records.map((record) => ({
    ...record,
    environment: {
      jsRegime,
      jsFlags,
      cpuThrottle,
      throttleScope,
      ...(verifiedSlowdownByEntry[record.entry] == null
        ? {}
        : { verifiedSlowdown: verifiedSlowdownByEntry[record.entry] }),
    },
  }));
}
