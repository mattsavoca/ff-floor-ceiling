"""Native XGBoost training with game-grouped temporal validation."""

from __future__ import annotations

import itertools
import json
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from .ingest import package_versions
from .schemas import FEATURE_COLUMNS, SCENARIO_KEYS, feature_spec_rows, numeric_features, require_columns


@dataclass(frozen=True)
class TrainConfig:
    """Training controls with a small deterministic tuning grid."""

    max_boost_rounds: int = 1800
    early_stopping_rounds: int = 80
    max_configs: int = 12
    seed: int = 20260906
    nthread: int = 4
    max_bin: int = 256
    quantiles: tuple[float, ...] = (0.15, 0.50, 0.85)
    grid: dict[str, tuple[Any, ...]] = field(
        default_factory=lambda: {
            "max_depth": (3, 5, 7),
            "min_child_weight": (1.0, 5.0),
            "eta": (0.03, 0.06),
            "subsample": (0.75, 0.95),
            "colsample_bytree": (0.75, 1.0),
            "reg_lambda": (1.0, 5.0),
        }
    )

    def __post_init__(self) -> None:
        if self.max_boost_rounds < 1:
            raise ValueError("max_boost_rounds must be positive")
        if self.early_stopping_rounds < 1:
            raise ValueError("early_stopping_rounds must be positive")
        if self.max_configs < 1:
            raise ValueError("max_configs must be positive")
        if self.nthread < 1:
            raise ValueError("nthread must be a positive fixed thread count")


def _import_xgboost():
    try:
        import xgboost as xgb
    except ImportError as error:
        raise RuntimeError("Install xgboost before training the DST model") from error
    return xgb


def _time_sort(frame: pd.DataFrame) -> pd.DataFrame:
    output = frame.copy()
    if "game_date_time" in output.columns:
        output["_sort_time"] = pd.to_datetime(output["game_date_time"], errors="coerce")
    else:
        output["_sort_time"] = pd.NaT
    output["_sort_season"] = pd.to_numeric(output["season"], errors="coerce")
    output["_sort_week"] = pd.to_numeric(output["week"], errors="coerce")
    return output.sort_values(
        ["_sort_time", "_sort_season", "_sort_week", "game_id"],
        na_position="last",
        kind="stable",
    )


def grouped_temporal_split(frame: pd.DataFrame, train_fraction: float = 0.8) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Split whole games in time order so both sides of a game stay together."""

    require_columns(frame, ["season", "week", "game_id", "target"], "DST training panel")
    if not 0.5 <= train_fraction < 1:
        raise ValueError("train_fraction must be at least 0.5 and less than 1")
    games = _time_sort(frame.loc[:, ["season", "week", "game_id", "game_date_time"] if "game_date_time" in frame.columns else ["season", "week", "game_id"]]).drop_duplicates("game_id")
    if len(games) < 2:
        raise ValueError("At least two games are required for a temporal split")
    cut = min(len(games) - 1, max(1, int(math.floor(len(games) * train_fraction))))
    train_games = set(games.iloc[:cut]["game_id"].astype(str))
    train = frame[frame["game_id"].astype(str).isin(train_games)].copy()
    test = frame[~frame["game_id"].astype(str).isin(train_games)].copy()
    if train.empty or test.empty:
        raise ValueError("Temporal split produced an empty partition")
    overlap = set(train["game_id"].astype(str)) & set(test["game_id"].astype(str))
    if overlap:
        raise AssertionError(f"Game-group split leaked game IDs: {sorted(overlap)[:3]}")
    return train.reset_index(drop=True), test.reset_index(drop=True)


def walk_forward_split(frame: pd.DataFrame, validation_season: int) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Use all earlier seasons for training and one season for validation."""

    require_columns(frame, ["season", "week", "game_id", "target"], "DST training panel")
    season = pd.to_numeric(frame["season"], errors="coerce")
    train = frame[season < int(validation_season)].copy()
    validation = frame[season == int(validation_season)].copy()
    if train.empty or validation.empty:
        raise ValueError(f"Need rows before and in validation season {validation_season}")
    overlap = set(train["game_id"].astype(str)) & set(validation["game_id"].astype(str))
    if overlap:
        raise AssertionError(f"Walk-forward split leaked game IDs: {sorted(overlap)[:3]}")
    return train.reset_index(drop=True), validation.reset_index(drop=True)


def _dmat(frame: pd.DataFrame, label: bool = True):
    xgb = _import_xgboost()
    features = numeric_features(frame).to_numpy(dtype=np.float32, na_value=np.nan)
    y = pd.to_numeric(frame["target"], errors="coerce").to_numpy(dtype=np.float32) if label else None
    return xgb.DMatrix(features, label=y, feature_names=list(FEATURE_COLUMNS), missing=np.nan)


def _base_params(config: TrainConfig, objective: str = "reg:squarederror", **params: Any) -> dict[str, Any]:
    output: dict[str, Any] = {
        "objective": objective,
        "tree_method": "hist",
        "max_bin": config.max_bin,
        "seed": config.seed,
        "nthread": config.nthread,
        "verbosity": 0,
    }
    output.update(params)
    return output


def _regression_metrics(actual: np.ndarray, predicted: np.ndarray) -> dict[str, float]:
    error = predicted - actual
    rmse = float(np.sqrt(np.mean(error**2)))
    mae = float(np.mean(np.abs(error)))
    denominator = float(np.sum((actual - np.mean(actual)) ** 2))
    r2 = float(1.0 - np.sum(error**2) / denominator) if denominator > 0 else float("nan")
    return {"rmse": rmse, "mae": mae, "bias": float(np.mean(error)), "r2": r2}


def _pinball_loss(actual: np.ndarray, predicted: np.ndarray, quantile: float) -> float:
    error = actual - predicted
    return float(np.mean(np.maximum(quantile * error, (quantile - 1.0) * error)))


def _candidate_grid(config: TrainConfig) -> list[dict[str, Any]]:
    names = list(config.grid)
    values = [config.grid[name] for name in names]
    candidates = [dict(zip(names, combo)) for combo in itertools.product(*values)]
    rng = np.random.default_rng(config.seed)
    rng.shuffle(candidates)
    return candidates[: max(1, config.max_configs)]


def tune_point_model(train: pd.DataFrame, validation: pd.DataFrame, config: TrainConfig) -> tuple[dict[str, Any], int, pd.DataFrame]:
    """Tune point loss on a game-disjoint validation set."""

    xgb = _import_xgboost()
    train_matrix = _dmat(train)
    validation_matrix = _dmat(validation)
    actual = validation["target"].to_numpy(dtype=float)
    records: list[dict[str, Any]] = []
    best: tuple[float, dict[str, Any], int] | None = None
    for index, candidate in enumerate(_candidate_grid(config), start=1):
        params = _base_params(config, **candidate)
        booster = xgb.train(
            params,
            train_matrix,
            num_boost_round=config.max_boost_rounds,
            evals=[(validation_matrix, "validation")],
            verbose_eval=False,
            early_stopping_rounds=config.early_stopping_rounds,
        )
        rounds = int(getattr(booster, "best_iteration", config.max_boost_rounds - 1)) + 1
        predicted = booster.predict(validation_matrix, iteration_range=(0, rounds))
        metrics = _regression_metrics(actual, predicted)
        record = {"candidate": index, "best_rounds": rounds, **metrics, **candidate}
        records.append(record)
        if best is None or metrics["rmse"] < best[0]:
            best = (metrics["rmse"], params, rounds)
    if best is None:
        raise RuntimeError("The XGBoost tuning grid returned no candidates")
    return best[1], best[2], pd.DataFrame(records).sort_values("rmse").reset_index(drop=True)


def tune_quantile_rounds(
    train: pd.DataFrame,
    validation: pd.DataFrame,
    params: dict[str, Any],
    quantile: float,
    config: TrainConfig,
) -> tuple[int, float]:
    """Select quantile boosting rounds on the same time-ordered holdout."""

    xgb = _import_xgboost()
    quantile_params = dict(params)
    quantile_params["objective"] = "reg:quantileerror"
    quantile_params["quantile_alpha"] = float(quantile)
    train_matrix = _dmat(train)
    validation_matrix = _dmat(validation)
    booster = xgb.train(
        quantile_params,
        train_matrix,
        num_boost_round=config.max_boost_rounds,
        evals=[(validation_matrix, "validation")],
        verbose_eval=False,
        early_stopping_rounds=config.early_stopping_rounds,
    )
    rounds = int(getattr(booster, "best_iteration", config.max_boost_rounds - 1)) + 1
    predicted = booster.predict(validation_matrix, iteration_range=(0, rounds))
    actual = validation["target"].to_numpy(dtype=float)
    return rounds, _pinball_loss(actual, predicted, quantile)


def fit_booster(
    frame: pd.DataFrame,
    params: dict[str, Any],
    rounds: int,
    quantile: float | None = None,
    config: TrainConfig = TrainConfig(),
):
    """Fit one native XGBoost booster."""

    xgb = _import_xgboost()
    fit_params = dict(params)
    if quantile is None:
        fit_params["objective"] = "reg:squarederror"
    else:
        fit_params["objective"] = "reg:quantileerror"
        fit_params["quantile_alpha"] = float(quantile)
    return xgb.train(
        fit_params,
        _dmat(frame),
        num_boost_round=max(1, int(rounds)),
        verbose_eval=False,
    )


def train_production_models(
    panel: pd.DataFrame,
    model_dir: str | Path,
    target_season: int | None = None,
    validation_season: int | None = None,
    config: TrainConfig = TrainConfig(),
) -> dict[str, Any]:
    """Tune on the last prior season and fit production point/quantile models."""

    require_columns(panel, ["season", "week", "game_id", "target", *FEATURE_COLUMNS], "DST training panel")
    source = panel[pd.to_numeric(panel["target"], errors="coerce").notna()].copy()
    source["season"] = pd.to_numeric(source["season"], errors="coerce").astype(int)
    available_seasons = sorted(source["season"].unique())
    if len(available_seasons) < 2:
        raise ValueError("At least two seasons are required for DST walk-forward training")
    if target_season is None:
        target_season = max(available_seasons) + 1
    history = source[source["season"] < target_season].copy()
    if validation_season is None:
        validation_season = max(int(season) for season in available_seasons if season < target_season)
    prior_seasons = [int(season) for season in available_seasons if season < validation_season]
    if prior_seasons:
        train_for_tuning, validation = walk_forward_split(history, validation_season)
    else:
        # A first historical season has no earlier season for a walk-forward
        # fold. Use a game-grouped temporal split inside that season and keep
        # the fallback explicit in metadata.
        train_for_tuning, validation = grouped_temporal_split(history, train_fraction=0.8)
        validation_season = int(validation["season"].max())
    best_params, best_rounds, tuning = tune_point_model(train_for_tuning, validation, config)
    validation_booster = fit_booster(train_for_tuning, best_params, best_rounds, config=config)
    final_train = source[source["season"] < target_season].reset_index(drop=True)
    point = fit_booster(final_train, best_params, best_rounds, config=config)

    output_dir = Path(model_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    point_path = output_dir / f"dst_point_target_{target_season}.json"
    point.save_model(point_path)
    quantile_paths: dict[str, str] = {}
    quantile_rounds: dict[str, int] = {}
    quantile_validation_metrics: dict[str, dict[str, float]] = {}
    for quantile in config.quantiles:
        rounds, validation_pinball = tune_quantile_rounds(
            train_for_tuning,
            validation,
            best_params,
            quantile,
            config,
        )
        quantile_model = fit_booster(final_train, best_params, rounds, quantile=quantile, config=config)
        label = f"p{int(round(quantile * 100)):02d}"
        path = output_dir / f"dst_{label}_target_{target_season}.json"
        quantile_model.save_model(path)
        quantile_paths[label] = str(path)
        quantile_rounds[label] = int(rounds)
        quantile_validation_metrics[label] = {"pinball_loss": float(validation_pinball)}
    latest_paths = {
        "point": output_dir / "dst_point_latest.json",
        **{label: output_dir / f"dst_{label}_latest.json" for label in quantile_paths},
    }
    for path, source_path in [(latest_paths["point"], point_path), *[(latest_paths[label], Path(path)) for label, path in quantile_paths.items()]]:
        path.write_bytes(source_path.read_bytes())

    tuning_path = output_dir / f"dst_tuning_target_{target_season}.csv"
    tuning.to_csv(tuning_path, index=False)
    feature_spec_path = output_dir / "dst_feature_spec.csv"
    pd.DataFrame(feature_spec_rows()).to_csv(feature_spec_path, index=False)
    metadata = {
        "model_version": "dst-xgb-python-v1",
        "target_season": int(target_season),
        "validation_season": int(validation_season),
        "training_seasons": sorted(int(value) for value in final_train["season"].unique()),
        "validation_rows": int(len(validation)),
        "validation_games": int(validation["game_id"].nunique()),
        "training_rows": int(len(final_train)),
        "training_games": int(final_train["game_id"].nunique()),
        "feature_columns": list(FEATURE_COLUMNS),
        "feature_spec": feature_spec_rows(),
        "excluded_upstream_features": ["days_in_past"],
        "target": "dst_fd_pts",
        "scoring_profile": "UPSTREAM_FD_PROFILE",
        "best_params": best_params,
        "best_rounds": int(best_rounds),
        "quantile_rounds": quantile_rounds,
        "point_validation_metrics": _regression_metrics(
            validation["target"].to_numpy(dtype=float),
            validation_booster.predict(_dmat(validation), iteration_range=(0, best_rounds)),
        ),
        "quantiles": list(config.quantiles),
        "quantile_validation_metrics": quantile_validation_metrics,
        "artifacts": {
            "point": str(point_path),
            "quantiles": quantile_paths,
            "tuning": str(tuning_path),
            "feature_spec": str(feature_spec_path),
        },
        "package_versions": package_versions(),
    }
    metadata_path = output_dir / "dst_model_metadata.json"
    metadata_path.write_text(json.dumps(metadata, indent=2, default=str), encoding="utf-8")
    return metadata
