export interface DerivedCell {
  key: string;
  values: Record<string, number | null | undefined>;
}

export function geomean(values: number[]): number | null;
export function completeEntryScores(ids: string[], cells: DerivedCell[]): {
  scores: { id: string; value: number | null }[];
  missing: string[];
  cellCount: number;
};
export function completeRowGeomeans(ids: string[], cells: DerivedCell[], baselineId?: string | null): {
  values: Map<string, number | null>;
  rowCount: number;
};
export function slopeFit(points: [number, number][]): number | null;
export function rankHistoryCell(
  entryIds: string[],
  records: Array<{ entry: string; median: number | null; rankEligible?: boolean; dnfCount: number }>,
  cohortEligible?: boolean,
): Array<{
  entry: string;
  record: { entry: string; median: number | null; rankEligible?: boolean; dnfCount: number } | null;
  rank: number | null;
  status: 'ranked' | 'missing' | 'observation' | 'dnf' | 'incomparable';
}>;
