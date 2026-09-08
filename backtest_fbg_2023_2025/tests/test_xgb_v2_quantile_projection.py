"""Focused tests for the v2 identity, feature, and quantile helpers."""

import importlib.util
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "15_xgb_v2_quantile_projection.py"
SPEC = importlib.util.spec_from_file_location("xgb_v2_quantile_projection", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def test_native_multi_quantile_contract_is_declared():
    assert MODULE.QUANTILES == (0.15, 0.50, 0.85)
    assert MODULE.QUANTILE_LABELS == ("p15", "p50", "p85")
    assert MODULE.xgb_params({}, nthread=1, seed=1)["objective"] == "reg:quantileerror"
    assert MODULE.xgb_params({}, nthread=1, seed=1)["quantile_alpha"] == [0.15, 0.50, 0.85]


def test_n_projectors_is_rejected_from_model_features():
    with pytest.raises(ValueError, match="n_projectors"):
        MODULE.assert_feature_columns(["week", "n_projectors"])
    audit = MODULE.rank_summary_feature_audit()
    assert not bool(audit.loc[audit["field"].eq("n_projectors"), "kept_as_model_feature"].iloc[0])
    assert "n_projectors" not in MODULE.MODEL_RANK_FEATURES


def test_multi_pinball_loss_uses_all_three_quantiles():
    actual = np.array([0.0, 10.0, 20.0])
    prediction = np.array([[0.0, 5.0, 15.0], [0.0, 10.0, 20.0], [5.0, 20.0, 25.0]])
    expected = np.mean(
        [
            MODULE.pinball_loss(actual, prediction[:, 0], 0.15),
            MODULE.pinball_loss(actual, prediction[:, 1], 0.50),
            MODULE.pinball_loss(actual, prediction[:, 2], 0.85),
        ]
    )
    assert MODULE.multi_pinball_loss(actual, prediction) == pytest.approx(expected)


def test_prediction_shape_requires_three_outputs():
    values = MODULE.validate_prediction_matrix(np.ones((2, 3)), 2)
    assert values.shape == (2, 3)
    with pytest.raises(ValueError, match="expected"):
        MODULE.validate_prediction_matrix(np.ones((2, 2)), 2)


def test_crossing_audit_keeps_raw_outputs_and_one_row_per_event():
    frame = pd.DataFrame(
        {
            "season": [2025, 2025],
            "week": [1, 2],
            "fbg_id": ["A", "B"],
            "stable_player_id": ["00-1", "00-2"],
            "position": ["RB", "WR"],
            "team": ["SF", "LVR"],
            "p15": [9.0, 1.0],
            "p50": [8.0, 2.0],
            "p85": [7.0, 0.0],
            "model_target_season": [2025, 2025],
        }
    )
    output = MODULE.quantile_crossings_frame(frame)
    assert len(output) == 5
    assert set(output["crossing_type"]) == {"p15_gt_p50", "p50_gt_p85", "p15_gt_p85"}
    assert output.loc[output["fbg_id"].eq("B"), "p85_raw"].eq(0.0).all()
    assert output.loc[output["fbg_id"].eq("B"), "team"].eq("LV").all()


def test_projection_score_keeps_standard_ppr_contract():
    row = {column: 0.0 for column in MODULE.PROJECTION_COLUMNS}
    row.update({"rec-yds": 100, "rec-td": 1, "rec-rec": 5})
    score = MODULE.projection_score(pd.DataFrame([row])).iloc[0]
    assert score == pytest.approx(10 + 6 + 5)
