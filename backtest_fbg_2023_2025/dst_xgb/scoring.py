"""DST scoring profile and historical target construction."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Mapping

import numpy as np
import pandas as pd

from .schedule import build_team_game_schedule
from .schemas import TEAM_GAME_KEYS, assert_unique, require_columns
from .teams import normalize_team_columns


@dataclass(frozen=True)
class DstScoringProfile:
    """A named scoring contract for a team defense fantasy target."""

    sack_points: float = 1.0
    defensive_touchdown_points: float = 6.0
    turnover_points: float = 2.0
    safety_points: float = 2.0
    defensive_two_point_points: float = 2.0
    points_allowed_multiplier: float = 2.0
    points_allowed_points: Mapping[str, float] = field(
        default_factory=lambda: {
            "35_plus": -4.0,
            "28_34": -1.0,
            "21_27": 0.0,
            "14_20": 1.0,
            "7_13": 4.0,
            "1_6": 7.0,
            "0": 10.0,
        }
    )


UPSTREAM_FD_PROFILE = DstScoringProfile()


def points_allowed_score(points_allowed: object, profile: DstScoringProfile = UPSTREAM_FD_PROFILE) -> float:
    """Map points allowed to the upstream FanDuel-style bucket."""

    value = pd.to_numeric(pd.Series([points_allowed]), errors="coerce").iloc[0]
    if pd.isna(value):
        return np.nan
    if value >= 35:
        return float(profile.points_allowed_points["35_plus"])
    if value >= 28:
        return float(profile.points_allowed_points["28_34"])
    if value >= 21:
        return float(profile.points_allowed_points["21_27"])
    if value >= 14:
        return float(profile.points_allowed_points["14_20"])
    if value >= 7:
        return float(profile.points_allowed_points["7_13"])
    if value >= 1:
        return float(profile.points_allowed_points["1_6"])
    return float(profile.points_allowed_points["0"])


def _points_allowed_series(values: pd.Series, profile: DstScoringProfile) -> pd.Series:
    return values.map(lambda value: points_allowed_score(value, profile))


def compute_dst_score(events: pd.DataFrame, profile: DstScoringProfile = UPSTREAM_FD_PROFILE) -> pd.Series:
    """Compute the configured score from an event aggregate table."""

    required = [
        "sacks",
        "defensive_touchdowns",
        "offensive_fumbles_lost",
        "defensive_safeties",
        "interceptions",
        "points_allowed",
        "defensive_two_point_conversions",
    ]
    require_columns(events, required, "DST event aggregate")
    values = events.copy()
    for column in required:
        values[column] = pd.to_numeric(values[column], errors="coerce").fillna(0.0)
    points_allowed = _points_allowed_series(values["points_allowed"], profile).fillna(0.0)
    return (
        profile.sack_points * values["sacks"]
        + profile.defensive_touchdown_points * values["defensive_touchdowns"]
        + profile.turnover_points * (values["offensive_fumbles_lost"] + values["interceptions"])
        + profile.safety_points * values["defensive_safeties"]
        + profile.defensive_two_point_points * values["defensive_two_point_conversions"]
        + profile.points_allowed_multiplier * points_allowed
    )


def _zero_aggregate(team_games: pd.DataFrame) -> pd.DataFrame:
    return team_games.loc[:, ["game_id", "team"]].drop_duplicates().assign(
        sacks=0.0,
        interceptions=0.0,
        defensive_safeties=0.0,
        defensive_two_point_conversions=0.0,
        defensive_touchdowns=0.0,
        offensive_fumbles_lost=0.0,
    )


def _pbp_event_aggregate(pbp: pd.DataFrame) -> pd.DataFrame:
    """Reproduce the upstream PBP event assignments."""

    required = ["game_id", "defteam", "posteam"]
    require_columns(pbp, required, "play-by-play")
    source = normalize_team_columns(pbp, ["defteam", "posteam", "return_team"])
    keys = ["game_id", "team"]

    def numeric(name: str) -> pd.Series:
        if name not in source.columns:
            return pd.Series(0.0, index=source.index)
        return pd.to_numeric(source[name], errors="coerce").fillna(0.0)

    defensive = source.loc[source["defteam"].notna(), ["game_id", "defteam"]].copy()
    defensive["team"] = defensive["defteam"]
    defensive["sacks"] = numeric("sack").loc[defensive.index]
    defensive["interceptions"] = numeric("interception").loc[defensive.index]
    defensive["defensive_safeties"] = numeric("safety").loc[defensive.index]
    defensive["defensive_two_point_conversions"] = numeric("defensive_two_point_conv").loc[defensive.index]
    defensive = defensive.groupby(keys, as_index=False)[
        ["sacks", "interceptions", "defensive_safeties", "defensive_two_point_conversions"]
    ].sum()

    return_columns = ["game_id", "defteam"]
    if "return_team" in source.columns:
        return_columns.append("return_team")
    returns = source.loc[numeric("return_touchdown") == 1, return_columns].copy()
    if len(returns):
        if "return_team" in returns.columns:
            returns["team"] = returns["return_team"].fillna(returns["defteam"])
        else:
            returns["team"] = returns["defteam"]
        return_tds = returns.loc[returns["team"].notna()].groupby(keys).size().rename("defensive_touchdowns").reset_index()
    else:
        return_tds = pd.DataFrame(columns=["game_id", "team", "defensive_touchdowns"])

    fumbles = source.loc[source["posteam"].notna(), ["game_id", "posteam"]].copy()
    fumbles["team"] = fumbles["posteam"]
    fumbles["offensive_fumbles_lost"] = numeric("fumble_lost").loc[fumbles.index]
    fumbles = fumbles.groupby(keys, as_index=False)["offensive_fumbles_lost"].sum()

    output = defensive.merge(return_tds, on=keys, how="outer").merge(fumbles, on=keys, how="outer")
    for column in [
        "sacks",
        "interceptions",
        "defensive_safeties",
        "defensive_two_point_conversions",
        "defensive_touchdowns",
        "offensive_fumbles_lost",
    ]:
        if column not in output.columns:
            output[column] = 0.0
        output[column] = pd.to_numeric(output[column], errors="coerce").fillna(0.0)

    # The fumble count belongs to the offense. It is reassigned to the defense
    # after the aggregate is joined to the opponent's team-game row.
    output = output.rename(columns={"team": "event_team"})
    defensive_events = output.loc[output["event_team"].notna()].copy()
    defensive_events["team"] = defensive_events["event_team"]
    return defensive_events.loc[:, ["game_id", "team", "sacks", "interceptions", "defensive_safeties", "defensive_two_point_conversions", "defensive_touchdowns", "offensive_fumbles_lost"]]


def _stats_event_aggregate(player_stats: pd.DataFrame) -> pd.DataFrame:
    """Fallback event aggregate when PBP is not cached."""

    require_columns(player_stats, ["game_id", "team"], "player statistics")
    source = normalize_team_columns(player_stats, ["team"])
    source["game_id"] = source["game_id"].astype("string")

    def sum_columns(names: list[str]) -> pd.Series:
        values = pd.Series(0.0, index=source.index)
        for name in names:
            if name in source.columns:
                values = values.add(pd.to_numeric(source[name], errors="coerce").fillna(0.0), fill_value=0.0)
        return values

    source["sacks"] = sum_columns(["def_sacks"])
    source["interceptions"] = sum_columns(["def_interceptions"])
    source["defensive_safeties"] = sum_columns(["def_safeties"])
    source["defensive_two_point_conversions"] = sum_columns(["def_2pt_made"])
    source["defensive_touchdowns"] = sum_columns(["def_tds", "fumble_recovery_tds", "special_teams_tds"])
    source["offensive_fumbles_lost"] = sum_columns([
        "sack_fumbles_lost",
        "rushing_fumbles_lost",
        "receiving_fumbles_lost",
    ])
    return source.groupby(["game_id", "team"], as_index=False)[
        [
            "sacks",
            "interceptions",
            "defensive_safeties",
            "defensive_two_point_conversions",
            "defensive_touchdowns",
            "offensive_fumbles_lost",
        ]
    ].sum()


def build_dst_targets(
    player_stats: pd.DataFrame | None,
    schedules: pd.DataFrame,
    pbp: pd.DataFrame | None = None,
    profile: DstScoringProfile = UPSTREAM_FD_PROFILE,
) -> pd.DataFrame:
    """Build one scored DST row for each completed team-game.

    PBP is the preferred source because it matches the upstream event logic.
    Full weekly player statistics remain a supported fallback for environments
    that do not cache PBP.
    """

    team_games = build_team_game_schedule(schedules)
    if pbp is not None and len(pbp):
        event_aggregate = _pbp_event_aggregate(pbp)
    elif player_stats is not None and len(player_stats):
        event_aggregate = _stats_event_aggregate(player_stats)
    else:
        event_aggregate = _zero_aggregate(team_games)

    event_aggregate = normalize_team_columns(event_aggregate, ["team"])
    event_aggregate["game_id"] = event_aggregate["game_id"].astype("string")
    defense = team_games.merge(event_aggregate, on=["game_id", "team"], how="left")
    offense_events = event_aggregate.loc[:, ["game_id", "team", "offensive_fumbles_lost"]].rename(
        columns={"team": "opponent", "offensive_fumbles_lost": "opponent_offensive_fumbles_lost"}
    )
    defense = defense.merge(offense_events, on=["game_id", "opponent"], how="left")
    defense["offensive_fumbles_lost"] = defense["opponent_offensive_fumbles_lost"].fillna(0.0)
    defense = defense.drop(columns=["opponent_offensive_fumbles_lost"])
    event_columns = [
        "sacks",
        "interceptions",
        "defensive_safeties",
        "defensive_two_point_conversions",
        "defensive_touchdowns",
    ]
    for column in event_columns:
        defense[column] = pd.to_numeric(defense[column], errors="coerce").fillna(0.0)
    defense["points_allowed"] = pd.to_numeric(defense["opponent_score"], errors="coerce")
    defense["points_allowed_score"] = _points_allowed_series(defense["points_allowed"], profile)
    defense["dst_fd_pts"] = compute_dst_score(
        defense.rename(columns={
            "offensive_fumbles_lost": "offensive_fumbles_lost",
        }),
        profile,
    )
    defense["target_available"] = defense["opponent_score"].notna() & defense["team_score"].notna()
    defense["dst_id"] = "DST_" + defense["team"].astype("string")
    output_columns = [
        *TEAM_GAME_KEYS,
        "opponent",
        "game_type",
        "gameday",
        "weekday",
        "gametime",
        "game_date_time",
        "dst_home_game",
        "team_score",
        "opponent_score",
        "team_rest",
        "opponent_rest",
        "rest_differential",
        "total_line",
        "team_implied_total",
        "opponent_implied_total",
        "team_spread_line",
        "team_spread_prob",
        "opponent_spread_prob",
        "team_moneyline_prob",
        "opponent_moneyline_prob",
        "div_game",
        "location",
        "neutral_site",
        "roof",
        "surface",
        "temp",
        "wind",
        "stadium_id",
        "stadium",
        "opponent_qb_id",
        "opponent_qb_name",
        "sacks",
        "interceptions",
        "defensive_safeties",
        "defensive_two_point_conversions",
        "defensive_touchdowns",
        "offensive_fumbles_lost",
        "points_allowed",
        "points_allowed_score",
        "dst_fd_pts",
        "target_available",
        "dst_id",
    ]
    output = defense.loc[:, [column for column in output_columns if column in defense.columns]].copy()
    output = output[output["target_available"]].reset_index(drop=True)
    assert_unique(output, TEAM_GAME_KEYS, "DST target table")
    return output
