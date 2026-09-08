"""Build the v2 multi-quantile PPR projection models.

This release has one native XGBoost quantile-error booster for each of QB, RB,
WR, and TE.  Each booster returns p15, p50, and p85 from one prediction call.

The script first runs an independent identity and outcome gate over the top
Footballguys projected players.  It then uses the corrected identity map to
create a common held-out evaluation set for the v2 booster and the existing
``ffsimulator`` output.
"""

from __future__ import annotations

import argparse
import itertools
import json
import math
import os
import re
import shutil
import time
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

import numpy as np
import pandas as pd
import xgboost as xgb


SCORING_FORMAT = "PPR"
SCORING_CONTRACT_VERSION = "ppr_v1"
MODEL_RELEASE = "forecast-ppr-v2"
ARTIFACT_VERSION = "xgb_v2_quantile_20260907"
FEATURE_VERSION = "fbg_rank_projection_v2"
QUANTILES = (0.15, 0.50, 0.85)
QUANTILE_LABELS = ("p15", "p50", "p85")
POSITIONS = ("QB", "RB", "WR", "TE")
TOP_LIMITS = {"QB": 30, "TE": 30, "WR": 40, "RB": 40}
DEFAULT_TARGET_SEASONS = (2024, 2025)
DEFAULT_VALIDATION_WEEKS = (14, 15, 16, 17)
DEFAULT_MAX_ROUNDS = 500
DEFAULT_EARLY_STOPPING_ROUNDS = 40
DEFAULT_MAX_CONFIGS = 48
DEFAULT_NTHREAD = min(8, max(1, os.cpu_count() or 1))

KEY_COLUMNS = ("season", "week", "fbg_id", "position")
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

# These are the only rank-summary fields used by the v2 model.  ``ecr`` is the
# mean of the selected rank values, so its definition remains meaningful with
# one selected projection set and with many.  The other rank-summary fields
# either measure source-set dispersion or refer to a specific consensus view.
MODEL_RANK_FEATURES = ("week", "ecr")
ALL_RANK_SUMMARY_FIELDS = (
    "ecr",
    "rank_sd",
    "n_projectors",
    "rank_min",
    "rank_max",
    "consensus_rank",
    "consensus_projected_score",
)
OUTCOME_COLUMNS = {
    "actual_score",
    "actual_record",
    "p15",
    "p50",
    "p85",
    "ffsim_p15",
    "ffsim_p50",
    "ffsim_p85",
}
KNOWN_MAPPINGS = {
    "GibbJa00": "00-0039139",
    "McCaCh00": "00-0033280",
}


class DataQualityGateError(RuntimeError):
    """Raised when a serious top-player identity problem blocks training."""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--target-seasons",
        default=",".join(str(value) for value in DEFAULT_TARGET_SEASONS),
        help="Comma-separated held-out seasons.",
    )
    parser.add_argument("--max-rounds", type=int, default=DEFAULT_MAX_ROUNDS)
    parser.add_argument(
        "--early-stopping-rounds", type=int, default=DEFAULT_EARLY_STOPPING_ROUNDS
    )
    parser.add_argument("--max-configs", type=int, default=DEFAULT_MAX_CONFIGS)
    parser.add_argument("--nthread", type=int, default=DEFAULT_NTHREAD)
    parser.add_argument("--output-dir", default=None)
    args = parser.parse_args()
    try:
        args.target_seasons = tuple(
            sorted({int(value.strip()) for value in args.target_seasons.split(",") if value.strip()})
        )
    except ValueError as error:
        parser.error(f"--target-seasons must be comma-separated integers: {error}")
    if not args.target_seasons:
        parser.error("--target-seasons must contain at least one season")
    if args.max_rounds < 1 or args.early_stopping_rounds < 1:
        parser.error("round limits must be positive")
    if args.max_configs < 1 or args.nthread < 1:
        parser.error("--max-configs and --nthread must be positive")
    return args


def project_root() -> Path:
    return Path(__file__).resolve().parents[2]


def backtest_root(root: Path) -> Path:
    return root / "backtest_fbg_2023_2025"


def safe_text(value: Any) -> str:
    if value is None or pd.isna(value):
        return ""
    return str(value).strip()


def json_safe(value: Any) -> Any:
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating,)):
        return None if not np.isfinite(value) else float(value)
    if isinstance(value, (np.bool_,)):
        return bool(value)
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {str(key): json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [json_safe(item) for item in value]
    return value


def normalize_team(value: Any) -> str:
    team = safe_text(value).upper()
    aliases = {
        "LAR": "LA",
        "STL": "LA",
        "OAK": "LV",
        "RAI": "LV",
        "LVR": "LV",
        "SD": "LAC",
        "JAC": "JAX",
        "WAS": "WAS",
        "WSH": "WAS",
        "SFO": "SF",
        "GNB": "GB",
        "NWE": "NE",
        "NOR": "NO",
        "KAN": "KC",
        "TAM": "TB",
        "CLV": "CLE",
        "HST": "HOU",
        "BLT": "BAL",
        "OTI": "TEN",
    }
    return aliases.get(team, team)


def normalize_name(value: Any) -> str:
    text = safe_text(value)
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    text = text.lower().replace("'", "")
    text = re.sub(r"\b(jr|sr|ii|iii|iv|v)\b", "", text)
    return re.sub(r"[^a-z0-9]", "", text)


def require_ppr_artifact(frame: pd.DataFrame, label: str) -> None:
    missing = {"scoring_format", "scoring_contract_version"}.difference(frame.columns)
    if missing:
        raise ValueError(f"{label} is missing PPR metadata columns: {sorted(missing)}")
    formats = set(frame["scoring_format"].dropna().astype(str).str.upper())
    contracts = set(frame["scoring_contract_version"].dropna().astype(str))
    if formats != {SCORING_FORMAT} or contracts != {SCORING_CONTRACT_VERSION}:
        raise ValueError(
            f"{label} does not use {SCORING_FORMAT}/{SCORING_CONTRACT_VERSION}: "
            f"formats={sorted(formats)}, contracts={sorted(contracts)}"
        )


def assert_feature_columns(features: Iterable[str]) -> None:
    feature_list = list(features)
    leaked = sorted(set(feature_list).intersection(OUTCOME_COLUMNS))
    if leaked:
        raise ValueError(f"Model features contain outcome fields: {leaked}")
    if "n_projectors" in feature_list:
        raise ValueError("n_projectors is a data-quality field and cannot be a model feature")


def projection_score(frame: pd.DataFrame) -> pd.Series:
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


def read_consensus_projections(root: Path) -> pd.DataFrame:
    """Read the selected approved Projections Consensus source."""
    bt = backtest_root(root)
    raw_root = bt / "data" / "raw" / "fbg"
    selection = pd.read_csv(
        bt / "data" / "derived" / "fbg_set_selection.csv",
        dtype={"season": "int64", "week": "int64", "set_id": "string"},
    )
    selection["set_name"] = selection["set_name"].astype("string").str.strip().str.lower()
    selected = selection[
        selection["selected"].astype("string").str.upper().eq("TRUE")
        & selection["set_name"].eq("projections consensus")
    ]
    selected_set_ids = {
        (int(row.season), int(row.week)): str(row.set_id)
        for row in selected.itertuples(index=False)
    }
    usecols = ["id", "pos", "team", "set-id", "set-name", *PROJECTION_COLUMNS]
    frames: list[pd.DataFrame] = []
    for path in sorted(raw_root.glob("season=*/week=*.csv")):
        match = re.search(r"season=(\d+)[\\/]week=(\d+)\.csv$", str(path))
        if match is None:
            raise ValueError(f"Cannot parse season and week from {path}")
        season, week = (int(value) for value in match.groups())
        set_id = selected_set_ids.get((season, week))
        if set_id is None:
            raise ValueError(f"No selected Projections Consensus set for {season} week {week}")
        raw = pd.read_csv(path, usecols=usecols, low_memory=False)
        set_name = raw["set-name"].astype("string").str.strip().str.lower()
        current = raw.loc[
            set_name.eq("projections consensus")
            & raw["set-id"].astype("string").eq(set_id)
        ].copy()
        current["season"] = season
        current["week"] = week
        current["fbg_id"] = current.pop("id").astype("string").str.strip()
        current["position"] = current.pop("pos").astype("string").str.strip().str.upper()
        current["team"] = current["team"].map(normalize_team)
        current = current[
            current["position"].isin(POSITIONS)
            & current["team"].ne("")
            & current["team"].ne("FA")
        ]
        current = current.drop(columns=["set-id", "set-name"])
        frames.append(current)
    if not frames:
        raise FileNotFoundError(f"No FBG source files under {raw_root}")
    output = pd.concat(frames, ignore_index=True)
    duplicate_mask = output.duplicated(list(KEY_COLUMNS), keep=False)
    if duplicate_mask.any():
        raise ValueError(
            "Approved projection source has duplicate keys: "
            f"{output.loc[duplicate_mask, list(KEY_COLUMNS)].head().to_dict('records')}"
        )
    output["projection_fpts"] = projection_score(output)
    return output


def select_top_players(projections: pd.DataFrame, labels: pd.DataFrame) -> pd.DataFrame:
    """Select the required top players for every season/week/position."""
    label_columns = [*KEY_COLUMNS, "player_name"]
    label_rows = labels[label_columns].drop_duplicates(list(KEY_COLUMNS))
    labeled = projections.merge(label_rows, on=list(KEY_COLUMNS), how="left", validate="one_to_one")
    rows = []
    for (season, week, position), group in labeled.groupby(
        ["season", "week", "position"], sort=True, dropna=False
    ):
        if position not in TOP_LIMITS:
            continue
        rows.append(
            group.sort_values(["projection_fpts", "fbg_id"], ascending=[False, True]).head(
                TOP_LIMITS[position]
            )
        )
    if not rows:
        raise ValueError("No top-player projection rows were selected")
    return pd.concat(rows, ignore_index=True)


@dataclass
class IdentitySources:
    """Candidate and outcome indexes used by the identity gate."""

    stats_candidates: dict[tuple[Any, ...], set[str]]
    roster_candidates: dict[tuple[Any, ...], set[str]]
    master_candidates: dict[tuple[Any, ...], set[str]]
    crosswalk_candidates: dict[tuple[Any, ...], set[str]]
    crosswalk_by_fbg: dict[str, list[dict[str, str]]]
    master_records: dict[str, dict[str, str]]
    outcomes: dict[tuple[int, int, str], tuple[float, int, tuple[str, ...]]]
    source_audit: dict[str, Any]


def add_candidate(mapping: dict[tuple[Any, ...], set[str]], key: tuple[Any, ...], gsis_id: Any) -> None:
    identifier = safe_text(gsis_id)
    if identifier and identifier.lower() not in {"nan", "none", "na"}:
        mapping.setdefault(key, set()).add(identifier)


def source_key(season: Any, week: Any, name: Any, position: Any, team: Any) -> tuple[Any, ...]:
    return (
        int(season),
        int(week),
        normalize_name(name),
        safe_text(position).upper(),
        normalize_team(team),
    )


def master_key(position: Any, name: Any) -> tuple[Any, ...]:
    return (safe_text(position).upper(), normalize_name(name))


def row_name_values(row: pd.Series, fields: Iterable[str]) -> list[str]:
    values = []
    for field in fields:
        value = safe_text(row.get(field))
        if value and normalize_name(value):
            values.append(value)
    return list(dict.fromkeys(values))


def load_manual_overrides(bt: Path) -> dict[tuple[str, str], dict[str, str]]:
    path = bt / "data" / "player_id_overrides.csv"
    if not path.is_file():
        return {}
    overrides = pd.read_csv(path, dtype="string").fillna("")
    required = {"fbg_id", "position", "gsis_id", "reason"}
    missing = required.difference(overrides.columns)
    if missing:
        raise DataQualityGateError(f"Manual override file is missing columns: {sorted(missing)}")
    records: dict[tuple[str, str], dict[str, str]] = {}
    for row in overrides.itertuples(index=False):
        fbg_id = safe_text(getattr(row, "fbg_id"))
        position = safe_text(getattr(row, "position")).upper()
        gsis_id = safe_text(getattr(row, "gsis_id"))
        reason = safe_text(getattr(row, "reason"))
        key = (fbg_id, position)
        if not fbg_id or position not in POSITIONS or not gsis_id or not reason:
            raise DataQualityGateError(
                f"Every manual override needs fbg_id, valid position, gsis_id, and reason: {key}"
            )
        if key in records:
            raise DataQualityGateError(f"Duplicate manual override key: {key}")
        records[key] = {"gsis_id": gsis_id, "reason": reason}
    return records


def load_identity_sources(root: Path, seasons: Iterable[int]) -> tuple[IdentitySources, dict[str, str]]:
    """Build weekly stats, roster, master, crosswalk, and outcome indexes."""
    bt = backtest_root(root)
    season_values = sorted({int(value) for value in seasons})
    stats_candidates: dict[tuple[Any, ...], set[str]] = {}
    roster_candidates: dict[tuple[Any, ...], set[str]] = {}
    outcomes: dict[tuple[int, int, str], tuple[float, int, tuple[str, ...]]] = {}
    stats_rows = 0
    roster_rows = 0
    outcome_groups = 0

    stats_frames: list[pd.DataFrame] = []
    stats_columns = [
        "player_id",
        "player_name",
        "player_display_name",
        "position",
        "season",
        "week",
        "season_type",
        "team",
        "fantasy_points_ppr",
    ]
    for season in season_values:
        path = bt / "data" / "raw" / "nflreadr" / "player_stats" / f"season={season}.parquet"
        if not path.is_file():
            raise FileNotFoundError(f"Missing approved weekly stats file: {path}")
        stats = pd.read_parquet(path, columns=stats_columns)
        stats = stats[
            stats["season_type"].astype("string").str.upper().eq("REG")
            & stats["position"].astype("string").str.upper().isin(POSITIONS)
        ].copy()
        stats_frames.append(stats)
        stats_rows += len(stats)
        for row in stats.itertuples(index=False):
            identifier = safe_text(row.player_id)
            if not identifier:
                continue
            for name in [safe_text(row.player_display_name), safe_text(row.player_name)]:
                if normalize_name(name):
                    add_candidate(
                        stats_candidates,
                        source_key(row.season, row.week, name, row.position, row.team),
                        identifier,
                    )
    all_stats = pd.concat(stats_frames, ignore_index=True) if stats_frames else pd.DataFrame()
    if not all_stats.empty:
        all_stats["_ppr"] = pd.to_numeric(all_stats["fantasy_points_ppr"], errors="coerce")
        valid = all_stats[all_stats["_ppr"].notna()].copy()
        grouped = valid.groupby(["season", "week", "player_id"], sort=False, dropna=False)
        for key, group in grouped:
            identifier = safe_text(key[2])
            if not identifier:
                continue
            teams = tuple(sorted({normalize_team(value) for value in group["team"] if normalize_team(value)}))
            outcomes[(int(key[0]), int(key[1]), identifier)] = (
                float(group["_ppr"].sum()),
                int(len(group)),
                teams,
            )
        outcome_groups = len(outcomes)

    roster_columns = [
        "season",
        "team",
        "position",
        "full_name",
        "first_name",
        "last_name",
        "gsis_id",
        "week",
        "game_type",
    ]
    for season in season_values:
        path = bt / "data" / "raw" / "nflreadr" / "rosters_weekly" / f"season={season}.parquet"
        if not path.is_file():
            raise FileNotFoundError(f"Missing approved weekly roster file: {path}")
        roster = pd.read_parquet(path, columns=roster_columns)
        roster = roster[
            roster["game_type"].astype("string").str.upper().eq("REG")
            & roster["position"].astype("string").str.upper().isin(POSITIONS)
        ].copy()
        roster_rows += len(roster)
        for row in roster.itertuples(index=False):
            identifier = safe_text(row.gsis_id)
            if not identifier:
                continue
            names = [safe_text(row.full_name), " ".join([safe_text(row.first_name), safe_text(row.last_name)]).strip()]
            for name in names:
                if normalize_name(name):
                    add_candidate(
                        roster_candidates,
                        source_key(row.season, row.week, name, row.position, row.team),
                        identifier,
                    )

    master_path = bt / "data" / "raw" / "nflreadr" / "players.parquet"
    master = pd.read_parquet(master_path)
    master_records: dict[str, dict[str, str]] = {}
    master_candidates: dict[tuple[Any, ...], set[str]] = {}
    for row in master.to_dict("records"):
        identifier = safe_text(row.get("gsis_id"))
        position = safe_text(row.get("position")).upper()
        if not identifier or position not in POSITIONS:
            continue
        names = [
            safe_text(row.get("display_name")),
            " ".join([safe_text(row.get("common_first_name")), safe_text(row.get("last_name"))]).strip(),
            " ".join([safe_text(row.get("first_name")), safe_text(row.get("last_name"))]).strip(),
            " ".join([safe_text(row.get("football_name")), safe_text(row.get("last_name"))]).strip(),
        ]
        names = [name for name in names if normalize_name(name)]
        for name in names:
            add_candidate(master_candidates, master_key(position, name), identifier)
        master_records.setdefault(
            identifier,
            {
                "display_name": safe_text(row.get("display_name")),
                "position": position,
                "latest_team": normalize_team(row.get("latest_team")),
            },
        )

    crosswalk_candidates: dict[tuple[Any, ...], set[str]] = {}
    crosswalk_by_fbg: dict[str, list[dict[str, str]]] = {}
    crosswalk_path = root.parent / "ff_drafter_2026" / "raw" / "dynastyprocess" / "db_playerids.csv"
    crosswalk_loaded = False
    if crosswalk_path.is_file():
        crosswalk = pd.read_csv(crosswalk_path, dtype="string").fillna("")
        required = {"pfr_id", "gsis_id", "name", "position", "team"}
        missing = required.difference(crosswalk.columns)
        if missing:
            raise DataQualityGateError(f"External crosswalk is missing columns: {sorted(missing)}")
        for row in crosswalk.to_dict("records"):
            fbg_id = safe_text(row.get("pfr_id"))
            identifier = safe_text(row.get("gsis_id"))
            name = safe_text(row.get("name"))
            position = safe_text(row.get("position")).upper()
            team = normalize_team(row.get("team"))
            if not fbg_id or not identifier:
                continue
            record = {
                "fbg_id": fbg_id,
                "gsis_id": identifier,
                "name": name,
                "position": position,
                "team": team,
            }
            crosswalk_by_fbg.setdefault(fbg_id, []).append(record)
            if name and position in POSITIONS and team and team != "FA":
                add_candidate(
                    crosswalk_candidates,
                    (fbg_id, normalize_name(name), position, team),
                    identifier,
                )
        crosswalk_loaded = True

    source_audit = {
        "weekly_stats_rows": stats_rows,
        "weekly_roster_rows": roster_rows,
        "weekly_outcome_groups": outcome_groups,
        "master_rows": int(len(master)),
        "external_crosswalk_path": str(crosswalk_path),
        "external_crosswalk_loaded": crosswalk_loaded,
    }
    return (
        IdentitySources(
            stats_candidates=stats_candidates,
            roster_candidates=roster_candidates,
            master_candidates=master_candidates,
            crosswalk_candidates=crosswalk_candidates,
            crosswalk_by_fbg=crosswalk_by_fbg,
            master_records=master_records,
            outcomes=outcomes,
            source_audit=source_audit,
        ),
        load_manual_overrides(bt),
    )


def resolve_identity_row(
    row: pd.Series,
    sources: IdentitySources,
    overrides: dict[tuple[str, str], dict[str, str]],
) -> dict[str, Any]:
    """Resolve one FBG row in the approved source order."""
    season = int(row["season"])
    week = int(row["week"])
    fbg_id = safe_text(row["fbg_id"])
    position = safe_text(row["position"]).upper()
    player_name = safe_text(row.get("player_name"))
    team = normalize_team(row.get("team"))
    name_key = normalize_name(player_name)
    weekly_key = (season, week, name_key, position, team)
    source_candidates = {
        "weekly_stats_name_position_team": set(sources.stats_candidates.get(weekly_key, set())),
        "weekly_roster_name_position_team": set(sources.roster_candidates.get(weekly_key, set())),
        "master_name_position": set(sources.master_candidates.get(master_key(position, player_name), set())),
        "pfr_crosswalk_verified": set(
            sources.crosswalk_candidates.get((fbg_id, name_key, position, team), set())
        ),
    }
    candidate_union = set().union(*source_candidates.values())
    notes: list[str] = []
    conflict_fields: set[str] = set()

    raw_crosswalk_rows = sources.crosswalk_by_fbg.get(fbg_id, [])
    if raw_crosswalk_rows and not source_candidates["pfr_crosswalk_verified"]:
        notes.append("crosswalk_fields_disagree")
        for crosswalk_row in raw_crosswalk_rows:
            if normalize_name(crosswalk_row.get("name")) != name_key:
                conflict_fields.add("name")
            if safe_text(crosswalk_row.get("position")).upper() != position:
                conflict_fields.add("position")
            if normalize_team(crosswalk_row.get("team")) != team:
                conflict_fields.add("team")
    elif raw_crosswalk_rows:
        if any(
            normalize_name(crosswalk_row.get("name")) != name_key
            or safe_text(crosswalk_row.get("position")).upper() != position
            or normalize_team(crosswalk_row.get("team")) != team
            for crosswalk_row in raw_crosswalk_rows
        ):
            notes.append("crosswalk_has_disagreeing_rows")

    stats_ids = source_candidates["weekly_stats_name_position_team"]
    roster_ids = source_candidates["weekly_roster_name_position_team"]
    if len(stats_ids) > 1:
        notes.append("weekly_stats_not_unique")
    if len(roster_ids) > 1:
        notes.append("weekly_roster_not_unique")
    if len(stats_ids) == 1 and len(roster_ids) == 1 and stats_ids != roster_ids:
        notes.append("conflicting_weekly_source_ids")

    override = overrides.get((fbg_id, position))
    if override:
        resolved_id = override["gsis_id"]
        match_method = "manual_override"
        override_reason = override["reason"]
        notes.append("manual_override_applied")
        if candidate_union and resolved_id not in candidate_union:
            notes.append("manual_override_superseded_candidate")
    else:
        resolved_id = ""
        match_method = "unmatched"
        override_reason = ""
        for method in (
            "weekly_stats_name_position_team",
            "weekly_roster_name_position_team",
            "master_name_position",
            "pfr_crosswalk_verified",
        ):
            candidates = source_candidates[method]
            if len(candidates) == 1:
                resolved_id = next(iter(candidates))
                match_method = method
                break

    master_record = sources.master_records.get(resolved_id)
    if resolved_id and master_record is None:
        # A weekly stats or roster match is already an approved identity
        # source.  The master table is a context source, so an older player
        # missing from the current master snapshot is recorded as a warning,
        # not treated as a new identity.
        notes.append("gsis_id_not_in_master")
    if master_record is not None:
        master_position = safe_text(master_record.get("position")).upper()
        if master_position and master_position != position:
            notes.append("master_position_conflict")
            conflict_fields.add("position")
        master_name = normalize_name(master_record.get("display_name"))
        if master_name and name_key and master_name != name_key:
            notes.append("master_name_conflict")
            conflict_fields.add("name")
        master_team = normalize_team(master_record.get("latest_team"))
        if master_team and team and master_team != team:
            notes.append("master_team_context_differs")
            conflict_fields.add("team")

    serious_reasons: list[str] = []
    if not resolved_id:
        serious_reasons.append("no_unique_gsis_id")
    if "conflicting_weekly_source_ids" in notes:
        serious_reasons.append("conflicting_weekly_source_ids")
    if "weekly_stats_not_unique" in notes and len(roster_ids) != 1 and not override:
        serious_reasons.append("weekly_stats_not_unique")
    if "weekly_roster_not_unique" in notes and len(stats_ids) != 1 and not override:
        serious_reasons.append("weekly_roster_not_unique")
    severity = "Serious" if serious_reasons else ("Warning" if notes else "Info")
    return {
        "season": season,
        "week": week,
        "fbg_id": fbg_id,
        "position": position,
        "stable_player_id": resolved_id or pd.NA,
        "match_method": match_method,
        "candidate_count": int(1 if override else len(candidate_union)),
        "source_candidate_ids": json.dumps(
            {name: sorted(values) for name, values in source_candidates.items()},
            sort_keys=True,
        ),
        "override_reason": override_reason,
        "identity_conflict_fields": ",".join(sorted(conflict_fields)),
        "resolution_notes": ";".join(dict.fromkeys(notes)),
        "serious_reasons": ";".join(dict.fromkeys(serious_reasons)),
        "identity_severity": severity,
    }


def apply_identity_resolution(
    panel: pd.DataFrame,
    sources: IdentitySources,
    overrides: dict[tuple[str, str], dict[str, str]],
) -> pd.DataFrame:
    resolution = pd.DataFrame(
        [resolve_identity_row(row, sources, overrides) for _, row in panel.iterrows()]
    )
    duplicate_keys = resolution.duplicated(list(KEY_COLUMNS), keep=False)
    if duplicate_keys.any():
        raise DataQualityGateError("Identity resolution produced duplicate panel keys")
    output = panel.drop(
        columns=[
            "gsis_id",
            "match_method",
            "candidate_count",
            "actual_score",
            "actual_record",
            "stable_player_id",
            "override_reason",
            "identity_conflict_fields",
            "resolution_notes",
            "serious_reasons",
            "identity_severity",
        ],
        errors="ignore",
    ).merge(
        resolution, on=list(KEY_COLUMNS), how="left", validate="one_to_one"
    )
    return attach_outcomes(output, sources)


def attach_outcomes(frame: pd.DataFrame, sources: IdentitySources) -> pd.DataFrame:
    observed_scores: list[float] = []
    actual_records: list[int] = []
    imputed: list[bool] = []
    outcome_teams: list[str] = []
    for row in frame.itertuples(index=False):
        identifier = safe_text(getattr(row, "stable_player_id"))
        outcome = sources.outcomes.get((int(row.season), int(row.week), identifier)) if identifier else None
        if outcome is None:
            observed_scores.append(0.0 if identifier else np.nan)
            actual_records.append(0)
            imputed.append(bool(identifier))
            outcome_teams.append("")
        else:
            observed_scores.append(float(outcome[0]))
            actual_records.append(1)
            imputed.append(False)
            outcome_teams.append(";".join(outcome[2]))
    output = frame.copy()
    output["actual_score"] = observed_scores
    output["actual_record"] = actual_records
    output["actual_score_imputed"] = imputed
    output["outcome_teams"] = outcome_teams
    return output


def rank_summary_feature_audit() -> pd.DataFrame:
    decisions = {
        "ecr": (
            True,
            "Mean of the selected rank values. With one set it is that rank, and with many sets it is their mean.",
        ),
        "rank_sd": (
            False,
            "Source-set dispersion is undefined as a truthful serving value when only one projection set is sent.",
        ),
        "n_projectors": (
            False,
            "Source-set count is not available in the one-set serving row. It remains a data-quality field only.",
        ),
        "rank_min": (
            False,
            "Minimum across source sets changes meaning when there is only one set and is not available at serving.",
        ),
        "rank_max": (
            False,
            "Maximum across source sets changes meaning when there is only one set and is not available at serving.",
        ),
        "consensus_rank": (
            False,
            "This is a selected consensus-set field, while the v2 serving contract has a generic one-set rank.",
        ),
        "consensus_projected_score": (
            False,
            "This is a selected consensus-set field. v2 uses the explicit PPR projection_fpts field instead.",
        ),
    }
    rows = []
    for field in ALL_RANK_SUMMARY_FIELDS:
        kept, reason = decisions[field]
        rows.append(
            {
                "field": field,
                "kept_as_model_feature": kept,
                "kept_in_data_quality_report": True,
                "meaning_stable_one_or_many_projection_sets": kept,
                "reason": reason,
            }
        )
    return pd.DataFrame(rows)


def build_outcome_errors(frame: pd.DataFrame, top_keys: set[tuple[Any, ...]]) -> pd.DataFrame:
    rows = []
    for row in frame.itertuples(index=False):
        key = (int(row.season), int(row.week), safe_text(row.fbg_id), safe_text(row.position).upper())
        error_types: list[str] = []
        serious = safe_text(getattr(row, "serious_reasons", ""))
        if serious:
            error_types.extend([value for value in serious.split(";") if value])
        notes = safe_text(getattr(row, "resolution_notes", ""))
        if notes:
            for note in notes.split(";"):
                if note in {
                    "crosswalk_fields_disagree",
                    "crosswalk_has_disagreeing_rows",
                    "master_position_conflict",
                    "master_name_conflict",
                    "master_team_context_differs",
                    "conflicting_weekly_source_ids",
                }:
                    error_types.append(note)
        if not safe_text(getattr(row, "stable_player_id", "")):
            error_types.append("no_unique_gsis_id")
        if int(getattr(row, "actual_record", 0)) != 1:
            error_types.extend(["no_actual_weekly_record", "actual_score_created_from_missing_record"])
        if not error_types:
            continue
        error_types = list(dict.fromkeys(error_types))
        is_top = key in top_keys
        severity = "Serious" if serious and is_top else ("Warning" if is_top else "Info")
        rows.append(
            {
                "season": int(row.season),
                "week": int(row.week),
                "fbg_id": safe_text(row.fbg_id),
                "player_name": safe_text(getattr(row, "player_name", "")),
                "position": safe_text(row.position).upper(),
                "team": normalize_team(getattr(row, "team", "")),
                "stable_player_id": safe_text(getattr(row, "stable_player_id", "")),
                "actual_score": float(row.actual_score) if pd.notna(row.actual_score) else np.nan,
                "actual_record": int(row.actual_record),
                "actual_score_imputed": bool(row.actual_score_imputed),
                "top_projected": is_top,
                "match_method": safe_text(row.match_method),
                "override_reason": safe_text(getattr(row, "override_reason", "")),
                "error_type": ";".join(error_types),
                "severity": severity,
                "resolution_notes": notes,
            }
        )
    columns = [
        "season",
        "week",
        "fbg_id",
        "player_name",
        "position",
        "team",
        "stable_player_id",
        "actual_score",
        "actual_record",
        "actual_score_imputed",
        "top_projected",
        "match_method",
        "override_reason",
        "error_type",
        "severity",
        "resolution_notes",
    ]
    return pd.DataFrame(rows, columns=columns)


def run_quality_gate(
    panel: pd.DataFrame,
    top: pd.DataFrame,
    sources: IdentitySources,
    overrides: dict[tuple[str, str], dict[str, str]],
    output_dir: Path,
) -> tuple[pd.DataFrame, dict[str, Any], pd.DataFrame]:
    resolved = apply_identity_resolution(panel, sources, overrides)
    top_keys = {
        (int(row.season), int(row.week), safe_text(row.fbg_id), safe_text(row.position).upper())
        for row in top.itertuples(index=False)
    }
    resolved["top_projected"] = [
        (int(row.season), int(row.week), safe_text(row.fbg_id), safe_text(row.position).upper()) in top_keys
        for row in resolved.itertuples(index=False)
    ]
    top_gate = resolved[resolved["top_projected"]].copy()
    if len(top_gate) != len(top):
        raise DataQualityGateError(
            f"Top-player gate lost keys: selected={len(top)}, resolved={len(top_gate)}"
        )
    top_gate["outcome_linked"] = top_gate["actual_record"].eq(1)
    top_gate["identity_linked"] = top_gate["stable_player_id"].notna()
    top_gate["serious_gate_error"] = top_gate["serious_reasons"].fillna("").ne("")
    top_group_selection = (
        top.groupby(["season", "week", "position"], sort=True)
        .size()
        .rename("selected_rows")
        .reset_index()
    )
    top_group_selection["required_limit"] = top_group_selection["position"].map(TOP_LIMITS)
    top_group_selection["selection_status"] = np.where(
        top_group_selection["selected_rows"].eq(top_group_selection["required_limit"]),
        "full_limit",
        "source_has_fewer_rows",
    )

    known_mapping_results: dict[str, dict[str, Any]] = {}
    serious_known_mapping_errors: list[str] = []
    for fbg_id, expected_id in KNOWN_MAPPINGS.items():
        rows = resolved[resolved["fbg_id"].eq(fbg_id)]
        actual_ids = sorted({safe_text(value) for value in rows["stable_player_id"] if safe_text(value)})
        passed = actual_ids == [expected_id]
        known_mapping_results[fbg_id] = {
            "expected_gsis_id": expected_id,
            "resolved_gsis_ids": actual_ids,
            "passed": passed,
            "row_count": int(len(rows)),
        }
        if not passed:
            serious_known_mapping_errors.append(f"{fbg_id} expected {expected_id}, got {actual_ids}")
    if serious_known_mapping_errors:
        top_gate.loc[:, "serious_gate_error"] = True

    summary_rows = []
    for position in POSITIONS:
        position_top = top_gate[top_gate["position"].eq(position)]
        summary_rows.append(
            {
                "position": position,
                "top_limit": TOP_LIMITS[position],
                "selected_rows": int(len(position_top)),
                "identity_linked_rows": int(position_top["identity_linked"].sum()),
                "observed_outcome_rows": int(position_top["outcome_linked"].sum()),
                "imputed_zero_rows": int(position_top["actual_score_imputed"].sum()),
                "serious_error_rows": int(position_top["serious_gate_error"].sum()),
                "identity_coverage": float(position_top["identity_linked"].mean())
                if len(position_top)
                else np.nan,
                "outcome_coverage": float(position_top["outcome_linked"].mean())
                if len(position_top)
                else np.nan,
                "gate_status": "PASS"
                if len(position_top)
                and position_top["identity_linked"].all()
                and not position_top["serious_gate_error"].any()
                else "FAIL",
            }
        )
    gate_summary = pd.DataFrame(summary_rows)
    outcome_errors = build_outcome_errors(resolved, top_keys)
    top_serious = int(top_gate["serious_gate_error"].sum()) + len(serious_known_mapping_errors)
    total_imputed = int(resolved["actual_score_imputed"].sum())
    quality = {
        "gate_status": "FAIL"
        if top_serious
        else ("PASS_WITH_OUTCOME_WARNINGS" if int((~top_gate["outcome_linked"]).sum()) else "PASS"),
        "serious_top_player_error_count": top_serious,
        "serious_top_player_errors": serious_known_mapping_errors
        + top_gate.loc[top_gate["serious_gate_error"], "serious_reasons"].dropna().tolist(),
        "known_mappings": known_mapping_results,
        "top_player_gate": gate_summary.to_dict("records"),
        "top_player_selection_by_group": top_group_selection.to_dict("records"),
        "top_player_groups_below_limit": int(
            top_group_selection["selection_status"].eq("source_has_fewer_rows").sum()
        ),
        "top_player_selected_rows": int(len(top_gate)),
        "top_player_identity_coverage": float(top_gate["identity_linked"].mean()),
        "top_player_outcome_coverage": float(top_gate["outcome_linked"].mean()),
        "top_player_observed_outcome_rows": int(top_gate["outcome_linked"].sum()),
        "top_player_imputed_zero_rows": int(top_gate["actual_score_imputed"].sum()),
        "all_panel_rows": int(len(resolved)),
        "all_panel_imputed_zero_rows": total_imputed,
        "outcome_error_rows": int(len(outcome_errors)),
        "outcome_error_counts": {
            str(key): int(value)
            for key, value in outcome_errors["error_type"].value_counts().items()
        }
        if not outcome_errors.empty
        else {},
        "identity_match_method_counts": {
            str(key): int(value) for key, value in resolved["match_method"].value_counts(dropna=False).items()
        },
        "identity_severity_counts": {
            str(key): int(value) for key, value in resolved["identity_severity"].value_counts(dropna=False).items()
        },
        "source_audit": sources.source_audit,
    }
    output_dir.mkdir(parents=True, exist_ok=True)
    top_gate.to_csv(output_dir / "top_player_gate.csv", index=False)
    top_group_selection.to_csv(output_dir / "top_player_selection_by_group.csv", index=False)
    resolved.to_csv(output_dir / "identity_resolution_audit.csv", index=False)
    outcome_errors.to_csv(output_dir / "outcome_errors.csv", index=False)
    rank_summary_feature_audit().to_csv(output_dir / "rank_summary_feature_audit.csv", index=False)
    (output_dir / "data_quality_report.json").write_text(
        json.dumps(json_safe(quality), indent=2), encoding="utf-8"
    )
    if top_serious:
        raise DataQualityGateError(
            "Serious top-player data linkage errors block model training. "
            f"See {output_dir / 'data_quality_report.json'} and {output_dir / 'outcome_errors.csv'}."
        )
    return resolved, quality, outcome_errors


def build_panel(root: Path, projections: pd.DataFrame) -> pd.DataFrame:
    bt = backtest_root(root)
    summary_columns = [
        *KEY_COLUMNS,
        "player_name",
        "team",
        "gsis_id",
        "match_method",
        "candidate_count",
        *ALL_RANK_SUMMARY_FIELDS,
        "actual_score",
        "actual_record",
        "scoring_format",
        "scoring_contract_version",
    ]
    summary = pd.read_parquet(
        bt / "data" / "derived" / "fbg_rank_summary.parquet", columns=summary_columns
    )
    require_ppr_artifact(summary, "FBG rank summary")
    summary["position"] = summary["position"].astype("string").str.upper()
    summary["fbg_id"] = summary["fbg_id"].astype("string").str.strip()
    summary["team"] = summary["team"].map(normalize_team)
    summary = summary[summary["position"].isin(POSITIONS)].copy()
    duplicates = summary.duplicated(list(KEY_COLUMNS), keep=False)
    if duplicates.any():
        raise DataQualityGateError("The rank summary has duplicate identity keys")
    panel = projections.merge(
        summary,
        on=list(KEY_COLUMNS),
        how="left",
        validate="one_to_one",
        suffixes=("", "_summary"),
        indicator="summary_join",
    )
    if panel["summary_join"].ne("both").any():
        counts = panel["summary_join"].value_counts(dropna=False).to_dict()
        raise DataQualityGateError(f"Projection and rank-summary keys do not match: {counts}")
    panel = panel.drop(columns=["summary_join"])
    difference = (
        pd.to_numeric(panel["consensus_projected_score"], errors="coerce")
        - pd.to_numeric(panel["projection_fpts"], errors="coerce")
    ).abs()
    finite_difference = difference.dropna()
    panel.attrs["projection_score_max_abs_difference"] = (
        float(finite_difference.max()) if not finite_difference.empty else np.nan
    )
    return panel


def build_evaluation_dataset(root: Path, resolved: pd.DataFrame) -> tuple[pd.DataFrame, dict[str, Any]]:
    """Create the common ffsimulator and XGBoost held-out row universe."""
    bt = backtest_root(root)
    baseline_columns = [
        *KEY_COLUMNS,
        "p15",
        "p50",
        "p85",
        "scoring_format",
        "scoring_contract_version",
    ]
    baseline = pd.read_parquet(
        bt / "outputs" / "player_predictions.parquet", columns=baseline_columns
    )
    require_ppr_artifact(baseline, "ffsimulator player predictions")
    baseline["position"] = baseline["position"].astype("string").str.upper()
    baseline["fbg_id"] = baseline["fbg_id"].astype("string").str.strip()
    baseline = baseline[baseline["position"].isin(POSITIONS)].copy()
    duplicate_baseline = baseline.duplicated(list(KEY_COLUMNS), keep=False)
    if duplicate_baseline.any():
        raise DataQualityGateError("ffsimulator predictions have duplicate comparison keys")
    baseline = baseline.rename(
        columns={"p15": "ffsim_p15", "p50": "ffsim_p50", "p85": "ffsim_p85"}
    ).drop(columns=["scoring_format", "scoring_contract_version"])
    resolved_columns = [
        *KEY_COLUMNS,
        "player_name",
        "team",
        "stable_player_id",
        "match_method",
        "candidate_count",
        "ecr",
        "rank_sd",
        "n_projectors",
        "rank_min",
        "rank_max",
        "consensus_rank",
        "consensus_projected_score",
        "actual_score",
        "actual_record",
        "actual_score_imputed",
        "projection_fpts",
        *PROJECTION_COLUMNS,
        "top_projected",
        "identity_severity",
        "resolution_notes",
    ]
    resolved_columns = [column for column in resolved_columns if column in resolved.columns]
    evaluation = resolved[resolved_columns].merge(
        baseline,
        on=list(KEY_COLUMNS),
        how="left",
        validate="one_to_one",
        indicator="ffsim_join",
    )
    join_counts = evaluation["ffsim_join"].value_counts(dropna=False).to_dict()
    evaluation = evaluation.drop(columns=["ffsim_join"])
    evaluation["team"] = evaluation["team"].map(normalize_team)
    evaluation["is_top_projected"] = evaluation["top_projected"].fillna(False).astype(bool)
    evaluation["stable_player_id"] = evaluation["stable_player_id"].astype("string")
    evaluation["actual_score"] = pd.to_numeric(evaluation["actual_score"], errors="coerce")
    evaluation["projection_fpts"] = pd.to_numeric(evaluation["projection_fpts"], errors="coerce")
    valid = (
        evaluation["stable_player_id"].notna()
        & evaluation["stable_player_id"].ne("")
        & evaluation["actual_score"].notna()
        & evaluation["projection_fpts"].notna()
    )
    modeling = evaluation[valid].copy()
    if modeling.empty:
        raise DataQualityGateError("No projected rows have a resolved ID and actual score")
    duplicate_stable = modeling.duplicated(
        ["season", "week", "position", "stable_player_id"], keep=False
    )
    duplicate_stable_groups = modeling.loc[duplicate_stable].groupby(
        ["season", "week", "position", "stable_player_id"], sort=True
    ).size()
    n_projector_counts = (
        resolved["n_projectors"].value_counts(dropna=False).sort_index().to_dict()
        if "n_projectors" in resolved
        else {}
    )
    audit = {
        "ffsimulator_rows": int(len(baseline)),
        "ffsimulator_join_counts": {str(key): int(value) for key, value in join_counts.items()},
        "modeling_rows": int(len(modeling)),
        "excluded_rows_without_resolved_id_or_actual_or_projection": int(len(evaluation) - len(modeling)),
        "modeling_rows_with_ffsimulator_output": int(
            modeling[["ffsim_p15", "ffsim_p50", "ffsim_p85"]].notna().all(axis=1).sum()
        ),
        "modeling_rows_without_ffsimulator_output": int(
            modeling[["ffsim_p15", "ffsim_p50", "ffsim_p85"]].isna().any(axis=1).sum()
        ),
        "same_stable_id_duplicate_groups": int(len(duplicate_stable_groups)),
        "same_stable_id_duplicate_rows": int(duplicate_stable.sum()),
        "same_stable_id_duplicate_group_samples": [
            {
                "season": int(key[0]),
                "week": int(key[1]),
                "position": str(key[2]),
                "stable_player_id": str(key[3]),
                "rows": int(value),
            }
            for key, value in list(duplicate_stable_groups.items())[:20]
        ],
        "modeling_rows_by_season_position": {
            f"{int(season)}_{position}": int(count)
            for (season, position), count in modeling.groupby(["season", "position"]).size().items()
        },
        "n_projectors_distribution": {str(key): int(value) for key, value in n_projector_counts.items()},
        "n_projectors_used_as_model_feature": False,
        "serving_feature_row_contains_n_projectors": False,
        "scoring_format": SCORING_FORMAT,
        "scoring_contract_version": SCORING_CONTRACT_VERSION,
    }
    return modeling, audit


def feature_columns(frame: pd.DataFrame, position: str) -> list[str]:
    candidates = [*MODEL_RANK_FEATURES, *PROJECTION_COLUMNS, "projection_fpts"]
    subset = frame[frame["position"].eq(position)]
    selected = []
    for column in candidates:
        if column not in subset.columns:
            continue
        values = pd.to_numeric(subset[column], errors="coerce")
        if int(values.dropna().nunique()) > 1:
            selected.append(column)
    assert_feature_columns(selected)
    if not selected:
        raise ValueError(f"No variable v2 features are available for {position}")
    return selected


def to_dmatrix(
    frame: pd.DataFrame,
    features: list[str],
    with_label: bool,
    require_positive: bool | None = None,
) -> xgb.DMatrix:
    assert_feature_columns(features)
    missing = sorted(set(features).difference(frame.columns))
    if missing:
        raise ValueError(f"DMatrix input is missing features: {missing}")
    values = frame[features].apply(pd.to_numeric, errors="coerce").to_numpy(dtype=np.float32)
    labels = None
    if with_label:
        if "actual_score" not in frame:
            raise ValueError("Training DMatrix needs actual_score")
        labels = pd.to_numeric(frame["actual_score"], errors="coerce").to_numpy(dtype=np.float32)
        positive_required = with_label if require_positive is None else require_positive
        if not np.isfinite(labels).all() or (positive_required and not (labels > 0).all()):
            raise ValueError("Every training DMatrix row must have actual_score > 0")
    return xgb.DMatrix(values, label=labels, feature_names=features, missing=np.nan)


def pinball_loss(actual: np.ndarray, prediction: np.ndarray, alpha: float) -> float:
    residual = np.asarray(actual, dtype=float) - np.asarray(prediction, dtype=float)
    loss = np.where(residual >= 0.0, alpha * residual, (alpha - 1.0) * residual)
    return float(np.mean(loss))


def multi_pinball_loss(actual: np.ndarray, prediction: np.ndarray) -> float:
    prediction_array = np.asarray(prediction, dtype=float)
    if prediction_array.ndim == 1:
        prediction_array = prediction_array.reshape(-1, len(QUANTILES))
    return float(
        np.mean(
            [
                pinball_loss(actual, prediction_array[:, index], alpha)
                for index, alpha in enumerate(QUANTILES)
            ]
        )
    )


def multi_pinball_metric(
    prediction: np.ndarray, dmatrix: xgb.DMatrix
) -> tuple[str, float]:
    prediction_array = np.asarray(prediction)
    if prediction_array.ndim == 1:
        prediction_array = prediction_array.reshape(-1, len(QUANTILES))
    return "multi_pinball", multi_pinball_loss(dmatrix.get_label(), prediction_array)


def validate_prediction_matrix(prediction: np.ndarray, row_count: int) -> np.ndarray:
    values = np.asarray(prediction, dtype=float)
    expected_shape = (row_count, len(QUANTILES))
    if values.shape != expected_shape:
        raise ValueError(f"XGBoost returned {values.shape}, expected {expected_shape}")
    if not np.isfinite(values).all():
        raise ValueError("XGBoost returned a non-finite quantile prediction")
    return values


def make_grid() -> list[dict[str, Any]]:
    grid = []
    for max_depth, min_child_weight, subsample, colsample, learning_rate, reg_lambda in itertools.product(
        (2, 3, 4),
        (1.0, 5.0, 15.0),
        (0.70, 0.90),
        (0.70, 1.00),
        (0.03, 0.06),
        (1.0, 5.0),
    ):
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
    return {
        "objective": "reg:quantileerror",
        "quantile_alpha": list(QUANTILES),
        "tree_method": "hist",
        "max_bin": 256,
        "nthread": nthread,
        "seed": seed,
        "verbosity": 0,
        **settings,
    }


def assert_walk_forward_split(prior: pd.DataFrame, target: pd.DataFrame, target_season: int) -> None:
    if prior.empty or target.empty:
        raise ValueError(f"Cannot validate an empty walk-forward split for {target_season}")
    prior_seasons = set(prior["season"].astype(int).unique())
    target_seasons = set(target["season"].astype(int).unique())
    if any(season >= target_season for season in prior_seasons):
        raise ValueError(f"Training rows for {target_season} contain target/future seasons")
    if target_seasons != {target_season}:
        raise ValueError(f"Target rows for {target_season} have unexpected seasons {target_seasons}")


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
    dtrain = to_dmatrix(train, features, with_label=True)
    dvalidation = to_dmatrix(validation, features, with_label=True, require_positive=False)
    validation_labels = pd.to_numeric(validation["actual_score"], errors="coerce").to_numpy(dtype=float)
    if not np.isfinite(validation_labels).all():
        raise ValueError("Validation labels must be finite")
    evals_result: dict[str, dict[str, list[float]]] = {}
    booster = xgb.train(
        xgb_params(settings, nthread=nthread, seed=seed),
        dtrain,
        num_boost_round=max_rounds,
        evals=[(dvalidation, "validation")],
        custom_metric=multi_pinball_metric,
        maximize=False,
        early_stopping_rounds=early_stopping_rounds,
        evals_result=evals_result,
        verbose_eval=False,
    )
    rounds = int(getattr(booster, "best_iteration", max_rounds - 1)) + 1
    prediction = validate_prediction_matrix(
        booster.predict(dvalidation, iteration_range=(0, rounds)), len(validation)
    )
    diagnostics = {
        **settings,
        "best_iteration": rounds - 1,
        "boosting_rounds": rounds,
        "validation_n": int(len(validation)),
        "validation_multi_pinball": multi_pinball_loss(validation_labels, prediction),
        "validation_p15_pinball": pinball_loss(validation_labels, prediction[:, 0], 0.15),
        "validation_p50_pinball": pinball_loss(validation_labels, prediction[:, 1], 0.50),
        "validation_p85_pinball": pinball_loss(validation_labels, prediction[:, 2], 0.85),
        "validation_p15_coverage": float(np.mean(validation_labels <= prediction[:, 0])),
        "validation_p50_coverage": float(np.mean(validation_labels <= prediction[:, 1])),
        "validation_p85_coverage": float(np.mean(validation_labels <= prediction[:, 2])),
    }
    return booster, diagnostics


def choose_model(
    train: pd.DataFrame,
    validation: pd.DataFrame,
    position: str,
    target_season: int,
    grid: list[dict[str, Any]],
    args: argparse.Namespace,
    all_features: list[str],
) -> tuple[dict[str, Any], pd.DataFrame]:
    results = []
    for index, settings in enumerate(grid, start=1):
        seed = 20260907 + target_season * 100 + POSITIONS.index(position)
        _, diagnostics = train_grid_model(
            train,
            validation,
            all_features,
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
                "grid_size": len(grid),
                "feature_count": len(all_features),
            }
        )
        results.append(diagnostics)
        if index == 1 or index == len(grid) or index % 12 == 0:
            print(f"  {position} {target_season}: grid {index}/{len(grid)}", flush=True)
    grid_results = pd.DataFrame(results).sort_values(
        ["validation_multi_pinball", "validation_p50_pinball", "max_depth", "grid_index"]
    ).reset_index(drop=True)
    best = grid_results.iloc[0].to_dict()
    selected = {
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
    selected["best_iteration"] = int(best["best_iteration"])
    selected["boosting_rounds"] = int(best["boosting_rounds"])
    return selected, grid_results


def fit_final_model(
    train: pd.DataFrame,
    features: list[str],
    settings: dict[str, Any],
    nthread: int,
    seed: int,
) -> xgb.Booster:
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


def quantile_crossings_frame(
    predictions: pd.DataFrame,
    p15_column: str = "p15",
    p50_column: str = "p50",
    p85_column: str = "p85",
    model: str = "xgboost_v2",
) -> pd.DataFrame:
    """Return one audit row for each raw quantile crossing event."""
    output_columns = [
        "model",
        "season",
        "week",
        "fbg_id",
        "stable_player_id",
        "position",
        "team",
        "crossing_type",
        "p15_raw",
        "p50_raw",
        "p85_raw",
        "model_target_season",
    ]
    rows = []
    for row in predictions.itertuples(index=False):
        p15 = float(getattr(row, p15_column))
        p50 = float(getattr(row, p50_column))
        p85 = float(getattr(row, p85_column))
        crossings = []
        if p15 > p50:
            crossings.append("p15_gt_p50")
        if p50 > p85:
            crossings.append("p50_gt_p85")
        if p15 > p85:
            crossings.append("p15_gt_p85")
        for crossing_type in crossings:
            rows.append(
                {
                    "model": model,
                    "season": int(getattr(row, "season")),
                    "week": int(getattr(row, "week")),
                    "fbg_id": safe_text(getattr(row, "fbg_id")),
                    "stable_player_id": safe_text(getattr(row, "stable_player_id")),
                    "position": safe_text(getattr(row, "position")).upper(),
                    "team": normalize_team(getattr(row, "team", "")),
                    "crossing_type": crossing_type,
                    "p15_raw": p15,
                    "p50_raw": p50,
                    "p85_raw": p85,
                    "model_target_season": int(getattr(row, "model_target_season")),
                }
            )
    return pd.DataFrame(rows, columns=output_columns)


def finite_prediction_rows(frame: pd.DataFrame, prefix: str) -> pd.DataFrame:
    columns = ["actual_score", f"{prefix}_p15", f"{prefix}_p50", f"{prefix}_p85"]
    missing = sorted(set(columns).difference(frame.columns))
    if missing:
        raise ValueError(f"Prediction comparison is missing columns: {missing}")
    numeric = frame[columns].apply(pd.to_numeric, errors="coerce")
    return frame.loc[numeric.notna().all(axis=1)].copy()


def metric_row(
    frame: pd.DataFrame,
    model: str,
    prefix: str,
    scope: str,
    scope_values: dict[str, Any],
) -> dict[str, Any] | None:
    complete = finite_prediction_rows(frame, prefix)
    if complete.empty:
        return None
    actual = complete["actual_score"].to_numpy(dtype=float)
    p15 = complete[f"{prefix}_p15"].to_numpy(dtype=float)
    p50 = complete[f"{prefix}_p50"].to_numpy(dtype=float)
    p85 = complete[f"{prefix}_p85"].to_numpy(dtype=float)
    crossing_events = int((p15 > p50).sum() + (p50 > p85).sum() + (p15 > p85).sum())
    return {
        "scope": scope,
        "scope_value": "all" if not scope_values else ",".join(
            f"{key}={value}" for key, value in scope_values.items()
        ),
        **scope_values,
        "model": model,
        "n": int(len(complete)),
        "p15_coverage": float(np.mean(actual <= p15)),
        "p50_coverage": float(np.mean(actual <= p50)),
        "p85_coverage": float(np.mean(actual <= p85)),
        "p15_pinball_loss": pinball_loss(actual, p15, 0.15),
        "p50_pinball_loss": pinball_loss(actual, p50, 0.50),
        "p85_pinball_loss": pinball_loss(actual, p85, 0.85),
        "p50_mae": float(np.mean(np.abs(actual - p50))),
        "p50_bias": float(np.mean(p50 - actual)),
        "interval_coverage": float(np.mean((actual >= p15) & (actual <= p85))),
        "interval_width": float(np.mean(p85 - p15)),
        "quantile_crossing_count": crossing_events,
        "scoring_format": SCORING_FORMAT,
        "scoring_contract_version": SCORING_CONTRACT_VERSION,
    }


def summarize_comparison(predictions: pd.DataFrame) -> pd.DataFrame:
    """Calculate the requested calibration and error metrics."""
    rows: list[dict[str, Any]] = []
    grouped_specs: list[tuple[str, list[str], pd.DataFrame]] = [("overall", [], predictions)]
    for column, scope in (("position", "position"), ("season", "season")):
        for value, group in predictions.groupby(column, sort=True, dropna=False):
            grouped_specs.append((scope, [column], group))
    for (season, position), group in predictions.groupby(["season", "position"], sort=True, dropna=False):
        grouped_specs.append(
            ("season_position", ["season", "position"], group)
        )
    top = predictions[predictions["is_top_projected"].eq(True)]
    if not top.empty:
        grouped_specs.append(("top_projected", [], top))
        for position, group in top.groupby("position", sort=True, dropna=False):
            grouped_specs.append(("top_projected_position", ["position"], group))

    for scope, columns, group in grouped_specs:
        scope_values = {}
        if columns:
            values = group.iloc[0]
            scope_values = {column: values[column] for column in columns}
        for model, prefix in (("xgboost_v2", "xgb"), ("ffsimulator", "ffsim")):
            row = metric_row(group, model, prefix, scope, scope_values)
            if row is not None:
                rows.append(row)
    return pd.DataFrame(rows)


def model_winners(metrics: pd.DataFrame) -> pd.DataFrame:
    rows = []
    position_metrics = metrics[metrics["scope"].eq("position")]
    for position in POSITIONS:
        group = position_metrics[position_metrics["position"].eq(position)]
        if group.empty:
            continue
        floor = group.sort_values(["p15_pinball_loss", "model"]).iloc[0]
        ceiling = group.sort_values(["p85_pinball_loss", "model"]).iloc[0]
        median = group.sort_values(["p50_pinball_loss", "model"]).iloc[0]
        rows.append(
            {
                "position": position,
                "floor_best_model": floor["model"],
                "floor_best_p15_pinball_loss": float(floor["p15_pinball_loss"]),
                "ceiling_best_model": ceiling["model"],
                "ceiling_best_p85_pinball_loss": float(ceiling["p85_pinball_loss"]),
                "median_best_model": median["model"],
                "median_best_p50_pinball_loss": float(median["p50_pinball_loss"]),
                "xgb_p15_pinball_loss": float(
                    group.loc[group["model"].eq("xgboost_v2"), "p15_pinball_loss"].iloc[0]
                ),
                "ffsim_p15_pinball_loss": float(
                    group.loc[group["model"].eq("ffsimulator"), "p15_pinball_loss"].iloc[0]
                ),
                "xgb_p85_pinball_loss": float(
                    group.loc[group["model"].eq("xgboost_v2"), "p85_pinball_loss"].iloc[0]
                ),
                "ffsim_p85_pinball_loss": float(
                    group.loc[group["model"].eq("ffsimulator"), "p85_pinball_loss"].iloc[0]
                ),
            }
        )
    return pd.DataFrame(rows)


def format_metric(value: Any, digits: int = 4) -> str:
    if value is None or pd.isna(value):
        return "NA"
    return f"{float(value):.{digits}f}"


def write_comparison_report(
    output_dir: Path,
    metrics: pd.DataFrame,
    winners: pd.DataFrame,
    quality: dict[str, Any],
    prediction_rows: int,
    crossing_count: int,
) -> None:
    lines = [
        "# XGBoost v2 comparison report",
        "",
        f"Release: `{MODEL_RELEASE}`  ",
        f"Scoring contract: `{SCORING_FORMAT}` / `{SCORING_CONTRACT_VERSION}`  ",
        f"Common held-out comparison rows: **{prediction_rows:,}**  ",
        f"Raw XGBoost quantile crossing events: **{crossing_count:,}**",
        "",
        "Pinball loss is the primary floor, median, and ceiling comparison metric. Lower is better. Coverage is the share of actual scores at or below each quantile. Interval coverage is the share between p15 and p85. Interval width is p85 minus p15.",
        "",
        "## Model winner by position",
        "",
        "| Position | Floor winner | Ceiling winner | Median winner | XGB p15 loss | ffsim p15 loss | XGB p85 loss | ffsim p85 loss |",
        "| --- | --- | --- | --- | ---: | ---: | ---: | ---: |",
    ]
    for row in winners.itertuples(index=False):
        lines.append(
            f"| {row.position} | {row.floor_best_model} | {row.ceiling_best_model} | {row.median_best_model} | "
            f"{format_metric(row.xgb_p15_pinball_loss)} | {format_metric(row.ffsim_p15_pinball_loss)} | "
            f"{format_metric(row.xgb_p85_pinball_loss)} | {format_metric(row.ffsim_p85_pinball_loss)} |"
        )
    lines.extend(["", "## Position metrics", ""])
    lines.append(
        "| Position | Model | N | p15 coverage | p50 coverage | p85 coverage | p15 loss | p50 loss | p85 loss | p50 MAE | p50 bias | Interval coverage | Width | Crossings |"
    )
    lines.append("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
    for row in metrics[metrics["scope"].eq("position")].sort_values(["position", "model"]).itertuples(index=False):
        lines.append(
            f"| {row.position} | {row.model} | {row.n} | {format_metric(row.p15_coverage)} | {format_metric(row.p50_coverage)} | {format_metric(row.p85_coverage)} | "
            f"{format_metric(row.p15_pinball_loss)} | {format_metric(row.p50_pinball_loss)} | {format_metric(row.p85_pinball_loss)} | {format_metric(row.p50_mae)} | {format_metric(row.p50_bias)} | "
            f"{format_metric(row.interval_coverage)} | {format_metric(row.interval_width)} | {row.quantile_crossing_count} |"
        )
    lines.extend(["", "## Season metrics", ""])
    lines.append("| Season | Model | N | p15 coverage | p50 coverage | p85 coverage | p15 loss | p50 loss | p85 loss | Interval coverage | Width | Crossings |")
    lines.append("| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
    for row in metrics[metrics["scope"].eq("season")].sort_values(["season", "model"]).itertuples(index=False):
        lines.append(
            f"| {row.season} | {row.model} | {row.n} | {format_metric(row.p15_coverage)} | {format_metric(row.p50_coverage)} | {format_metric(row.p85_coverage)} | "
            f"{format_metric(row.p15_pinball_loss)} | {format_metric(row.p50_pinball_loss)} | {format_metric(row.p85_pinball_loss)} | {format_metric(row.interval_coverage)} | {format_metric(row.interval_width)} | {row.quantile_crossing_count} |"
        )
    lines.extend(["", "## Top projected player metrics", ""])
    top_metrics = metrics[metrics["scope"].eq("top_projected")]
    lines.append("| Model | N | p15 coverage | p50 coverage | p85 coverage | p15 loss | p50 loss | p85 loss | p50 MAE | p50 bias | Interval coverage | Width | Crossings |")
    lines.append("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
    for row in top_metrics.sort_values("model").itertuples(index=False):
        lines.append(
            f"| {row.model} | {row.n} | {format_metric(row.p15_coverage)} | {format_metric(row.p50_coverage)} | {format_metric(row.p85_coverage)} | {format_metric(row.p15_pinball_loss)} | {format_metric(row.p50_pinball_loss)} | {format_metric(row.p85_pinball_loss)} | {format_metric(row.p50_mae)} | {format_metric(row.p50_bias)} | {format_metric(row.interval_coverage)} | {format_metric(row.interval_width)} | {row.quantile_crossing_count} |"
        )
    lines.extend(
        [
            "",
            "## Data quality gate",
            "",
            f"Gate status: **{quality.get('gate_status')}**.",
            f"Top-player identity coverage: **{format_metric(quality.get('top_player_identity_coverage') * 100, 2)}%**.",
            f"Top-player observed-outcome coverage: **{format_metric(quality.get('top_player_outcome_coverage') * 100, 2)}%**.",
            f"Top-player imputed-zero rows: **{quality.get('top_player_imputed_zero_rows', 0):,}**.",
            f"Top-player groups below the requested limit because the approved non-FA source had fewer available rows: **{quality.get('top_player_groups_below_limit', 0):,}**.",
            "The missing-outcome rows and all identity conflict notes are in `outcome_errors.csv` and `identity_resolution_audit.csv`.",
            "",
            "## Evaluation files",
            "",
            "- `comparison_metrics.csv` contains the full position, season, season-position, and top-player slices.",
            "- `quantile_crossings.csv` preserves raw XGBoost outputs for every crossing event.",
            "- `predictions.parquet` contains the common XGBoost and ffsimulator row-level comparison data.",
        ]
    )
    (output_dir / "comparison_report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_model_card(
    root: Path,
    output_dir: Path,
    quality: dict[str, Any],
    modeling_audit: dict[str, Any],
    training_audit: dict[str, Any],
    metrics: pd.DataFrame,
    winners: pd.DataFrame,
    crossings: pd.DataFrame,
    metadata: dict[str, Any],
) -> Path:
    """Write the nine-section model card required for this release."""
    position_metrics = metrics[metrics["scope"].eq("position")]
    lines = [
        "# Model Card: XGBoost v2 PPR Floor, Median, and Ceiling",
        "",
        "## 1. Model Details",
        "",
        f"- Developer: `ff_floor_ceiling` project.",
        f"- Development date: 2026-09-07.",
        f"- Model release: `{MODEL_RELEASE}`.",
        f"- Artifact version: `{ARTIFACT_VERSION}`.",
        "- Model type: four serialized native XGBoost boosters, one each for QB, RB, WR, and TE.",
        "- Objective: `reg:quantileerror` with `quantile_alpha=[0.15, 0.50, 0.85]`.",
        "- Target: `actual_score`, under the PPR scoring contract.",
        "- Output contract: one prediction call returns p15 in column 0, p50 in column 1, and p85 in column 2.",
        f"- XGBoost version: `{xgb.__version__}`.",
        f"- Feature version: `{FEATURE_VERSION}`.",
        f"- Feature names by position are stored in `{output_dir.name}/metadata.json`.",
        "- License and contact: repository owner and project documentation. This research artifact has no separate deployment license or support agreement.",
        "",
        "## 2. Intended Use",
        "",
        "The model estimates weekly PPR floor, median, and ceiling coverage for fantasy football players at the four modeled positions. It is intended for research, calibration review, and comparison with the rank-conditioned `ffsimulator` baseline.",
        "",
        "Intended users are the project owner and reviewers who understand weekly fantasy projections and quantile error. The model is out of scope for player health, contract, betting, financial, or other real-world decisions, and it must not be treated as a guarantee of a player score or as an automated roster decision.",
        "",
        "## 3. Factors",
        "",
        "Relevant technical factors are position, season, week, team, projected PPR score, projected stat lines, and rank availability. Performance can also change when the projection provider, source set, player identity, scoring rules, or season mix changes.",
        "",
        "The evaluation reports unitary slices by position and season, plus top projected players and season-position intersections. The data does not include demographic labels. No demographic or phenotypic inference is made, and no such group result is claimed.",
        "",
        "## 4. Metrics",
        "",
        "The primary model-selection and comparison measure is pinball loss at each requested quantile. Lower loss is better. Coverage is the share of actual scores at or below a predicted quantile. P50 mean absolute error and p50 bias describe median error. Interval coverage is the share of actual scores between p15 and p85. Interval width is p85 minus p15. Quantile crossings are raw violations of p15 <= p50 <= p85 and are never repaired before reporting.",
        "",
        f"The common held-out comparison has {metadata.get('comparison_rows', 0):,} rows. No confidence intervals were estimated in this run. The comparison uses the same keys and rows for XGBoost and `ffsimulator`.",
        "",
        "## 5. Evaluation Data",
        "",
        "Evaluation uses the approved Footballguys Projections Consensus source for regular-season weeks 1 through 17 of 2023 through 2025. The row universe is the existing `ffsimulator` output, which keeps the same source keys and at least three projectors. The corrected identity gate links each row to one GSIS ID and one weekly outcome where available. Missing weekly records are imputed to an actual score of zero and are listed in `outcome_errors.csv`.",
        "",
        f"The held-out seasons are {', '.join(str(value) for value in metadata.get('target_seasons_scored', []))}. The baseline and XGBoost comparisons use {metadata.get('comparison_rows', 0):,} matching rows. Important data-quality limits are the {quality.get('top_player_imputed_zero_rows', 0):,} top-player rows without an observed weekly stats record and any other rows listed in the error file.",
        "",
        "## 6. Training Data",
        "",
        "Training uses the same approved projection and corrected outcome sources. For each held-out season, the booster sees earlier seasons only. The inner validation window is weeks 14 through 17 of the most recent prior season. Every row passed to an XGBoost training DMatrix has `actual_score > 0`; zero and negative outcomes are excluded from training and remain eligible for held-out scoring when their identity is resolved.",
        "",
        f"Training rows after the positive-score rule: {training_audit.get('positive_training_rows', 0):,}. Excluded non-positive candidate rows: {training_audit.get('nonpositive_candidate_rows', 0):,}. Invalid training rows after the rule: {training_audit.get('invalid_training_rows', 0):,}.",
        "",
        "The model features contain the week, ecr, raw projected stat fields, and derived PPR projection score when variable for the position. Source-set count and source-set rank dispersion fields are retained in the data-quality report only. No fabricated source count is sent to the model.",
        "",
        "## 7. Quantitative Analyses",
        "",
        "### Model winner by position",
        "",
        "Floor and ceiling winners below use lower p15 and p85 pinball loss, respectively.",
        "",
        "| Position | Floor winner | Ceiling winner | Median winner |",
        "| --- | --- | --- | --- |",
    ]
    for row in winners.itertuples(index=False):
        lines.append(f"| {row.position} | {row.floor_best_model} | {row.ceiling_best_model} | {row.median_best_model} |")
    lines.extend(["", "### Held-out metrics by position", ""])
    lines.append("| Position | Model | N | p15 coverage | p50 coverage | p85 coverage | p15 loss | p50 loss | p85 loss | p50 MAE | p50 bias | Interval coverage | Width |")
    lines.append("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
    for row in position_metrics.sort_values(["position", "model"]).itertuples(index=False):
        lines.append(
            f"| {row.position} | {row.model} | {row.n} | {format_metric(row.p15_coverage)} | {format_metric(row.p50_coverage)} | {format_metric(row.p85_coverage)} | {format_metric(row.p15_pinball_loss)} | {format_metric(row.p50_pinball_loss)} | {format_metric(row.p85_pinball_loss)} | {format_metric(row.p50_mae)} | {format_metric(row.p50_bias)} | {format_metric(row.interval_coverage)} | {format_metric(row.interval_width)} |"
        )
    lines.extend(
        [
            "",
            "Season, season-position, and top-projected-player slices are in `comparison_metrics.csv`. The raw prediction rows are in `predictions.parquet`. The model produced",
            f"{len(crossings):,} quantile crossing events across {crossings['stable_player_id'].nunique() if not crossings.empty else 0:,} affected stable player IDs.",
            "",
            "## 8. Ethical Considerations",
            "",
            "The output describes uncertain fantasy projection ranges. It can affect how a user values players, but it does not measure a person's worth, health, character, or future outside the fantasy scoring task. The pipeline uses public sports records and stable player identifiers. It records identity conflicts and manual overrides so reviewers can inspect them. It does not infer sensitive personal attributes.",
            "",
            "The model can amplify errors in public projections, stale team labels, incomplete rosters, duplicate master records, and missing weekly stats. Reviewers should treat a quantile as a calibrated estimate for this historical data, not as a factual statement about a player.",
            "",
            "## 9. Caveats and Recommendations",
            "",
            "- The top-player identity gate resolved all selected top-player IDs in this run, including `GibbJa00` to `00-0039139` and `McCaCh00` to `00-0033280`.",
            f"- Top-player observed-outcome coverage was {format_metric(quality.get('top_player_outcome_coverage', np.nan) * 100, 2)}%. Missing records were allowed to proceed only as explicit imputed-zero errors.",
            f"- {quality.get('top_player_groups_below_limit', 0):,} top-player groups had fewer available non-FA source rows than the requested limit. The gate audited every available row in those groups.",
            f"- Serious top-player linkage errors: {quality.get('serious_top_player_error_count', 0):,}.",
            f"- Invalid training rows: {training_audit.get('invalid_training_rows', 0):,}.",
            f"- Raw quantile crossing events: {len(crossings):,}. Inspect `quantile_crossings.csv` before any downstream use. The model outputs were not reordered or clipped.",
            "- Web integration is active in the local and asset-backed application paths. Deployment promotion and deployed health verification remain pending. The retained v1 assets support rollback.",
            "- Re-run the gate when source sets, scoring rules, weekly data, master players, or crosswalk files change. Add uncertainty intervals, longer historical evaluation, and an independent review before production use.",
            "",
            "This card documents the release and its evidence. It is not a complete audit, deployment approval, or legal determination.",
        ]
    )
    card = output_dir / "ml_model_card.md"
    card.write_text("\n".join(lines) + "\n", encoding="utf-8")
    docs_card = root / "docs" / "ml_model_card_xgb_v2.md"
    docs_card.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(card, docs_card)
    return card


def run_experiment(args: argparse.Namespace) -> None:
    root = project_root()
    bt = backtest_root(root)
    output_dir = (
        Path(args.output_dir)
        if args.output_dir
        else bt / "outputs" / "xgb_v2_quantile_projection"
    )
    output_dir.mkdir(parents=True, exist_ok=True)
    walk_forward_dir = output_dir / "walk_forward_models"
    release_model_dir = output_dir / "models"
    walk_forward_dir.mkdir(parents=True, exist_ok=True)
    release_model_dir.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()

    print("Reading the approved Projections Consensus source...", flush=True)
    projections = read_consensus_projections(root)
    panel = build_panel(root, projections)
    top = select_top_players(projections, panel)
    seasons = sorted({int(value) for value in projections["season"].unique()})
    print(
        f"Projection rows: {len(projections):,}; top-player gate rows: {len(top):,}; seasons: {seasons}.",
        flush=True,
    )

    sources, overrides = load_identity_sources(root, seasons)
    resolved, quality, outcome_errors = run_quality_gate(
        panel, top, sources, overrides, output_dir
    )
    print(
        f"Data-quality gate: {quality['gate_status']}; top identity coverage "
        f"{quality['top_player_identity_coverage']:.3%}; observed top outcomes "
        f"{quality['top_player_outcome_coverage']:.3%}.",
        flush=True,
    )

    modeling, modeling_audit = build_evaluation_dataset(root, resolved)
    features_by_position = {
        position: feature_columns(modeling, position) for position in POSITIONS
    }
    for position, features in features_by_position.items():
        assert_feature_columns(features)
        print(f"{position} features ({len(features)}): {', '.join(features)}", flush=True)

    candidate_training = modeling[modeling["actual_score"].gt(0)].copy()
    finite_training = candidate_training["actual_score"].notna() & np.isfinite(
        candidate_training["actual_score"].to_numpy(dtype=float)
    )
    invalid_training_rows = int((~finite_training | ~candidate_training["actual_score"].gt(0)).sum())
    if invalid_training_rows:
        raise DataQualityGateError(
            f"Invalid positive-score training rows detected: {invalid_training_rows}"
        )
    training_audit = {
        "candidate_rows": int(len(modeling)),
        "positive_training_rows": int(len(candidate_training)),
        "nonpositive_candidate_rows": int(len(modeling) - len(candidate_training)),
        "invalid_training_rows": invalid_training_rows,
        "training_target": "actual_score",
        "training_rule": "actual_score > 0",
        "feature_names_by_position": features_by_position,
    }
    quality["modeling_audit"] = modeling_audit
    quality["training_audit"] = training_audit
    quality["feature_names_by_position"] = features_by_position
    quality["rank_summary_feature_audit"] = rank_summary_feature_audit().to_dict("records")
    (output_dir / "data_quality_report.json").write_text(
        json.dumps(json_safe(quality), indent=2), encoding="utf-8"
    )

    grid = make_grid()[: args.max_configs]
    print(
        f"Common held-out rows: {len(modeling):,}; grid candidates per position/season: {len(grid):,}.",
        flush=True,
    )
    all_predictions: list[pd.DataFrame] = []
    all_grid_results: list[pd.DataFrame] = []
    all_selected: list[dict[str, Any]] = []
    walk_forward_records: list[dict[str, Any]] = []

    for target_season in args.target_seasons:
        prior = modeling[modeling["season"].lt(target_season)].copy()
        target = modeling[modeling["season"].eq(target_season)].copy()
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
            raise ValueError(f"Cannot form the inner walk-forward split for {target_season}")
        print(
            f"Target {target_season}: prior seasons {sorted(prior['season'].unique())}; "
            f"validation {validation_season} weeks {DEFAULT_VALIDATION_WEEKS}.",
            flush=True,
        )
        for position in POSITIONS:
            position_inner_train = inner_train[
                inner_train["position"].eq(position) & inner_train["actual_score"].gt(0)
            ].copy()
            position_validation = validation[validation["position"].eq(position)].copy()
            position_prior = prior[
                prior["position"].eq(position) & prior["actual_score"].gt(0)
            ].copy()
            position_target = target[target["position"].eq(position)].copy()
            if position_inner_train.empty or position_validation.empty or position_prior.empty or position_target.empty:
                raise ValueError(
                    f"Cannot train/evaluate {position} for target season {target_season}: "
                    f"inner_train={len(position_inner_train)}, validation={len(position_validation)}, "
                    f"prior={len(position_prior)}, target={len(position_target)}"
                )
            features = features_by_position[position]
            selected, grid_results = choose_model(
                position_inner_train,
                position_validation,
                position,
                target_season,
                grid,
                args,
                features,
            )
            grid_results["training_seasons"] = ",".join(
                str(value) for value in sorted(prior["season"].unique())
            )
            grid_results["validation_season"] = validation_season
            all_grid_results.append(grid_results)
            best_grid = grid_results.iloc[0]
            selected_record = {
                "target_season": target_season,
                "position": position,
                "training_seasons": ",".join(
                    str(value) for value in sorted(prior["season"].unique())
                ),
                "validation_season": validation_season,
                "validation_weeks": ",".join(str(value) for value in DEFAULT_VALIDATION_WEEKS),
                "feature_count": len(features),
                "features": ",".join(features),
                **selected,
                "inner_validation_multi_pinball": float(best_grid["validation_multi_pinball"]),
                "inner_validation_p15_pinball": float(best_grid["validation_p15_pinball"]),
                "inner_validation_p50_pinball": float(best_grid["validation_p50_pinball"]),
                "inner_validation_p85_pinball": float(best_grid["validation_p85_pinball"]),
                "scoring_format": SCORING_FORMAT,
                "scoring_contract_version": SCORING_CONTRACT_VERSION,
                "features_contain_outcomes": False,
            }
            all_selected.append(selected_record)
            seed = 20260907 + target_season * 100 + POSITIONS.index(position)
            final_model = fit_final_model(position_prior, features, selected, args.nthread, seed)
            model_path = walk_forward_dir / f"xgb_v2_{position.lower()}_through_{target_season - 1}.json"
            final_model.save_model(str(model_path))
            dtarget = to_dmatrix(position_target, features, with_label=False)
            raw_prediction = validate_prediction_matrix(
                final_model.predict(
                    dtarget, iteration_range=(0, int(selected["boosting_rounds"]))
                ),
                len(position_target),
            )
            prediction_frame = position_target[
                ["season", "week", "fbg_id", "position", "stable_player_id", "team", "player_name", "projection_fpts", "is_top_projected", "actual_score", "ffsim_p15", "ffsim_p50", "ffsim_p85"]
            ].copy()
            prediction_frame["p15"] = raw_prediction[:, 0]
            prediction_frame["p50"] = raw_prediction[:, 1]
            prediction_frame["p85"] = raw_prediction[:, 2]
            prediction_frame["xgb_p15"] = raw_prediction[:, 0]
            prediction_frame["xgb_p50"] = raw_prediction[:, 1]
            prediction_frame["xgb_p85"] = raw_prediction[:, 2]
            prediction_frame["p15_raw"] = raw_prediction[:, 0]
            prediction_frame["p50_raw"] = raw_prediction[:, 1]
            prediction_frame["p85_raw"] = raw_prediction[:, 2]
            prediction_frame["model_target_season"] = target_season
            prediction_frame["model_training_seasons"] = ",".join(
                str(value) for value in sorted(prior["season"].unique())
            )
            prediction_frame["model_position"] = position
            prediction_frame["model_feature_names"] = ",".join(features)
            prediction_frame["scoring_format"] = SCORING_FORMAT
            prediction_frame["scoring_contract_version"] = SCORING_CONTRACT_VERSION
            prediction_frame["prediction_call_count"] = 1
            all_predictions.append(prediction_frame)
            walk_forward_records.append(
                {
                    "target_season": target_season,
                    "position": position,
                    "model_path": str(model_path.relative_to(output_dir)),
                    "training_rows": int(len(position_prior)),
                    "feature_count": len(features),
                    "features": features,
                    "boosting_rounds": int(selected["boosting_rounds"]),
                    "training_seasons": sorted(int(value) for value in position_prior["season"].unique()),
                    "validation_season": validation_season,
                    "validation_weeks": list(DEFAULT_VALIDATION_WEEKS),
                    "validation_multi_pinball": float(best_grid["validation_multi_pinball"]),
                    "scoring_format": SCORING_FORMAT,
                    "scoring_contract_version": SCORING_CONTRACT_VERSION,
                    "prediction_call_count": 1,
                }
            )
            print(
                f"  {position} {target_season}: validation loss "
                f"{selected_record['inner_validation_multi_pinball']:.4f}; "
                f"rounds {selected['boosting_rounds']}; OOS rows {len(position_target):,}.",
                flush=True,
            )

    if not all_predictions:
        raise RuntimeError("No target-season predictions were produced")
    predictions = pd.concat(all_predictions, ignore_index=True)
    prediction_key_duplicates = predictions.duplicated(list(KEY_COLUMNS), keep=False)
    if prediction_key_duplicates.any():
        raise ValueError("XGBoost predictions contain duplicate comparison keys")
    if not predictions["prediction_call_count"].eq(1).all():
        raise ValueError("A prediction row was not produced by exactly one multi-quantile call")

    crossings = quantile_crossings_frame(predictions)
    common_mask = predictions[["ffsim_p15", "ffsim_p50", "ffsim_p85"]].notna().all(axis=1)
    comparison_frame = predictions[common_mask].copy()
    if comparison_frame.empty:
        raise ValueError("No common held-out rows have all ffsimulator quantiles")
    comparison_metrics = summarize_comparison(comparison_frame)
    winners = model_winners(comparison_metrics)
    if winners.empty or len(winners) != len(POSITIONS):
        raise ValueError("Comparison did not produce winners for all four positions")
    comparison_rows = int(len(comparison_frame))
    expected_target_comparison_rows = int(
        modeling[
            modeling["season"].isin(args.target_seasons)
            & modeling[["ffsim_p15", "ffsim_p50", "ffsim_p85"]].notna().all(axis=1)
        ].shape[0]
    )
    if comparison_rows != expected_target_comparison_rows:
        raise ValueError(
            f"The common comparison count does not match the target-season ffsimulator-covered rows: "
            f"comparison={comparison_rows}, target_ffsimulator_covered={expected_target_comparison_rows}"
        )

    metrics_path = output_dir / "comparison_metrics.csv"
    predictions.to_parquet(output_dir / "predictions.parquet", index=False)
    comparison_frame.to_parquet(output_dir / "comparison_rows.parquet", index=False)
    crossings.to_csv(output_dir / "quantile_crossings.csv", index=False)
    comparison_metrics.to_csv(metrics_path, index=False)
    winners.to_csv(output_dir / "model_winners.csv", index=False)
    pd.concat(all_grid_results, ignore_index=True).to_csv(output_dir / "grid_results.csv", index=False)
    pd.DataFrame(all_selected).to_csv(output_dir / "selected_models.csv", index=False)
    pd.DataFrame(walk_forward_records).to_json(
        output_dir / "walk_forward_model_records.json", orient="records", indent=2
    )

    max_historical_season = int(modeling["season"].max())
    release_target_season = max(args.target_seasons) + 1
    latest_selected = pd.DataFrame(all_selected)
    release_records: list[dict[str, Any]] = []
    backend_dir = root / "web" / "api" / "producer-assets" / "models" / "v2"
    backend_model_dir = backend_dir / "models"
    backend_model_dir.mkdir(parents=True, exist_ok=True)
    for position in POSITIONS:
        selected_rows = latest_selected[latest_selected["position"].eq(position)].sort_values("target_season")
        if selected_rows.empty:
            raise ValueError(f"No selected settings for release position {position}")
        selected_row = selected_rows.iloc[-1].to_dict()
        release_settings = {
            key: selected_row[key]
            for key in (
                "max_depth",
                "min_child_weight",
                "subsample",
                "colsample_bytree",
                "learning_rate",
                "reg_lambda",
                "boosting_rounds",
            )
        }
        release_train = modeling[
            modeling["position"].eq(position)
            & modeling["season"].le(max_historical_season)
            & modeling["actual_score"].gt(0)
        ].copy()
        release_model = fit_final_model(
            release_train,
            features_by_position[position],
            release_settings,
            args.nthread,
            20260907 + release_target_season * 100 + POSITIONS.index(position),
        )
        release_path = release_model_dir / f"xgb_v2_{position.lower()}_through_{max_historical_season}.json"
        release_model.save_model(str(release_path))
        backend_path = backend_model_dir / release_path.name
        shutil.copy2(release_path, backend_path)
        release_records.append(
            {
                "target_season": release_target_season,
                "position": position,
                "model_path": f"models/{release_path.name}",
                "training_rows": int(len(release_train)),
                "training_seasons": sorted(int(value) for value in release_train["season"].unique()),
                "max_historical_season_used": max_historical_season,
                "feature_count": len(features_by_position[position]),
                "features": features_by_position[position],
                "boosting_rounds": int(release_settings["boosting_rounds"]),
                "validation_result": {
                    "selected_from_target_season": int(selected_row["target_season"]),
                    "validation_season": int(selected_row["validation_season"]),
                    "validation_weeks": list(DEFAULT_VALIDATION_WEEKS),
                    "multi_pinball_loss": float(selected_row["inner_validation_multi_pinball"]),
                    "p15_pinball_loss": float(selected_row["inner_validation_p15_pinball"]),
                    "p50_pinball_loss": float(selected_row["inner_validation_p50_pinball"]),
                    "p85_pinball_loss": float(selected_row["inner_validation_p85_pinball"]),
                },
                "scoring_format": SCORING_FORMAT,
                "scoring_contract_version": SCORING_CONTRACT_VERSION,
                "objective": "reg:quantileerror",
                "quantile_alpha": list(QUANTILES),
            }
        )

    quality["comparison_audit"] = {
        "common_heldout_rows": comparison_rows,
        "all_xgboost_prediction_rows": int(len(predictions)),
        "xgboost_rows": comparison_rows,
        "ffsimulator_rows": comparison_rows,
        "same_heldout_rows": True,
        "quantile_crossing_event_count": int(len(crossings)),
        "quantile_crossing_row_count": int(
            crossings[["season", "week", "fbg_id", "position"]].drop_duplicates().shape[0]
        )
        if not crossings.empty
        else 0,
        "quantile_crossing_affected_stable_player_ids": sorted(
            crossings["stable_player_id"].dropna().astype(str).unique().tolist()
        )
        if not crossings.empty
        else [],
    }
    quality["backend_release_model_count"] = len(release_records)
    quality["backend_release_model_positions"] = [record["position"] for record in release_records]
    (output_dir / "data_quality_report.json").write_text(
        json.dumps(json_safe(quality), indent=2), encoding="utf-8"
    )
    shutil.copy2(output_dir / "data_quality_report.json", backend_dir / "data_quality_report.json")
    shutil.copy2(output_dir / "outcome_errors.csv", backend_dir / "outcome_errors.csv")
    shutil.copy2(output_dir / "quantile_crossings.csv", backend_dir / "quantile_crossings.csv")
    shutil.copy2(output_dir / "predictions.parquet", backend_dir / "predictions.parquet")
    shutil.copy2(output_dir / "comparison_rows.parquet", backend_dir / "comparison_rows.parquet")
    shutil.copy2(metrics_path, backend_dir / "comparison_metrics.csv")

    metadata = {
        "model_release": MODEL_RELEASE,
        "artifact_version": ARTIFACT_VERSION,
        "model_type": "native_xgboost_multi_quantile_booster",
        "objective": "reg:quantileerror",
        "quantile_alpha": list(QUANTILES),
        "quantile_output_columns": {"0": "p15", "1": "p50", "2": "p85"},
        "one_prediction_call_returns_all_quantiles": True,
        "feature_version": FEATURE_VERSION,
        "feature_names_by_position": features_by_position,
        "serving_feature_contract": {
            "features_by_position": features_by_position,
            "requires_stable_player_id": True,
            "does_not_send_source_set_count": True,
        },
        "training_seasons": sorted(int(value) for value in modeling["season"].unique()),
        "target_seasons_requested": list(args.target_seasons),
        "target_seasons_scored": sorted(predictions["model_target_season"].unique().astype(int).tolist()),
        "release_target_season": release_target_season,
        "scoring_format": SCORING_FORMAT,
        "scoring_contract_version": SCORING_CONTRACT_VERSION,
        "target_column": "actual_score",
        "projection_score_field": "projection_fpts",
        "validation_result": {
            "walk_forward": True,
            "validation_weeks": list(DEFAULT_VALIDATION_WEEKS),
            "selected_model_records": len(all_selected),
            "path": "selected_models.csv",
        },
        "model_artifact_version": ARTIFACT_VERSION,
        "model_records": release_records,
        "walk_forward_model_records": walk_forward_records,
        "comparison_rows": comparison_rows,
        "quantile_crossing_event_count": int(len(crossings)),
        "quantile_crossing_affected_stable_player_ids": sorted(
            crossings["stable_player_id"].dropna().astype(str).unique().tolist()
        )
        if not crossings.empty
        else [],
        "data_quality_report_path": "data_quality_report.json",
        "predictions_path": "predictions.parquet",
        "comparison_metrics_path": "comparison_metrics.csv",
        "runtime": {
            "python": os.sys.version,
            "xgboost": xgb.__version__,
            "pandas": pd.__version__,
            "numpy": np.__version__,
        },
        "elapsed_seconds_before_card": time.perf_counter() - started,
    }
    metadata_path = output_dir / "metadata.json"
    metadata_path.write_text(json.dumps(json_safe(metadata), indent=2), encoding="utf-8")
    shutil.copy2(metadata_path, backend_dir / "metadata.json")

    card = write_model_card(
        root,
        output_dir,
        quality,
        modeling_audit,
        training_audit,
        comparison_metrics,
        winners,
        crossings,
        {**metadata, "comparison_rows": comparison_rows},
    )
    shutil.copy2(card, backend_dir / "model_card.md")
    metadata["model_card_path"] = "model_card.md"
    metadata["elapsed_seconds"] = time.perf_counter() - started
    metadata_path.write_text(json.dumps(json_safe(metadata), indent=2), encoding="utf-8")
    shutil.copy2(metadata_path, backend_dir / "metadata.json")
    write_comparison_report(
        output_dir,
        comparison_metrics,
        winners,
        quality,
        comparison_rows,
        len(crossings),
    )

    print("\nModel winners by position:", flush=True)
    print(
        winners[
            [
                "position",
                "floor_best_model",
                "ceiling_best_model",
                "median_best_model",
            ]
        ].to_string(index=False),
        flush=True,
    )
    print(
        f"\nWrote v2 model, prediction, comparison, quality, and card artifacts to {output_dir}",
        flush=True,
    )


if __name__ == "__main__":
    run_experiment(parse_args())
