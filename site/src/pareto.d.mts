export interface ParetoDatum {
  entry?: string;
  bytes: number;
  fcp: number;
  regimeKey?: string;
}

export const DEFAULT_PARETO_WEB_REGIME: Readonly<{
  jsRegime: 'jit'; jsFlags: '--expose-gc'; cpuThrottle: 1;
}>;
export function paretoRegimeKey(record: {
  harness?: string; jsRegime?: string | null; jsFlags?: string | null; cpuThrottle?: number | null;
}): string;
export function paretoRegimeRecords<T extends {
  harness?: string; jsRegime?: string | null; jsFlags?: string | null; cpuThrottle?: number | null;
}>(records: T[], harness?: string): T[];
export function paretoFrontier<T extends ParetoDatum>(points: T[]): T[];
export function paretoLine<T extends ParetoDatum>(points: T[]): T[];
