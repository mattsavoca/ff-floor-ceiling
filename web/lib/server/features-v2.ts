import type { ParsedProjectionRow } from "@/lib/csv";
import type { PredictionFeatureRow } from "@/lib/types";
import type { RankedProjectionRow } from "./rank-reference";
import { FEATURE_VERSION, MODEL_POSITIONS, type ModelPosition } from "../model-release";

export const FEATURE_VERSION_V2 = FEATURE_VERSION;
export const MODEL_POSITIONS_V2 = MODEL_POSITIONS;

export const FEATURE_NAMES_BY_POSITION: Record<ModelPosition, readonly string[]> = {
  QB: [
    "week", "ecr", "pass-att", "pass-cmp", "pass-1d", "pass-int", "pass-sck", "pass-td", "pass-yds",
    "rush-car", "rush-1d", "rush-td", "rush-yds", "fum-lost", "projection_fpts",
  ],
  RB: [
    "week", "ecr", "pass-att", "pass-cmp", "pass-1d", "pass-int", "pass-td", "pass-yds", "rush-car",
    "rush-1d", "rush-td", "rush-yds", "rec-rec", "rec-tgt", "rec-td", "rec-yds", "fum-lost", "projection_fpts",
  ],
  WR: [
    "week", "ecr", "pass-int", "rush-car", "rush-1d", "rush-td", "rush-yds", "rec-rec", "rec-tgt", "rec-td",
    "rec-yds", "fum-lost", "projection_fpts",
  ],
  TE: [
    "week", "ecr", "rush-car", "rush-1d", "rush-td", "rush-yds", "rec-rec", "rec-tgt", "rec-td", "rec-yds",
    "fum-lost", "projection_fpts",
  ],
};

const featureAliases: Record<string, string[]> = {
  "pass-2pt": ["pass_2pt", "pass_two_point"],
  "pass-att": ["pass_att", "pass_attempts"],
  "pass-cmp": ["pass_cmp", "pass_completions"],
  "pass-1d": ["pass_1d", "pass_first_downs"],
  "pass-int": ["pass_int", "interceptions"],
  "pass-sck": ["pass_sck", "sacks"],
  "pass-td": ["pass_td", "pass_touchdowns"],
  "pass-yds": ["pass_yds", "pass_yards"],
  "rush-2pt": ["rush_2pt", "rush_two_point"],
  "rush-car": ["rush_car", "rush_attempts"],
  "rush-1d": ["rush_1d", "rush_first_downs"],
  "rush-td": ["rush_td", "rush_touchdowns"],
  "rush-yds": ["rush_yds", "rush_yards"],
  "rec-2pt": ["rec_2pt", "rec_two_point"],
  "rec-rec": ["rec_rec", "receptions", "rec"],
  "rec-tgt": ["rec_tgt", "targets"],
  "rec-td": ["rec_td", "rec_touchdowns"],
  "rec-yds": ["rec_yds", "rec_yards"],
  "fum-lost": ["fum_lost", "fumbles_lost"],
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

export type ServingFeatureRowV2 = PredictionFeatureRow & {
  row: RankedProjectionRow;
};

export function buildFeatureRowV2(row: RankedProjectionRow, week: number): ServingFeatureRowV2 {
  const position = row.position as ModelPosition;
  if (!MODEL_POSITIONS.includes(position)) throw new Error(`The v2 model does not support ${row.position}.`);
  const features: Record<string, number> = {};
  for (const feature of FEATURE_NAMES_BY_POSITION[position]) {
    if (feature === "week") features[feature] = week;
    else if (feature === "ecr") features[feature] = row.ecr;
    else if (feature === "projection_fpts") features[feature] = row.csvProjection;
    else features[feature] = rawValue(row, feature);
  }
  return { stablePlayerId: row.stablePlayerId, features, row };
}

export function buildFeatureRowsV2(rows: RankedProjectionRow[], week: number) {
  return rows.map((row) => buildFeatureRowV2(row, week));
}

export function groupServingFeaturesV2(rows: ServingFeatureRowV2[]) {
  const groups = new Map<string, ServingFeatureRowV2[]>();
  for (const row of rows) {
    const values = groups.get(row.row.position) ?? [];
    values.push(row);
    groups.set(row.row.position, values);
  }
  return groups;
}
