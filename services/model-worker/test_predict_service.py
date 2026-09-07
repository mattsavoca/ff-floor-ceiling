"""Tests for the released XGBoost prediction boundary."""

import importlib.util
import json
import sys
from pathlib import Path
from threading import Lock

import pytest


SERVICE_PATH = Path(__file__).resolve().parent / "predict_service.py"
SPEC = importlib.util.spec_from_file_location("forecast_predict_service", SERVICE_PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)

REPOSITORY_ROOT = SERVICE_PATH.parents[2]


def make_validation_service() -> object:
    """Create a service with a fake record for validation-only tests."""

    service = object.__new__(MODULE.PredictionService)
    service.release = "forecast-ppr-v1"
    service.records = (
        MODULE.ModelRecord(
            target_season=2025,
            position="RB",
            model_path=Path("unused.json"),
            features=("week", "ecr"),
            quantile_label="p15",
        ),
    )
    service._booster_cache = {}
    service._cache_lock = Lock()
    return service


def test_missing_scoring_contract_is_a_client_validation_error():
    service = make_validation_service()
    with pytest.raises(MODULE.PredictionError, match="scoring contract"):
        service.predict(
            "p15",
            {
                "model_release": "forecast-ppr-v1",
                "feature_version": MODULE.FEATURE_VERSION,
                "position": "RB",
                "season": 2026,
                "week": 1,
                "rows": [{"stable_player_id": "p1", "features": {"week": 1, "ecr": 1}}],
            },
        )


def test_missing_features_report_fields_and_player_ids():
    service = make_validation_service()
    with pytest.raises(MODULE.PredictionError) as error:
        service.predict(
            "p15",
            {
                "model_release": "forecast-ppr-v1",
                "feature_version": MODULE.FEATURE_VERSION,
                "scoring_contract_version": MODULE.SCORING_CONTRACT_VERSION,
                "position": "RB",
                "season": 2026,
                "week": 1,
                "rows": [{"stable_player_id": "p1", "features": {"week": 1}}],
            },
        )
    assert error.value.fields == ["ecr"]
    assert error.value.player_ids == ["p1"]


def test_duplicate_prediction_ids_are_rejected_before_model_load():
    service = make_validation_service()
    with pytest.raises(MODULE.PredictionError, match="duplicate stable IDs"):
        service.predict(
            "p15",
            {
                "model_release": "forecast-ppr-v1",
                "feature_version": MODULE.FEATURE_VERSION,
                "scoring_contract_version": MODULE.SCORING_CONTRACT_VERSION,
                "position": "RB",
                "season": 2026,
                "week": 1,
                "rows": [
                    {"stable_player_id": "p1", "features": {"week": 1, "ecr": 1}},
                    {"stable_player_id": "p1", "features": {"week": 1, "ecr": 2}},
                ],
            },
        )


@pytest.mark.parametrize("quantile", ["p15", "p85"])
def test_released_quantile_service_returns_one_prediction(quantile: str):
    """Load the checked-in release and confirm its public response contract."""

    model_root = REPOSITORY_ROOT / "backtest_fbg_2023_2025" / "outputs" / f"xgb_{quantile}_projection"
    metadata = json.loads((model_root / "metadata.json").read_text(encoding="utf-8"))
    record = next(item for item in metadata["model_records"] if item["position"] == "RB")
    features = {name: 1.0 for name in record["features"].split(",")}
    service = MODULE.PredictionService(model_root, "forecast-ppr-v1")
    response = service.predict(
        quantile,
        {
            "model_release": "forecast-ppr-v1",
            "feature_version": MODULE.FEATURE_VERSION,
            "scoring_contract_version": MODULE.SCORING_CONTRACT_VERSION,
            "position": "RB",
            "season": 2026,
            "week": 1,
            "rows": [{"stable_player_id": "p1", "features": features}],
        },
    )
    assert response["quantile"] == quantile
    assert response["prediction_count"] == 1
    assert response["predictions"][0]["stable_player_id"] == "p1"
    assert response["predictions"][0][quantile] >= 0
