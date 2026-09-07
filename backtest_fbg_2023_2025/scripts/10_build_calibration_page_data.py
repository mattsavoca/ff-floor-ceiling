"""Build the calibration page data from validated PPR model artifacts."""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd


SCORING_FORMAT = "PPR"
SCORING_CONTRACT_VERSION = "ppr_v1"
POSITIONS = ("QB", "RB", "WR", "TE")
SEASONS = (2024, 2025)
OOS_WEEKS = (14, 15, 16, 17)
MODEL_LABELS = {"simulation_baseline": "ffsimulator", "xgb_projection": "XGBoost"}


def root() -> Path:
    return Path(__file__).resolve().parents[2]


def require_ppr(frame: pd.DataFrame, label: str) -> None:
    required = {"scoring_format", "scoring_contract_version"}
    missing = sorted(required.difference(frame.columns))
    if missing:
        raise ValueError(f"{label} is missing PPR metadata columns: {missing}")
    if set(frame["scoring_format"].dropna().astype(str)) != {SCORING_FORMAT}:
        raise ValueError(f"{label} is not a PPR artifact")
    if set(frame["scoring_contract_version"].dropna().astype(str)) != {SCORING_CONTRACT_VERSION}:
        raise ValueError(f"{label} does not use {SCORING_CONTRACT_VERSION}")


def metric(value: Any) -> Any:
    """Convert pandas and NumPy values to JSON-safe TypeScript values."""
    if value is None:
        return None
    if isinstance(value, (float, np.floating)):
        return None if not np.isfinite(value) else float(value)
    if isinstance(value, (int, np.integer)):
        return int(value)
    if isinstance(value, (bool, np.bool_)):
        return bool(value)
    return value


def clean(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): clean(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [clean(item) for item in value]
    return metric(value)


def p85_metrics(actual: np.ndarray, prediction: np.ndarray) -> dict[str, float | int | None]:
    actual = np.asarray(actual, dtype=float)
    prediction = np.asarray(prediction, dtype=float)
    above = actual > prediction
    residual = actual - prediction
    losses = np.where(residual >= 0.0, 0.85 * residual, -0.15 * residual)
    if len(prediction) > 1 and np.std(prediction) > 0.0:
        slope, intercept = np.polyfit(prediction, actual, 1)
    else:
        slope, intercept = np.nan, np.nan
    return {
        "n": int(len(actual)),
        "p85_coverage": float(np.mean(actual <= prediction)),
        "p85_pinball_loss": float(np.mean(losses)),
        "calibration_slope": float(slope),
        "calibration_intercept": float(intercept),
        "p85_mae": float(np.mean(np.abs(residual))),
        "p85_rmse": float(np.sqrt(np.mean(residual**2))),
        # This helper receives only an upper quantile. A lower-bound miss rate
        # is not identifiable without p15, so keep it explicitly unavailable.
        "low_side_miss_rate": np.nan,
        "high_side_miss_rate": float(np.mean(actual > prediction)),
        "mean_score_above_p85": float(np.mean(actual[above])) if above.any() else np.nan,
        "average_tail_excess": float(np.mean(residual[above])) if above.any() else np.nan,
        "n_above_p85": int(above.sum()),
        "p85_rank_spearman": float(pd.Series(actual).corr(pd.Series(prediction), method="spearman")),
    }


def choose_reference(group: pd.DataFrame) -> str:
    """Choose the reference model with a transparent coverage guard."""
    near = group[(group["p85_coverage"] - 0.85).abs() <= 0.05]
    candidates = near if not near.empty else group.assign(coverage_distance=(group["p85_coverage"] - 0.85).abs())
    if near.empty:
        return str(candidates.sort_values(["coverage_distance", "p85_pinball_loss", "model"]).iloc[0]["model"])
    return str(candidates.sort_values(["p85_pinball_loss", "model"]).iloc[0]["model"])


def row_from_metrics(row: pd.Series) -> dict[str, Any]:
    names = {
        "model": MODEL_LABELS[str(row["model"])],
        "season": int(row["season"]) if pd.notna(row["season"]) else None,
        "position": str(row["position"]) if pd.notna(row["position"]) else "ALL",
        "sampleCount": int(row["n"]),
        "p15Coverage": row.get("p15_coverage"),
        "p50Coverage": row.get("p50_coverage"),
        "p85Coverage": row.get("p85_coverage"),
        "intervalCoverage": row.get("interval_coverage"),
        "p15ToP85IntervalCoverage": row.get("p15_to_p85_interval_coverage"),
        "p85PinballLoss": row.get("p85_pinball_loss"),
        "calibrationSlope": row.get("calibration_slope"),
        "calibrationIntercept": row.get("calibration_intercept"),
        "p50Mae": row.get("p50_mae"),
        "p50Rmse": row.get("p50_rmse"),
        "p85Mae": row.get("p85_mae"),
        "p85Rmse": row.get("p85_rmse"),
        "lowSideMissRate": row.get("low_side_miss_rate"),
        "highSideMissRate": row.get("high_side_miss_rate"),
        "meanScoreAboveP85": row.get("mean_score_above_p85"),
        "averageTailExcess": row.get("average_tail_excess"),
        "sampleCountAboveP85": row.get("n_above_p85"),
        "predictedMeanAboveP85": row.get("predicted_mean_above_p85"),
        "predictedAverageTailExcess": row.get("predicted_average_tail_excess"),
        "rankSpearman": row.get("p85_rank_spearman"),
        "scoringFormat": SCORING_FORMAT,
    }
    return clean(names)


def build_data() -> dict[str, Any]:
    backtest = root() / "backtest_fbg_2023_2025"
    output = backtest / "outputs"
    xgb_output = output / "xgb_p85_projection"
    ffsim_metadata = json.loads((output / "player_backtest_metadata.json").read_text(encoding="utf-8"))
    xgb_metadata = json.loads((xgb_output / "metadata.json").read_text(encoding="utf-8"))

    player = pd.read_parquet(output / "player_predictions.parquet")
    require_ppr(player, "ffsimulator player predictions")
    player = player[player["season"].isin(SEASONS)].copy()
    if set(player["season"].unique()) != set(SEASONS):
        raise ValueError("The page requires held-out ffsimulator rows for 2024 and 2025.")

    xgb_predictions = pd.read_parquet(xgb_output / "predictions.parquet")
    require_ppr(xgb_predictions, "XGBoost predictions")
    xgb_predictions = xgb_predictions[xgb_predictions["season"].isin(SEASONS)].copy()
    expected_keys = ["season", "week", "fbg_id", "position"]
    check = player.merge(
        xgb_predictions[expected_keys + ["baseline_p15", "baseline_p50", "baseline_p85"]],
        on=expected_keys,
        how="inner",
        validate="one_to_one",
    )
    for left, right in (("p15", "baseline_p15"), ("p50", "baseline_p50"), ("p85", "baseline_p85")):
        difference = (check[left] - check[right]).abs().max()
        if not np.isfinite(difference) or difference > 1e-8:
            raise ValueError(f"The XGBoost page join does not match ffsimulator {left} values.")

    metrics = pd.read_csv(xgb_output / "metrics.csv")
    require_ppr(metrics, "XGBoost metrics")
    metrics = metrics[metrics["group"].eq("season_position")].copy()
    metrics = metrics[metrics["season"].isin(SEASONS) & metrics["position"].isin(POSITIONS)]
    expected_models = {"simulation_baseline", "xgb_projection"}
    if set(metrics["model"].unique()) != expected_models:
        raise ValueError("The scorecard must contain both PPR models.")

    overall = pd.read_csv(xgb_output / "metrics.csv")
    overall = overall[overall["group"].eq("all")]
    overall = overall[overall["model"].isin(expected_models)]

    position_metrics = pd.read_csv(xgb_output / "metrics.csv")
    position_metrics = position_metrics[
        position_metrics["group"].eq("position") & position_metrics["position"].isin(POSITIONS)
    ].copy()
    selected_by_position = {
        position: MODEL_LABELS[choose_reference(group)]
        for position, group in position_metrics.groupby("position", sort=True)
    }

    selection_rows = []
    for position in POSITIONS:
        group = position_metrics[position_metrics["position"].eq(position)].copy()
        group = group.set_index("model")
        selected_model = selected_by_position[position]
        selected_key = next(key for key, label in MODEL_LABELS.items() if label == selected_model)
        selected = group.loc[selected_key]
        row = {
            "position": position,
            "n": int(selected["n"]),
            "selectedModel": selected_model,
            "selectedVersion": "ppr_v1",
            "selectedCoverage": selected["p85_coverage"],
            "selectedPinballLoss": selected["p85_pinball_loss"],
            "selectedP85Mae": selected["p85_mae"],
            "selectedP85Rmse": selected["p85_rmse"],
            "selectedHighSideMissRate": selected["high_side_miss_rate"],
            "selectedAverageTailExcess": selected["average_tail_excess"],
            "selectedRankSpearman": selected["p85_rank_spearman"],
        }
        for key, label in MODEL_LABELS.items():
            source = group.loc[key]
            prefix = "ffsimulator" if label == "ffsimulator" else "xgb"
            row[f"{prefix}Coverage"] = source["p85_coverage"]
            row[f"{prefix}PinballLoss"] = source["p85_pinball_loss"]
            row[f"{prefix}RankSpearman"] = source["p85_rank_spearman"]
        selection_rows.append(clean(row))

    selected_row_parts = []
    for position, model in selected_by_position.items():
        subset = xgb_predictions[xgb_predictions["position"].eq(position)].copy()
        prediction_column = "baseline_p85" if model == "ffsimulator" else "xgb_p85"
        selected_row_parts.append(subset[["actual_score", prediction_column]].rename(columns={prediction_column: "prediction"}))
    selected_rows = pd.concat(selected_row_parts, ignore_index=True)
    selected_overall = p85_metrics(
        selected_rows["actual_score"].to_numpy(), selected_rows["prediction"].to_numpy()
    )

    weekly = xgb_predictions[
        xgb_predictions["season"].eq(2025) & xgb_predictions["week"].isin(OOS_WEEKS)
    ].copy()
    if set(weekly["week"].unique()) != set(OOS_WEEKS):
        raise ValueError("The page requires 2025 OOS rows for Weeks 14 through 17.")

    weekly_position_metrics = []
    for (week, position), group in weekly.groupby(["week", "position"], sort=True):
        position_name = str(position)
        selected_model = selected_by_position[position_name]
        prediction_column = "baseline_p85" if selected_model == "ffsimulator" else "xgb_p85"
        values = p85_metrics(
            group["actual_score"].to_numpy(), group[prediction_column].to_numpy()
        )
        weekly_position_metrics.append(
            clean(
                {
                    "season": 2025,
                    "week": int(week),
                    "position": position_name,
                    "model": selected_model,
                    "n": values["n"],
                    "coverage": values["p85_coverage"],
                    "pinballLoss": values["p85_pinball_loss"],
                    "p85Mae": values["p85_mae"],
                    "p85Rmse": values["p85_rmse"],
                    "highSideMissRate": values["high_side_miss_rate"],
                    "meanScoreAboveP85": values["mean_score_above_p85"],
                    "averageTailExcess": values["average_tail_excess"],
                    "nAboveP85": values["n_above_p85"],
                    "rankSpearman": values["p85_rank_spearman"],
                    "scoringFormat": SCORING_FORMAT,
                }
            )
        )
    if len(weekly_position_metrics) != len(OOS_WEEKS) * len(POSITIONS):
        raise ValueError("The page requires one selected model row for every OOS week and position.")

    weekly_summaries = []
    for week, group in weekly.groupby("week", sort=True):
        selected_parts = []
        for position, selected_model in selected_by_position.items():
            prediction_column = "baseline_p85" if selected_model == "ffsimulator" else "xgb_p85"
            selected_parts.append(
                group[group["position"].eq(position)][["actual_score", prediction_column]].rename(
                    columns={prediction_column: "prediction"}
                )
            )
        selected_week = pd.concat(selected_parts, ignore_index=True)
        values = p85_metrics(
            selected_week["actual_score"].to_numpy(), selected_week["prediction"].to_numpy()
        )
        weekly_summaries.append(
            clean(
                {
                    "season": 2025,
                    "week": int(week),
                    "n": values["n"],
                    "coverage": values["p85_coverage"],
                    "pinballLoss": values["p85_pinball_loss"],
                    "p85Mae": values["p85_mae"],
                    "p85Rmse": values["p85_rmse"],
                    "highSideMissRate": values["high_side_miss_rate"],
                    "meanScoreAboveP85": values["mean_score_above_p85"],
                    "averageTailExcess": values["average_tail_excess"],
                    "nAboveP85": values["n_above_p85"],
                    "rankSpearman": values["p85_rank_spearman"],
                    "scoringFormat": SCORING_FORMAT,
                }
            )
        )

    bins = pd.read_csv(xgb_output / "p85_calibration.csv")
    require_ppr(bins, "XGBoost p85 calibration")
    bins = bins[bins["n"].ge(30)].copy()
    bins["model"] = bins["model"].map(MODEL_LABELS)
    calibration_bins = [
        clean(
            {
                "season": int(row.season),
                "position": str(row.position),
                "model": str(row.model),
                "bin": int(row.p85_bin),
                "n": int(row.n),
                "predicted": row.predicted_p85,
                "observed": row.observed_p85,
                "scoringFormat": SCORING_FORMAT,
            }
        )
        for row in bins.itertuples(index=False)
    ]
    selected_bins = [
        row for row in calibration_bins
        if selected_by_position[row["position"]] == row["model"]
    ]

    fits = pd.read_csv(xgb_output / "selected_models.csv")
    if set(fits["position"].unique()) != set(POSITIONS) or len(fits) != 8:
        raise ValueError("The page requires eight PPR XGBoost fits, one per position and target season.")
    model_fits = []
    training_rows_by_model = {
        (int(record["target_season"]), str(record["position"])): int(record["training_rows"])
        for record in xgb_metadata["model_records"]
    }
    for row in fits.sort_values(["target_season", "position"]).itertuples(index=False):
        training = [part for part in str(row.training_seasons).split(",") if part]
        model_fits.append(
            clean(
                {
                    "targetSeason": int(row.target_season),
                    "position": str(row.position),
                    "trainingSeasons": " and ".join(training),
                    "trainingRows": training_rows_by_model[(int(row.target_season), str(row.position))],
                    "featureCount": int(row.feature_count),
                    "maxDepth": int(row.max_depth),
                    "minChildWeight": float(row.min_child_weight),
                    "subsample": float(row.subsample),
                    "learningRate": float(row.learning_rate),
                    "rounds": int(row.boosting_rounds),
                    "scoringFormat": SCORING_FORMAT,
                }
            )
        )

    scorecard = [row_from_metrics(row) for _, row in metrics.iterrows()]
    overall_rows = [row_from_metrics(row) for _, row in overall.iterrows()]
    season_summaries = []
    for season, group in metrics.groupby("season", sort=True):
        selected_group = group[
            group.apply(lambda row: MODEL_LABELS[row["model"]] == selected_by_position[row["position"]], axis=1)
        ]
        season_summaries.append(
            clean(
                {
                    "season": int(season),
                    "n": int(selected_group["n"].sum()),
                    "coverage": np.average(
                        selected_group["p85_coverage"], weights=selected_group["n"]
                    ),
                    "pinballLoss": np.average(
                        selected_group["p85_pinball_loss"], weights=selected_group["n"]
                    ),
                }
            )
        )

    if ffsim_metadata.get("scoring_format") != SCORING_FORMAT or xgb_metadata.get("scoring_format") != SCORING_FORMAT:
        raise ValueError("Model metadata does not use PPR.")

    run_date = date.today().strftime("%b %d, %Y").replace(" 0", " ")
    return clean(
        {
            "selectedModelByPosition": selected_by_position,
            "calibrationModel": {
                "displayName": "Validated PPR offensive models",
                "shortName": "PPR model calibration",
                "version": "ppr_v1 · sim-2026.1 · xgb_p85_projection",
                "status": "Validated PPR outputs",
                "owner": "Matt Savoca",
                "runDate": run_date,
                "algorithm": "ffsimulator + XGBoost",
                "objective": "Estimate weekly PPR scores and the p85 ceiling",
                "target": "85th percentile of weekly PPR points",
                "oosRows": selected_overall["n"],
                "oosSeasons": "2024 and 2025",
                "positionModels": 4,
                "xgboostFits": 8,
                "calibrationMethod": "Held-out season comparison by position",
                "scoringFormat": SCORING_FORMAT,
                "scoringRules": [
                    "1 point per reception",
                    "no tight-end reception bonus",
                    "no receiving first-down points",
                ],
                "maxHistoricalSeasonUsed": max(
                    int(ffsim_metadata["target_history"][0]["max_historical_season"]),
                    int(xgb_metadata["max_historical_season_used"]),
                ),
            },
            "ffsimulatorModel": {
                "name": "ffsimulator",
                "version": "ppr_v1 · rank-conditioned simulation",
                "algorithm": "Rank-conditioned simulation",
                "output": "Full p15 floor, p50 middle estimate, and p85 ceiling",
                "simulations": int(ffsim_metadata["simulation_settings"]["n_simulations"]),
                "input": "Earlier-season PPR outcome pools",
            },
            "selectedPortfolioOverall": {
                "n": selected_overall["n"],
                "coverage": selected_overall["p85_coverage"],
                "pinballLoss": selected_overall["p85_pinball_loss"],
                "p85Mae": selected_overall["p85_mae"],
                "p85Rmse": selected_overall["p85_rmse"],
                "highSideMissRate": selected_overall["high_side_miss_rate"],
                "meanScoreAboveP85": selected_overall["mean_score_above_p85"],
                "averageTailExcess": selected_overall["average_tail_excess"],
                "nAboveP85": selected_overall["n_above_p85"],
                "rankSpearman": selected_overall["p85_rank_spearman"],
            },
            "positionModelSelections": selection_rows,
            "scorecardMetrics": scorecard,
            "overallMetrics": overall_rows,
            "oosSeasonPositionMetrics": [
                clean(
                    {
                        "season": int(row["season"]),
                        "position": str(row["position"]),
                        "n": int(row["n"]),
                        "coverage": row["p85_coverage"],
                        "pinballLoss": row["p85_pinball_loss"],
                        "rankSpearman": row["p85_rank_spearman"],
                        "selectedModel": selected_by_position[str(row["position"])],
                        "selectedCoverage": row["p85_coverage"],
                        "selectedPinballLoss": row["p85_pinball_loss"],
                        "selectedRankSpearman": row["p85_rank_spearman"],
                        "intervalCoverage": row.get("interval_coverage"),
                        "scoringFormat": SCORING_FORMAT,
                    }
                )
                for _, row in metrics.iterrows()
                if MODEL_LABELS[str(row["model"])] == selected_by_position[str(row["position"])]
            ],
            "oosSeasonSummaries": season_summaries,
            "oosWeeklyPositionMetrics": weekly_position_metrics,
            "oosWeeklySummaries": weekly_summaries,
            "modelFits": model_fits,
            "featureFamilies": [
                {"name": "Rank summaries", "detail": "Week, consensus rank, rank spread, projector count, and rank limits."},
                {"name": "Stat projections", "detail": "Passing, rushing, receiving, and fumble projections from Footballguys."},
                {"name": "Derived PPR score", "detail": "Projected stats converted to PPR points with one point per reception."},
            ],
            "calibrationBinMinimum": 30,
            "calibrationBins": calibration_bins,
            "selectedCalibrationBins": selected_bins,
            "oosOverall": overall_rows[-1] if overall_rows else {},
            "baselineOverall": next(
                row for row in overall_rows if row["model"] == "ffsimulator"
            ),
            "oosPositionSummaries": selection_rows,
            "scoringContract": {
                "format": SCORING_FORMAT,
                "version": SCORING_CONTRACT_VERSION,
                "rules": [
                    "1 point per reception",
                    "no tight-end reception bonus",
                    "no receiving first-down points",
                ],
            },
        }
    )


def write_typescript(data: dict[str, Any]) -> None:
    target = root() / "web" / "lib" / "calibration-data.ts"
    lines = [
        "// Generated by backtest_fbg_2023_2025/scripts/10_build_calibration_page_data.py.",
        "// Do not edit the metric values by hand. Rebuild them from validated PPR artifacts.",
        "",
        'export type CalibrationPosition = "QB" | "RB" | "WR" | "TE";',
        'export type CalibrationSeason = 2024 | 2025;',
        'export type CalibrationModelKey = "ffsimulator" | "XGBoost";',
        "",
    ]
    exports = [
        "selectedModelByPosition",
        "calibrationModel",
        "ffsimulatorModel",
        "selectedPortfolioOverall",
        "positionModelSelections",
        "scorecardMetrics",
        "overallMetrics",
        "oosSeasonPositionMetrics",
        "oosSeasonSummaries",
        "oosWeeklyPositionMetrics",
        "oosWeeklySummaries",
        "modelFits",
        "featureFamilies",
        "calibrationBinMinimum",
        "calibrationBins",
        "selectedCalibrationBins",
        "oosOverall",
        "baselineOverall",
        "oosPositionSummaries",
        "scoringContract",
    ]
    for name in exports:
        value = json.dumps(data[name], indent=2, ensure_ascii=False, allow_nan=False)
        lines.append(f"export const {name} = {value} as const;")
        lines.append("")
    target.write_text("\n".join(lines), encoding="utf-8")


if __name__ == "__main__":
    write_typescript(build_data())
