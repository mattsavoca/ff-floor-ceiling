export type TabId = "overview" | "methodology" | "calibration" | "projection" | "overrides";
export type Position = "QB" | "RB" | "WR" | "TE" | "DST";
export type ViewMode = "original" | "adjusted";

export type RangeValues = {
  floor: number;
  median: number;
  ceiling: number;
};

export type ForecastRow = {
  id: string;
  name: string;
  position: Position;
  team: string;
  opponent: string;
  game: string;
  sourceProjection: number;
  original: RangeValues;
  nSimulations: number;
  hasDraws: boolean;
  actual?: number;
};

export type OverrideSpec = {
  factor: number;
  inactive: boolean;
  exclude: boolean;
  defensePreset: boolean;
  analystProjection?: number;
  edits: Partial<RangeValues>;
  reason: string;
  savedAt: string;
  revision: number;
};

export type UploadReport = {
  fileName: string;
  sourceTimestamp: string;
  rows: number;
  accepted: number;
  excluded: number;
  unresolved: number;
  selectedSet: string;
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
