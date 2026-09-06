#!/usr/bin/env python3
"""Build the scored, scenario-expanded DST training panel."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dst_xgb.evaluate import validate_panel  # noqa: E402
from dst_xgb.features import build_scenario_panel  # noqa: E402
from dst_xgb.ingest import DST_PBP_COLUMNS, DEFAULT_RAW_DIR, read_cached, read_cached_pbp  # noqa: E402
from dst_xgb.predict import read_table, write_table  # noqa: E402
from dst_xgb.scoring import build_dst_targets  # noqa: E402


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
    parser.add_argument("--seasons", required=True)
    parser.add_argument("--fbg-draws", required=True, help="Original R ffsimulator player draws")
    parser.add_argument("--raw-dir", default=str(DEFAULT_RAW_DIR))
    parser.add_argument("--output", required=True)
    parser.add_argument("--targets-output", default=None)
    parser.add_argument("--pbp-start-season", type=int, default=None)
    parser.add_argument("--no-pbp", action="store_true")
    args = parser.parse_args()

    seasons = parse_seasons(args.seasons)
    stats = read_cached("player_stats", seasons, args.raw_dir)
    schedules = read_cached("schedules", seasons, args.raw_dir)
    pbp = None
    if not args.no_pbp:
        first_pbp = min(seasons) if args.pbp_start_season is None else args.pbp_start_season
        pbp_seasons = list(range(first_pbp, max(seasons) + 1))
        try:
            pbp = read_cached_pbp(pbp_seasons, args.raw_dir, columns=list(DST_PBP_COLUMNS))
        except FileNotFoundError as error:
            print(f"Warning: {error}. Building targets from full player statistics.", file=sys.stderr)
    draws = read_table(args.fbg_draws)
    targets = build_dst_targets(stats, schedules, pbp=pbp)
    panel = build_scenario_panel(targets, schedules, draws, pbp=pbp)
    audit = validate_panel(panel)
    write_table(panel, args.output)
    targets_output = args.targets_output or str(Path(args.output).with_name("dst_targets.parquet"))
    write_table(targets, targets_output)
    manifest_path = Path(args.raw_dir) / "manifest.json"
    source_manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else None
    panel_metadata = {
        "panel_version": "dst-scenario-panel-v1",
        "output": args.output,
        "targets_output": targets_output,
        "fbg_draws": args.fbg_draws,
        "source_manifest": source_manifest,
        "panel_audit": audit,
        "target_rows": len(targets),
        "target_source": "nflverse PBP when cached, full player statistics fallback",
        "scenario_source": "original_fbg",
    }
    metadata_path = Path(args.output).with_name("dst_scenario_panel_metadata.json")
    metadata_path.write_text(json.dumps(panel_metadata, indent=2, default=str), encoding="utf-8")
    print(json.dumps(panel_metadata, indent=2, default=str))


if __name__ == "__main__":
    main()
