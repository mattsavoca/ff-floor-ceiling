"""Walk-forward XGBoost PPR p85 experiment with Footballguys projections.

This experiment is separate from the rank-conditioned simulation. It trains
one direct p85 quantile model for each skill position. The model uses the
Footballguys consensus stat projections and rank-summary features.

The experiment uses season-level walk-forward evaluation. It selects grid
settings on the last four weeks of the most recent training season, refits the
selected settings on all prior seasons, and scores the next season.
"""

from __future__ import annotations

import argparse
import itertools
import json
import os
import re
import time
from pathlib import Path
from typing import Any, Iterable

import numpy as np
import pandas as pd
import xgboost as xgb


SCORING_FORMAT = "PPR"
SCORING_CONTRACT_VERSION = "ppr_v1"
ALPHA = 0.85
POSITIONS = ("QB", "RB", "WR", "TE")
DEFAULT_TARGET_SEASONS = (2024, 2025)
DEFAULT_MAX_ROUNDS = 700
DEFAULT_EARLY_STOPPING_ROUNDS = 50
DEFAULT_VALIDATION_WEEKS = (14, 15, 16, 17)

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
    "baseline_p15",
    "baseline_p50",
    "baseline_p85",
    "baseline_mean_above_p85",
    "baseline_p85_tail_excess",
    "xgb_p85",
}


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
        help="Optional output directory. Defaults to outputs/xgb_p85_projection.",
    )
    args = parser.parse_args()
    target_seasons = tuple(
        sorted({int(value.strip()) for value in args.target_seasons.split(",") if value.strip()})
    )
    if not target_seasons:
        parser.error("--target-seasons must contain at least one season.")
    if args.max_rounds < 1:
        parser.error("--max-rounds must be positive.")
    if args.early_stopping_rounds < 1:
        parser.error("--early-stopping-rounds must be positive.")
    if args.max_configs is not None and args.max_configs < 1:
        parser.error("--max-configs must be positive.")
    if args.nthread < 1:
        parser.error("--nthread must be positive.")
    args.target_seasons = target_seasons
    return args


def project_root() -> Path:
    """Return the repository root for this script.

    Returns
    -------
    pathlib.Path
        Repository root path.
    """
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
    """Reject outcome or future-result fields from XGBoost features."""
    leaked = sorted(set(features).intersection(OUTCOME_COLUMNS))
    if leaked:
        raise ValueError(f"XGBoost features contain outcome columns: {leaked}")


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
            f"XGBoost training rows for {target_season} contain target or future seasons: {invalid_prior}"
        )
    if invalid_target:
        raise ValueError(
            f"XGBoost target rows for {target_season} contain unexpected seasons: {invalid_target}"
        )
    if prior_seasons and max(prior_seasons) >= target_season:
        raise ValueError(f"XGBoost training history is not strictly earlier than {target_season}.")


def pinball_loss(actual: np.ndarray, prediction: np.ndarray, alpha: float = ALPHA) -> float:
    """Calculate mean pinball loss for one quantile.

    Parameters
    ----------
    actual : numpy.ndarray
        Observed scores.
    prediction : numpy.ndarray
        Predicted quantile values.
    alpha : float, optional
        Quantile level, by default 0.85.

    Returns
    -------
    float
        Mean pinball loss.
    """
    residual = np.asarray(actual, dtype=float) - np.asarray(prediction, dtype=float)
    losses = np.where(residual >= 0.0, alpha * residual, (alpha - 1.0) * residual)
    return float(np.mean(losses))


def pinball_metric(prediction: np.ndarray, dmatrix: xgb.DMatrix) -> tuple[str, float]:
    """Return the p85 pinball metric for XGBoost evaluation.

    Parameters
    ----------
    prediction : numpy.ndarray
        Model predictions.
    dmatrix : xgboost.DMatrix
        Evaluation data with labels.

    Returns
    -------
    tuple[str, float]
        Metric name and value.
    """
    return "p85_pinball", pinball_loss(dmatrix.get_label(), prediction)


def make_grid() -> list[dict[str, Any]]:
    """Build the bounded p85 parameter grid.

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
    """Combine fixed and searched XGBoost parameters.

    Parameters
    ----------
    settings : dict[str, Any]
        Searched parameters.
    nthread : int
        Number of training threads.
    seed : int
        Random seed.

    Returns
    -------
    dict[str, Any]
        Complete XGBoost parameter dictionary.
    """
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


def read_consensus_projections(root: Path) -> pd.DataFrame:
    """Read consensus projection rows from all cached FBG weeks.

    Parameters
    ----------
    root : pathlib.Path
        Repository root.

    Returns
    -------
    pandas.DataFrame
        One consensus projection row per player, week, and position.
    """
    raw_root = root / "backtest_fbg_2023_2025" / "data" / "raw" / "fbg"
    usecols = ["id", "pos", "team", "set-id", "set-name", *PROJECTION_COLUMNS]
    selection_path = root / "backtest_fbg_2023_2025" / "data" / "derived" / "fbg_set_selection.csv"
    selection = pd.read_csv(selection_path, dtype={"season": "int64", "week": "int64", "set_id": "string"})
    selection["set_name"] = selection["set_name"].astype("string").str.strip().str.lower()
    selected = selection[
        selection["selected"].astype("string").str.upper().eq("TRUE")
        & selection["set_name"].eq("projections consensus")
    ].copy()
    selected_set_ids = {
        (int(row.season), int(row.week)): str(row.set_id)
        for row in selected.itertuples(index=False)
    }
    frames = []
    for path in sorted(raw_root.glob("season=*/week=*.csv")):
        match = re.search(r"season=(\d+)[\\/]week=(\d+)\.csv$", str(path))
        if match is None:
            raise ValueError(f"Cannot parse season and week from {path}.")
        season, week = (int(value) for value in match.groups())
        raw = pd.read_csv(path, usecols=usecols, low_memory=False)
        set_name = raw["set-name"].astype("string").str.strip().str.lower()
        selected_set_id = selected_set_ids.get((season, week))
        if selected_set_id is None:
            raise ValueError(f"No selected consensus set exists for {season} week {week}.")
        consensus = raw.loc[
            set_name.eq("projections consensus")
            & raw["set-id"].astype("string").eq(selected_set_id)
        ].copy()
        consensus["season"] = season
        consensus["week"] = week
        consensus["fbg_id"] = consensus.pop("id").astype("string").str.strip()
        consensus["position"] = consensus.pop("pos").astype("string").str.strip().str.upper()
        consensus["team"] = consensus["team"].astype("string").str.strip().str.upper()
        consensus = consensus[
            consensus["position"].isin(POSITIONS)
            & consensus["team"].notna()
            & consensus["team"].ne("FA")
        ]
        consensus = consensus.drop(columns=["team", "set-id", "set-name"])
        frames.append(consensus)
    if not frames:
        raise FileNotFoundError(f"No cached FBG CSV files found under {raw_root}.")
    output = pd.concat(frames, ignore_index=True)
    duplicate_mask = output.duplicated(list(KEY_COLUMNS), keep=False)
    if duplicate_mask.any():
        duplicates = output.loc[duplicate_mask, list(KEY_COLUMNS)].head(5).to_dict("records")
        raise ValueError(f"Consensus projections contain duplicate keys: {duplicates}")
    return output


def projection_score(frame: pd.DataFrame) -> pd.Series:
    """Calculate PPR projection points from raw FBG stat projections.

    Parameters
    ----------
    frame : pandas.DataFrame
        Consensus projection rows.

    Returns
    -------
    pandas.Series
        Projected fantasy score for each row.
    """
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
        + values["rec-rec"] * 1.0
        - values["fum-lost"] * 2.0
    )


def build_dataset(root: Path) -> tuple[pd.DataFrame, dict[str, Any]]:
    """Join rank summaries, raw projections, and baseline p85 output.

    Parameters
    ----------
    root : pathlib.Path
        Repository root.

    Returns
    -------
    tuple[pandas.DataFrame, dict[str, Any]]
        Modeling data and join audit values.
    """
    backtest_root = root / "backtest_fbg_2023_2025"
    summary_path = backtest_root / "data" / "derived" / "fbg_rank_summary.parquet"
    baseline_path = backtest_root / "outputs" / "player_predictions.parquet"
    summary_columns = [
        *KEY_COLUMNS,
        "gsis_id",
        "ecr",
        "rank_sd",
        "n_projectors",
        "rank_min",
        "rank_max",
        "consensus_rank",
        "consensus_projected_score",
        "actual_score",
        "scoring_format",
        "scoring_contract_version",
    ]
    summary = pd.read_parquet(summary_path, columns=summary_columns)
    require_ppr_artifact(summary, "FBG rank summary")
    summary["position"] = summary["position"].astype("string").str.upper()
    summary = summary[summary["position"].isin(POSITIONS)].copy()
    summary["fbg_id"] = summary["fbg_id"].astype("string").str.strip()

    projections = read_consensus_projections(root)
    projections["projection_fpts"] = projection_score(projections)
    merged = summary.merge(
        projections,
        on=list(KEY_COLUMNS),
        how="left",
        validate="one_to_one",
        indicator="projection_join",
    )
    join_counts = merged["projection_join"].value_counts(dropna=False).to_dict()
    if join_counts.get("left_only", 0) or join_counts.get("right_only", 0):
        raise ValueError(f"Projection join did not conserve keys: {join_counts}")

    baseline_columns = [
        *KEY_COLUMNS,
        "p15",
        "p50",
        "p85",
        "mean_above_p85",
        "p85_tail_excess",
        "scoring_format",
        "scoring_contract_version",
    ]
    baseline_raw = pd.read_parquet(baseline_path, columns=baseline_columns)
    require_ppr_artifact(baseline_raw, "ffsimulator player predictions")
    baseline = baseline_raw.drop(columns=["scoring_format", "scoring_contract_version"])
    baseline["position"] = baseline["position"].astype("string").str.upper()
    baseline["fbg_id"] = baseline["fbg_id"].astype("string").str.strip()
    baseline_duplicates = baseline.duplicated(list(KEY_COLUMNS), keep=False)
    if baseline_duplicates.any():
        duplicates = baseline.loc[baseline_duplicates, list(KEY_COLUMNS)].head(5).to_dict("records")
        raise ValueError(f"Baseline predictions contain duplicate keys: {duplicates}")
    merged = merged.merge(
        baseline,
        on=list(KEY_COLUMNS),
        how="left",
        validate="one_to_one",
    )
    for column in [
        *RANK_FEATURES,
        *PROJECTION_COLUMNS,
        "projection_fpts",
        "actual_score",
        "p15",
        "p50",
        "p85",
        "mean_above_p85",
        "p85_tail_excess",
    ]:
        if column in merged:
            merged[column] = pd.to_numeric(merged[column], errors="coerce")
    projection_difference = (
        merged["consensus_projected_score"] - merged["projection_fpts"]
    ).abs()
    max_projection_difference = float(projection_difference.max())
    if not np.isfinite(max_projection_difference) or max_projection_difference > 1e-8:
        raise ValueError(
            "R and Python PPR projection scores do not match. "
            f"Maximum absolute difference: {max_projection_difference}"
        )
    merged["model_eligible"] = (
        merged["gsis_id"].notna()
        & merged["n_projectors"].ge(3)
        & merged["actual_score"].notna()
        & merged["projection_fpts"].notna()
    )
    eligible = merged[merged["model_eligible"]].copy()
    if eligible.empty:
        raise ValueError("No model-eligible rows remain after the panel filters.")
    assert_feature_columns([column for column in [*RANK_FEATURES, *PROJECTION_COLUMNS, "projection_fpts"] if column in eligible])
    audit = {
        "summary_rows": int(len(summary)),
        "consensus_projection_rows": int(len(projections)),
        "projection_join_counts": {str(key): int(value) for key, value in join_counts.items()},
        "baseline_rows": int(len(baseline)),
        "eligible_rows": int(len(eligible)),
        "eligible_by_season_position": {
            f"{int(season)}_{position}": int(count)
            for (season, position), count in eligible.groupby(["season", "position"]).size().items()
        },
        "scoring_format": SCORING_FORMAT,
        "scoring_contract_version": SCORING_CONTRACT_VERSION,
        "outcome_column": "actual_score",
        "feature_outcome_columns": sorted(
            set([*RANK_FEATURES, *PROJECTION_COLUMNS, "projection_fpts"]).intersection(OUTCOME_COLUMNS)
        ),
        "projection_score_max_abs_difference": max_projection_difference,
    }
    return eligible, audit


def feature_columns(frame: pd.DataFrame, position: str) -> list[str]:
    """Return non-constant numeric features for one position.

    Parameters
    ----------
    frame : pandas.DataFrame
        Modeling data.
    position : str
        Position-specific model label.

    Returns
    -------
    list[str]
        Numeric model feature names.
    """
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
    """Convert a modeling frame to one XGBoost DMatrix.

    Parameters
    ----------
    frame : pandas.DataFrame
        Modeling rows.
    features : list[str]
        Feature columns.
    with_label : bool
        Whether to attach actual scores as labels.

    Returns
    -------
    xgboost.DMatrix
        Prepared matrix.
    """
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
    """Fit one grid candidate and score its validation quantile.

    Parameters
    ----------
    train : pandas.DataFrame
        Inner training rows.
    validation : pandas.DataFrame
        Inner validation rows.
    features : list[str]
        Position-specific features.
    settings : dict[str, Any]
        Candidate hyperparameters.
    max_rounds : int
        Maximum boosting rounds.
    early_stopping_rounds : int
        Early stopping patience.
    nthread : int
        Number of XGBoost threads.
    seed : int
        Candidate random seed.

    Returns
    -------
    tuple[xgboost.Booster, dict[str, Any]]
        Fitted booster and validation diagnostics.
    """
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
    """Search the grid for one position and target season.

    Parameters
    ----------
    train : pandas.DataFrame
        Inner training rows.
    validation : pandas.DataFrame
        Inner validation rows.
    position : str
        Position-specific model label.
    target_season : int
        Held-out target season.
    grid : list[dict[str, Any]]
        Candidate settings.
    args : argparse.Namespace
        Experiment settings.

    Returns
    -------
    tuple[dict[str, Any], pandas.DataFrame, list[str]]
        Best settings, all grid diagnostics, and feature names.
    """
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
            }
        )
        results.append(diagnostics)
        if index == 1 or index == total or index % 24 == 0:
            print(f"  {position} {target_season}: grid {index}/{total}", flush=True)
    grid_results = pd.DataFrame(results)
    grid_results = grid_results.sort_values(
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
    """Refit selected settings on all prior-season rows.

    Parameters
    ----------
    train : pandas.DataFrame
        All rows before the target season.
    features : list[str]
        Position-specific features.
    settings : dict[str, Any]
        Selected settings and round count.
    nthread : int
        Number of XGBoost threads.
    seed : int
        Random seed.

    Returns
    -------
    xgboost.Booster
        Final walk-forward model.
    """
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
    """Create PPR quantile and descriptive metrics by model and group.

    Parameters
    ----------
    predictions : pandas.DataFrame
        OOS row-level prediction table.

    Returns
    -------
    pandas.DataFrame
        Long-form metrics table.
    """
    complete = predictions.dropna(subset=["actual_score", "baseline_p85", "xgb_p85"])
    rows = []
    groupings: Iterable[tuple[str, list[str]]] = (
        ("all", []),
        ("season", ["season"]),
        ("position", ["position"]),
        ("season_position", ["season", "position"]),
    )
    for group_name, group_columns in groupings:
        grouped = [((), complete)] if not group_columns else complete.groupby(group_columns, dropna=False, sort=True)
        for group_key, group in grouped:
            if not isinstance(group_key, tuple):
                group_key = (group_key,)
            group_values = dict(zip(group_columns, group_key))
            actual = group["actual_score"].to_numpy(dtype=float)
            for model_name, column in (("simulation_baseline", "baseline_p85"), ("xgb_projection", "xgb_p85")):
                prediction = group[column].to_numpy(dtype=float)
                above = actual > prediction
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
                    "n": int(len(group)),
                    "p15_coverage": np.nan,
                    "p50_coverage": np.nan,
                    "p85_coverage": float(np.mean(actual <= prediction)),
                    "p85_coverage_error": float(np.mean(actual <= prediction) - ALPHA),
                    "p15_pinball_loss": np.nan,
                    "p50_pinball_loss": np.nan,
                    "p85_pinball_loss": pinball_loss(actual, prediction),
                    "p85_bias": float(np.mean(prediction - actual)),
                    "p85_mae": float(np.mean(np.abs(prediction - actual))),
                    "p85_rmse": float(np.sqrt(np.mean((actual - prediction) ** 2))),
                    "mean_p85": float(np.mean(prediction)),
                    "calibration_slope": float(calibration[0]),
                    "calibration_intercept": float(calibration[1]),
                    "p50_mae": np.nan,
                    "p50_rmse": np.nan,
                    "mean_p50": np.nan,
                    "p50_bias": np.nan,
                    "low_side_miss_rate": np.nan,
                    "high_side_miss_rate": float(np.mean(actual > prediction)),
                    "mean_score_above_p85": float(np.mean(actual[above])) if above.any() else np.nan,
                    "average_tail_excess": float(np.mean(actual[above] - prediction[above])) if above.any() else np.nan,
                    "n_above_p85": int(above.sum()),
                    "predicted_mean_above_p85": np.nan,
                    "predicted_average_tail_excess": np.nan,
                    "mae": float(np.mean(np.abs(actual - prediction))),
                    "rmse": float(np.sqrt(np.mean((actual - prediction) ** 2))),
                    "p85_rank_spearman": spearman_correlation(actual, prediction),
                }
                if model_name == "simulation_baseline":
                    lower = group["baseline_p15"].to_numpy(dtype=float)
                    median = group["baseline_p50"].to_numpy(dtype=float)
                    lower_complete = np.isfinite(lower).all() and np.isfinite(median).all()
                    if lower_complete:
                        row.update(
                            {
                                "p15_coverage": float(np.mean(actual <= lower)),
                                "p50_coverage": float(np.mean(actual <= median)),
                                "p15_pinball_loss": pinball_loss(actual, lower, alpha=0.15),
                                "p50_pinball_loss": pinball_loss(actual, median, alpha=0.50),
                                "p50_mae": float(np.mean(np.abs(actual - median))),
                                "p50_rmse": float(np.sqrt(np.mean((actual - median) ** 2))),
                                "mean_p50": float(np.mean(median)),
                                "p50_bias": float(np.mean(median - actual)),
                                "low_side_miss_rate": float(np.mean(actual < lower)),
                                "interval_coverage": float(np.mean((actual >= lower) & (actual <= prediction))),
                                "p15_to_p85_interval_coverage": float(
                                    np.mean((actual >= lower) & (actual <= prediction))
                                ),
                                "mean_interval_width": float(np.mean(prediction - lower)),
                                "mae": float(np.mean(np.abs(actual - median))),
                                "rmse": float(np.sqrt(np.mean((actual - median) ** 2))),
                            }
                        )
                    predicted_mean = group["baseline_mean_above_p85"].to_numpy(dtype=float)
                    predicted_excess = group["baseline_p85_tail_excess"].to_numpy(dtype=float)
                    if np.isfinite(predicted_mean).any():
                        row["predicted_mean_above_p85"] = float(np.nanmean(predicted_mean))
                    if np.isfinite(predicted_excess).any():
                        row["predicted_average_tail_excess"] = float(np.nanmean(predicted_excess))
                rows.append(row)
    return pd.DataFrame(rows)


def boom_capture(predictions: pd.DataFrame) -> pd.DataFrame:
    """Measure upper-fifth boom selection for each model.

    Parameters
    ----------
    predictions : pandas.DataFrame
        OOS row-level prediction table.

    Returns
    -------
    pandas.DataFrame
        Boom rate and capture by season, position, and model.
    """
    rows = []
    complete = predictions.dropna(subset=["actual_score", "baseline_p85", "xgb_p85"])
    # The boom definition is season-wide. Position is used only to report
    # results, so the threshold does not change by position.
    season_cutoffs = complete.groupby("season")["actual_score"].transform(
        lambda values: np.quantile(values, ALPHA, method="linear")
    )
    complete = complete.assign(boom_cutoff=season_cutoffs)
    grouped = complete.groupby(["season", "position"], sort=True)
    for (season, position), group in grouped:
        actual = group["actual_score"].to_numpy(dtype=float)
        boom = actual >= group["boom_cutoff"].to_numpy(dtype=float)
        top_n = max(1, int(np.ceil(len(group) * 0.20)))
        for model_name, column in (("simulation_baseline", "baseline_p85"), ("xgb_projection", "xgb_p85")):
            ranking = group[column].to_numpy(dtype=float)
            top_indexes = np.argsort(-ranking, kind="mergesort")[:top_n]
            top_mask = np.zeros(len(group), dtype=bool)
            top_mask[top_indexes] = True
            rows.append(
                {
                    "season": int(season),
                    "position": position,
                    "model": model_name,
                    "n": int(len(group)),
                    "top_n": top_n,
                    "boom_n": int(boom.sum()),
                    "top_boom_rate": float(boom[top_mask].mean()),
                    "boom_capture": float(boom[top_mask].sum() / boom.sum()) if boom.sum() else np.nan,
                    "boom_lift": float(boom[top_mask].mean() / boom.mean()) if boom.mean() else np.nan,
                    "boom_threshold_scope": "season",
                    "boom_cutoff": float(group["boom_cutoff"].iloc[0]),
                    "scoring_format": SCORING_FORMAT,
                    "scoring_contract_version": SCORING_CONTRACT_VERSION,
                }
            )
    return pd.DataFrame(rows)


def calibration_table(predictions: pd.DataFrame) -> pd.DataFrame:
    """Build empirical p85 calibration bins for both model families.

    Parameters
    ----------
    predictions : pandas.DataFrame
        OOS row-level prediction table.

    Returns
    -------
    pandas.DataFrame
        Calibration rows with counts and empirical p85 values.
    """
    complete = predictions.dropna(subset=["actual_score", "baseline_p85", "xgb_p85"]).copy()
    rows = []
    for model_name, column in (("simulation_baseline", "baseline_p85"), ("xgb_projection", "xgb_p85")):
        complete["p85_bin"] = np.floor(complete[column] + 0.5).astype(int)
        for (season, position, p85_bin), group in complete.groupby(
            ["season", "position", "p85_bin"], sort=True
        ):
            observed = float(np.quantile(group["actual_score"], ALPHA, method="linear"))
            predicted = float(group[column].mean())
            rows.append(
                {
                    "model": model_name,
                    "scoring_format": SCORING_FORMAT,
                    "scoring_contract_version": SCORING_CONTRACT_VERSION,
                    "season": int(season),
                    "position": position,
                    "p85_bin": int(p85_bin),
                    "n": int(len(group)),
                    "predicted_p85": predicted,
                    "observed_p85": observed,
                    "bias": observed - predicted,
                }
            )
    return pd.DataFrame(rows)


def importance_table(
    booster: xgb.Booster,
    features: list[str],
    position: str,
    target_season: int,
) -> pd.DataFrame:
    """Return gain importance for one final model."""
    gain = booster.get_score(importance_type="gain")
    rows = [
        {
            "target_season": target_season,
            "position": position,
            "feature": feature,
            "gain": float(gain.get(feature, 0.0)),
            "used_in_tree": feature in gain,
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
    """Run the complete walk-forward p85 experiment."""
    root = project_root()
    output_dir = Path(args.output_dir) if args.output_dir else root / "backtest_fbg_2023_2025" / "outputs" / "xgb_p85_projection"
    output_dir.mkdir(parents=True, exist_ok=True)
    model_dir = output_dir / "models"
    model_dir.mkdir(parents=True, exist_ok=True)

    started = time.perf_counter()
    data, audit = build_dataset(root)
    require_ppr_artifact(data, "XGBoost model dataset")
    grid = make_grid()
    if args.max_configs is not None:
        grid = grid[: args.max_configs]
    print(f"Rows: {len(data):,}. Grid candidates per position and season: {len(grid):,}.", flush=True)

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
        print(
            f"Target {target_season}: train seasons {sorted(prior['season'].unique())}, "
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
            grid_results["training_seasons"] = ",".join(str(value) for value in sorted(prior["season"].unique()))
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
                "max_historical_season_used": int(prior["season"].max()),
                "features_contain_outcomes": False,
            }
            all_best.append(best_record)
            seed = 20260904 + target_season * 100 + POSITIONS.index(position)
            final_model = fit_final_model(position_prior, features, best_settings, args.nthread, seed)
            model_path = model_dir / f"xgb_p85_{position.lower()}_through_{target_season - 1}.json"
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
                    "features_contain_outcomes": False,
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
            prediction_frame["baseline_mean_above_p85"] = position_target[
                "mean_above_p85"
            ].to_numpy(dtype=float)
            prediction_frame["baseline_p85_tail_excess"] = position_target[
                "p85_tail_excess"
            ].to_numpy(dtype=float)
            prediction_frame["xgb_p85"] = prediction
            prediction_frame["model_target_season"] = target_season
            prediction_frame["model_training_seasons"] = ",".join(
                str(value) for value in sorted(prior["season"].unique())
            )
            prediction_frame["model_position"] = position
            prediction_frame["max_historical_season_used"] = int(prior["season"].max())
            prediction_frame["scoring_format"] = SCORING_FORMAT
            prediction_frame["scoring_contract_version"] = SCORING_CONTRACT_VERSION
            all_predictions.append(prediction_frame)
            print(
                f"  {position} {target_season}: selected p85 pinball "
                f"{best_record['inner_validation_pinball']:.4f}; "
                f"rounds {best_settings['boosting_rounds']}; OOS rows {len(position_target):,}.",
                flush=True,
            )

    if not all_predictions:
        raise RuntimeError("The experiment produced no target-season predictions.")
    predictions = pd.concat(all_predictions, ignore_index=True)
    grid_results = pd.concat(all_grid_results, ignore_index=True)
    best_results = pd.DataFrame(all_best)
    importance = pd.concat(all_importance, ignore_index=True)
    metrics = summarize_metrics(predictions)
    boom = boom_capture(predictions)
    calibration = calibration_table(predictions)

    predictions.to_parquet(output_dir / "predictions.parquet", index=False)
    grid_results.to_csv(output_dir / "grid_results.csv", index=False)
    best_results.to_csv(output_dir / "selected_models.csv", index=False)
    importance.to_csv(output_dir / "feature_importance.csv", index=False)
    metrics.to_csv(output_dir / "metrics.csv", index=False)
    boom.to_csv(output_dir / "boom_capture.csv", index=False)
    calibration.to_csv(output_dir / "p85_calibration.csv", index=False)

    metadata = {
        "experiment": "direct_xgboost_p85_ppr_with_fbg_projection_data",
        "scoring_format": SCORING_FORMAT,
        "scoring_contract_version": SCORING_CONTRACT_VERSION,
        "target_column": "actual_score",
        "projection_score_field": "projection_fpts",
        "objective": "reg:quantileerror",
        "quantile_alpha": ALPHA,
        "metric": "p85_pinball",
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
            "min_child_weight": [1, 5, 15],
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
            "features_contain_target_or_future_outcomes": False,
            "calibration_uses_target_season_outcomes_only_after_prediction": True,
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

    print("\nOOS PPR metrics by position and model:", flush=True)
    report = metrics[metrics["group"].eq("position")]
    print(
        report[
            [
                "position",
                "model",
                "n",
                "p85_coverage",
                "p85_pinball_loss",
                "calibration_slope",
                "calibration_intercept",
                "p85_bias",
                "p85_mae",
                "p85_rmse",
                "high_side_miss_rate",
                "mean_score_above_p85",
                "interval_coverage",
            ]
        ].to_string(index=False),
        flush=True,
    )
    print(f"\nWrote experiment artifacts to {output_dir}", flush=True)


if __name__ == "__main__":
    run_experiment(parse_args())
