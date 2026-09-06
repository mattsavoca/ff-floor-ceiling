"""Scenario scoring for original FBG simulations."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

from .features import aggregate_fbg_draws, add_opponent_qb_features, build_model_features
from .schedule import build_team_game_schedule
from .schemas import FEATURE_COLUMNS, require_columns
from .teams import normalize_team_columns


def _import_xgboost():
    try:
        import xgboost as xgb
    except ImportError as error:
        raise RuntimeError("Install xgboost before scoring the DST model") from error
    return xgb


def read_table(path: str | Path) -> pd.DataFrame:
    """Read CSV or Parquet by file suffix."""

    source = Path(path)
    if source.suffix.lower() in {".parquet", ".pq"}:
        return pd.read_parquet(source)
    return pd.read_csv(source)


def write_table(frame: pd.DataFrame, path: str | Path) -> None:
    """Write CSV or Parquet by file suffix."""

    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.suffix.lower() in {".parquet", ".pq"}:
        frame.to_parquet(destination, index=False, compression="zstd")
    else:
        frame.to_csv(destination, index=False)


def _model_path(model_dir: Path, label: str, target_season: int | None = None) -> Path:
    if target_season is not None:
        candidate = model_dir / f"dst_{label}_target_{target_season}.json"
        if candidate.exists():
            return candidate
    candidate = model_dir / f"dst_{label}_latest.json"
    if candidate.exists():
        return candidate
    candidate = model_dir / f"dst_{label}.json"
    if candidate.exists():
        return candidate
    raise FileNotFoundError(f"No {label} DST model exists in {model_dir}")


def load_model_metadata(model_dir: str | Path) -> dict:
    path = Path(model_dir) / "dst_model_metadata.json"
    if not path.exists():
        raise FileNotFoundError(f"Missing model metadata: {path}")
    metadata = json.loads(path.read_text(encoding="utf-8"))
    if metadata.get("feature_columns") != list(FEATURE_COLUMNS):
        raise ValueError("Model feature contract does not match the Python DST feature version")
    return metadata


def predict_feature_frame(
    features: pd.DataFrame,
    model_dir: str | Path,
    target_season: int | None = None,
) -> pd.DataFrame:
    """Predict point and configured quantile outputs from feature rows."""

    xgb = _import_xgboost()
    require_columns(features, list(FEATURE_COLUMNS), "DST prediction features")
    metadata = load_model_metadata(model_dir)
    dmatrix = xgb.DMatrix(
        features.loc[:, FEATURE_COLUMNS].to_numpy(dtype=np.float32, na_value=np.nan),
        feature_names=list(FEATURE_COLUMNS),
        missing=np.nan,
    )
    model_dir_path = Path(model_dir)
    output = pd.DataFrame(index=features.index)
    for label in ["point", "p15", "p50", "p85"]:
        path = _model_path(model_dir_path, label, target_season=target_season)
        booster = xgb.Booster()
        booster.load_model(path)
        output[f"dst_{label}"] = booster.predict(dmatrix)
    quantile_values = output.loc[:, ["dst_p15", "dst_p50", "dst_p85"]].to_numpy(dtype=float)
    output.loc[:, ["dst_p15", "dst_p50", "dst_p85"]] = np.sort(quantile_values, axis=1)
    output["model_target_season"] = metadata.get("target_season")
    return output


def ensure_schedule_game_ids(schedule: pd.DataFrame, season: int | None = None, week: int | None = None) -> pd.DataFrame:
    """Add deterministic game IDs to a forward schedule when needed."""

    output = schedule.copy()
    if "season" not in output.columns:
        if season is None:
            raise ValueError("schedule has no season column")
        output["season"] = season
    if "week" not in output.columns:
        if week is None:
            raise ValueError("schedule has no week column")
        output["week"] = week
    if "game_id" not in output.columns:
        require_columns(output, ["away_team", "home_team"], "forward schedule")
        output["game_id"] = (
            output["season"].astype(int).astype(str)
            + "_"
            + output["week"].astype(int).map(lambda value: f"{value:02d}")
            + "_"
            + output["away_team"].astype(str)
            + "_"
            + output["home_team"].astype(str)
        )
    return output


def score_fbg_scenarios(
    draws: pd.DataFrame,
    schedule: pd.DataFrame,
    model_dir: str | Path,
    season: int | None = None,
    week: int | None = None,
    pbp: pd.DataFrame | None = None,
) -> pd.DataFrame:
    """Score one DST row per original FBG simulation and team.

    ``projected_score`` is the point prediction. The original FBG player
    simulations remain the source of scenario variation in the offense
    features. Quantile columns describe model uncertainty for the same row.
    """

    schedule = ensure_schedule_game_ids(schedule, season=season, week=week)
    team_games = build_team_game_schedule(schedule)
    if season is not None:
        team_games = team_games[team_games["season"] == int(season)]
    if week is not None:
        team_games = team_games[team_games["week"] == int(week)]
    team_games = add_opponent_qb_features(team_games, pbp=pbp)
    scenarios = aggregate_fbg_draws(
        draws,
        schedule_team_games=team_games,
        default_season=season,
        default_week=week,
    )
    if season is not None:
        scenarios = scenarios[scenarios["season"] == int(season)]
    if week is not None:
        scenarios = scenarios[scenarios["week"] == int(week)]
    features = build_model_features(team_games, offense_scenarios=scenarios, require_simulation=True)
    predictions = predict_feature_frame(features, model_dir=model_dir, target_season=season)
    output = features.loc[:, ["simulation_id", "season", "week", "game_id", "team", "opponent", "game_date_time"]].copy()
    output["position"] = "DST"
    output["player_id"] = "DST_" + output["team"].astype("string")
    output["player_name"] = output["team"].astype("string") + " DST"
    output["active"] = 1
    output["dst_mean"] = predictions["dst_point"].to_numpy()
    output["dst_p15"] = predictions["dst_p15"].to_numpy()
    output["dst_p50"] = predictions["dst_p50"].to_numpy()
    output["dst_p85"] = predictions["dst_p85"].to_numpy()
    output["projected_score"] = output["dst_mean"]
    output["model_target_season"] = predictions["model_target_season"].to_numpy()
    output["feature_as_of"] = features["feature_as_of"].to_numpy() if "feature_as_of" in features.columns else pd.NaT
    output["opponent_qb_history_available"] = features.get(
        "opponent_qb_history_available", pd.Series(0, index=features.index)
    ).to_numpy()
    output["missing_feature_count"] = features.get(
        "missing_feature_count", pd.Series(0, index=features.index)
    ).to_numpy()
    metadata = load_model_metadata(model_dir)
    output["scoring_profile"] = "UPSTREAM_FD_PROFILE"
    output["model_id"] = metadata.get("model_version", "dst-xgb-python-v1")
    output["source"] = "original_fbg_simulator"
    output = output.sort_values(["simulation_id", "team"], kind="stable").reset_index(drop=True)
    return output
