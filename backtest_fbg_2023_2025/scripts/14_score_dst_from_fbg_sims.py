#!/usr/bin/env python3
"""Score DST rows from the original R FBG simulation draws."""

from __future__ import annotations

import argparse
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dst_xgb.ingest import DST_PBP_COLUMNS, DEFAULT_RAW_DIR, cached_pbp_seasons, read_cached_pbp  # noqa: E402
from dst_xgb.predict import read_table, score_fbg_scenarios, write_table  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--draws", required=True, help="CSV or Parquet from the original ffsimulator path")
    parser.add_argument("--schedule", required=True, help="One-row-per-game CSV or Parquet schedule")
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--season", type=int, required=True)
    parser.add_argument("--week", type=int, required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--raw-dir", default=str(DEFAULT_RAW_DIR), help="DST raw cache used for prior QB PBP history")
    parser.add_argument("--pbp-start-season", type=int, default=None)
    parser.add_argument("--no-pbp", action="store_true", help="Use the model fallback when no prior PBP is available")
    args = parser.parse_args()
    pbp = None
    if not args.no_pbp:
        pbp_seasons = cached_pbp_seasons(
            args.raw_dir,
            before_season=args.season,
            start_season=args.pbp_start_season,
        )
        if pbp_seasons:
            pbp = read_cached_pbp(pbp_seasons, args.raw_dir, columns=list(DST_PBP_COLUMNS))
            print(f"Loaded prior QB history from PBP seasons: {','.join(map(str, pbp_seasons))}")
        else:
            print(
                "Warning: no prior PBP cache was found. QB features will use the documented zero fallback.",
                file=sys.stderr,
            )
    scored = score_fbg_scenarios(
        read_table(args.draws),
        read_table(args.schedule),
        args.model_dir,
        season=args.season,
        week=args.week,
        pbp=pbp,
    )
    write_table(scored, args.output)
    print(f"Wrote {len(scored):,} DST scenario rows to {args.output}")


if __name__ == "__main__":
    main()
