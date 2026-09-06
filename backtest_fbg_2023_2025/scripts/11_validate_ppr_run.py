"""Run the validation gates for the canonical PPR model outputs."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd
from PIL import Image


SCORING_FORMAT = "PPR"
SCORING_CONTRACT_VERSION = "ppr_v1"
SEASONS = tuple(range(2012, 2026))
TARGET_SEASONS = (2023, 2024, 2025)
POSITIONS = {"QB", "RB", "WR", "TE"}
OUTCOME_COLUMNS = {
    "actual_score",
    "p15",
    "p50",
    "p85",
    "baseline_p15",
    "baseline_p50",
    "baseline_p85",
    "baseline_mean_above_p85",
    "baseline_p85_tail_excess",
    "xgb_p85",
}


def project_root() -> Path:
    return Path(__file__).resolve().parents[2]


def require_ppr(frame: pd.DataFrame, label: str) -> None:
    required = {"scoring_format", "scoring_contract_version"}
    missing = sorted(required.difference(frame.columns))
    if missing:
        raise AssertionError(f"{label} is missing metadata columns: {missing}")
    formats = set(frame["scoring_format"].dropna().astype(str))
    contracts = set(frame["scoring_contract_version"].dropna().astype(str))
    if formats != {SCORING_FORMAT} or contracts != {SCORING_CONTRACT_VERSION}:
        raise AssertionError(f"{label} has formats={formats}, contracts={contracts}")


def validate_raw_ppr(backtest: Path) -> None:
    paths = sorted((backtest / "data" / "raw" / "nflreadr" / "player_stats").glob("season=*.parquet"))
    found = {int(path.stem.split("=")[1]) for path in paths}
    if found != set(SEASONS):
        raise AssertionError(f"Raw player-stat seasons are incomplete: {sorted(found)}")
    for path in paths:
        frame = pd.read_parquet(path)
        required = {"fantasy_points", "fantasy_points_ppr", "receptions", "position", "season_type", "week"}
        missing = sorted(required.difference(frame.columns))
        if missing:
            raise AssertionError(f"{path.name} is missing raw PPR columns: {missing}")
        scoped = frame[
            frame["season_type"].astype(str).str.upper().eq("REG")
            & pd.to_numeric(frame["week"], errors="coerce").isin(range(1, 18))
            & frame["position"].astype(str).str.upper().isin(POSITIONS)
        ].copy()
        base = pd.to_numeric(scoped["fantasy_points"], errors="coerce")
        ppr = pd.to_numeric(scoped["fantasy_points_ppr"], errors="coerce")
        receptions = pd.to_numeric(scoped["receptions"], errors="coerce")
        if base.isna().any() or ppr.isna().any() or receptions.isna().any():
            raise AssertionError(f"{path.name} contains missing scoped PPR values")
        difference = (ppr - base - receptions).abs().max()
        if not np.isfinite(difference) or difference > 1e-8:
            raise AssertionError(f"{path.name} fails raw PPR parity: {difference}")


def validate_scoring_history(backtest: Path, metadata: dict) -> None:
    manifest = pd.read_csv(backtest / "outputs" / "scoring_history_manifest.csv")
    if len(manifest) != len(TARGET_SEASONS):
        raise AssertionError("Scoring-history manifest does not contain one row per target season")
    for row in manifest.itertuples(index=False):
        if row.scoring_format != SCORING_FORMAT or row.scoring_contract_version != SCORING_CONTRACT_VERSION:
            raise AssertionError("Scoring-history manifest is not PPR")
        target = int(row.target_season)
        history = pd.read_parquet(row.history_document)
        require_ppr(history, f"scoring history for {target}")
        seasons = pd.to_numeric(history["season"], errors="coerce").dropna().astype(int)
        if seasons.empty or (seasons >= target).any():
            raise AssertionError(f"Scoring history for {target} contains target or future seasons")
        if bool(row.contains_target_or_future):
            raise AssertionError(f"Manifest marks a leaked history for {target}")
        metadata_row = next(item for item in metadata["target_history"] if int(item["target_season"]) == target)
        if int(metadata_row["max_historical_season"]) >= target or metadata_row["contains_target_or_future"]:
            raise AssertionError(f"Metadata marks a leaked history for {target}")


def validate_outputs(backtest: Path) -> None:
    output = backtest / "outputs"
    player = pd.read_parquet(output / "player_predictions.parquet")
    require_ppr(player, "ffsimulator player predictions")
    for column in ("actual_score", "p15", "p50", "p85", "mean_above_p85", "p85_tail_excess"):
        if column not in player:
            raise AssertionError(f"Player predictions are missing {column}")
    if set(player["season"].unique()) != set(TARGET_SEASONS):
        raise AssertionError("Player predictions do not cover all target seasons")

    metadata = json.loads((output / "player_backtest_metadata.json").read_text(encoding="utf-8"))
    if metadata.get("scoring_format") != SCORING_FORMAT:
        raise AssertionError("ffsimulator metadata is not PPR")
    if metadata["simulation_settings"]["seed_formula"] != "100000 + target_season * 100 + target_week":
        raise AssertionError("ffsimulator seed policy is missing")
    validate_scoring_history(backtest, metadata)
    reproducibility = json.loads((output / "reproducibility_check.json").read_text(encoding="utf-8"))
    all_comparisons = reproducibility.get("comparisons", []) + reproducibility.get("xgb_smoke_comparisons", [])
    if reproducibility.get("status") != "passed" or not all_comparisons or not all(
        comparison.get("match") for comparison in all_comparisons
    ):
        raise AssertionError("Seeded reproducibility receipt did not pass")

    for name in ("team_draws.parquet", "team_predictions.parquet", "game_predictions.parquet"):
        frame = pd.read_parquet(output / name)
        require_ppr(frame, name)
    for name in ("player_scorecard_metrics.csv", "team_metrics.csv"):
        frame = pd.read_csv(output / name)
        require_ppr(frame, name)

    xgb_output = output / "xgb_p85_projection"
    xgb_metadata = json.loads((xgb_output / "metadata.json").read_text(encoding="utf-8"))
    if xgb_metadata.get("scoring_format") != SCORING_FORMAT:
        raise AssertionError("XGBoost metadata is not PPR")
    if float(xgb_metadata.get("data_audit", {}).get("projection_score_max_abs_difference", np.inf)) > 1e-8:
        raise AssertionError("R and Python PPR projection scores do not match")
    if xgb_metadata.get("seed_policy") != "20260904 + target_season * 100 + position_index":
        raise AssertionError("XGBoost seed policy is missing")
    if xgb_metadata.get("leakage_checks", {}).get("features_contain_target_or_future_outcomes") is not False:
        raise AssertionError("XGBoost metadata does not prove feature leakage control")
    if len(xgb_metadata.get("model_records", [])) != 8:
        raise AssertionError("XGBoost did not produce eight position-season fits")
    for record in xgb_metadata["model_records"]:
        if int(record["max_historical_season_used"]) >= int(record["target_season"]):
            raise AssertionError("XGBoost model record has a leaked training cutoff")
        features = set(str(record.get("features", "")).split(","))
        if features.intersection(OUTCOME_COLUMNS):
            raise AssertionError(f"XGBoost model record contains outcome features: {features}")
        if "rec-1d" in features:
            raise AssertionError("Receiving first downs remain an active XGBoost feature")

    xgb_predictions = pd.read_parquet(xgb_output / "predictions.parquet")
    require_ppr(xgb_predictions, "XGBoost predictions")
    metrics = pd.read_csv(xgb_output / "metrics.csv")
    require_ppr(metrics, "XGBoost metrics")
    required_metrics = {
        "p15_coverage",
        "p50_coverage",
        "p85_coverage",
        "p85_pinball_loss",
        "calibration_slope",
        "calibration_intercept",
        "interval_coverage",
        "p15_to_p85_interval_coverage",
        "p50_mae",
        "p50_rmse",
        "p85_mae",
        "p85_rmse",
        "low_side_miss_rate",
        "high_side_miss_rate",
        "mean_score_above_p85",
        "average_tail_excess",
        "mae",
        "rmse",
        "n_above_p85",
        "n",
    }
    missing_metrics = sorted(required_metrics.difference(metrics.columns))
    if missing_metrics:
        raise AssertionError(f"XGBoost metrics are missing required fields: {missing_metrics}")
    position_season = metrics[metrics["group"].eq("season_position")]
    if set(position_season["model"].unique()) != {"simulation_baseline", "xgb_projection"}:
        raise AssertionError("XGBoost metrics do not contain both model families")
    if set(position_season["position"].unique()) != POSITIONS or set(position_season["season"].unique()) != {2024, 2025}:
        raise AssertionError("XGBoost metrics do not cover all held-out positions and seasons")
    position_metrics = metrics[metrics["group"].eq("position")]
    baseline_metrics = position_metrics[position_metrics["model"].eq("simulation_baseline")]
    xgb_metrics = position_metrics[position_metrics["model"].eq("xgb_projection")]
    if baseline_metrics["low_side_miss_rate"].isna().any():
        raise AssertionError("ffsimulator low-side miss rates are unavailable")
    if xgb_metrics["low_side_miss_rate"].notna().any():
        raise AssertionError("XGBoost reports a lower-bound miss rate without a p15 output")

    boom = pd.read_csv(xgb_output / "boom_capture.csv")
    require_ppr(boom, "boom capture")
    if set(boom["boom_threshold_scope"].dropna()) != {"season"}:
        raise AssertionError("Boom thresholds are not season-wide")

    page_data = backtest.parent / "web" / "lib" / "calibration-data.ts"
    page_component = backtest.parent / "web" / "components" / "FloorCeilingApp.tsx"
    for path in (page_data, page_component):
        text = path.read_text(encoding="utf-8").upper()
        if "FFFL" in text:
            raise AssertionError(f"Active calibration presentation contains FFFL wording: {path}")

    chart_paths = sorted((output / "plots").glob("*.png"))
    if len(chart_paths) < 8:
        raise AssertionError(f"Expected at least eight rendered charts, found {len(chart_paths)}")
    for path in chart_paths:
        if path.stat().st_size == 0:
            raise AssertionError(f"Chart is empty: {path}")
        with Image.open(path) as image:
            image.verify()


if __name__ == "__main__":
    validate_outputs(project_root() / "backtest_fbg_2023_2025")
    print("All PPR validation gates passed.")
