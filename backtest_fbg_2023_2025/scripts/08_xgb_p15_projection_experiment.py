"""Run a walk-forward XGBoost PPR p15 projection experiment.

This experiment mirrors the validated direct p85 model workflow. It trains
one lower-quantile model for each supported skill position, selects settings
with an earlier-season validation slice, and scores later seasons once.
"""

from __future__ import annotations

import argparse
import importlib.util
import itertools
import json
import os
import time
from pathlib import Path
from typing import Any, Iterable

import numpy as np
import pandas as pd
import xgboost as xgb


SCORING_FORMAT = "PPR"
SCORING_CONTRACT_VERSION = "ppr_v1"
ALPHA = 0.15
QUANTILE_LABEL = "p15"
POSITIONS = ("QB", "RB", "WR", "TE")
DEFAULT_TARGET_SEASONS = (2024, 2025)
DEFAULT_MAX_ROUNDS = 700
DEFAULT_EARLY_STOPPING_ROUNDS = 50
DEFAULT_VALIDATION_WEEKS = (14, 15, 16, 17)

# These columns are copied from the validated p85 feature contract. Keep the
# order stable because it is part of the serialized model and SHAP contract.
RANK_FEATURES = (
    "week",
    "ecr",
    "rank_sd",
    "n_projectors",
    "rank_min",
    "rank_max",
    "consensus_rank",
    "consensus_projected_score",
)

PROJECTION_COLUMNS = (
    "ssn-gms",
    "ssn-ssn",
    "pass-2pt",
    "pass-att",
    "pass-cmp",
    "pass-1d",
    "pass-int",
    "pass-sck",
    "pass-td",
    "pass-yds",
    "rush-2pt",
    "rush-car",
    "rush-1d",
    "rush-td",
    "rush-yds",
    "rec-2pt",
    "rec-rec",
    "rec-tgt",
    "rec-td",
    "rec-yds",
    "fum-lost",
)

PROJECTION_SCORE_COLUMNS = (
    "pass-yds",
    "pass-td",
    "pass-int",
    "pass-2pt",
    "rush-yds",
    "rush-td",
    "rush-2pt",
    "rec-yds",
    "rec-td",
    "rec-2pt",
    "rec-rec",
    "fum-lost",
)

KEY_COLUMNS = ("season", "week", "fbg_id", "position")
OUTCOME_COLUMNS = {
    "actual_score",
    "p15",
    "p50",
    "p85",
    "mean_below_p15",
    "p15_tail_excess",
    "mean_above_p85",
    "p85_tail_excess",
    "baseline_p15",
    "baseline_p50",
    "baseline_p85",
    "baseline_mean_below_p15",
    "baseline_p15_tail_excess",
    "baseline_mean_above_p85",
    "baseline_p85_tail_excess",
    "xgb_p15",
    "xgb_p85",
}


def load_p85_helpers(root: Path) -> Any:
    """Load the validated p85 module for the shared data path.

    Parameters
    ----------
    root : pathlib.Path
        Repository root.

    Returns
    -------
    Any
        Loaded p85 experiment module.
    """
    script_path = root / "backtest_fbg_2023_2025" / "scripts" / "08_xgb_p85_projection_experiment.py"
    spec = importlib.util.spec_from_file_location("xgb_p85_projection_for_p15", script_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot load shared p85 helpers from {script_path}.")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def parse_args() -> argparse.Namespace:
    """Parse command-line arguments.

    Returns
    -------
    argparse.Namespace
        Parsed experiment settings.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--target-seasons",
        default=",".join(str(value) for value in DEFAULT_TARGET_SEASONS),
        help="Comma-separated target seasons to score.",
    )
    parser.add_argument(
        "--max-rounds",
        type=int,
        default=DEFAULT_MAX_ROUNDS,
        help="Maximum boosting rounds for each grid fit.",
    )
    parser.add_argument(
        "--early-stopping-rounds",
        type=int,
        default=DEFAULT_EARLY_STOPPING_ROUNDS,
        help="Early stopping patience for grid fits.",
    )
    parser.add_argument(
        "--max-configs",
        type=int,
        default=None,
        help="Optional deterministic prefix of the grid for smoke runs.",
    )
    parser.add_argument(
        "--nthread",
        type=int,
        default=min(8, max(1, os.cpu_count() or 1)),
        help="XGBoost threads per model.",
    )
    parser.add_argument(
        "--output-dir",
        default=None,
        help="Optional output directory. Defaults to outputs/xgb_p15_projection.",
    )
    args = parser.parse_args()
    args.target_seasons = tuple(
        sorted({int(value.strip()) for value in args.target_seasons.split(",") if value.strip()})
    )
    if not args.target_seasons:
        parser.error("--target-seasons must contain at least one season.")
    if args.max_rounds < 1:
        parser.error("--max-rounds must be positive.")
    if args.early_stopping_rounds < 1:
        parser.error("--early-stopping-rounds must be positive.")
    if args.max_configs is not None and args.max_configs < 1:
        parser.error("--max-configs must be positive.")
    if args.nthread < 1:
        parser.error("--nthread must be positive.")
    return args


def project_root() -> Path:
    """Return the repository root for this script."""
    return Path(__file__).resolve().parents[2]


def require_ppr_artifact(frame: pd.DataFrame, label: str) -> None:
    """Require a frame to carry the active PPR scoring contract."""
    required = {"scoring_format", "scoring_contract_version"}
    missing = sorted(required.difference(frame.columns))
    if missing:
        raise ValueError(f"{label} is missing PPR metadata columns: {missing}")
    formats = set(frame["scoring_format"].dropna().astype(str).str.upper())
    contracts = set(frame["scoring_contract_version"].dropna().astype(str))
    if formats != {SCORING_FORMAT} or contracts != {SCORING_CONTRACT_VERSION}:
        raise ValueError(
            f"{label} does not use the active {SCORING_FORMAT} scoring contract: "
            f"formats={sorted(formats)}, contracts={sorted(contracts)}"
        )


def assert_feature_columns(features: list[str]) -> None:
    """Reject outcomes, future results, and legacy scoring fields from features."""
    leaked = sorted(set(features).intersection(OUTCOME_COLUMNS))
    if "rec-1d" in features:
        leaked.append("rec-1d")
    if leaked:
        raise ValueError(f"XGBoost features contain outcome or inactive scoring columns: {sorted(set(leaked))}")


def assert_walk_forward_split(
    prior: pd.DataFrame,
    target: pd.DataFrame,
    target_season: int,
) -> None:
    """Prove that a target-season fit sees earlier seasons only."""
    if prior.empty or target.empty:
        raise ValueError(f"Cannot validate an empty split for target season {target_season}.")
    prior_seasons = set(pd.to_numeric(prior["season"], errors="coerce").dropna().astype(int))
    target_seasons = set(pd.to_numeric(target["season"], errors="coerce").dropna().astype(int))
    invalid_prior = sorted(season for season in prior_seasons if season >= target_season)
    invalid_target = sorted(season for season in target_seasons if season != target_season)
    if invalid_prior:
        raise ValueError(
            f"P15 training rows for {target_season} contain target or future seasons: {invalid_prior}"
        )
    if invalid_target:
        raise ValueError(
            f"P15 target rows for {target_season} contain unexpected seasons: {invalid_target}"
        )


def assert_calibration_rows(predictions: pd.DataFrame) -> None:
    """Require target-season rows before any calibration calculation."""
    required = {"season", "actual_score", "xgb_p15", "baseline_p15"}
    missing = sorted(required.difference(predictions.columns))
    if missing:
        raise ValueError(f"P15 calibration input is missing columns: {missing}")
    if predictions.empty:
        raise ValueError("P15 calibration input is empty.")
    if predictions["actual_score"].isna().any():
        raise ValueError("P15 calibration input contains missing outcomes.")
    if predictions[["xgb_p15", "baseline_p15"]].isna().any().any():
        raise ValueError("P15 calibration input contains missing predictions.")


def pinball_loss(actual: np.ndarray, prediction: np.ndarray, alpha: float = ALPHA) -> float:
    """Calculate mean pinball loss for one quantile."""
    if not 0.0 < alpha < 1.0:
        raise ValueError("alpha must be between 0 and 1.")
    residual = np.asarray(actual, dtype=float) - np.asarray(prediction, dtype=float)
    losses = np.where(residual >= 0.0, alpha * residual, (alpha - 1.0) * residual)
    return float(np.mean(losses))


def pinball_metric(prediction: np.ndarray, dmatrix: xgb.DMatrix) -> tuple[str, float]:
    """Return the P15 pinball metric for XGBoost evaluation."""
    return "p15_pinball", pinball_loss(dmatrix.get_label(), prediction)


def make_grid() -> list[dict[str, Any]]:
    """Build the bounded P15 parameter grid.

    The grid matches the P85 search method. P15 selects its own winner from
    fresh validation losses, so the P85 settings are never reused.

    Returns
    -------
    list of dict[str, Any]
        Deterministic model parameter dictionaries.
    """
    grid = []
    values = itertools.product(
        (2, 3, 4),
        (1.0, 5.0, 15.0),
        (0.70, 0.90),
        (0.70, 1.00),
        (0.03, 0.06),
        (1.0, 5.0),
    )
    for max_depth, min_child_weight, subsample, colsample, learning_rate, reg_lambda in values:
        grid.append(
            {
                "max_depth": max_depth,
                "min_child_weight": min_child_weight,
                "subsample": subsample,
                "colsample_bytree": colsample,
                "learning_rate": learning_rate,
                "reg_lambda": reg_lambda,
            }
        )
    return grid


def xgb_params(settings: dict[str, Any], nthread: int, seed: int) -> dict[str, Any]:
    """Combine fixed and searched XGBoost parameters."""
    return {
        "objective": "reg:quantileerror",
        "quantile_alpha": ALPHA,
        "tree_method": "hist",
        "max_bin": 256,
        "nthread": nthread,
        "seed": seed,
        "verbosity": 0,
        **settings,
    }


def projection_score(frame: pd.DataFrame) -> pd.Series:
    """Calculate standard PPR projection points from raw FBG stats."""
    values = {
        column: pd.to_numeric(frame[column], errors="coerce").fillna(0.0)
        for column in PROJECTION_SCORE_COLUMNS
    }
    return (
        values["pass-yds"] / 25.0
        + values["pass-td"] * 4.0
        - values["pass-int"]
        + values["pass-2pt"] * 2.0
        + values["rush-yds"] / 10.0
        + values["rush-td"] * 6.0
        + values["rush-2pt"] * 2.0
        + values["rec-yds"] / 10.0
        + values["rec-td"] * 6.0
        + values["rec-2pt"] * 2.0
        + values["rec-rec"]
        - values["fum-lost"] * 2.0
    )


def build_dataset(root: Path) -> tuple[pd.DataFrame, dict[str, Any]]:
    """Use the validated P85 join path and expose the P15 model frame."""
    helpers = load_p85_helpers(root)
    data, audit = helpers.build_dataset(root)
    require_ppr_artifact(data, "P15 XGBoost model dataset")
    if audit.get("feature_outcome_columns"):
        raise ValueError(
            "The shared XGBoost data audit found outcome columns in the feature universe: "
            f"{audit['feature_outcome_columns']}"
        )
    missing = sorted(
        {"actual_score", "p15", "p50", "p85", "mean_below_p15", "p15_tail_excess"}.difference(data.columns)
    )
    if missing:
        raise ValueError(f"P15 model dataset is missing floor-side baseline columns: {missing}")
    assert_feature_columns([*RANK_FEATURES, *PROJECTION_COLUMNS, "projection_fpts"])
    return data, audit


def feature_columns(frame: pd.DataFrame, position: str) -> list[str]:
    """Return non-constant numeric P15 features for one position."""
    candidates = [*RANK_FEATURES, *PROJECTION_COLUMNS, "projection_fpts"]
    subset = frame[frame["position"].eq(position)]
    selected = [
        column
        for column in candidates
        if column in subset.columns and subset[column].nunique(dropna=False) > 1
    ]
    assert_feature_columns(selected)
    if not selected:
        raise ValueError(f"No variable features are available for {position}.")
    return selected


def to_dmatrix(frame: pd.DataFrame, features: list[str], with_label: bool) -> xgb.DMatrix:
    """Convert one P15 modeling frame to an XGBoost DMatrix."""
    assert_feature_columns(features)
    missing = sorted(set(features).difference(frame.columns))
    if missing:
        raise ValueError(f"DMatrix input is missing feature columns: {missing}")
    values = frame[features].astype(float).to_numpy()
    labels = frame["actual_score"].astype(float).to_numpy() if with_label else None
    return xgb.DMatrix(values, label=labels, feature_names=features, missing=np.nan)


def train_grid_model(
    train: pd.DataFrame,
    validation: pd.DataFrame,
    features: list[str],
    settings: dict[str, Any],
    max_rounds: int,
    early_stopping_rounds: int,
    nthread: int,
    seed: int,
) -> tuple[xgb.Booster, dict[str, Any]]:
    """Fit one P15 grid candidate and score its validation quantile."""
    dtrain = to_dmatrix(train, features, with_label=True)
    dvalidation = to_dmatrix(validation, features, with_label=True)
    evals_result: dict[str, dict[str, list[float]]] = {}
    booster = xgb.train(
        xgb_params(settings, nthread=nthread, seed=seed),
        dtrain,
        num_boost_round=max_rounds,
        evals=[(dvalidation, "validation")],
        custom_metric=pinball_metric,
        maximize=False,
        early_stopping_rounds=early_stopping_rounds,
        evals_result=evals_result,
        verbose_eval=False,
    )
    rounds = int(getattr(booster, "best_iteration", max_rounds - 1)) + 1
    prediction = np.maximum(0.0, booster.predict(dvalidation, iteration_range=(0, rounds)))
    actual = validation["actual_score"].to_numpy(dtype=float)
    diagnostics = {
        **settings,
        "best_iteration": rounds - 1,
        "boosting_rounds": rounds,
        "validation_n": int(len(validation)),
        "validation_pinball": pinball_loss(actual, prediction),
        "validation_coverage": float(np.mean(actual <= prediction)),
        "validation_bias": float(np.mean(prediction - actual)),
        "validation_mae": float(np.mean(np.abs(prediction - actual))),
    }
    return booster, diagnostics


def choose_model(
    train: pd.DataFrame,
    validation: pd.DataFrame,
    position: str,
    target_season: int,
    grid: list[dict[str, Any]],
    args: argparse.Namespace,
) -> tuple[dict[str, Any], pd.DataFrame, list[str]]:
    """Search the P15 grid for one position and target season."""
    features = feature_columns(train, position)
    results = []
    total = len(grid)
    for index, settings in enumerate(grid, start=1):
        seed = 20260904 + target_season * 100 + POSITIONS.index(position)
        _, diagnostics = train_grid_model(
            train,
            validation,
            features,
            settings,
            max_rounds=args.max_rounds,
            early_stopping_rounds=args.early_stopping_rounds,
            nthread=args.nthread,
            seed=seed,
        )
        diagnostics.update(
            {
                "target_season": target_season,
                "position": position,
                "grid_index": index,
                "grid_size": total,
                "feature_count": len(features),
                "quantile_alpha": ALPHA,
            }
        )
        results.append(diagnostics)
        if index == 1 or index == total or index % 24 == 0:
            print(f"  {position} {target_season}: P15 grid {index}/{total}", flush=True)
    grid_results = pd.DataFrame(results).sort_values(
        ["validation_pinball", "validation_mae", "max_depth", "min_child_weight", "grid_index"]
    ).reset_index(drop=True)
    best = grid_results.iloc[0].to_dict()
    best_settings = {
        key: best[key]
        for key in (
            "max_depth",
            "min_child_weight",
            "subsample",
            "colsample_bytree",
            "learning_rate",
            "reg_lambda",
        )
    }
    best_settings["best_iteration"] = int(best["best_iteration"])
    best_settings["boosting_rounds"] = int(best["boosting_rounds"])
    return best_settings, grid_results, features


def fit_final_model(
    train: pd.DataFrame,
    features: list[str],
    settings: dict[str, Any],
    nthread: int,
    seed: int,
) -> xgb.Booster:
    """Refit selected P15 settings on all prior-season rows."""
    dtrain = to_dmatrix(train, features, with_label=True)
    model_settings = {
        key: settings[key]
        for key in (
            "max_depth",
            "min_child_weight",
            "subsample",
            "colsample_bytree",
            "learning_rate",
            "reg_lambda",
        )
    }
    return xgb.train(
        xgb_params(model_settings, nthread=nthread, seed=seed),
        dtrain,
        num_boost_round=int(settings["boosting_rounds"]),
        verbose_eval=False,
    )


def spearman_correlation(actual: np.ndarray, prediction: np.ndarray) -> float:
    """Calculate Spearman correlation without a scikit-learn dependency."""
    actual_rank = pd.Series(actual).rank(method="average").to_numpy()
    prediction_rank = pd.Series(prediction).rank(method="average").to_numpy()
    if np.std(actual_rank) == 0.0 or np.std(prediction_rank) == 0.0:
        return float("nan")
    return float(np.corrcoef(actual_rank, prediction_rank)[0, 1])


def summarize_metrics(predictions: pd.DataFrame) -> pd.DataFrame:
    """Create P15 quantile and descriptive metrics by model and group."""
    complete = predictions.dropna(subset=["actual_score", "baseline_p15", "xgb_p15"])
    rows = []
    groupings: Iterable[tuple[str, list[str]]] = (
        ("all", []),
        ("season", ["season"]),
        ("position", ["position"]),
        ("season_position", ["season", "position"]),
    )
    for group_name, group_columns in groupings:
        grouped = (
            [((), complete)]
            if not group_columns
            else complete.groupby(group_columns, dropna=False, sort=True)
        )
        for group_key, group in grouped:
            if not isinstance(group_key, tuple):
                group_key = (group_key,)
            group_values = dict(zip(group_columns, group_key))
            actual = group["actual_score"].to_numpy(dtype=float)
            for model_name, column in (
                ("simulation_baseline", "baseline_p15"),
                ("xgb_projection", "xgb_p15"),
            ):
                prediction = group[column].to_numpy(dtype=float)
                residual = actual - prediction
                below = actual < prediction
                calibration = (
                    np.polyfit(prediction, actual, 1)
                    if len(prediction) > 1 and np.std(prediction) > 0.0
                    else (np.nan, np.nan)
                )
                row = {
                    "group": group_name,
                    **group_values,
                    "model": model_name,
                    "scoring_format": SCORING_FORMAT,
                    "scoring_contract_version": SCORING_CONTRACT_VERSION,
                    "target_quantile": ALPHA,
                    "quantile_label": QUANTILE_LABEL,
                    "n": int(len(group)),
                    "p15_coverage": float(np.mean(actual <= prediction)),
                    "p15_coverage_error": float(np.mean(actual <= prediction) - ALPHA),
                    "p15_pinball_loss": pinball_loss(actual, prediction),
                    "p15_bias": float(np.mean(prediction - actual)),
                    "p15_mae": float(np.mean(np.abs(residual))),
                    "p15_rmse": float(np.sqrt(np.mean(residual**2))),
                    "mean_p15": float(np.mean(prediction)),
                    "calibration_slope": float(calibration[0]),
                    "calibration_intercept": float(calibration[1]),
                    "p50_coverage": np.nan,
                    "p50_pinball_loss": np.nan,
                    "p50_mae": np.nan,
                    "p50_rmse": np.nan,
                    "mean_p50": np.nan,
                    "p50_bias": np.nan,
                    "p85_coverage": np.nan,
                    "p85_pinball_loss": np.nan,
                    "p85_mae": np.nan,
                    "p85_rmse": np.nan,
                    "mean_p85": np.nan,
                    "low_side_miss_rate": float(np.mean(actual < prediction)),
                    "high_side_miss_rate": np.nan,
                    "mean_below_p15": float(np.mean(actual[below])) if below.any() else np.nan,
                    "mean_score_below_p15": float(np.mean(actual[below])) if below.any() else np.nan,
                    "p15_tail_excess": float(np.mean(prediction[below] - actual[below])) if below.any() else np.nan,
                    "average_tail_excess": float(np.mean(prediction[below] - actual[below])) if below.any() else np.nan,
                    "n_below_p15": int(below.sum()),
                    "predicted_mean_below_p15": np.nan,
                    "predicted_p15_tail_excess": np.nan,
                    "predicted_average_tail_excess": np.nan,
                    "interval_coverage": np.nan,
                    "p15_to_p85_interval_coverage": np.nan,
                    "mean_interval_width": np.nan,
                    "mae": float(np.mean(np.abs(residual))),
                    "rmse": float(np.sqrt(np.mean(residual**2))),
                    "p15_rank_spearman": spearman_correlation(actual, prediction),
                }
                if model_name == "simulation_baseline":
                    lower = group["baseline_p15"].to_numpy(dtype=float)
                    median = group["baseline_p50"].to_numpy(dtype=float)
                    upper = group["baseline_p85"].to_numpy(dtype=float)
                    if np.isfinite(median).all() and np.isfinite(upper).all():
                        row.update(
                            {
                                "p50_coverage": float(np.mean(actual <= median)),
                                "p50_pinball_loss": pinball_loss(actual, median, alpha=0.50),
                                "p50_mae": float(np.mean(np.abs(actual - median))),
                                "p50_rmse": float(np.sqrt(np.mean((actual - median) ** 2))),
                                "mean_p50": float(np.mean(median)),
                                "p50_bias": float(np.mean(median - actual)),
                                "p85_coverage": float(np.mean(actual <= upper)),
                                "p85_pinball_loss": pinball_loss(actual, upper, alpha=0.85),
                                "p85_mae": float(np.mean(np.abs(actual - upper))),
                                "p85_rmse": float(np.sqrt(np.mean((actual - upper) ** 2))),
                                "mean_p85": float(np.mean(upper)),
                                "high_side_miss_rate": float(np.mean(actual > upper)),
                                "interval_coverage": float(np.mean((actual >= lower) & (actual <= upper))),
                                "p15_to_p85_interval_coverage": float(
                                    np.mean((actual >= lower) & (actual <= upper))
                                ),
                                "mean_interval_width": float(np.mean(upper - lower)),
                            }
                        )
                    predicted_mean = group["baseline_mean_below_p15"].to_numpy(dtype=float)
                    predicted_excess = group["baseline_p15_tail_excess"].to_numpy(dtype=float)
                    if np.isfinite(predicted_mean).any():
                        row["predicted_mean_below_p15"] = float(np.nanmean(predicted_mean))
                    if np.isfinite(predicted_excess).any():
                        row["predicted_p15_tail_excess"] = float(np.nanmean(predicted_excess))
                        row["predicted_average_tail_excess"] = float(np.nanmean(predicted_excess))
                rows.append(row)
    return pd.DataFrame(rows)


def bust_capture(predictions: pd.DataFrame) -> pd.DataFrame:
    """Measure lower-fifth bust selection with a season-wide threshold."""
    complete = predictions.dropna(subset=["actual_score", "baseline_p15", "xgb_p15"]).copy()
    assert_calibration_rows(complete)
    season_cutoffs = complete.groupby("season")["actual_score"].transform(
        lambda values: np.quantile(values, ALPHA, method="linear")
    )
    complete = complete.assign(bust_cutoff=season_cutoffs)
    rows = []
    for (season, position), group in complete.groupby(["season", "position"], sort=True):
        actual = group["actual_score"].to_numpy(dtype=float)
        bust = actual <= group["bust_cutoff"].to_numpy(dtype=float)
        bottom_n = max(1, int(np.ceil(len(group) * 0.20)))
        for model_name, column in (
            ("simulation_baseline", "baseline_p15"),
            ("xgb_projection", "xgb_p15"),
        ):
            ranking = group[column].to_numpy(dtype=float)
            bottom_indexes = np.argsort(ranking, kind="mergesort")[:bottom_n]
            bottom_mask = np.zeros(len(group), dtype=bool)
            bottom_mask[bottom_indexes] = True
            rows.append(
                {
                    "season": int(season),
                    "position": position,
                    "model": model_name,
                    "n": int(len(group)),
                    "bottom_n": bottom_n,
                    "bust_n": int(bust.sum()),
                    "bottom_bust_rate": float(bust[bottom_mask].mean()),
                    "bust_capture": float(bust[bottom_mask].sum() / bust.sum()) if bust.sum() else np.nan,
                    "bust_lift": float(bust[bottom_mask].mean() / bust.mean()) if bust.mean() else np.nan,
                    "bust_threshold_scope": "season",
                    "bust_cutoff": float(group["bust_cutoff"].iloc[0]),
                    "scoring_format": SCORING_FORMAT,
                    "scoring_contract_version": SCORING_CONTRACT_VERSION,
                    "target_quantile": ALPHA,
                    "quantile_label": QUANTILE_LABEL,
                }
            )
    return pd.DataFrame(rows)


def calibration_table(predictions: pd.DataFrame) -> pd.DataFrame:
    """Build empirical P15 calibration bins for both model families."""
    complete = predictions.dropna(subset=["actual_score", "baseline_p15", "xgb_p15"]).copy()
    assert_calibration_rows(complete)
    rows = []
    for model_name, column in (
        ("simulation_baseline", "baseline_p15"),
        ("xgb_projection", "xgb_p15"),
    ):
        complete["p15_bin"] = np.floor(complete[column] + 0.5).astype(int)
        for (season, position, p15_bin), group in complete.groupby(
            ["season", "position", "p15_bin"], sort=True
        ):
            observed = float(np.quantile(group["actual_score"], ALPHA, method="linear"))
            predicted = float(group[column].mean())
            rows.append(
                {
                    "model": model_name,
                    "scoring_format": SCORING_FORMAT,
                    "scoring_contract_version": SCORING_CONTRACT_VERSION,
                    "target_quantile": ALPHA,
                    "quantile_label": QUANTILE_LABEL,
                    "season": int(season),
                    "position": position,
                    "p15_bin": int(p15_bin),
                    "n": int(len(group)),
                    "predicted_p15": predicted,
                    "observed_p15": observed,
                    "bias": observed - predicted,
                }
            )
    return pd.DataFrame(rows)


p15_calibration_table = calibration_table


def importance_table(
    booster: xgb.Booster,
    features: list[str],
    position: str,
    target_season: int,
) -> pd.DataFrame:
    """Return gain importance for one final P15 model."""
    gain = booster.get_score(importance_type="gain")
    rows = [
        {
            "target_season": target_season,
            "position": position,
            "feature": feature,
            "gain": float(gain.get(feature, 0.0)),
            "used_in_tree": feature in gain,
            "scoring_format": SCORING_FORMAT,
            "scoring_contract_version": SCORING_CONTRACT_VERSION,
            "target_quantile": ALPHA,
        }
        for feature in features
    ]
    return pd.DataFrame(rows).sort_values("gain", ascending=False)


def json_safe(value: Any) -> Any:
    """Convert common NumPy values into JSON-compatible values."""
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating,)):
        return float(value)
    if isinstance(value, (np.bool_,)):
        return bool(value)
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, dict):
        return {str(key): json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(item) for item in value]
    return value


def run_experiment(args: argparse.Namespace) -> None:
    """Run the complete walk-forward P15 experiment."""
    root = project_root()
    output_dir = (
        Path(args.output_dir)
        if args.output_dir
        else root / "backtest_fbg_2023_2025" / "outputs" / "xgb_p15_projection"
    )
    output_dir.mkdir(parents=True, exist_ok=True)
    model_dir = output_dir / "models"
    model_dir.mkdir(parents=True, exist_ok=True)

    started = time.perf_counter()
    data, audit = build_dataset(root)
    grid = make_grid()
    if args.max_configs is not None:
        grid = grid[: args.max_configs]
    print(
        f"Rows: {len(data):,}. P15 grid candidates per position and season: {len(grid):,}.",
        flush=True,
    )

    all_predictions = []
    all_grid_results = []
    all_best = []
    all_importance = []
    model_records = []
    for target_season in args.target_seasons:
        prior = data[data["season"].lt(target_season)].copy()
        target = data[data["season"].eq(target_season)].copy()
        if prior.empty or target.empty:
            print(f"Skipping target season {target_season}: missing prior or target rows.", flush=True)
            continue
        assert_walk_forward_split(prior, target, target_season)
        validation_season = int(prior["season"].max())
        validation = prior[
            prior["season"].eq(validation_season)
            & prior["week"].isin(DEFAULT_VALIDATION_WEEKS)
        ].copy()
        inner_train = prior.drop(validation.index).copy()
        if validation.empty or inner_train.empty:
            raise ValueError(f"Cannot form an inner time split for target season {target_season}.")
        if not set(validation["season"].unique()).issubset(prior["season"].unique()):
            raise ValueError("P15 validation rows are outside the prior-season training frame.")
        print(
            f"Target {target_season}: P15 train seasons {sorted(prior['season'].unique())}, "
            f"validation {validation_season} weeks {DEFAULT_VALIDATION_WEEKS}.",
            flush=True,
        )
        for position in POSITIONS:
            position_inner_train = inner_train[inner_train["position"].eq(position)]
            position_validation = validation[validation["position"].eq(position)]
            position_prior = prior[prior["position"].eq(position)]
            position_target = target[target["position"].eq(position)]
            if position_validation.empty or position_target.empty:
                print(f"  Skipping {position} {target_season}: no validation or target rows.", flush=True)
                continue
            best_settings, grid_results, features = choose_model(
                position_inner_train,
                position_validation,
                position,
                target_season,
                grid,
                args,
            )
            assert_feature_columns(features)
            grid_results["training_seasons"] = ",".join(
                str(value) for value in sorted(prior["season"].unique())
            )
            grid_results["validation_season"] = validation_season
            all_grid_results.append(grid_results)
            best_record = {
                "target_season": target_season,
                "position": position,
                "training_seasons": ",".join(str(value) for value in sorted(prior["season"].unique())),
                "validation_season": validation_season,
                "validation_weeks": ",".join(str(value) for value in DEFAULT_VALIDATION_WEEKS),
                "feature_count": len(features),
                "features": ",".join(features),
                **best_settings,
                "inner_validation_pinball": float(grid_results.iloc[0]["validation_pinball"]),
                "inner_validation_coverage": float(grid_results.iloc[0]["validation_coverage"]),
                "scoring_format": SCORING_FORMAT,
                "scoring_contract_version": SCORING_CONTRACT_VERSION,
                "target_quantile": ALPHA,
                "quantile_label": QUANTILE_LABEL,
                "max_historical_season_used": int(prior["season"].max()),
                "features_contain_outcomes": False,
                "features_contain_legacy_scoring_fields": False,
            }
            all_best.append(best_record)
            seed = 20260904 + target_season * 100 + POSITIONS.index(position)
            final_model = fit_final_model(position_prior, features, best_settings, args.nthread, seed)
            model_path = model_dir / f"xgb_p15_{position.lower()}_through_{target_season - 1}.json"
            final_model.save_model(str(model_path))
            all_importance.append(importance_table(final_model, features, position, target_season))
            model_records.append(
                {
                    "target_season": target_season,
                    "position": position,
                    "model_path": str(model_path.relative_to(output_dir)),
                    "training_rows": len(position_prior),
                    "feature_count": len(features),
                    "features": ",".join(features),
                    "boosting_rounds": int(best_settings["boosting_rounds"]),
                    "training_seasons": ",".join(
                        str(value) for value in sorted(position_prior["season"].unique())
                    ),
                    "max_historical_season_used": int(position_prior["season"].max()),
                    "scoring_format": SCORING_FORMAT,
                    "scoring_contract_version": SCORING_CONTRACT_VERSION,
                    "target_quantile": ALPHA,
                    "quantile_label": QUANTILE_LABEL,
                    "features_contain_outcomes": False,
                    "features_contain_legacy_scoring_fields": False,
                }
            )
            target_features = to_dmatrix(position_target, features, with_label=False)
            prediction = np.maximum(
                0.0,
                final_model.predict(
                    target_features,
                    iteration_range=(0, int(best_settings["boosting_rounds"])),
                ),
            )
            prediction_frame = position_target[list(KEY_COLUMNS)].copy()
            prediction_frame["actual_score"] = position_target["actual_score"].to_numpy(dtype=float)
            prediction_frame["baseline_p15"] = position_target["p15"].to_numpy(dtype=float)
            prediction_frame["baseline_p50"] = position_target["p50"].to_numpy(dtype=float)
            prediction_frame["baseline_p85"] = position_target["p85"].to_numpy(dtype=float)
            prediction_frame["baseline_mean_below_p15"] = position_target[
                "mean_below_p15"
            ].to_numpy(dtype=float)
            prediction_frame["baseline_p15_tail_excess"] = position_target[
                "p15_tail_excess"
            ].to_numpy(dtype=float)
            prediction_frame["xgb_p15"] = prediction
            prediction_frame["model_target_season"] = target_season
            prediction_frame["model_training_seasons"] = ",".join(
                str(value) for value in sorted(prior["season"].unique())
            )
            prediction_frame["model_position"] = position
            prediction_frame["max_historical_season_used"] = int(prior["season"].max())
            prediction_frame["target_quantile"] = ALPHA
            prediction_frame["quantile_label"] = QUANTILE_LABEL
            prediction_frame["scoring_format"] = SCORING_FORMAT
            prediction_frame["scoring_contract_version"] = SCORING_CONTRACT_VERSION
            all_predictions.append(prediction_frame)
            print(
                f"  {position} {target_season}: selected P15 pinball "
                f"{best_record['inner_validation_pinball']:.4f}; "
                f"rounds {best_settings['boosting_rounds']}; OOS rows {len(position_target):,}.",
                flush=True,
            )

    if not all_predictions:
        raise RuntimeError("The P15 experiment produced no target-season predictions.")
    predictions = pd.concat(all_predictions, ignore_index=True)
    assert_calibration_rows(predictions)
    grid_results = pd.concat(all_grid_results, ignore_index=True)
    best_results = pd.DataFrame(all_best)
    importance = pd.concat(all_importance, ignore_index=True)
    metrics = summarize_metrics(predictions)
    bust = bust_capture(predictions)
    calibration = calibration_table(predictions)

    predictions.to_parquet(output_dir / "predictions.parquet", index=False)
    grid_results.to_csv(output_dir / "grid_results.csv", index=False)
    best_results.to_csv(output_dir / "selected_models.csv", index=False)
    importance.to_csv(output_dir / "feature_importance.csv", index=False)
    metrics.to_csv(output_dir / "metrics.csv", index=False)
    bust.to_csv(output_dir / "bust_capture.csv", index=False)
    calibration.to_csv(output_dir / "p15_calibration.csv", index=False)

    metadata = {
        "experiment": "direct_xgboost_p15_ppr_with_fbg_projection_data",
        "scoring_format": SCORING_FORMAT,
        "scoring_contract_version": SCORING_CONTRACT_VERSION,
        "target_column": "actual_score",
        "projection_score_field": "projection_fpts",
        "objective": "reg:quantileerror",
        "quantile_alpha": ALPHA,
        "target_quantile": ALPHA,
        "quantile_label": QUANTILE_LABEL,
        "metric": "p15_pinball",
        "positions": list(POSITIONS),
        "target_seasons_requested": list(args.target_seasons),
        "target_seasons_scored": sorted(predictions["model_target_season"].unique().tolist()),
        "max_historical_season_used": int(
            max(record["max_historical_season_used"] for record in model_records)
        ),
        "max_historical_season_used_by_target": {
            str(target_season): int(target_season - 1)
            for target_season in sorted(predictions["model_target_season"].unique().tolist())
        },
        "projection_seasons_available": sorted(data["season"].unique().tolist()),
        "initial_warmup_season": int(data["season"].min()),
        "grid_candidates_per_position_and_target": len(grid),
        "grid_definition": {
            "max_depth": [2, 3, 4],
            "min_child_weight": [1.0, 5.0, 15.0],
            "subsample": [0.70, 0.90],
            "colsample_bytree": [0.70, 1.00],
            "learning_rate": [0.03, 0.06],
            "reg_lambda": [1.0, 5.0],
        },
        "max_rounds": args.max_rounds,
        "early_stopping_rounds": args.early_stopping_rounds,
        "validation_weeks": list(DEFAULT_VALIDATION_WEEKS),
        "nthread": args.nthread,
        "seed_policy": "20260904 + target_season * 100 + position_index",
        "feature_families": {
            "rank_summary": list(RANK_FEATURES),
            "raw_projection_stats": list(PROJECTION_COLUMNS),
            "derived_projection": ["projection_fpts"],
        },
        "data_audit": audit,
        "leakage_checks": {
            "training_rows_before_target_season": True,
            "target_outcomes_excluded_from_training": True,
            "features_contain_target_or_future_outcomes": False,
            "features_contain_legacy_scoring_fields": False,
            "calibration_uses_target_season_outcomes_only_after_prediction": True,
            "calibration_contains_future_scores": False,
            "walk_forward_temporal_order": True,
        },
        "model_records": model_records,
        "runtime": {
            "python": os.sys.version,
            "xgboost": xgb.__version__,
            "pandas": pd.__version__,
            "numpy": np.__version__,
        },
        "elapsed_seconds": time.perf_counter() - started,
    }
    (output_dir / "metadata.json").write_text(
        json.dumps(json_safe(metadata), indent=2), encoding="utf-8"
    )

    print("\nOOS PPR P15 metrics by position and model:", flush=True)
    report = metrics[metrics["group"].eq("position")]
    print(
        report[
            [
                "position",
                "model",
                "n",
                "p15_coverage",
                "p15_pinball_loss",
                "calibration_slope",
                "calibration_intercept",
                "p15_bias",
                "p15_mae",
                "p15_rmse",
                "low_side_miss_rate",
                "mean_below_p15",
                "p15_tail_excess",
                "interval_coverage",
            ]
        ].to_string(index=False),
        flush=True,
    )
    print(f"\nWrote P15 experiment artifacts to {output_dir}", flush=True)


if __name__ == "__main__":
    run_experiment(parse_args())
