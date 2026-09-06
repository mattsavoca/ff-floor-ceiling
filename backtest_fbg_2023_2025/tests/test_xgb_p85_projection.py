"""Focused tests for the PPR XGBoost experiment helpers."""

import importlib.util
from pathlib import Path

import numpy as np
import pandas as pd
import pytest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "08_xgb_p85_projection_experiment.py"
SPEC = importlib.util.spec_from_file_location("xgb_p85_projection_experiment", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def test_projection_score_uses_one_point_per_reception_without_first_down_or_te_bonus():
    assert "rec-1d" not in MODULE.PROJECTION_COLUMNS
    assert "rec-1d" not in MODULE.PROJECTION_SCORE_COLUMNS
    row = {column: 0.0 for column in MODULE.PROJECTION_COLUMNS}
    row.update(
        {
            "position": "TE",
            "rec-yds": 100,
            "rec-td": 1,
            "rec-rec": 5,
            "rec-1d": 3,
        }
    )
    score = MODULE.projection_score(pd.DataFrame([row])).iloc[0]
    assert score == pytest.approx(10 + 6 + 5)


def test_features_reject_outcome_columns():
    with pytest.raises(ValueError, match="outcome columns"):
        MODULE.assert_feature_columns(["week", "actual_score"])


def test_boom_threshold_is_shared_across_positions_within_a_season():
    actual = np.arange(1.0, 11.0)
    frame = pd.DataFrame(
        {
            "season": 2025,
            "position": ["QB"] * 5 + ["RB"] * 5,
            "actual_score": actual,
            "baseline_p85": actual + 1,
            "xgb_p85": actual + 2,
        }
    )
    output = MODULE.boom_capture(frame)
    assert output["boom_threshold_scope"].eq("season").all()
    assert output["boom_cutoff"].nunique() == 1
    assert output["boom_cutoff"].iloc[0] == pytest.approx(np.quantile(actual, 0.85))
    assert output["boom_n"].sum() / 2 == 2


def test_metrics_keep_interval_coverage_only_for_the_full_simulation_model():
    frame = pd.DataFrame(
        {
            "season": [2024, 2024, 2025, 2025],
            "position": ["QB", "RB", "WR", "TE"],
            "actual_score": [10.0, 20.0, 30.0, 40.0],
            "baseline_p15": [2.0, 10.0, 20.0, 30.0],
            "baseline_p50": [8.0, 18.0, 28.0, 38.0],
            "baseline_p85": [12.0, 22.0, 32.0, 42.0],
            "baseline_mean_above_p85": [16.0, 26.0, 36.0, 46.0],
            "baseline_p85_tail_excess": [4.0, 4.0, 4.0, 4.0],
            "xgb_p85": [11.0, 21.0, 31.0, 41.0],
        }
    )
    output = MODULE.summarize_metrics(frame)
    xgb_rows = output[output["model"].eq("xgb_projection")]
    baseline_rows = output[output["model"].eq("simulation_baseline")]
    assert xgb_rows["interval_coverage"].isna().all()
    assert xgb_rows["low_side_miss_rate"].isna().all()
    assert baseline_rows["interval_coverage"].notna().all()
    assert baseline_rows["low_side_miss_rate"].notna().all()
    assert output["scoring_format"].eq("PPR").all()
