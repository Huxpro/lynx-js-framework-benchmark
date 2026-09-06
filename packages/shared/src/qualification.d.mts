import type { ScoreOperation } from './scorecard.mjs';

export interface PairedObservation {
  readonly session: string;
  readonly order: 'AB' | 'BA';
  readonly cells: Readonly<
    Record<
      string,
      Readonly<{
        candidate: number;
        comparator: number;
      }>
    >
  >;
}

export function qualifyPairedScorecard(options: {
  pairs: readonly PairedObservation[];
  cells: readonly ScoreOperation[];
  minimumPairs?: number;
  resamples?: number;
  confidence?: number;
  seed?: number;
  strictWinUpperRatio?: number;
  engineeringPointRatio?: number;
  coreCellNonInferiorityUpperRatio?: number;
  orderBalanceMaximumDifference?: number;
}): {
  pairCount: number;
  orderCounts: { AB: number; BA: number };
  aggregate: {
    point: number;
    lower: number;
    upper: number;
    strictWin: boolean;
    engineeringTarget: boolean;
  };
  cells: Record<
    string,
    { point: number; lower: number; upper: number; nonInferior: boolean }
  >;
  pass: boolean;
};
