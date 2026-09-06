"""Schedule orientation and pregame market transformations."""

from __future__ import annotations

from collections.abc import Iterable

import numpy as np
import pandas as pd

from .schemas import TEAM_GAME_KEYS, assert_unique, require_columns
from .teams import normalize_team_columns


def american_to_probability(values: Iterable[object] | pd.Series) -> pd.Series:
    """Convert American odds to an implied probability."""

    numbers = pd.to_numeric(pd.Series(values), errors="coerce").astype(float)
    positive = numbers > 0
    probability = pd.Series(np.nan, index=numbers.index, dtype="float64")
    probability.loc[positive] = 100.0 / (numbers.loc[positive] + 100.0)
    probability.loc[~positive & numbers.notna() & (numbers != 0)] = (
        numbers.loc[~positive & numbers.notna() & (numbers != 0)].abs()
        / (numbers.loc[~positive & numbers.notna() & (numbers != 0)].abs() + 100.0)
    )
    return probability


def _column_or_default(frame: pd.DataFrame, name: str, default: object = np.nan) -> pd.Series:
    if name in frame.columns:
        return frame[name]
    return pd.Series(default, index=frame.index)


def _game_datetime(frame: pd.DataFrame) -> pd.Series:
    gameday = _column_or_default(frame, "gameday", pd.NaT)
    gametime = _column_or_default(frame, "gametime", "")
    values = pd.to_datetime(gameday.astype("string") + " " + gametime.astype("string"), errors="coerce")
    return values


def _side_rows(schedule: pd.DataFrame, side: str) -> pd.DataFrame:
    other = "away" if side == "home" else "home"
    output = pd.DataFrame(index=schedule.index)
    output["season"] = pd.to_numeric(schedule["season"], errors="coerce").astype("Int64")
    output["week"] = pd.to_numeric(schedule["week"], errors="coerce").astype("Int64")
    output["game_id"] = schedule["game_id"].astype("string")
    output["game_type"] = _column_or_default(schedule, "game_type", "REG").astype("string").str.upper()
    output["gameday"] = _column_or_default(schedule, "gameday")
    output["weekday"] = _column_or_default(schedule, "weekday")
    output["gametime"] = _column_or_default(schedule, "gametime")
    output["game_date_time"] = _game_datetime(schedule)
    output["feature_as_of"] = pd.to_datetime(_column_or_default(schedule, "feature_as_of"), errors="coerce")
    missing_as_of = output["feature_as_of"].isna()
    output.loc[missing_as_of, "feature_as_of"] = output.loc[missing_as_of, "game_date_time"]
    output["team"] = schedule[f"{side}_team"]
    output["opponent"] = schedule[f"{other}_team"]
    output["is_home"] = int(side == "home")
    output["dst_home_game"] = int(side == "home")
    output["team_score"] = _column_or_default(schedule, f"{side}_score")
    output["opponent_score"] = _column_or_default(schedule, f"{other}_score")
    output["team_rest"] = _column_or_default(schedule, f"{side}_rest")
    output["opponent_rest"] = _column_or_default(schedule, f"{other}_rest")
    output["team_moneyline"] = _column_or_default(schedule, f"{side}_moneyline")
    output["opponent_moneyline"] = _column_or_default(schedule, f"{other}_moneyline")
    output["team_spread_odds"] = _column_or_default(schedule, f"{side}_spread_odds")
    output["opponent_spread_odds"] = _column_or_default(schedule, f"{other}_spread_odds")

    # nflverse stores the closing spread from the away-team perspective. The
    # upstream R code converts it to a positive favorite margin for the home
    # row. Keep that orientation because it produces the implied total used by
    # the saved recipe.
    raw_spread = pd.to_numeric(_column_or_default(schedule, "spread_line"), errors="coerce")
    output["team_spread_line"] = raw_spread if side == "home" else -raw_spread
    output["total_line"] = _column_or_default(schedule, "total_line")
    total = pd.to_numeric(output["total_line"], errors="coerce")
    team_spread = pd.to_numeric(output["team_spread_line"], errors="coerce")
    output["team_implied_total"] = (total + team_spread) / 2.0
    output["opponent_implied_total"] = (total - team_spread) / 2.0
    output["team_spread_prob"] = american_to_probability(output["team_spread_odds"])
    output["opponent_spread_prob"] = american_to_probability(output["opponent_spread_odds"])
    output["team_moneyline_prob"] = american_to_probability(output["team_moneyline"])
    output["opponent_moneyline_prob"] = american_to_probability(output["opponent_moneyline"])

    output["div_game"] = _column_or_default(schedule, "div_game", 0)
    output["location"] = _column_or_default(schedule, "location", "Home")
    output["roof"] = _column_or_default(schedule, "roof")
    output["surface"] = _column_or_default(schedule, "surface")
    output["temp"] = _column_or_default(schedule, "temp")
    output["wind"] = _column_or_default(schedule, "wind")
    output["stadium_id"] = _column_or_default(schedule, "stadium_id")
    output["stadium"] = _column_or_default(schedule, "stadium")
    output["opponent_qb_id"] = _column_or_default(schedule, f"{other}_qb_id")
    output["opponent_qb_name"] = _column_or_default(schedule, f"{other}_qb_name")
    output["neutral_site"] = output["location"].astype("string").str.lower().eq("neutral")
    return output.reset_index(drop=True)


def build_team_game_schedule(schedules: pd.DataFrame) -> pd.DataFrame:
    """Convert one schedule row into one row for each team.

    The returned rows are defense-oriented. ``team`` is the defense, so
    ``opponent`` is the offense that the model predicts against.
    """

    require_columns(schedules, ["season", "week", "game_id", "away_team", "home_team"], "schedules")
    source = schedules.copy()
    source = source[source.get("game_type", "REG").astype("string").str.upper().isin(["REG", "POST", "WC", "DIV", "CON", "SB", "CONF", "PRO"])] if "game_type" in source.columns else source
    source = normalize_team_columns(source, ["away_team", "home_team"])
    if source["game_id"].isna().any():
        raise ValueError("schedules has missing game_id values")
    home = _side_rows(source, "home")
    away = _side_rows(source, "away")
    output = pd.concat([home, away], ignore_index=True)
    output["team"] = output["team"].map(lambda value: value)
    output["opponent"] = output["opponent"].map(lambda value: value)
    output["team_rest"] = pd.to_numeric(output["team_rest"], errors="coerce")
    output["opponent_rest"] = pd.to_numeric(output["opponent_rest"], errors="coerce")
    output["rest_differential"] = output["team_rest"] - output["opponent_rest"]
    output["season"] = output["season"].astype("int64")
    output["week"] = output["week"].astype("int64")
    output = output.sort_values(["season", "week", "game_id", "dst_home_game"], kind="stable").reset_index(drop=True)
    assert_unique(output, TEAM_GAME_KEYS, "team-game schedule")
    return output
