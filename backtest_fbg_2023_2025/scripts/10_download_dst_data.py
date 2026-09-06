#!/usr/bin/env python3
"""Download full NFL inputs for the Python DST pipeline."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dst_xgb.ingest import DEFAULT_RAW_DIR, download_dst_data  # noqa: E402


def parse_seasons(value: str) -> list[int]:
    seasons: list[int] = []
    for part in value.split(","):
        part = part.strip()
        if ":" in part:
            start, end = (int(piece) for piece in part.split(":", 1))
            seasons.extend(range(start, end + 1))
        else:
            seasons.append(int(part))
    return sorted(set(seasons))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seasons", required=True, help="Season years, for example 2013:2025")
    parser.add_argument("--raw-dir", default=str(DEFAULT_RAW_DIR))
    parser.add_argument("--pbp-start-season", type=int, default=None)
    parser.add_argument("--no-pbp", action="store_true", help="Skip the play-by-play cache")
    parser.add_argument("--force", action="store_true", help="Redownload existing season files")
    args = parser.parse_args()
    manifest = download_dst_data(
        parse_seasons(args.seasons),
        raw_dir=args.raw_dir,
        pbp_start_season=args.pbp_start_season,
        include_pbp=not args.no_pbp,
        force=args.force,
    )
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
