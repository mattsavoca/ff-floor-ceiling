#!/usr/bin/env python3
"""Tune and fit the production Python DST XGBoost bundle."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dst_xgb.predict import read_table  # noqa: E402
from dst_xgb.train import TrainConfig, train_production_models  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--panel", required=True)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--target-season", type=int, default=None)
    parser.add_argument("--validation-season", type=int, default=None)
    parser.add_argument("--max-configs", type=int, default=12)
    parser.add_argument("--max-boost-rounds", type=int, default=1800)
    parser.add_argument("--early-stopping-rounds", type=int, default=80)
    parser.add_argument("--seed", type=int, default=20260906)
    parser.add_argument("--nthread", type=int, default=4)
    args = parser.parse_args()
    config = TrainConfig(
        max_boost_rounds=args.max_boost_rounds,
        early_stopping_rounds=args.early_stopping_rounds,
        max_configs=args.max_configs,
        seed=args.seed,
        nthread=args.nthread,
    )
    metadata = train_production_models(
        read_table(args.panel),
        model_dir=args.model_dir,
        target_season=args.target_season,
        validation_season=args.validation_season,
        config=config,
    )
    print(json.dumps(metadata, indent=2, default=str))


if __name__ == "__main__":
    main()
