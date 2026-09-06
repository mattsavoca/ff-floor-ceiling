#!/usr/bin/env python3
"""Run leakage-safe historical DST model backtests by target season."""

from __future__ import annotations

import argparse
from pathlib import Path
import sys

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dst_xgb.evaluate import evaluate_breakdowns, evaluate_predictions, fit_market_baseline, predict_market_baseline  # noqa: E402
from dst_xgb.predict import predict_feature_frame, read_table, write_table  # noqa: E402
from dst_xgb.train import TrainConfig, train_production_models  # noqa: E402


def parse_seasons(value: str) -> list[int]:
    return sorted({int(part.strip()) for part in value.split(",") if part.strip()})


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--panel", required=True)
    parser.add_argument("--target-seasons", required=True, help="Comma-separated seasons to score")
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--metrics-output", default=None)
    parser.add_argument("--max-configs", type=int, default=12)
    parser.add_argument("--max-boost-rounds", type=int, default=1800)
    parser.add_argument("--early-stopping-rounds", type=int, default=80)
    parser.add_argument("--seed", type=int, default=20260906)
    parser.add_argument("--nthread", type=int, default=4)
    args = parser.parse_args()

    panel = read_table(args.panel)
    config = TrainConfig(
        max_boost_rounds=args.max_boost_rounds,
        early_stopping_rounds=args.early_stopping_rounds,
        max_configs=args.max_configs,
        seed=args.seed,
        nthread=args.nthread,
    )
    prediction_parts: list[pd.DataFrame] = []
    for target_season in parse_seasons(args.target_seasons):
        train_production_models(panel, args.model_dir, target_season=target_season, config=config)
        target_rows = panel[panel["season"] == target_season].copy()
        if target_rows.empty:
            continue
        predicted = predict_feature_frame(target_rows, args.model_dir, target_season=target_season)
        market_model = fit_market_baseline(panel[panel["season"] < target_season].copy())
        context_columns = [
            "season",
            "week",
            "game_id",
            "team",
            "dst_fd_pts",
            "target",
            "opponent_implied_team_total",
            "dst_home_game",
            "roof",
            "wind",
            "missing_feature_count",
            "opponent_qb_history_available",
        ]
        result = target_rows.loc[:, [column for column in context_columns if column in target_rows.columns]].reset_index(drop=True)
        result = pd.concat([result, predicted.reset_index(drop=True)], axis=1)
        result["market_baseline"] = predict_market_baseline(target_rows, market_model)
        prediction_parts.append(result)
    if not prediction_parts:
        raise ValueError("No requested target-season rows were found in the panel")
    predictions = pd.concat(prediction_parts, ignore_index=True)
    write_table(predictions, args.output)
    metrics_output = args.metrics_output or str(Path(args.output).with_name("dst_backtest_metrics.csv"))
    metrics = evaluate_predictions(predictions)
    metrics.to_csv(metrics_output, index=False)
    breakdowns_output = str(Path(metrics_output).with_name("dst_backtest_breakdowns.csv"))
    evaluate_breakdowns(predictions).to_csv(breakdowns_output, index=False)
    print(metrics.to_string(index=False))
    print(f"Wrote DST error breakdowns to {breakdowns_output}")


if __name__ == "__main__":
    main()
