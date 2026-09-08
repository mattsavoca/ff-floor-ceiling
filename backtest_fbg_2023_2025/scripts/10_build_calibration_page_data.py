"""Build the web calibration data from the released v2 comparison artifact."""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd


SCORING_FORMAT = "PPR"
SCORING_CONTRACT_VERSION = "ppr_v1"
MODEL_RELEASE = "forecast-ppr-v2"
ARTIFACT_VERSION = "xgb_v2_quantile_20260907"
POSITIONS = ("QB", "RB", "WR", "TE")
SEASONS = (2024, 2025)
OOS_WEEKS = (14, 15, 16, 17)
MODEL_COLUMNS = {
    "ffsimulator": ("ffsim_p15", "ffsim_p50", "ffsim_p85"),
    "XGBoost": ("xgb_p15", "xgb_p50", "xgb_p85"),
}


def root() -> Path:
    return Path(__file__).resolve().parents[2]


def clean(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): clean(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [clean(item) for item in value]
    if value is None:
        return None
    if isinstance(value, (float, np.floating)):
        return None if not np.isfinite(value) else float(value)
    if isinstance(value, (int, np.integer)):
        return int(value)
    if isinstance(value, (bool, np.bool_)):
        return bool(value)
    return value


def require_ppr(frame: pd.DataFrame, label: str) -> None:
    required = {"scoring_format", "scoring_contract_version"}
    missing = sorted(required.difference(frame.columns))
    if missing:
        raise ValueError(f"{label} is missing PPR metadata columns: {missing}")
    if set(frame["scoring_format"].dropna().astype(str)) != {SCORING_FORMAT}:
        raise ValueError(f"{label} is not a PPR artifact")
    if set(frame["scoring_contract_version"].dropna().astype(str)) != {SCORING_CONTRACT_VERSION}:
        raise ValueError(f"{label} does not use {SCORING_CONTRACT_VERSION}")


def model_frame(frame: pd.DataFrame, model: str) -> pd.DataFrame:
    p15, p50, p85 = MODEL_COLUMNS[model]
    selected = frame[["actual_score", p15, p50, p85]].copy()
    return selected.rename(columns={p15: "p15", p50: "p50", p85: "p85"})


def model_metrics(frame: pd.DataFrame, model: str) -> dict[str, Any]:
    values = model_frame(frame, model)
    return normalized_metrics(values, model)


def normalized_metrics(values: pd.DataFrame, model: str) -> dict[str, Any]:
    actual = values["actual_score"].to_numpy(dtype=float)
    p15 = values["p15"].to_numpy(dtype=float)
    p50 = values["p50"].to_numpy(dtype=float)
    p85 = values["p85"].to_numpy(dtype=float)
    if len(actual) == 0:
        raise ValueError(f"Cannot calculate empty metrics for {model}")
    residual = actual - p50
    p15_loss = np.where(actual >= p15, 0.15 * (actual - p15), 0.85 * (p15 - actual))
    p50_loss = np.abs(residual) * 0.5
    p85_loss = np.where(actual >= p85, 0.85 * (actual - p85), 0.15 * (p85 - actual))
    above = actual > p85
    below = actual < p15
    if len(actual) > 1 and np.std(p85) > 0:
        p85_slope, p85_intercept = np.polyfit(p85, actual, 1)
    else:
        p85_slope, p85_intercept = np.nan, np.nan
    if len(actual) > 1 and np.std(p15) > 0:
        p15_slope, p15_intercept = np.polyfit(p15, actual, 1)
    else:
        p15_slope, p15_intercept = np.nan, np.nan
    return clean(
        {
            "model": model,
            "n": len(actual),
            "p15_coverage": np.mean(actual <= p15),
            "p50_coverage": np.mean(actual <= p50),
            "p85_coverage": np.mean(actual <= p85),
            "p15_pinball_loss": np.mean(p15_loss),
            "p50_pinball_loss": np.mean(p50_loss),
            "p85_pinball_loss": np.mean(p85_loss),
            "p50_mae": np.mean(np.abs(residual)),
            "p50_rmse": np.sqrt(np.mean(residual**2)),
            "p50_bias": np.mean(p50 - actual),
            "p15_mae": np.mean(np.abs(actual - p15)),
            "p15_rmse": np.sqrt(np.mean((actual - p15) ** 2)),
            "p85_mae": np.mean(np.abs(actual - p85)),
            "p85_rmse": np.sqrt(np.mean((actual - p85) ** 2)),
            "interval_coverage": np.mean((actual >= p15) & (actual <= p85)),
            "interval_width": np.mean(p85 - p15),
            "quantile_crossing_count": int(np.sum((p15 > p50) | (p50 > p85))),
            "p15_bias": np.mean(p15 - actual),
            "p15_slope": p15_slope,
            "p15_intercept": p15_intercept,
            "p85_slope": p85_slope,
            "p85_intercept": p85_intercept,
            "low_side_miss_rate": np.mean(below),
            "high_side_miss_rate": np.mean(above),
            "mean_below_p15": np.mean(actual[below]) if below.any() else np.nan,
            "p15_tail_excess": np.mean(p15[below] - actual[below]) if below.any() else np.nan,
            "n_below_p15": int(below.sum()),
            "mean_score_above_p85": np.mean(actual[above]) if above.any() else np.nan,
            "average_tail_excess": np.mean(actual[above] - p85[above]) if above.any() else np.nan,
            "n_above_p85": int(above.sum()),
            "rank_spearman": pd.Series(actual).corr(pd.Series(p50), method="spearman"),
        }
    )


def display_metric_row(values: dict[str, Any], season: int | None, position: str) -> dict[str, Any]:
    return clean(
        {
            "model": values["model"],
            "season": season,
            "position": position,
            "sampleCount": values["n"],
            "p15Coverage": values["p15_coverage"],
            "p50Coverage": values["p50_coverage"],
            "p85Coverage": values["p85_coverage"],
            "intervalCoverage": values["interval_coverage"],
            "p15ToP85IntervalCoverage": values["interval_coverage"],
            "p15PinballLoss": values["p15_pinball_loss"],
            "p50PinballLoss": values["p50_pinball_loss"],
            "p85PinballLoss": values["p85_pinball_loss"],
            "calibrationSlope": values["p85_slope"],
            "calibrationIntercept": values["p85_intercept"],
            "p15CalibrationSlope": values["p15_slope"],
            "p15CalibrationIntercept": values["p15_intercept"],
            "p50Mae": values["p50_mae"],
            "p50Rmse": values["p50_rmse"],
            "p50Bias": values["p50_bias"],
            "p15Mae": values["p15_mae"],
            "p15Rmse": values["p15_rmse"],
            "p85Mae": values["p85_mae"],
            "p85Rmse": values["p85_rmse"],
            "lowSideMissRate": values["low_side_miss_rate"],
            "highSideMissRate": values["high_side_miss_rate"],
            "meanBelowP15": values["mean_below_p15"],
            "meanScoreBelowP15": values["mean_below_p15"],
            "p15TailExcess": values["p15_tail_excess"],
            "averageTailExcess": values["average_tail_excess"],
            "sampleCountBelowP15": values["n_below_p15"],
            "meanScoreAboveP85": values["mean_score_above_p85"],
            "sampleCountAboveP85": values["n_above_p85"],
            "rankSpearman": values["rank_spearman"],
            "scoringFormat": SCORING_FORMAT,
        }
    )


def records_for_scopes(frame: pd.DataFrame) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    scopes: list[tuple[str, int | None, str | None, pd.DataFrame]] = [("overall", None, None, frame)]
    scopes.extend(("position", None, position, frame[frame["position"].eq(position)]) for position in POSITIONS)
    scopes.extend(("season", int(season), None, frame[frame["season"].eq(season)]) for season in SEASONS)
    scopes.extend(
        ("season_position", int(season), position, frame[frame["season"].eq(season) & frame["position"].eq(position)])
        for season in SEASONS
        for position in POSITIONS
    )
    top = frame[frame["is_top_projected"].astype(bool)]
    scopes.append(("top_projected", None, None, top))
    scopes.extend(("top_projected_position", None, position, top[top["position"].eq(position)]) for position in POSITIONS)
    for scope, season, position, group in scopes:
        if group.empty:
            continue
        for model in MODEL_COLUMNS:
            values = model_metrics(group, model)
            values.update({"scope": scope, "season": season, "position": position or "ALL"})
            records.append(values)
    return records


def index_metrics(records: list[dict[str, Any]], scope: str) -> dict[tuple[int | None, str], dict[str, Any]]:
    return {
        (record["season"], record["position"]): record
        for record in records
        if record["scope"] == scope
    }


def select_model(position_records: dict[str, dict[str, Any]], metric_name: str) -> str:
    return min(position_records, key=lambda model: (position_records[model][metric_name], model))


def selection_row(position: str, values: dict[str, dict[str, Any]], quantile: str, selected_model: str) -> dict[str, Any]:
    selected = values[selected_model]
    prefix = "p85" if quantile == "p85" else "p15"
    return clean(
        {
            "position": position,
            "n": selected["n"],
            "selectedModel": selected_model,
            "selectedVersion": ARTIFACT_VERSION,
            "selectedCoverage": selected[f"{prefix}_coverage"],
            "selectedPinballLoss": selected[f"{prefix}_pinball_loss"],
            f"selected{prefix.upper()}Mae": selected[f"{prefix}_mae"],
            f"selected{prefix.upper()}Rmse": selected[f"{prefix}_rmse"],
            "selectedHighSideMissRate": selected["high_side_miss_rate"],
            "selectedLowSideMissRate": selected["low_side_miss_rate"],
            "selectedAverageTailExcess": selected["average_tail_excess"],
            "selectedP15TailExcess": selected["p15_tail_excess"],
            "selectedMeanBelowP15": selected["mean_below_p15"],
            "selectedRankSpearman": selected["rank_spearman"],
            "ffsimulatorCoverage": values["ffsimulator"][f"{prefix}_coverage"],
            "ffsimulatorPinballLoss": values["ffsimulator"][f"{prefix}_pinball_loss"],
            "ffsimulatorRankSpearman": values["ffsimulator"]["rank_spearman"],
            "xgbCoverage": values["XGBoost"][f"{prefix}_coverage"],
            "xgbPinballLoss": values["XGBoost"][f"{prefix}_pinball_loss"],
            "xgbRankSpearman": values["XGBoost"]["rank_spearman"],
        }
    )


def selected_overall(frame: pd.DataFrame, selections: dict[str, str]) -> dict[str, Any]:
    parts = []
    for position, model in selections.items():
        subset = frame[frame["position"].eq(position)]
        parts.append(model_frame(subset, model))
    return normalized_metrics(pd.concat(parts, ignore_index=True), "selected mix")


def weekly_data(frame: pd.DataFrame, selections: dict[str, str], quantile: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    weekly = frame[frame["season"].eq(2025) & frame["week"].isin(OOS_WEEKS)].copy()
    if set(weekly["week"].unique()) != set(OOS_WEEKS):
        raise ValueError("Calibration data requires 2025 Weeks 14 through 17.")
    position_rows = []
    for week in OOS_WEEKS:
        for position in POSITIONS:
            group = weekly[weekly["week"].eq(week) & weekly["position"].eq(position)]
            values = model_metrics(group, selections[position])
            position_rows.append(
                clean(
                    {
                        "season": 2025,
                        "week": week,
                        "position": position,
                        "model": selections[position],
                        "n": values["n"],
                        "coverage": values[f"{quantile}_coverage"],
                        "pinballLoss": values[f"{quantile}_pinball_loss"],
                        "p15Mae": values["p15_mae"],
                        "p15Rmse": values["p15_rmse"],
                        "p85Mae": values["p85_mae"],
                        "p85Rmse": values["p85_rmse"],
                        "lowSideMissRate": values["low_side_miss_rate"],
                        "highSideMissRate": values["high_side_miss_rate"],
                        "meanBelowP15": values["mean_below_p15"],
                        "p15TailExcess": values["p15_tail_excess"],
                        "meanScoreAboveP85": values["mean_score_above_p85"],
                        "averageTailExcess": values["average_tail_excess"],
                        "nBelowP15": values["n_below_p15"],
                        "nAboveP85": values["n_above_p85"],
                        "rankSpearman": values["rank_spearman"],
                        "scoringFormat": SCORING_FORMAT,
                    }
                )
            )
    summaries = []
    for week in OOS_WEEKS:
        selected_parts = []
        group = weekly[weekly["week"].eq(week)]
        for position, model in selections.items():
            selected_parts.append(model_frame(group[group["position"].eq(position)], model))
        values = normalized_metrics(pd.concat(selected_parts, ignore_index=True), "selected mix")
        summaries.append(
            clean(
                {
                    "season": 2025,
                    "week": week,
                    "n": values["n"],
                    "coverage": values[f"{quantile}_coverage"],
                    "pinballLoss": values[f"{quantile}_pinball_loss"],
                    "p15Mae": values["p15_mae"],
                    "p85Mae": values["p85_mae"],
                    "lowSideMissRate": values["low_side_miss_rate"],
                    "highSideMissRate": values["high_side_miss_rate"],
                    "rankSpearman": values["rank_spearman"],
                    "scoringFormat": SCORING_FORMAT,
                }
            )
        )
    return position_rows, summaries


def calibration_bins(frame: pd.DataFrame) -> list[dict[str, Any]]:
    bins: list[dict[str, Any]] = []
    for model, (_, _, p85) in MODEL_COLUMNS.items():
        for season in SEASONS:
            for position in POSITIONS:
                group = frame[frame["season"].eq(season) & frame["position"].eq(position)].copy()
                if group.empty:
                    continue
                group["bin"] = pd.qcut(group[p85], q=min(10, max(1, len(group) // 30)), labels=False, duplicates="drop")
                for bin_number, bin_group in group.groupby("bin", observed=True):
                    if len(bin_group) < 30:
                        continue
                    bins.append(
                        clean(
                            {
                                "season": season,
                                "position": position,
                                "model": model,
                                "bin": int(bin_number),
                                "n": len(bin_group),
                                "predicted": bin_group[p85].mean(),
                                "observed": bin_group["actual_score"].mean(),
                                "scoringFormat": SCORING_FORMAT,
                            }
                        )
                    )
    return bins


def model_fits(output: Path, metadata: dict[str, Any]) -> list[dict[str, Any]]:
    fits = pd.read_csv(output / "selected_models.csv")
    if set(fits["position"].unique()) != set(POSITIONS) or len(fits) != 8:
        raise ValueError("The calibration page requires eight walk-forward v2 fits.")
    records = json.loads((output / "walk_forward_model_records.json").read_text(encoding="utf-8"))
    training_rows = {(int(row["target_season"]), str(row["position"])): int(row["training_rows"]) for row in records}
    result = []
    for row in fits.sort_values(["target_season", "position"]).itertuples(index=False):
        training = [part for part in str(row.training_seasons).split(",") if part]
        result.append(
            clean(
                {
                    "targetSeason": int(row.target_season),
                    "position": str(row.position),
                    "trainingSeasons": " and ".join(training),
                    "trainingRows": training_rows[(int(row.target_season), str(row.position))],
                    "featureCount": int(row.feature_count),
                    "maxDepth": int(row.max_depth),
                    "minChildWeight": float(row.min_child_weight),
                    "subsample": float(row.subsample),
                    "colsample": float(row.colsample_bytree),
                    "learningRate": float(row.learning_rate),
                    "regLambda": float(row.reg_lambda),
                    "rounds": int(row.boosting_rounds),
                    "quantiles": "p15, p50, p85",
                    "scoringFormat": SCORING_FORMAT,
                }
            )
        )
    return result


def build_data() -> dict[str, Any]:
    backtest = root() / "backtest_fbg_2023_2025"
    output = backtest / "outputs" / "xgb_v2_quantile_projection"
    metadata = json.loads((output / "metadata.json").read_text(encoding="utf-8"))
    if metadata.get("model_release") != MODEL_RELEASE or metadata.get("artifact_version") != ARTIFACT_VERSION:
        raise ValueError("Calibration data must use the active v2 release.")
    if metadata.get("feature_version") != "fbg_rank_projection_v2" or "n_projectors" in json.dumps(metadata.get("feature_names_by_position", {})):
        raise ValueError("Calibration metadata contains an invalid v2 feature contract.")
    frame = pd.read_parquet(output / "comparison_rows.parquet")
    require_ppr(frame, "v2 comparison rows")
    frame = frame[frame["season"].isin(SEASONS)].copy()
    if set(frame["season"].unique()) != set(SEASONS):
        raise ValueError("Calibration data requires held-out rows for 2024 and 2025.")
    if frame[["actual_score", "xgb_p15", "xgb_p50", "xgb_p85", "ffsim_p15", "ffsim_p50", "ffsim_p85"]].isna().any().any():
        raise ValueError("Calibration rows contain missing actual or model values.")

    records = records_for_scopes(frame)
    position_records = {
        position: {record["model"]: record for record in records if record["scope"] == "position" and record["position"] == position}
        for position in POSITIONS
    }
    ceiling_selections = {position: "XGBoost" for position in POSITIONS}
    floor_selections = {
        position: select_model(position_records[position], "p15_pinball_loss")
        for position in POSITIONS
    }
    high_selection_rows = [selection_row(position, position_records[position], "p85", ceiling_selections[position]) for position in POSITIONS]
    floor_selection_rows = [selection_row(position, position_records[position], "p15", floor_selections[position]) for position in POSITIONS]

    high_overall = selected_overall(frame, ceiling_selections)
    floor_overall = selected_overall(frame, floor_selections)
    high_weekly_positions, high_weekly_summaries = weekly_data(frame, ceiling_selections, "p85")
    floor_weekly_positions, floor_weekly_summaries = weekly_data(frame, floor_selections, "p15")
    display_records = [display_metric_row(record, record["season"], record["position"]) for record in records]
    position_display = index_metrics(records, "position")
    season_position_records = [record for record in records if record["scope"] == "season_position"]
    high_selected_season = [
        clean(
            {
                "season": int(record["season"]),
                "position": record["position"],
                "n": record["n"],
                "coverage": record["p85_coverage"],
                "pinballLoss": record["p85_pinball_loss"],
                "rankSpearman": record["rank_spearman"],
                "selectedModel": ceiling_selections[record["position"]],
                "selectedCoverage": record["p85_coverage"],
                "selectedPinballLoss": record["p85_pinball_loss"],
                "selectedRankSpearman": record["rank_spearman"],
                "intervalCoverage": record["interval_coverage"],
                "scoringFormat": SCORING_FORMAT,
            }
        )
        for record in season_position_records
        if record["model"] == ceiling_selections[record["position"]]
    ]
    floor_selected_season = [
        clean(
            {
                "season": int(record["season"]),
                "position": record["position"],
                "n": record["n"],
                "coverage": record["p15_coverage"],
                "pinballLoss": record["p15_pinball_loss"],
                "rankSpearman": record["rank_spearman"],
                "selectedModel": floor_selections[record["position"]],
                "selectedCoverage": record["p15_coverage"],
                "selectedPinballLoss": record["p15_pinball_loss"],
                "selectedRankSpearman": record["rank_spearman"],
                "lowSideMissRate": record["low_side_miss_rate"],
                "meanBelowP15": record["mean_below_p15"],
                "p15TailExcess": record["p15_tail_excess"],
                "scoringFormat": SCORING_FORMAT,
            }
        )
        for record in season_position_records
        if record["model"] == floor_selections[record["position"]]
    ]
    high_season_summaries = []
    floor_season_summaries = []
    for season in SEASONS:
        high_parts = [record for record in season_position_records if record["season"] == season and record["model"] == "XGBoost"]
        floor_parts = [record for record in season_position_records if record["season"] == season and record["model"] == floor_selections[record["position"]]]
        high_season_summaries.append(clean({"season": season, "n": sum(record["n"] for record in high_parts), "coverage": np.average([record["p85_coverage"] for record in high_parts], weights=[record["n"] for record in high_parts]), "pinballLoss": np.average([record["p85_pinball_loss"] for record in high_parts], weights=[record["n"] for record in high_parts])}))
        floor_season_summaries.append(clean({"season": season, "n": sum(record["n"] for record in floor_parts), "coverage": np.average([record["p15_coverage"] for record in floor_parts], weights=[record["n"] for record in floor_parts]), "pinballLoss": np.average([record["p15_pinball_loss"] for record in floor_parts], weights=[record["n"] for record in floor_parts])}))

    all_position_rows = [selection_row(position, position_records[position], "p85", "XGBoost") for position in POSITIONS]
    all_floor_rows = [selection_row(position, position_records[position], "p15", floor_selections[position]) for position in POSITIONS]
    all_metrics = {record["model"]: record for record in records if record["scope"] == "overall"}
    try:
        ffsim_metadata = json.loads((backtest / "outputs" / "player_backtest_metadata.json").read_text(encoding="utf-8"))
        simulation_count = int(ffsim_metadata.get("simulation_settings", {}).get("n_simulations", 1000))
    except (OSError, json.JSONDecodeError):
        simulation_count = 1000
    run_date = date.today().strftime("%b %d, %Y").replace(" 0", " ")
    model_fits_value = model_fits(output, metadata)
    bins = calibration_bins(frame)
    selected_bins = [row for row in bins if row["model"] == "XGBoost"]
    floor_bins = [row for row in bins if row["model"] == floor_selections[row["position"]]]
    feature_families = [
        {"name": "Pregame context", "detail": "Week, ECR, and the approved PPR projection score."},
        {"name": "Stat projections", "detail": "Passing, rushing, receiving, and fumble projections from Footballguys."},
        {"name": "Position contract", "detail": "Each position uses its own exact feature list from fbg_rank_projection_v2."},
    ]
    scoring_contract = {"format": SCORING_FORMAT, "version": SCORING_CONTRACT_VERSION, "rules": ["1 point per reception", "no tight-end reception bonus", "no receiving first-down points"]}
    calibration_model = {
        "displayName": "Forecast PPR v2 multi-quantile models",
        "shortName": "PPR v2 model calibration",
        "version": f"{MODEL_RELEASE} · {ARTIFACT_VERSION}",
        "status": "Validated PPR outputs",
        "owner": "Matt Savoca",
        "runDate": run_date,
        "algorithm": "XGBoost multi-quantile with ffsimulator diagnostic",
        "objective": "Estimate weekly PPR p15, p50, and p85",
        "target": "15th, 50th, and 85th percentiles of weekly PPR points",
        "oosRows": high_overall["n"],
        "oosSeasons": "2024 and 2025",
        "positionModels": 4,
        "xgboostFits": 8,
        "calibrationMethod": "Held-out season comparison by position",
        "metric": "p85_pinball_loss",
        "scoringFormat": SCORING_FORMAT,
        "scoringRules": scoring_contract["rules"],
        "maxHistoricalSeasonUsed": 2025,
    }
    floor_model = {**calibration_model, "objective": "Estimate the weekly PPR p15 floor", "target": "15th percentile of weekly PPR points", "metric": "p15_pinball_loss", "oosRows": floor_overall["n"]}
    data = {
        "selectedModelByPosition": ceiling_selections,
        "calibrationModel": calibration_model,
        "ffsimulatorModel": {"name": "ffsimulator", "version": "ppr_v1 · rank-conditioned diagnostic", "algorithm": "Rank-conditioned simulation", "output": "Diagnostic p15, p50, and p85 values", "simulations": simulation_count, "input": "Earlier-season PPR outcome pools"},
        "selectedPortfolioOverall": {"n": high_overall["n"], "coverage": high_overall["p85_coverage"], "pinballLoss": high_overall["p85_pinball_loss"], "p85Mae": high_overall["p85_mae"], "p85Rmse": high_overall["p85_rmse"], "highSideMissRate": high_overall["high_side_miss_rate"], "meanScoreAboveP85": high_overall["mean_score_above_p85"], "averageTailExcess": high_overall["average_tail_excess"], "nAboveP85": high_overall["n_above_p85"], "rankSpearman": high_overall["rank_spearman"]},
        "positionModelSelections": high_selection_rows,
        "scorecardMetrics": display_records,
        "overallMetrics": [display_metric_row(record, None, "ALL") for record in all_metrics.values()],
        "oosSeasonPositionMetrics": high_selected_season,
        "oosSeasonSummaries": high_season_summaries,
        "oosWeeklyPositionMetrics": high_weekly_positions,
        "oosWeeklySummaries": high_weekly_summaries,
        "modelFits": model_fits_value,
        "featureFamilies": feature_families,
        "calibrationBinMinimum": 30,
        "calibrationBins": bins,
        "selectedCalibrationBins": selected_bins,
        "oosOverall": display_metric_row(all_metrics["XGBoost"], None, "ALL"),
        "baselineOverall": display_metric_row(all_metrics["ffsimulator"], None, "ALL"),
        "oosPositionSummaries": all_position_rows,
        "scoringContract": scoring_contract,
        "floorSelectedModelByPosition": floor_selections,
        "floorCalibrationModel": floor_model,
        "floorFfsimulatorModel": {"name": "ffsimulator", "version": "ppr_v1 · rank-conditioned diagnostic", "algorithm": "Rank-conditioned simulation", "output": "Diagnostic p15 value", "simulations": simulation_count, "input": "Earlier-season PPR outcome pools"},
        "floorSelectedPortfolioOverall": {"n": floor_overall["n"], "coverage": floor_overall["p15_coverage"], "pinballLoss": floor_overall["p15_pinball_loss"], "p15Mae": floor_overall["p15_mae"], "p15Rmse": floor_overall["p15_rmse"], "lowSideMissRate": floor_overall["low_side_miss_rate"], "meanBelowP15": floor_overall["mean_below_p15"], "p15TailExcess": floor_overall["p15_tail_excess"], "nBelowP15": floor_overall["n_below_p15"], "rankSpearman": floor_overall["rank_spearman"]},
        "floorPositionModelSelections": floor_selection_rows,
        "floorScorecardMetrics": display_records,
        "floorOverallMetrics": [display_metric_row(record, None, "ALL") for record in all_metrics.values()],
        "floorOosSeasonPositionMetrics": floor_selected_season,
        "floorOosSeasonSummaries": floor_season_summaries,
        "floorOosWeeklyPositionMetrics": floor_weekly_positions,
        "floorOosWeeklySummaries": floor_weekly_summaries,
        "floorModelFits": model_fits_value,
        "floorFeatureFamilies": feature_families,
        "floorCalibrationBinMinimum": 30,
        "floorCalibrationBins": bins,
        "floorSelectedCalibrationBins": floor_bins,
        "floorOosOverall": display_metric_row(all_metrics["XGBoost"], None, "ALL"),
        "floorBaselineOverall": display_metric_row(all_metrics["ffsimulator"], None, "ALL"),
        "floorOosPositionSummaries": all_floor_rows,
        "floorScoringContract": {**scoring_contract, "targetQuantile": 0.15, "metric": "p15_pinball_loss"},
    }
    return clean(data)


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
        "selectedModelByPosition", "calibrationModel", "ffsimulatorModel", "selectedPortfolioOverall", "positionModelSelections", "scorecardMetrics", "overallMetrics", "oosSeasonPositionMetrics", "oosSeasonSummaries", "oosWeeklyPositionMetrics", "oosWeeklySummaries", "modelFits", "featureFamilies", "calibrationBinMinimum", "calibrationBins", "selectedCalibrationBins", "oosOverall", "baselineOverall", "oosPositionSummaries", "scoringContract", "floorSelectedModelByPosition", "floorCalibrationModel", "floorFfsimulatorModel", "floorSelectedPortfolioOverall", "floorPositionModelSelections", "floorScorecardMetrics", "floorOverallMetrics", "floorOosSeasonPositionMetrics", "floorOosSeasonSummaries", "floorOosWeeklyPositionMetrics", "floorOosWeeklySummaries", "floorModelFits", "floorFeatureFamilies", "floorCalibrationBinMinimum", "floorCalibrationBins", "floorSelectedCalibrationBins", "floorOosOverall", "floorBaselineOverall", "floorOosPositionSummaries", "floorScoringContract",
    ]
    for name in exports:
        value = json.dumps(data[name], indent=2, ensure_ascii=False, allow_nan=False)
        lines.append(f"export const {name} = {value} as const;")
        lines.append("")
    target.write_text("\n".join(lines), encoding="utf-8")


if __name__ == "__main__":
    write_typescript(build_data())
