export interface ScoreCell {
  suite: string;
  workload: string;
  scale: number;
  metric: string;
}

export interface ScoreProfile {
  key: string;
  label: string;
  cells: readonly ScoreCell[];
}

export const SCORE_PROFILES: Readonly<Record<
  'interactive' | 'interactive1k' | 'interactive10k' | 'storms' | 'startup',
  ScoreProfile
>>;
export const HEATMAP_SCORE_KEYS: readonly ('interactive' | 'storms' | 'startup')[];
export function scoreCellKey(scoreCell: ScoreCell): string;

