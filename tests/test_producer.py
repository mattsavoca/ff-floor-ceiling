"""Tests for the portable ffsimulator inference boundary."""

import importlib.util
import sys
from pathlib import Path


import pytest


SERVICE_PATH = Path(__file__).resolve().parents[1] / "web" / "api" / "producer.py"
SPEC = importlib.util.spec_from_file_location("forecast_producer", SERVICE_PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def fixture_request(simulation_count: int) -> dict[str, object]:
    """Build the four-row acceptance fixture request."""

    return {
        "schema_version": "ffsimulator-request.v1",
        "week": 1,
        "seed": 20260907,
        "simulation_count": simulation_count,
        "rows": [
            {"stable_player_id": "17298", "position": "QB", "rank": 1, "rank_uncertainty": 1.1, "source_order": 1},
            {"stable_player_id": "4379399", "position": "RB", "rank": 1, "rank_uncertainty": 0.5, "source_order": 2},
            {"stable_player_id": "4258173", "position": "WR", "rank": 1, "rank_uncertainty": 0.5, "source_order": 3},
            {"stable_player_id": "3930086", "position": "TE", "rank": 1, "rank_uncertainty": 0.5, "source_order": 4},
        ],
    }


def test_one_based_rank_boundary_supports_default_simulation_count() -> None:
    """Clamp negative sampled ranks before outcome-pool lookup."""

    response = MODULE.FfsimulatorService().simulate(fixture_request(1000))

    assert response["schema_version"] == "ffsimulator-prediction.v1"
    assert response["simulation_count"] == 1000
    assert [row["stable_player_id"] for row in response["rows"]] == ["17298", "4379399", "4258173", "3930086"]
    assert all(row["n_simulations"] == 1000 for row in response["rows"])


def test_unsupported_positive_rank_remains_a_reported_error() -> None:
    """Keep unsupported positive rank draws visible instead of hiding them."""

    request = fixture_request(100)
    request["rows"] = [{"stable_player_id": "p1", "position": "QB", "rank": 89, "rank_uncertainty": 0.5, "source_order": 1}]

    with pytest.raises(MODULE.ProducerError, match="does not cover QB rank"):
        MODULE.FfsimulatorService().simulate(request)
