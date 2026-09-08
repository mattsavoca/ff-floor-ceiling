export const MODEL_RELEASE = "forecast-ppr-v2";
export const FEATURE_VERSION = "fbg_rank_projection_v2";
export const MODEL_TARGET = "actual_score";
export const MODEL_OBJECTIVE = "reg:quantileerror";
export const XGBOOST_VERSION = "3.4.1";
export const SCORING_FORMAT = "PPR";
export const SCORING_CONTRACT_VERSION = "ppr_v1";
export const METRIC_DEFINITION_VERSION = "ppr_v1_projection_formula";
export const MODEL_ARTIFACT_VERSION = "xgb_v2_quantile_20260907";
export const RESULT_SCHEMA_VERSION = "forecast-result.v3";
export const RANGE_POLICY_VERSION = "direct_xgb_quantiles_v1";
export const MODEL_ENDPOINT_PATH = "/v2/models/predict";
export const QUANTILE_LEVELS = [0.15, 0.5, 0.85] as const;
export const MODEL_POSITIONS = ["QB", "RB", "WR", "TE"] as const;
export const MODEL_TRAINING_SEASONS = [2023, 2024, 2025] as const;
export const MODEL_VALIDATION_RESULT = {
  walkForward: true,
  validationWeeks: [14, 15, 16, 17],
  selectedModelRecords: 8,
} as const;

export type ModelPosition = (typeof MODEL_POSITIONS)[number];
