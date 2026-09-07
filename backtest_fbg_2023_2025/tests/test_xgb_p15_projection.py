"""Focused tests for the PPR XGBoost P15 experiment helpers."""

import importlib.util
from pathlib import Path

import numpy as np
import pandas as pd
import pytest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "08_xgb_p15_projection_experiment.py"
SPEC = importlib.util.spec_from_file_location("xgb_p15_projection_experiment", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def test_p15_contract_uses_standard_ppr_projection_points():
    assert MODULE.ALPHA == pytest.approx(0.15)
    assert "rec-1d" not in MODULE.PROJECTION_COLUMNS
    assert "rec-1d" not in MODULE.PROJECTION_SCORE_COLUMNS
    row = {column: 0.0 for column in MODULE.PROJECTION_COLUMNS}
    row.update({"pass-yds": 250, "rec-yds": 100, "rec-td": 1, "rec-rec": 5})
    score = MODULE.projection_score(pd.DataFrame([row])).iloc[0]
    assert score == pytest.approx(10 + 10 + 6 + 5)


def test_p15_pinball_loss_weights_lower_side_errors():
    actual = np.array([0.0, 10.0])
    prediction = np.array([5.0, 5.0])
    expected = ((0.15 * 5.0) + (0.85 * 5.0)) / 2
    assert MODULE.pinball_loss(actual, prediction) == pytest.approx(expected)


def test_features_reject_outcomes_and_legacy_scoring_fields():
    with pytest.raises(ValueError, match="outcome or inactive"):
        MODULE.assert_feature_columns(["week", "actual_score"])
    with pytest.raises(ValueError, match="outcome or inactive"):
        MODULE.assert_feature_columns(["week", "rec-1d"])


def test_lower_tail_metrics_use_strictly_below_floor_rows():
    frame = pd.DataFrame(
        {
            "season": [2024, 2024, 2024, 2024],
            "position": ["QB", "QB", "QB", "QB"],
            "actual_score": [0.0, 4.0, 10.0, 20.0],
            "baseline_p15": [2.0, 2.0, 8.0, 18.0],
            "baseline_p50": [5.0, 5.0, 12.0, 22.0],
            "baseline_p85": [10.0, 10.0, 18.0, 30.0],
            "baseline_mean_below_p15": [0.0, 0.0, 5.0, 15.0],
            "baseline_p15_tail_excess": [2.0, 2.0, 3.0, 3.0],
            "xgb_p15": [1.0, 3.0, 9.0, 19.0],
        }
    )
    output = MODULE.summarize_metrics(frame)
    xgb = output[(output["group"] == "position") & output["model"].eq("xgb_projection")].iloc[0]
    assert xgb["low_side_miss_rate"] == pytest.approx(0.25)
    assert xgb["mean_below_p15"] == pytest.approx(0.0)
    assert xgb["p15_tail_excess"] == pytest.approx(1.0)
    assert xgb["n_below_p15"] == 1


def test_bust_threshold_is_shared_across_positions_within_a_season():
    actual = np.arange(1.0, 11.0)
    frame = pd.DataFrame(
        {
            "season": 2025,
            "position": ["QB"] * 5 + ["RB"] * 5,
            "actual_score": actual,
            "baseline_p15": actual + 1,
            "xgb_p15": actual + 2,
        }
    )
    output = MODULE.bust_capture(frame)
    assert output["bust_threshold_scope"].eq("season").all()
    assert output["bust_cutoff"].nunique() == 1
    assert output["bust_cutoff"].iloc[0] == pytest.approx(np.quantile(actual, 0.15))
    assert output["bust_n"].sum() / 2 == 2
