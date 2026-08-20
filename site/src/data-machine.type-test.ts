import type { Machine } from './data';

// A publishable Native cohort is a virtual, cross-lease machine. It carries
// device and campaign provenance, but it is not a single host run and therefore
// has no latest host calibration or latest run pointer.
const nativeCohortMachine = {
  id: 'native-cohort',
  platform: 'android',
  cpuModel: 'linaro',
  cores: 8,
  node: null,
} satisfies Machine;

void nativeCohortMachine;
