"""NFL data download and local Parquet cache helpers."""

from __future__ import annotations

import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pandas as pd


DEFAULT_RAW_DIR = Path(__file__).resolve().parents[1] / "data" / "raw" / "dst"
DST_PBP_COLUMNS = (
    "season",
    "week",
    "game_id",
    "play_id",
    "defteam",
    "posteam",
    "return_team",
    "sack",
    "interception",
    "safety",
    "defensive_two_point_conv",
    "return_touchdown",
    "fumble_lost",
    "qb_dropback",
    "pass_attempt",
    "rush_attempt",
    "passer_player_id",
    "rusher_player_id",
    "epa",
    "cpoe",
)


def _require_nflreadpy() -> Any:
    try:
        import nflreadpy as nfl
    except ImportError as error:
        raise RuntimeError("Install nflreadpy before downloading DST data") from error
    return nfl


def _write_table(table: Any, path: Path) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    if hasattr(table, "write_parquet"):
        table.write_parquet(path, compression="zstd")
        return int(table.height)
    frame = pd.DataFrame(table)
    frame.to_parquet(path, index=False, compression="zstd")
    return len(frame)


def _load_one(nfl: Any, kind: str, season: int | None = None) -> Any:
    functions = {
        "player_stats": nfl.load_player_stats,
        "schedules": nfl.load_schedules,
        "rosters_weekly": nfl.load_rosters_weekly,
        "pbp": nfl.load_pbp,
    }
    if kind not in functions:
        raise ValueError(f"Unsupported NFL data kind: {kind}")
    if season is None:
        return functions[kind]()
    return functions[kind]([int(season)])


def download_dst_data(
    seasons: list[int],
    raw_dir: str | Path = DEFAULT_RAW_DIR,
    pbp_start_season: int | None = None,
    include_pbp: bool = True,
    force: bool = False,
) -> dict[str, Any]:
    """Download full nflverse tables into a versioned local cache.

    The download is one season at a time. This limits peak memory and lets an
    interrupted run keep the completed season files.
    """

    if not seasons:
        raise ValueError("At least one season is required")
    clean_seasons = sorted({int(season) for season in seasons})
    raw_path = Path(raw_dir)
    nfl = _require_nflreadpy()
    manifest: dict[str, Any] = {
        "created_at_utc": datetime.now(timezone.utc).isoformat(),
        "source": "nflverse via nflreadpy",
        "seasons": clean_seasons,
        "pbp_start_season": pbp_start_season if include_pbp else None,
        "include_pbp": include_pbp,
        "tables": {},
    }

    for kind in ["player_stats", "schedules", "rosters_weekly"]:
        entries: list[dict[str, Any]] = []
        for season in clean_seasons:
            path = raw_path / kind / f"season={season}.parquet"
            if path.exists() and not force:
                rows = len(pd.read_parquet(path, columns=["season"])) if kind != "rosters_weekly" else len(pd.read_parquet(path, columns=["season"]))
                entries.append({"season": season, "path": str(path), "rows": rows, "cached": True})
                continue
            table = _load_one(nfl, kind, season)
            rows = _write_table(table, path)
            entries.append({"season": season, "path": str(path), "rows": rows, "cached": False})
        manifest["tables"][kind] = entries

    players_path = raw_path / "players.parquet"
    if players_path.exists() and not force:
        players_rows = len(pd.read_parquet(players_path, columns=["gsis_id"]))
        manifest["tables"]["players"] = {"path": str(players_path), "rows": players_rows, "cached": True}
    else:
        if not hasattr(nfl, "load_players"):
            raise RuntimeError("The installed nflreadpy version has no load_players function")
        players = nfl.load_players()
        players_rows = _write_table(players, players_path)
        manifest["tables"]["players"] = {"path": str(players_path), "rows": players_rows, "cached": False}

    if include_pbp:
        first_pbp_season = min(clean_seasons) if pbp_start_season is None else int(pbp_start_season)
        pbp_entries: list[dict[str, Any]] = []
        for season in range(first_pbp_season, max(clean_seasons) + 1):
            path = raw_path / "pbp" / f"season={season}.parquet"
            if path.exists() and not force:
                rows = len(pd.read_parquet(path, columns=["season"]))
                pbp_entries.append({"season": season, "path": str(path), "rows": rows, "cached": True})
                continue
            table = _load_one(nfl, "pbp", season)
            rows = _write_table(table, path)
            pbp_entries.append({"season": season, "path": str(path), "rows": rows, "cached": False})
        manifest["tables"]["pbp"] = pbp_entries

    manifest_path = raw_path / "manifest.json"
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return manifest


def read_cached(kind: str, seasons: list[int], raw_dir: str | Path = DEFAULT_RAW_DIR) -> pd.DataFrame:
    """Read season-partitioned local data into pandas."""

    raw_path = Path(raw_dir)
    frames: list[pd.DataFrame] = []
    for season in sorted({int(value) for value in seasons}):
        path = raw_path / kind / f"season={season}.parquet"
        if not path.exists():
            raise FileNotFoundError(f"Missing cached {kind} file: {path}")
        frames.append(pd.read_parquet(path))
    if not frames:
        return pd.DataFrame()
    return pd.concat(frames, ignore_index=True, sort=False)


def read_cached_pbp(
    seasons: list[int], raw_dir: str | Path = DEFAULT_RAW_DIR, columns: list[str] | None = None
) -> pd.DataFrame:
    """Read cached PBP by season, optionally projecting columns on disk."""

    raw_path = Path(raw_dir)
    frames: list[pd.DataFrame] = []
    for season in sorted({int(value) for value in seasons}):
        path = raw_path / "pbp" / f"season={season}.parquet"
        if not path.exists():
            raise FileNotFoundError(f"Missing cached pbp file: {path}")
        frames.append(pd.read_parquet(path, columns=columns))
    return pd.concat(frames, ignore_index=True, sort=False) if frames else pd.DataFrame()


def cached_pbp_seasons(
    raw_dir: str | Path = DEFAULT_RAW_DIR,
    before_season: int | None = None,
    start_season: int | None = None,
) -> list[int]:
    """Return cached PBP seasons that are safe for a target forecast.

    The forward scorer uses this helper to discover prior PBP without making a
    network request or requiring a hard-coded history range.
    """

    pbp_dir = Path(raw_dir) / "pbp"
    seasons: list[int] = []
    for path in pbp_dir.glob("season=*.parquet"):
        try:
            season = int(path.stem.split("=", 1)[1])
        except (IndexError, ValueError):
            continue
        if before_season is not None and season >= int(before_season):
            continue
        if start_season is not None and season < int(start_season):
            continue
        seasons.append(season)
    return sorted(set(seasons))


def package_versions() -> dict[str, str]:
    """Return versions recorded with model metadata."""

    import numpy
    import pandas
    import xgboost

    versions = {
        "python": subprocess.check_output(["python", "--version"], text=True).strip(),
        "numpy": numpy.__version__,
        "pandas": pandas.__version__,
        "xgboost": xgboost.__version__,
    }
    try:
        import nflreadpy

        versions["nflreadpy"] = nflreadpy.__version__
    except (ImportError, AttributeError):
        pass
    return versions
