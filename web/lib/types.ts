export type TabId = "video-submission" | "overview" | "methodology" | "calibration" | "projection" | "overrides";
export type Position = "QB" | "RB" | "WR" | "TE" | "DST";
export type ViewMode = "original" | "adjusted";

export type RangeValues = {
  floor: number;
  median: number;
  ceiling: number;
};

export type RangeValueSources = {
  floor: string;
  average: string;
  median: string;
  ceiling: string;
};

export type RawProjectionFields = Record<string, string>;

export type ForecastRow = {
  id: string;
  name: string;
  position: Position;
  team: string;
  opponent: string;
  game: string;
  sourceProjection: number;
  average?: number;
  csvProjection?: number;
  rank?: number;
  sourceRowOrder?: number;
  rankSd?: number;
  rankSdMatch?: "exact" | "nearest";
  season?: number;
  week?: number;
  inputRevision?: string;
  runId?: string;
  modelRelease?: string;
  originalAverage?: number;
  rawProjection?: RawProjectionFields;
  ffsim?: {
    mean: number;
    p15: number;
    p50: number;
    p85: number;
    zeroRate: number;
    activeRate: number;
  };
  xgbP15?: number;
  xgbP50?: number;
  xgbP85?: number;
  valueSources?: RangeValueSources;
  original: RangeValues;
  nSimulations: number;
  hasDraws: boolean;
  actual?: number;
};

export type OverridePreset = "full" | "half" | "quarter" | "reduced_role";

export type OverrideSpec = {
  factor: number;
  workloadFactor?: number;
  preset?: OverridePreset;
  inactive: boolean;
  exclude: boolean;
  defensePreset: boolean;
  analystProjection?: number;
  edits: Partial<RangeValues>;
  reason: string;
  savedAt: string;
  revision: number;
  overrideSetId?: string;
  runId?: string;
  uploadId?: string;
  sourceInputRevision?: string;
  stablePlayerId?: string;
  workspaceId?: string;
};

export type OverrideHistoryEntry = {
  id: string;
  action: "save" | "reset" | "copy";
  stablePlayerId?: string;
  label: string;
  detail: string;
  time: string;
  tone: "blue" | "orange" | "gray";
  previous?: RangeValues;
  next?: RangeValues;
};

export type UploadReport = {
  fileName: string;
  sourceTimestamp: string;
  rows: number;
  accepted: number;
  excluded: number;
  unresolved: number;
  positionCounts: Record<"QB" | "RB" | "WR" | "TE", number>;
  selectedSet: string;
  selectedSetLabel?: string;
  selectedSetId?: string;
  sets: Array<{ id: string; label: string; rows: number }>;
  errors: Array<{ row: number; field: string; message: string; value?: string }>;
  sourceOrderUsed: boolean;
};

export type RunState = "Empty" | "Checking upload" | "Ready" | "Queued" | "Running" | "Complete" | "Failed" | "Canceled";

export type OutcomeCardRow = {
  position: Position;
  baselineCoverage: number;
  directCoverage: number;
  baselineLoss: number;
  directLoss: number;
  baselineN: number;
  directN: number;
};

export type HistoricalMetric = {
  name: string;
  value: string;
  detail: string;
  tone?: "good" | "warn" | "neutral";
};

export type PredictionFeatureRow = {
  stablePlayerId: string;
  features: Record<string, number>;
};

export type ModelPrediction = {
  stablePlayerId: string;
  value: number;
};

export type ForecastModelStatus = {
  status: "complete" | "failed";
  release?: string;
  featureVersion?: string;
  predictionCount?: number;
  predictionCallCount?: number;
  quantileCrossingCount?: number;
  quantileCrossingPlayerIds?: string[];
  negativePredictionCount?: number;
  negativePredictionPlayerIds?: string[];
  error?: string;
};

export type ForecastResultRow = {
  stablePlayerId: string;
  playerName: string;
  position: Exclude<Position, "DST">;
  team: string;
  opponent: string;
  gameId: string;
  season: number;
  week: number;
  sourceRowOrder: number;
  ecr: number;
  rankSd: number;
  rankSdMatch: "exact" | "nearest";
  csvProjection: number;
  rawProjection: RawProjectionFields;
  ffsimMean: number;
  ffsimP15: number;
  ffsimP50: number;
  ffsimP85: number;
  ffsimZeroRate: number;
  ffsimActiveRate: number;
  xgbP15: number | null;
  xgbP50?: number | null;
  xgbP85: number | null;
  floor: number;
  average: number;
  median: number;
  ceiling: number;
  rangeWidth: number;
  valueSources: RangeValueSources;
};

export type ForecastResultV2 = {
  schemaVersion: "forecast-result.v2";
  runId: string;
  uploadId: string;
  state: "Complete";
  metadata: {
    season: number;
    week: number;
    scoringContractVersion: string;
    metricDefinitionVersion: string;
    simulationCount: number;
    seed: number;
    modelRelease: string;
    rankReferenceSnapshot: string;
    sourceInputRevision: string;
    createdAt: string;
    completedAt: string;
    acceptedRowCount: number;
    excludedRowCount: number;
    positionCounts: Record<"QB" | "RB" | "WR" | "TE", number>;
    outputRowCount: number;
    rankRule: string;
    rankSourceOrder: "preserved";
  };
  modelStatus: {
    ffsimulator: ForecastModelStatus;
    xgbP85: ForecastModelStatus;
    xgbP15: ForecastModelStatus;
  };
  rows: ForecastResultRow[];
};

export type ForecastResultRowV3 = Omit<ForecastResultRow, "xgbP15" | "xgbP50" | "xgbP85"> & {
  xgbP15: number;
  xgbP50: number;
  xgbP85: number;
};

export type ForecastResultV3 = {
  schemaVersion: "forecast-result.v3";
  runId: string;
  uploadId: string;
  state: "Complete";
  metadata: {
    season: number;
    week: number;
    scoringFormat: string;
    scoringContractVersion: string;
    metricDefinitionVersion: string;
    simulationCount: number;
    seed: number;
    modelRelease: string;
    featureVersion: string;
    modelTarget: string;
    modelObjective: string;
    xgboostVersion: string;
    modelArtifactVersion: string;
    modelTrainingSeasons: readonly number[];
    validationResult: {
      walkForward: boolean;
      validationWeeks: readonly number[];
      selectedModelRecords: number;
    };
    predictionCallCount: number;
    quantileCrossingCount: number;
    quantileCrossingPlayerIds: readonly string[];
    negativePredictionCount: number;
    negativePredictionPlayerIds: readonly string[];
    quantileLevels: readonly [0.15, 0.5, 0.85];
    rangePolicyVersion: string;
    inferenceEndpoint: string;
    rankReferenceSnapshot: string;
    sourceInputRevision: string;
    createdAt: string;
    completedAt: string;
    acceptedRowCount: number;
    excludedRowCount: number;
    positionCounts: Record<"QB" | "RB" | "WR" | "TE", number>;
    outputRowCount: number;
    rankRule: string;
    rankSourceOrder: "preserved";
  };
  modelStatus: {
    ffsimulator: ForecastModelStatus;
    xgb: ForecastModelStatus;
  };
  rows: ForecastResultRowV3[];
};

export type ForecastResult = ForecastResultV2 | ForecastResultV3;

export type OverrideSet = {
  overrideSetId: string;
  runId: string;
  uploadId: string;
  sourceInputRevision: string;
  workspaceId: string;
  records: Record<string, OverrideSpec>;
  history: OverrideHistoryEntry[];
};
