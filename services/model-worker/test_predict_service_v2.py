"""Tests for the v2 multi-quantile local inference boundary."""

import importlib.util
import sys
from pathlib import Path

import pytest


SERVICE_PATH = Path(__file__).resolve().parent / "predict_service_v2.py"
SPEC = importlib.util.spec_from_file_location("forecast_predict_service_v2", SERVICE_PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)

MODEL_ROOT = SERVICE_PATH.parents[2] / "backtest_fbg_2023_2025" / "outputs" / "xgb_v2_quantile_projection"


@pytest.fixture(scope="module")
def service() -> object:
    return MODULE.PredictionServiceV2(MODEL_ROOT)


def request_for(service: object, position: str, features: dict[str, float] | None = None) -> dict[str, object]:
    record = next(record for record in service.records if record.position == position)
    values = features or {feature: 1.0 for feature in record.features}
    return {
        "model_release": "forecast-ppr-v2",
        "feature_version": "fbg_rank_projection_v2",
        "scoring_contract_version": "ppr_v1",
        "position": position,
        "season": 2026,
        "week": 1,
        "rows": [{"stable_player_id": f"{position.lower()}-1", "features": values}],
    }


@pytest.mark.parametrize("position", ["QB", "RB", "WR", "TE"])
def test_one_call_returns_three_ordered_quantiles(service: object, position: str) -> None:
    response = service.predict(request_for(service, position))

    assert response["schema_version"] == "model-prediction.v2"
    assert response["prediction_call_count"] == 1
    assert response["quantile_output_columns"] == {"0": "p15", "1": "p50", "2": "p85"}
    assert response["prediction_count"] == 1
    assert response["model_artifact_version"] == "xgb_v2_quantile_20260907"
    prediction = response["predictions"][0]
    assert prediction["p15"] <= prediction["p50"] <= prediction["p85"]
    assert response["quantile_crossing_count"] == 0
    assert response["negative_prediction_count"] == 0


def test_n_projectors_is_rejected(service: object) -> None:
    request = request_for(service, "RB")
    request["rows"][0]["features"]["n_projectors"] = 1

    with pytest.raises(MODULE.PredictionError, match="missing valid model features") as error:
        service.predict(request)

    assert error.value.fields == ["n_projectors"]
    assert error.value.player_ids == ["rb-1"]


def test_extra_feature_is_rejected(service: object) -> None:
    request = request_for(service, "TE")
    request["rows"][0]["features"]["rank_min"] = 1

    with pytest.raises(MODULE.PredictionError, match="missing valid model features") as error:
        service.predict(request)

    assert error.value.fields == ["unsupported:rank_min"]
