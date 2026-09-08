"""Tests for the active Vercel v2 multi-quantile producer boundary."""

import importlib.util
import sys
from pathlib import Path

import pytest


SERVICE_PATH = Path(__file__).resolve().parents[1] / "web" / "api" / "producer.py"
SPEC = importlib.util.spec_from_file_location("forecast_producer_v2", SERVICE_PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def make_service() -> object:
    return MODULE.PredictionServiceV2()


def make_request(service: object, position: str) -> dict[str, object]:
    record = next(record for record in service.records if record.position == position)
    return {
        "model_release": "forecast-ppr-v2",
        "feature_version": "fbg_rank_projection_v2",
        "scoring_contract_version": "ppr_v1",
        "position": position,
        "season": 2026,
        "week": 1,
        "rows": [{"stable_player_id": f"{position.lower()}-1", "features": {feature: 1.0 for feature in record.features}}],
    }


@pytest.mark.parametrize("position", ["QB", "RB", "WR", "TE"])
def test_active_producer_returns_all_quantiles(position: str) -> None:
    service = make_service()
    response = service.predict(make_request(service, position))

    assert response["model_release"] == "forecast-ppr-v2"
    assert response["model_artifact_version"] == "xgb_v2_quantile_20260907"
    assert response["prediction_call_count"] == 1
    assert response["quantile_output_columns"] == {"0": "p15", "1": "p50", "2": "p85"}
    assert response["quantile_crossing_count"] == 0
    assert response["negative_prediction_count"] == 0
    assert response["predictions"][0]["p15"] <= response["predictions"][0]["p50"] <= response["predictions"][0]["p85"]


def test_active_producer_rejects_n_projectors() -> None:
    service = make_service()
    request = make_request(service, "QB")
    request["rows"][0]["features"]["n_projectors"] = 1

    with pytest.raises(MODULE.ProducerError, match="missing valid model features") as error:
        service.predict(request)

    assert error.value.fields == ["n_projectors"]
