"""Pregame feature engineering shared by historical and forward scoring."""

from __future__ import annotations

from collections.abc import Mapping
import warnings

import numpy as np
import pandas as pd

from .schedule import build_team_game_schedule
from .schemas import (
    FEATURE_COLUMNS,
    SCENARIO_KEYS,
    SIM_POSITION_COLUMNS,
    SIMULATION_DRAW_COLUMNS,
    TEAM_GAME_KEYS,
    assert_unique,
    numeric_features,
    require_columns,
)
from .teams import normalize_team_columns


DEFAULT_RANK_LIMITS = {"QB": 33, "RB": 70, "WR": 70, "TE": 48, "K": 33}


def _numeric_series(frame: pd.DataFrame, column: str, default: float = np.nan) -> pd.Series:
    if column not in frame.columns:
        return pd.Series(default, index=frame.index, dtype="float64")
    return pd.to_numeric(frame[column], errors="coerce")


def _as_flag(values: pd.Series) -> pd.Series:
    if values.dtype == bool:
        return values.astype("float64")
    text = values.astype("string").str.lower().str.strip()
    true_values = text.isin(["1", "true", "yes", "y"])
    numeric = pd.to_numeric(values, errors="coerce")
    return numeric.where(numeric.notna(), true_values.astype(float)).fillna(0.0).astype(float)


def _parse_game_hour(values: pd.Series) -> pd.Series:
    text = values.astype("string").str.extract(r"(\d{1,2}):(\d{2})", expand=True)
    hour = pd.to_numeric(text[0], errors="coerce")
    minute = pd.to_numeric(text[1], errors="coerce")
    parsed = hour + minute / 60.0
    missing = parsed.isna()
    timestamps = pd.to_datetime(values, format="%H:%M", errors="coerce")
    if timestamps.isna().all():
        timestamps = pd.to_datetime(values, errors="coerce")
    parsed.loc[missing] = timestamps.dt.hour.loc[missing] + timestamps.dt.minute.loc[missing] / 60.0
    return parsed


def _weighted_qb_efficiency(
    qb_id: object,
    season: int,
    week: int,
    history: Mapping[str, pd.DataFrame],
) -> tuple[float, float, bool]:
    if qb_id is None or pd.isna(qb_id):
        return 0.0, 0.0, False
    key = str(qb_id)
    source = history.get(key)
    if source is None or source.empty:
        return 0.0, 0.0, False
    eligible = source[(source["season"] < season) | ((source["season"] == season) & (source["week"] < week))]
    if eligible.empty:
        return 0.0, 0.0, False
    plays = eligible.head(500).copy()
    if float(plays["pass_attempt"].sum()) <= 10:
        return 0.0, 0.0, False
    n_plays = len(plays)
    recency = np.arange(1, n_plays + 1, dtype=float)
    weights = np.where(recency <= 0.25 * n_plays, 2.0, np.where(recency <= 0.75 * n_plays, 1.0, 0.5))
    epa = pd.to_numeric(plays["epa"], errors="coerce").to_numpy(dtype=float)
    cpoe = pd.to_numeric(plays["cpoe"], errors="coerce").to_numpy(dtype=float)

    def weighted_mean(values: np.ndarray) -> float:
        valid = np.isfinite(values)
        if not valid.any():
            return 0.0
        return float(np.average(values[valid], weights=weights[valid]))

    return weighted_mean(epa), weighted_mean(cpoe), True


def _prepare_qb_history(pbp: pd.DataFrame) -> dict[str, pd.DataFrame]:
    """Extract the same pass, scramble, and QB rush rows as the R ETL."""

    required = ["season", "week", "game_id", "play_id", "qb_dropback", "pass_attempt", "rush_attempt"]
    require_columns(pbp, required, "play-by-play")
    source = pbp.copy()
    source["season"] = pd.to_numeric(source["season"], errors="coerce")
    source["week"] = pd.to_numeric(source["week"], errors="coerce")
    source["play_id"] = pd.to_numeric(source["play_id"], errors="coerce")
    qb_dropback = _numeric_series(source, "qb_dropback", 0).fillna(0)
    pass_attempt = _numeric_series(source, "pass_attempt", 0).fillna(0)
    rush_attempt = _numeric_series(source, "rush_attempt", 0).fillna(0)
    pass_rows = (qb_dropback == 1) & (pass_attempt == 1)
    scramble_rows = (qb_dropback == 1) & (pass_attempt == 0) & (rush_attempt == 1)
    rush_rows = (qb_dropback == 0) & (rush_attempt == 1)
    selected = source.loc[pass_rows | scramble_rows | rush_rows].copy()
    if selected.empty:
        return {}
    selected["player_id"] = pd.NA
    selected.loc[pass_rows.loc[selected.index], "player_id"] = selected.loc[pass_rows.loc[selected.index], "passer_player_id"] if "passer_player_id" in selected.columns else pd.NA
    non_pass = (~pass_rows & (scramble_rows | rush_rows)).loc[selected.index]
    if "rusher_player_id" in selected.columns:
        selected.loc[non_pass, "player_id"] = selected.loc[non_pass, "rusher_player_id"]
    selected["pass_attempt"] = pass_attempt.loc[selected.index].astype(float)
    selected["epa"] = _numeric_series(selected, "epa", np.nan)
    selected["cpoe"] = _numeric_series(selected, "cpoe", np.nan)
    selected = selected[selected["player_id"].notna() & selected["season"].notna() & selected["week"].notna()]
    selected["player_id"] = selected["player_id"].astype("string")
    selected = selected.sort_values(["player_id", "season", "week", "play_id"], ascending=[True, False, False, False], kind="stable")
    return {key: group.reset_index(drop=True) for key, group in selected.groupby("player_id", sort=False)}


def add_opponent_qb_features(team_games: pd.DataFrame, pbp: pd.DataFrame | None = None) -> pd.DataFrame:
    """Add leakage-safe weighted opponent QB EPA and CPOE."""

    output = team_games.copy()
    if pbp is None or pbp.empty:
        output["opponent_qb_epa"] = 0.0
        output["opponent_qb_cpoe"] = 0.0
        output["opponent_qb_history_available"] = 0
        return output
    history = _prepare_qb_history(pbp)
    metrics = [
        _weighted_qb_efficiency(qb_id, int(season), int(week), history)
        for qb_id, season, week in zip(output["opponent_qb_id"], output["season"], output["week"])
    ]
    output["opponent_qb_epa"] = [value[0] for value in metrics]
    output["opponent_qb_cpoe"] = [value[1] for value in metrics]
    output["opponent_qb_history_available"] = [int(value[2]) for value in metrics]
    return output


def aggregate_fbg_draws(
    draws: pd.DataFrame,
    schedule_team_games: pd.DataFrame | None = None,
    default_season: int | None = None,
    default_week: int | None = None,
    rank_limits: Mapping[str, int] | None = None,
    require_original: bool = True,
) -> pd.DataFrame:
    """Aggregate original FBG player draws into scenario team offense fields."""

    required = ["simulation_id", "week", "position", "team", "projected_score"]
    require_columns(draws, required, "FBG player draws")
    source = draws.copy()
    if "simulation_mode" not in source.columns:
        if require_original:
            raise ValueError(
                "FBG player draws must include simulation_mode=original_fbg. "
                "Rerun the original player simulation export before building DST inputs."
            )
    else:
        modes = source["simulation_mode"].dropna().astype("string").str.lower().unique().tolist()
        if any(mode != "original_fbg" for mode in modes):
            raise ValueError(
                "DST scenarios must come from the original FBG simulator path. "
                f"Received modes: {', '.join(sorted(modes))}"
            )
    if "season" not in source.columns:
        if default_season is None:
            raise ValueError("FBG player draws has no season column and default_season was not supplied")
        source["season"] = default_season
    if default_week is not None:
        source["week"] = default_week
    source["position"] = source["position"].astype("string").str.upper().str.strip()
    source = normalize_team_columns(source, ["team"])
    source["simulation_id"] = pd.to_numeric(source["simulation_id"], errors="coerce")
    source["season"] = pd.to_numeric(source["season"], errors="coerce")
    source["week"] = pd.to_numeric(source["week"], errors="coerce")
    source["projected_score"] = pd.to_numeric(source["projected_score"], errors="coerce").fillna(0.0)
    source = source[source["position"].isin(SIM_POSITION_COLUMNS) & source["team"].notna() & source["simulation_id"].notna()]
    limits = dict(DEFAULT_RANK_LIMITS if rank_limits is None else rank_limits)
    if "rank" in source.columns:
        ranks = pd.to_numeric(source["rank"], errors="coerce")
        keep = pd.Series(True, index=source.index)
        for position, limit in limits.items():
            position_rows = source["position"].eq(position)
            keep &= ~position_rows | ranks.isna() | (ranks <= limit)
        source = source[keep]
    grouped = source.groupby(["season", "week", "simulation_id", "team", "position"], as_index=False)["projected_score"].sum()
    wide = grouped.pivot_table(
        index=["season", "week", "simulation_id", "team"],
        columns="position",
        values="projected_score",
        aggfunc="sum",
        fill_value=0.0,
    ).reset_index()
    wide.columns.name = None
    for position, column in SIM_POSITION_COLUMNS.items():
        if position not in wide.columns:
            wide[position] = 0.0
        wide[column] = pd.to_numeric(wide[position], errors="coerce").fillna(0.0)
        wide = wide.drop(columns=[position])
    score_columns = list(SIM_POSITION_COLUMNS.values())
    wide["sim_off_total_fd_points"] = wide[score_columns].sum(axis=1)
    if schedule_team_games is not None:
        mapping = schedule_team_games.loc[:, ["season", "week", "game_id", "team"]].drop_duplicates()
        wide = wide.merge(mapping, on=["season", "week", "team"], how="left", validate="many_to_one")
        if wide["game_id"].isna().any():
            missing = int(wide["game_id"].isna().sum())
            warnings.warn(
                f"Dropping {missing:,} FBG scenario rows for teams without a scheduled game",
                stacklevel=2,
            )
            wide = wide[wide["game_id"].notna()].copy()
    return wide.reset_index(drop=True)


def build_model_features(
    team_games: pd.DataFrame,
    offense_scenarios: pd.DataFrame | None = None,
    require_simulation: bool = False,
) -> pd.DataFrame:
    """Build the versioned numeric feature frame used by training and scoring."""

    output = team_games.copy()
    require_columns(output, ["season", "week", "game_id", "team"], "team-game features")
    if offense_scenarios is not None:
        scenario_columns = ["season", "week", "game_id", "team", "simulation_id", *SIM_POSITION_COLUMNS.values(), "sim_off_total_fd_points"]
        available = [column for column in scenario_columns if column in offense_scenarios.columns]
        require_columns(offense_scenarios, ["season", "week", "game_id", "team", "simulation_id", "sim_off_total_fd_points"], "FBG scenario features")
        output = output.merge(
            offense_scenarios.loc[:, available],
            on=["season", "week", "game_id", "team"],
            how="inner",
            validate="one_to_many",
        )
    elif require_simulation:
        raise ValueError("FBG offense scenarios are required for this model variant")

    source_map = {
        "dst_home_game": "dst_home_game",
        "dst_team_total": "team_implied_total",
        "opponent_implied_team_total": "opponent_implied_total",
        "opponent_team_total": "opponent_implied_total",
        "dst_team_spread_prob": "team_spread_prob",
        "opponent_spread_prob": "opponent_spread_prob",
        "dst_team_moneyline_prob": "team_moneyline_prob",
        "opponent_moneyline_prob": "opponent_moneyline_prob",
        "dst_team_rest": "team_rest",
        "opponent_rest": "opponent_rest",
    }
    for target, source in source_map.items():
        if target not in output.columns:
            output[target] = output[source] if source in output.columns else np.nan
    output["div_game"] = _as_flag(output["div_game"]) if "div_game" in output.columns else 0.0
    output["game_type_reg"] = output.get("game_type", "REG").astype("string").str.upper().eq("REG").astype(float)
    output["dst_home_game"] = _as_flag(output["dst_home_game"])
    output["dist_from_onepm"] = ( _parse_game_hour(output.get("gametime", pd.Series(np.nan, index=output.index))) - 13.0).abs()
    wind = _numeric_series(output, "wind", np.nan)
    output["high_wind"] = wind.ge(20).astype(float)
    output["moderate_wind"] = (wind.gt(15) & wind.lt(20)).astype(float)
    location = output.get("location", pd.Series("Home", index=output.index)).astype("string").str.lower()
    neutral = output.get("neutral_site", location.eq("neutral"))
    output["location_neutral"] = _as_flag(pd.Series(neutral, index=output.index))

    roof = output.get("roof", pd.Series(pd.NA, index=output.index)).astype("string").str.lower().str.strip()
    roof = roof.replace({"retractable": "open", "outdoor": "outdoors"})
    output["roof_closed"] = roof.eq("closed").astype(float)
    output["roof_dome"] = roof.eq("dome").astype(float)
    output["roof_open"] = roof.eq("open").astype(float)
    output["roof_outdoors"] = roof.eq("outdoors").astype(float)
    if "opponent_qb_epa" not in output.columns:
        output["opponent_qb_epa"] = 0.0
    if "opponent_qb_cpoe" not in output.columns:
        output["opponent_qb_cpoe"] = 0.0
    if "rest_differential" not in output.columns:
        output["rest_differential"] = _numeric_series(output, "team_rest", np.nan) - _numeric_series(output, "opponent_rest", np.nan)

    if "sim_off_total_fd_points" not in output.columns:
        if require_simulation:
            raise ValueError("FBG scenario rows have no sim_off_total_fd_points")
        output["sim_off_total_fd_points"] = np.nan
    total = pd.to_numeric(output["sim_off_total_fd_points"], errors="coerce")
    for position, column in SIM_POSITION_COLUMNS.items():
        if column not in output.columns:
            output[column] = np.nan
        numerator = pd.to_numeric(output[column], errors="coerce")
        output[f"sim_{position.lower()}_fpts_share"] = np.where(total > 0, numerator / total, 0.0)

    assert_unique(output, SCENARIO_KEYS if "simulation_id" in output.columns else TEAM_GAME_KEYS, "model feature rows")
    output["temp"] = _numeric_series(output, "temp", np.nan)
    output["rest_differential"] = _numeric_series(output, "rest_differential", np.nan)
    output["season"] = pd.to_numeric(output["season"], errors="coerce").astype("int64")
    output["week"] = pd.to_numeric(output["week"], errors="coerce").astype("int64")
    output["missing_feature_count"] = numeric_features(output).isna().sum(axis=1).astype(int)
    return output


def build_scenario_panel(
    targets: pd.DataFrame,
    schedules: pd.DataFrame,
    fbg_draws: pd.DataFrame,
    pbp: pd.DataFrame | None = None,
) -> pd.DataFrame:
    """Join completed DST targets to original FBG simulation scenarios."""

    require_columns(targets, [*TEAM_GAME_KEYS, "dst_fd_pts"], "DST targets")
    team_games = build_team_game_schedule(schedules)
    team_games = add_opponent_qb_features(team_games, pbp=pbp)
    target_columns = [*TEAM_GAME_KEYS, "dst_fd_pts", "target_available"]
    target_frame = targets.loc[:, [column for column in target_columns if column in targets.columns]].copy()
    base = team_games.merge(target_frame, on=list(TEAM_GAME_KEYS), how="inner", validate="one_to_one")
    scenarios = aggregate_fbg_draws(fbg_draws, schedule_team_games=team_games)
    output = build_model_features(base, offense_scenarios=scenarios, require_simulation=True)
    output["target"] = pd.to_numeric(output["dst_fd_pts"], errors="coerce")
    output = output[output["target"].notna()].reset_index(drop=True)
    return output
