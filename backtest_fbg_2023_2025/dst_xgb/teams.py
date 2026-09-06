"""Canonical NFL team identifiers used by the DST pipeline.

The surrounding R project uses ``LA`` for the Rams. Keep that convention at
the Python boundary so FBG, schedule, and PBP joins use one key.
"""

from __future__ import annotations

from collections.abc import Iterable

import pandas as pd


TEAM_ALIASES = {
    "ARZ": "ARI",
    "BLT": "BAL",
    "CLV": "CLE",
    "GBP": "GB",
    "HST": "HOU",
    "JAC": "JAX",
    "KCC": "KC",
    "LA": "LA",
    "LAC": "LAC",
    "LAR": "LA",
    "LV": "LV",
    "LVR": "LV",
    "NEP": "NE",
    "NOS": "NO",
    "OAK": "LV",
    "SD": "LAC",
    "SF": "SF",
    "SFO": "SF",
    "SL": "LA",
    "STL": "LA",
    "TB": "TB",
    "TBB": "TB",
    "WAS": "WAS",
    "WSH": "WAS",
}
DST_POSITION_ALIASES = {"DST", "TD", "DEF", "D/ST", "D"}


def normalize_team(value: object) -> str | None:
    """Return the project team code for one value.

    Unknown non-empty codes are returned in upper case. This keeps the
    adapter forward-compatible while still normalizing known historical
    aliases.
    """

    if value is None:
        return None
    missing = pd.isna(value)
    if isinstance(missing, bool) and missing:
        return None
    text = str(value).strip().upper()
    if not text:
        return None
    return TEAM_ALIASES.get(text, text)


def normalize_team_series(values: Iterable[object] | pd.Series) -> pd.Series:
    """Normalize a sequence and preserve its pandas index when present."""

    if isinstance(values, pd.Series):
        return values.map(normalize_team)
    return pd.Series([normalize_team(value) for value in values])


def normalize_team_columns(frame: pd.DataFrame, columns: Iterable[str]) -> pd.DataFrame:
    """Copy a frame and normalize the listed team columns."""

    output = frame.copy()
    for column in columns:
        if column in output.columns:
            output[column] = normalize_team_series(output[column])
    return output


def normalize_dst_rows(frame: pd.DataFrame) -> pd.DataFrame:
    """Normalize provider defense rows without treating them as player targets."""

    output = frame.copy()
    position_column = "position" if "position" in output.columns else "pos" if "pos" in output.columns else None
    if position_column is None or "team" not in output.columns:
        raise ValueError("DST provider rows need a position or pos column and a team column")
    position = output[position_column].astype("string").str.upper().str.strip()
    output = output[position.isin(DST_POSITION_ALIASES)].copy()
    output["position"] = "DST"
    output["team"] = normalize_team_series(output["team"])
    if "player_id" not in output.columns:
        output["player_id"] = output["id"] if "id" in output.columns else "DST_" + output["team"].astype("string")
    if "player_name" not in output.columns:
        output["player_name"] = output["name"] if "name" in output.columns else output["team"].astype("string") + " DST"
    return output.reset_index(drop=True)
