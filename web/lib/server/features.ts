import type { ParsedProjectionRow } from "@/lib/csv";
import type { PredictionFeatureRow } from "@/lib/types";
import type { RankedProjectionRow } from "./rank-reference";

export const FEATURE_VERSION = "fbg_rank_projection_v1";
export const MODEL_POSITIONS = ["RB", "WR", "TE"] as const;

const rawFeatureFields = [
  "pass_2pt", "pass_att", "pass_cmp", "pass_1d", "pass_int", "pass_sck", "pass_td", "pass_yds",
  "rush_2pt", "rush_car", "rush_1d", "rush_td", "rush_yds", "rec_2pt", "rec_rec", "rec_tgt", "rec_td", "rec_yds", "fum_lost",
] as const;

const featureAliases: Record<string, string[]> = {
  "pass-2pt": ["pass_2pt"],
  "pass-att": ["pass_att"],
  "pass-cmp": ["pass_cmp"],
  "pass-1d": ["pass_1d"],
  "pass-int": ["pass_int"],
  "pass-sck": ["pass_sck"],
  "pass-td": ["pass_td"],
  "pass-yds": ["pass_yds"],
  "rush-2pt": ["rush_2pt"],
  "rush-car": ["rush_car"],
  "rush-1d": ["rush_1d"],
  "rush-td": ["rush_td"],
  "rush-yds": ["rush_yds"],
  "rec-2pt": ["rec_2pt"],
  "rec-rec": ["rec_rec"],
  "rec-tgt": ["rec_tgt"],
  "rec-td": ["rec_td"],
  "rec-yds": ["rec_yds"],
  "fum-lost": ["fum_lost"],
};

function rawValue(row: ParsedProjectionRow, feature: string) {
  const aliases = featureAliases[feature] ?? [feature.replaceAll("-", "_")];
  for (const alias of aliases) {
    if (Object.prototype.hasOwnProperty.call(row.raw, alias)) {
      const value = row.raw[alias];
      if (value === "") return 0;
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) throw new Error(`The feature ${feature} is not numeric for ${row.stablePlayerId}.`);
      return numeric;
    }
  }
  throw new MissingFeatureError(feature, row.stablePlayerId);
}

export class MissingFeatureError extends Error {
  readonly field: string;
  readonly stablePlayerId: string;

  constructor(field: string, stablePlayerId: string) {
    super(`The feature ${field} is missing for ${stablePlayerId}.`);
    this.name = "MissingFeatureError";
    this.field = field;
    this.stablePlayerId = stablePlayerId;
  }
}

export type ServingFeatureRow = PredictionFeatureRow & {
  row: RankedProjectionRow;
};

export function buildFeatureRow(row: RankedProjectionRow, week: number): ServingFeatureRow {
  const features: Record<string, number> = {
    week,
    ecr: row.ecr,
    rank_sd: row.rankSd,
    n_projectors: 1,
    rank_min: row.ecr,
    rank_max: row.ecr,
    consensus_rank: row.ecr,
    consensus_projected_score: row.csvProjection,
    projection_fpts: row.csvProjection,
  };
  for (const field of rawFeatureFields) {
    const modelName = field.replaceAll("_", "-");
    features[modelName] = rawValue(row, modelName);
  }
  return { stablePlayerId: row.stablePlayerId, features, row };
}

export function buildFeatureRows(rows: RankedProjectionRow[], week: number) {
  return rows.map((row) => buildFeatureRow(row, week));
}

export function groupServingFeatures(rows: ServingFeatureRow[]) {
  const groups = new Map<string, ServingFeatureRow[]>();
  for (const row of rows) {
    const values = groups.get(row.row.position) ?? [];
    values.push(row);
    groups.set(row.row.position, values);
  }
  return groups;
}
