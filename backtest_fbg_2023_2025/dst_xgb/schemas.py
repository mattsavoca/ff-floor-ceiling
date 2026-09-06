"""Versioned keys and feature contracts for the DST model."""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import asdict, dataclass

import pandas as pd


TEAM_GAME_KEYS = ("season", "week", "game_id", "team")
SCENARIO_KEYS = ("season", "week", "game_id", "team", "simulation_id")

# This is the saved upstream feature list, with ``days_in_past`` removed.
# That field changes when the same historical row is scored on a different
# day. The clean model keeps every other pregame field, including the legacy
# duplicate ``opponent_team_total`` column for parity.
UPSTREAM_FEATURE_COLUMNS = (
    "sim_off_total_fd_points",
    "div_game",
    "total_line",
    "dst_home_game",
    "dst_team_total",
    "opponent_implied_team_total",
    "opponent_team_total",
    "dst_team_spread_prob",
    "opponent_spread_prob",
    "dst_team_moneyline_prob",
    "opponent_moneyline_prob",
    "dst_team_rest",
    "opponent_rest",
    "temp",
    "rest_differential",
    "opponent_qb_epa",
    "opponent_qb_cpoe",
    "game_type_reg",
    "days_in_past",
    "dist_from_onepm",
    "sim_qb_fpts_share",
    "sim_rb_fpts_share",
    "sim_wr_fpts_share",
    "sim_te_fpts_share",
    "sim_k_fpts_share",
    "high_wind",
    "moderate_wind",
    "location_neutral",
    "roof_closed",
    "roof_dome",
    "roof_open",
    "roof_outdoors",
)

FEATURE_COLUMNS = tuple(column for column in UPSTREAM_FEATURE_COLUMNS if column != "days_in_past")


@dataclass(frozen=True)
class FeatureSpec:
    """One versioned feature contract row."""

    name: str
    source: str
    availability: str
    dtype: str
    transform: str


_SCHEDULE_SPECS = {
    "div_game": ("schedule", "before kickoff", "float", "binary division-game flag"),
    "total_line": ("schedule market", "before kickoff", "float", "raw total line"),
    "dst_home_game": ("schedule", "before kickoff", "float", "1 when defense is home"),
    "dst_team_total": ("schedule market", "before kickoff", "float", "defense implied team total"),
    "opponent_implied_team_total": ("schedule market", "before kickoff", "float", "opponent implied team total"),
    "opponent_team_total": ("schedule market", "before kickoff", "float", "legacy duplicate of opponent implied total"),
    "dst_team_spread_prob": ("schedule market", "before kickoff", "float", "American odds to implied probability"),
    "opponent_spread_prob": ("schedule market", "before kickoff", "float", "American odds to implied probability"),
    "dst_team_moneyline_prob": ("schedule market", "before kickoff", "float", "American odds to implied probability"),
    "opponent_moneyline_prob": ("schedule market", "before kickoff", "float", "American odds to implied probability"),
    "dst_team_rest": ("schedule", "before kickoff", "float", "defense rest days"),
    "opponent_rest": ("schedule", "before kickoff", "float", "opponent rest days"),
    "temp": ("schedule weather", "before kickoff", "float", "numeric temperature"),
    "rest_differential": ("schedule", "before kickoff", "float", "defense rest minus opponent rest"),
    "game_type_reg": ("schedule", "before kickoff", "float", "1 for regular season"),
    "dist_from_onepm": ("schedule kickoff", "before kickoff", "float", "absolute kickoff-hour distance from 13:00"),
    "high_wind": ("schedule weather", "before kickoff", "float", "1 when wind is at least 20"),
    "moderate_wind": ("schedule weather", "before kickoff", "float", "1 when wind is greater than 15 and less than 20"),
    "location_neutral": ("schedule", "before kickoff", "float", "1 for neutral site"),
    "roof_closed": ("schedule venue", "before kickoff", "float", "one-hot roof category"),
    "roof_dome": ("schedule venue", "before kickoff", "float", "one-hot roof category"),
    "roof_open": ("schedule venue", "before kickoff", "float", "one-hot roof category"),
    "roof_outdoors": ("schedule venue", "before kickoff", "float", "one-hot roof category"),
    "opponent_qb_epa": ("historical PBP", "before target kickoff", "float", "recency-weighted QB EPA from prior plays"),
    "opponent_qb_cpoe": ("historical PBP", "before target kickoff", "float", "recency-weighted QB CPOE from prior plays"),
}

_FBG_SPECS = {
    "sim_off_total_fd_points": ("original FBG player draws", "pregame simulation", "float", "sum of simulated QB, RB, WR, TE, and optional K points"),
    "sim_qb_fpts_share": ("original FBG player draws", "pregame simulation", "float", "simulated QB points divided by simulated offense total"),
    "sim_rb_fpts_share": ("original FBG player draws", "pregame simulation", "float", "simulated RB points divided by simulated offense total"),
    "sim_wr_fpts_share": ("original FBG player draws", "pregame simulation", "float", "simulated WR points divided by simulated offense total"),
    "sim_te_fpts_share": ("original FBG player draws", "pregame simulation", "float", "simulated TE points divided by simulated offense total"),
    "sim_k_fpts_share": ("original FBG player draws", "pregame simulation", "float", "simulated K points divided by simulated offense total, zero when K is absent"),
}

FEATURE_SPEC = tuple(
    FeatureSpec(name, *(_FBG_SPECS[name] if name in _FBG_SPECS else _SCHEDULE_SPECS[name]))
    for name in FEATURE_COLUMNS
)


def feature_spec_rows() -> list[dict[str, str]]:
    """Return the feature contract in a JSON and CSV friendly form."""

    return [asdict(spec) for spec in FEATURE_SPEC]

SIM_POSITION_COLUMNS = {
    "QB": "sim_qb_fd_points",
    "RB": "sim_rb_fd_points",
    "WR": "sim_wr_fd_points",
    "TE": "sim_te_fd_points",
    "K": "sim_k_fd_points",
}
SIMULATION_DRAW_COLUMNS = (
    "simulation_id",
    "season",
    "week",
    "player_id",
    "player_name",
    "position",
    "team",
    "projected_score",
    "active",
)


def require_columns(frame: pd.DataFrame, columns: Iterable[str], label: str = "data") -> None:
    """Raise a readable error when a data contract is incomplete."""

    missing = [column for column in columns if column not in frame.columns]
    if missing:
        raise ValueError(f"{label} is missing columns: {', '.join(missing)}")


def assert_unique(frame: pd.DataFrame, keys: Iterable[str], label: str = "data") -> None:
    """Assert that one row exists for each key."""

    key_list = list(keys)
    require_columns(frame, key_list, label)
    duplicate_count = int(frame.duplicated(key_list).sum())
    if duplicate_count:
        raise ValueError(f"{label} has {duplicate_count:,} duplicate rows for {key_list}")


def numeric_features(frame: pd.DataFrame, columns: Iterable[str] = FEATURE_COLUMNS) -> pd.DataFrame:
    """Return model columns as float values with missing values preserved."""

    column_list = list(columns)
    require_columns(frame, column_list, "model feature frame")
    output = frame.loc[:, column_list].copy()
    for column in column_list:
        output[column] = pd.to_numeric(output[column], errors="coerce").astype("float64")
    return output
