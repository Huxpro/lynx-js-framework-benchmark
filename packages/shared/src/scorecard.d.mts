export interface ScoreOperation {
  readonly key: string;
  readonly label: string;
  readonly workload: string;
  readonly metric?: string;
  readonly scale: number;
  readonly weight: number;
}

export const JS_FRAMEWORK_SCORE_OPS: readonly ScoreOperation[];
export const JS_FRAMEWORK_SCORE_WEIGHTS: Readonly<Record<string, number>>;
export const ROADMAP_SCORECARD: Readonly<{
  version: number;
  ratio: string;
  platforms: readonly Readonly<Record<string, string | boolean>>[];
  suites: Readonly<
    Record<
      string,
      Readonly<{
        aggregate: string;
        cells: readonly ScoreOperation[];
      }>
    >
  >;
  diagnosticScales: Readonly<{
    startup: readonly number[];
    bulk: readonly number[];
  }>;
  correctness: readonly string[];
  correctnessAssertions: readonly string[];
  engagement: Readonly<{
    requiredPerCell: readonly string[];
    failure: string;
  }>;
  timeoutsMs: Readonly<{
    interaction: number;
    startup: number;
  }>;
  statistics: Readonly<Record<string, string | number>>;
  tail: Readonly<Record<string, unknown>>;
  memory: Readonly<Record<string, unknown>>;
  identity: Readonly<Record<string, unknown>>;
}>;
