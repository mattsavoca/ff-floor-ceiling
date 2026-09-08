"""Serve the released forecast producers from one Vercel Python function.

The function exposes the same contracts as the local R and Python producers.
It loads immutable XGBoost model files and an exported ffsimulator outcome pool
from ``api/producer-assets``. It does not train or tune a model during a
request.
"""

from __future__ import annotations

import hmac
import json
import math
import os
import re
import sys
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from threading import Lock
from typing import Any
from urllib.parse import urlsplit

import numpy as np
import xgboost as xgb


MODEL_RELEASE = "forecast-ppr-v1"
FEATURE_VERSION = "fbg_rank_projection_v1"
SCORING_CONTRACT_VERSION = "ppr_v1"
MODEL_POSITIONS = {"RB", "WR", "TE"}
QUANTILES = {"p15": 0.15, "p85": 0.85}
V2_MODEL_RELEASE = "forecast-ppr-v2"
V2_FEATURE_VERSION = "fbg_rank_projection_v2"
V2_MODEL_ARTIFACT_VERSION = "xgb_v2_quantile_20260907"
V2_MODEL_POSITIONS = {"QB", "RB", "WR", "TE"}
V2_QUANTILE_ALPHA = [0.15, 0.5, 0.85]
V2_QUANTILE_COLUMNS = {"0": "p15", "1": "p50", "2": "p85"}
V2_MODEL_ENDPOINT = "/v2/models/predict"
ASSET_ROOT = Path(__file__).resolve().parent / "producer-assets"
MAX_BODY_BYTES = 20 * 1024 * 1024


class ProducerError(ValueError):
    """Represent a client-visible producer error."""

    def __init__(self, message: str, *, status: int = 400, fields: list[str] | None = None, player_ids: list[str] | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.fields = fields or []
        self.player_ids = player_ids or []

    def payload(self) -> dict[str, Any]:
        return {
            "error": str(self),
            "missing_features": self.fields,
            "affected_player_ids": self.player_ids,
        }


@dataclass(frozen=True)
class ModelRecord:
    target_season: int
    position: str
    model_path: Path
    features: tuple[str, ...]


class PredictionService:
    """Load one quantile's released XGBoost models."""

    def __init__(self, quantile_label: str) -> None:
        if quantile_label not in QUANTILES:
            raise RuntimeError(f"Unsupported quantile: {quantile_label}")
        self.quantile_label = quantile_label
        self.model_root = ASSET_ROOT / "models" / quantile_label
        self.metadata_path = self.model_root / "metadata.json"
        self.metadata = self._load_metadata()
        self.records = self._load_records()
        self._booster_cache: dict[Path, xgb.Booster] = {}
        self._cache_lock = Lock()

    def _load_metadata(self) -> dict[str, Any]:
        try:
            return json.loads(self.metadata_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise RuntimeError(f"Cannot read model metadata at {self.metadata_path}: {error}") from error

    def _load_records(self) -> tuple[ModelRecord, ...]:
        metadata_label = str(self.metadata.get("quantile_label", ""))
        if metadata_label != self.quantile_label:
            raise RuntimeError(f"Model metadata quantile does not match {self.quantile_label}")
        records: list[ModelRecord] = []
        for item in self.metadata.get("model_records", []):
            position = str(item.get("position", "")).upper()
            if position not in MODEL_POSITIONS:
                continue
            features = tuple(str(item.get("features", "")).split(","))
            if not features or any(not feature for feature in features):
                raise RuntimeError(f"Model metadata has no feature list for {position}")
            relative_path = str(item.get("model_path", "")).replace("\\", "/")
            model_path = (self.model_root / relative_path).resolve()
            if not model_path.is_file() or self.model_root.resolve() not in model_path.parents:
                raise RuntimeError(f"Released model file is missing: {model_path}")
            records.append(ModelRecord(
                target_season=int(item["target_season"]),
                position=position,
                model_path=model_path,
                features=features,
            ))
        if not records:
            raise RuntimeError("The model release has no RB, WR, or TE records")
        return tuple(records)

    def _select_record(self, position: str, season: int) -> ModelRecord:
        candidates = [record for record in self.records if record.position == position]
        if not candidates:
            raise ProducerError(f"No released model exists for position {position}", fields=["position"])
        eligible = [record for record in candidates if record.target_season <= season]
        return max(eligible or candidates, key=lambda record: record.target_season)

    def _load_booster(self, path: Path) -> xgb.Booster:
        with self._cache_lock:
            if path not in self._booster_cache:
                booster = xgb.Booster()
                booster.load_model(str(path))
                self._booster_cache[path] = booster
            return self._booster_cache[path]

    @staticmethod
    def _validate_request(request: dict[str, Any]) -> tuple[str, int, int, list[dict[str, Any]]]:
        if request.get("model_release") != MODEL_RELEASE:
            raise ProducerError("The requested model release is unavailable", fields=["model_release"])
        if request.get("scoring_contract_version") != SCORING_CONTRACT_VERSION:
            raise ProducerError("The scoring contract is unsupported", fields=["scoring_contract_version"])
        if request.get("feature_version") != FEATURE_VERSION:
            raise ProducerError("The feature version is unsupported", fields=["feature_version"])
        position = str(request.get("position", "")).upper()
        if position not in MODEL_POSITIONS:
            raise ProducerError("XGBoost services accept RB, WR, and TE only", fields=["position"])
        try:
            season = int(request["season"])
            week = int(request["week"])
        except (KeyError, TypeError, ValueError) as error:
            raise ProducerError("season and week must be integers", fields=["season", "week"]) from error
        if not 2020 <= season <= 2100 or not 1 <= week <= 18:
            raise ProducerError("season or week is outside the supported range", fields=["season", "week"])
        rows = request.get("rows")
        if not isinstance(rows, list) or not rows:
            raise ProducerError("rows must contain at least one feature row", fields=["rows"])
        ids: list[str] = []
        for row in rows:
            if not isinstance(row, dict) or not row.get("stable_player_id"):
                raise ProducerError("Every row needs a stable_player_id", fields=["stable_player_id"])
            ids.append(str(row["stable_player_id"]))
        if len(ids) != len(set(ids)):
            duplicates = sorted({player_id for player_id in ids if ids.count(player_id) > 1})
            raise ProducerError("Prediction request contains duplicate stable IDs", player_ids=duplicates)
        return position, season, week, rows

    def predict(self, request: dict[str, Any]) -> dict[str, Any]:
        position, season, week, rows = self._validate_request(request)
        record = self._select_record(position, season)
        missing_by_player: dict[str, list[str]] = {}
        values: list[list[float]] = []
        ids: list[str] = []
        for row in rows:
            player_id = str(row["stable_player_id"])
            ids.append(player_id)
            feature_values = row.get("features")
            if not isinstance(feature_values, dict):
                missing_by_player[player_id] = list(record.features)
                continue
            missing = [feature for feature in record.features if feature not in feature_values]
            invalid = [
                feature
                for feature in record.features
                if feature in feature_values
                and (
                    isinstance(feature_values[feature], bool)
                    or not isinstance(feature_values[feature], (int, float))
                    or not math.isfinite(float(feature_values[feature]))
                )
            ]
            if missing or invalid:
                missing_by_player[player_id] = sorted(set(missing + invalid))
                continue
            values.append([float(feature_values[feature]) for feature in record.features])
        if missing_by_player:
            fields = sorted({field for row_fields in missing_by_player.values() for field in row_fields})
            raise ProducerError(
                "One or more prediction rows are missing valid model features",
                fields=fields,
                player_ids=sorted(missing_by_player),
            )

        matrix = xgb.DMatrix(np.asarray(values, dtype=np.float32), feature_names=list(record.features))
        raw_predictions = self._load_booster(record.model_path).predict(matrix)
        predictions = np.maximum(0.0, np.asarray(raw_predictions, dtype=np.float64))
        if len(predictions) != len(ids) or not np.isfinite(predictions).all():
            raise RuntimeError("The released model returned an invalid prediction batch")
        return {
            "schema_version": "model-prediction.v1",
            "model_release": MODEL_RELEASE,
            "feature_version": FEATURE_VERSION,
            "scoring_contract_version": SCORING_CONTRACT_VERSION,
            "quantile": self.quantile_label,
            "position": position,
            "season": season,
            "week": week,
            "model_target_season": record.target_season,
            "feature_names": list(record.features),
            "prediction_count": len(ids),
            "predictions": [
                {"stable_player_id": player_id, self.quantile_label: float(value)}
                for player_id, value in zip(ids, predictions, strict=True)
            ],
        }


class PredictionServiceV2:
    """Load one v2 booster per position and return all three quantiles."""

    def __init__(self) -> None:
        self.model_root = ASSET_ROOT / "models" / "v2"
        self.metadata_path = self.model_root / "metadata.json"
        self.metadata = self._load_metadata()
        self.records = self._load_records()
        self._booster_cache: dict[Path, xgb.Booster] = {}
        self._cache_lock = Lock()

    def _load_metadata(self) -> dict[str, Any]:
        try:
            metadata = json.loads(self.metadata_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise RuntimeError(f"Cannot read v2 model metadata at {self.metadata_path}: {error}") from error
        if metadata.get("model_release") != V2_MODEL_RELEASE:
            raise RuntimeError("The active model release is not forecast-ppr-v2")
        if metadata.get("artifact_version") != V2_MODEL_ARTIFACT_VERSION:
            raise RuntimeError("The active v2 artifact version is unsupported")
        if metadata.get("feature_version") != V2_FEATURE_VERSION:
            raise RuntimeError("The active v2 feature version is unsupported")
        if metadata.get("scoring_contract_version") != SCORING_CONTRACT_VERSION:
            raise RuntimeError("The active v2 scoring contract is unsupported")
        if metadata.get("objective") != "reg:quantileerror" or metadata.get("target_column") != "actual_score":
            raise RuntimeError("The active v2 objective or target is unsupported")
        if metadata.get("quantile_alpha") != V2_QUANTILE_ALPHA or metadata.get("quantile_output_columns") != V2_QUANTILE_COLUMNS:
            raise RuntimeError("The active v2 quantile metadata is unsupported")
        if metadata.get("one_prediction_call_returns_all_quantiles") is not True:
            raise RuntimeError("The active v2 release must return all quantiles in one call")
        return metadata

    def _load_records(self) -> tuple[ModelRecord, ...]:
        records: list[ModelRecord] = []
        feature_map = self.metadata.get("feature_names_by_position", {})
        for item in self.metadata.get("model_records", []):
            position = str(item.get("position", "")).upper()
            if position not in V2_MODEL_POSITIONS:
                continue
            raw_features = item.get("features", [])
            features = tuple(str(value) for value in raw_features) if not isinstance(raw_features, str) else tuple(value for value in raw_features.split(",") if value)
            if not features or "n_projectors" in features or tuple(str(value) for value in feature_map.get(position, [])) != features:
                raise RuntimeError(f"The active v2 feature list is invalid for {position}")
            relative_path = str(item.get("model_path", "")).replace("\\", "/")
            model_path = (self.model_root / relative_path).resolve()
            if not model_path.is_file() or self.model_root.resolve() not in model_path.parents:
                raise RuntimeError(f"The active v2 model file is missing: {model_path}")
            records.append(ModelRecord(int(item["target_season"]), position, model_path, features))
        by_position = {record.position for record in records}
        if by_position != V2_MODEL_POSITIONS or len(records) != len(V2_MODEL_POSITIONS):
            raise RuntimeError(f"The active v2 release must contain one QB, RB, WR, and TE booster: {by_position}")
        return tuple(records)

    def _load_booster(self, path: Path) -> xgb.Booster:
        with self._cache_lock:
            if path not in self._booster_cache:
                booster = xgb.Booster()
                booster.load_model(str(path))
                self._booster_cache[path] = booster
            return self._booster_cache[path]

    def _select_record(self, position: str, season: int) -> ModelRecord:
        candidates = [record for record in self.records if record.position == position]
        if not candidates:
            raise ProducerError(f"No active v2 booster exists for {position}", fields=["position"])
        eligible = [record for record in candidates if record.target_season <= season]
        return max(eligible or candidates, key=lambda record: record.target_season)

    @staticmethod
    def _validate_request(request: dict[str, Any]) -> tuple[str, int, int, list[dict[str, Any]]]:
        if request.get("model_release") != V2_MODEL_RELEASE:
            raise ProducerError("The requested v2 model release is unavailable", fields=["model_release"])
        if request.get("scoring_contract_version") != SCORING_CONTRACT_VERSION:
            raise ProducerError("The scoring contract is unsupported", fields=["scoring_contract_version"])
        if request.get("feature_version") != V2_FEATURE_VERSION:
            raise ProducerError("The feature version is unsupported", fields=["feature_version"])
        position = str(request.get("position", "")).upper()
        if position not in V2_MODEL_POSITIONS:
            raise ProducerError("The v2 model accepts QB, RB, WR, and TE", fields=["position"])
        try:
            season = int(request["season"])
            week = int(request["week"])
        except (KeyError, TypeError, ValueError) as error:
            raise ProducerError("season and week must be integers", fields=["season", "week"]) from error
        if not 2020 <= season <= 2100 or not 1 <= week <= 18:
            raise ProducerError("season or week is outside the supported range", fields=["season", "week"])
        rows = request.get("rows")
        if not isinstance(rows, list) or not rows:
            raise ProducerError("rows must contain at least one feature row", fields=["rows"])
        ids = []
        for row in rows:
            if not isinstance(row, dict) or not row.get("stable_player_id"):
                raise ProducerError("Every row needs a stable_player_id", fields=["stable_player_id"])
            ids.append(str(row["stable_player_id"]))
        if len(ids) != len(set(ids)):
            duplicates = sorted({player_id for player_id in ids if ids.count(player_id) > 1})
            raise ProducerError("The v2 request contains duplicate stable IDs", player_ids=duplicates)
        return position, season, week, rows

    def predict(self, request: dict[str, Any]) -> dict[str, Any]:
        position, season, week, rows = self._validate_request(request)
        record = self._select_record(position, season)
        values: list[list[float]] = []
        ids: list[str] = []
        errors: dict[str, list[str]] = {}
        for row in rows:
            player_id = str(row["stable_player_id"])
            ids.append(player_id)
            feature_values = row.get("features")
            if not isinstance(feature_values, dict):
                errors[player_id] = list(record.features)
                continue
            if "n_projectors" in feature_values:
                errors[player_id] = ["n_projectors"]
                continue
            missing = [feature for feature in record.features if feature not in feature_values]
            extra = [feature for feature in feature_values if feature not in record.features]
            invalid = [
                feature
                for feature in record.features
                if feature in feature_values
                and (
                    isinstance(feature_values[feature], bool)
                    or not isinstance(feature_values[feature], (int, float))
                    or not math.isfinite(float(feature_values[feature]))
                )
            ]
            if missing or invalid or extra:
                errors[player_id] = sorted(set(missing + invalid + [f"unsupported:{feature}" for feature in extra]))
                continue
            values.append([float(feature_values[feature]) for feature in record.features])
        if errors:
            raise ProducerError(
                "One or more v2 prediction rows are missing valid model features",
                fields=sorted({field for fields in errors.values() for field in fields}),
                player_ids=sorted(errors),
            )

        matrix = xgb.DMatrix(np.asarray(values, dtype=np.float32), feature_names=list(record.features))
        raw = np.asarray(self._load_booster(record.model_path).predict(matrix), dtype=np.float64)
        expected_shape = (len(ids), 3)
        if raw.shape != expected_shape or not np.isfinite(raw).all():
            raise RuntimeError(f"The active v2 booster returned {raw.shape}, expected finite {expected_shape}")
        crossing_ids = [player_id for player_id, row in zip(ids, raw, strict=True) if row[0] > row[1] or row[1] > row[2]]
        negative_ids = [player_id for player_id, row in zip(ids, raw, strict=True) if np.any(row < 0)]
        return {
            "schema_version": "model-prediction.v2",
            "model_release": V2_MODEL_RELEASE,
            "feature_version": V2_FEATURE_VERSION,
            "scoring_contract_version": SCORING_CONTRACT_VERSION,
            "position": position,
            "season": season,
            "week": week,
            "model_target_season": record.target_season,
            "model_artifact_version": V2_MODEL_ARTIFACT_VERSION,
            "feature_names": list(record.features),
            "quantile_output_columns": V2_QUANTILE_COLUMNS,
            "prediction_count": len(ids),
            "prediction_call_count": 1,
            "quantile_crossing_count": len(crossing_ids),
            "quantile_crossing_player_ids": crossing_ids,
            "negative_prediction_count": len(negative_ids),
            "negative_prediction_player_ids": negative_ids,
            "predictions": [
                {"stable_player_id": player_id, "p15": float(row[0]), "p50": float(row[1]), "p85": float(row[2])}
                for player_id, row in zip(ids, raw, strict=True)
            ],
        }


class FfsimulatorService:
    """Implement the weekly rank-conditioned ffsimulator contract."""

    def __init__(self) -> None:
        outcome_path = ASSET_ROOT / "adp_outcomes.json"
        try:
            raw = json.loads(outcome_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise RuntimeError(f"Cannot read ffsimulator outcome pool at {outcome_path}: {error}") from error
        if not isinstance(raw, list):
            raise RuntimeError("The ffsimulator outcome pool must be a JSON array")
        self.outcomes: dict[tuple[str, int], list[float]] = {}
        for item in raw:
            if not isinstance(item, dict):
                raise RuntimeError("The ffsimulator outcome pool has an invalid row")
            position = str(item.get("pos", "")).upper()
            rank = item.get("rank")
            scores = item.get("week_outcomes")
            if isinstance(scores, (int, float)):
                scores = [scores]
            if position not in {"QB", "RB", "WR", "TE"} or not isinstance(rank, (int, float)) or not isinstance(scores, list) or not scores:
                raise RuntimeError("The ffsimulator outcome pool has an invalid row")
            numeric_scores = [float(score) for score in scores]
            if not all(math.isfinite(score) for score in numeric_scores):
                raise RuntimeError("The ffsimulator outcome pool has invalid score values")
            self.outcomes.setdefault((position, int(rank)), []).extend(numeric_scores)

    @staticmethod
    def _number(value: Any, field: str) -> float:
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
            raise ProducerError(f"{field} must be a finite number", fields=[field])
        return float(value)

    def simulate(self, request: dict[str, Any]) -> dict[str, Any]:
        if request.get("schema_version") != "ffsimulator-request.v1":
            raise ProducerError("The ffsimulator request schema is unsupported", fields=["schema_version"])
        try:
            week = int(request["week"])
            seed = int(request["seed"])
            simulation_count = int(request["simulation_count"])
        except (KeyError, TypeError, ValueError) as error:
            raise ProducerError("week, seed, and simulation_count must be integers", fields=["week", "seed", "simulation_count"]) from error
        if not 1 <= week <= 18:
            raise ProducerError("week must be from 1 through 18", fields=["week"])
        if not 0 <= seed <= 2_147_483_647:
            raise ProducerError("seed must be a non-negative 32-bit integer", fields=["seed"])
        if not 100 <= simulation_count <= 10_000:
            raise ProducerError("simulation_count must be from 100 through 10000", fields=["simulation_count"])
        rows = request.get("rows")
        if not isinstance(rows, list) or not rows:
            raise ProducerError("rows must contain at least one ranking row", fields=["rows"])

        ids: list[str] = []
        normalized: list[tuple[str, str, float, float]] = []
        for row in rows:
            if not isinstance(row, dict) or not row.get("stable_player_id"):
                raise ProducerError("Every ranking row needs a stable_player_id", fields=["stable_player_id"])
            player_id = str(row["stable_player_id"])
            position = str(row.get("position", "")).upper()
            if position not in {"QB", "RB", "WR", "TE"}:
                raise ProducerError(f"Unsupported ffsimulator position for {player_id}", fields=["position"], player_ids=[player_id])
            rank = self._number(row.get("rank"), "rank")
            rank_uncertainty = self._number(row.get("rank_uncertainty"), "rank_uncertainty")
            if rank <= 0 or rank_uncertainty < 0:
                raise ProducerError(f"Invalid ranking values for {player_id}", player_ids=[player_id])
            source_order = row.get("source_order")
            if isinstance(source_order, bool) or not isinstance(source_order, (int, float)) or int(source_order) < 1:
                raise ProducerError(f"source_order must be a positive integer for {player_id}", fields=["source_order"], player_ids=[player_id])
            ids.append(player_id)
            normalized.append((player_id, position, rank, rank_uncertainty))
        if len(ids) != len(set(ids)):
            duplicates = sorted({player_id for player_id in ids if ids.count(player_id) > 1})
            raise ProducerError("The ffsimulator request contains duplicate stable IDs", player_ids=duplicates)

        rng = np.random.RandomState(seed)
        result_rows: list[dict[str, Any]] = []
        for player_id, position, rank, rank_uncertainty in normalized:
            sampled_ranks = np.rint(rng.normal(rank, rank_uncertainty / 2.0, simulation_count)).astype(np.int64)
            # Rank values are 1-based domain values. Keep the lower boundary
            # consistent with the R worker before looking up outcome pools.
            sampled_ranks[sampled_ranks < 1] = 1
            scores = np.empty(simulation_count, dtype=np.float64)
            for sampled_rank in np.unique(sampled_ranks):
                pool = self.outcomes.get((position, int(sampled_rank)))
                if not pool:
                    raise ProducerError(
                        f"The outcome pool does not cover {position} rank {int(sampled_rank)} for {player_id}",
                        fields=["rank"],
                        player_ids=[player_id],
                    )
                indexes = np.flatnonzero(sampled_ranks == sampled_rank)
                scores[indexes] = np.asarray(pool, dtype=np.float64)[rng.randint(0, len(pool), size=len(indexes))]
            scores = np.maximum(scores, 0.0)
            p15, p50, p85 = np.quantile(scores, [0.15, 0.50, 0.85], method="linear")
            result_rows.append({
                "stable_player_id": player_id,
                "mean": float(np.mean(scores)),
                "median": float(p50),
                "p15": float(p15),
                "p50": float(p50),
                "p85": float(p85),
                "probability_zero": float(np.mean(scores == 0)),
                "probability_active": 1.0,
                "n_simulations": simulation_count,
            })
        return {
            "schema_version": "ffsimulator-prediction.v1",
            "week": week,
            "seed": seed,
            "simulation_count": simulation_count,
            "package_version": "portable-ffsimulator-v1",
            "rows": result_rows,
        }


def _check_token(headers: Any) -> None:
    expected = os.environ.get("INFERENCE_SERVICE_TOKEN")
    if not expected:
        raise ProducerError("INFERENCE_SERVICE_TOKEN is not configured", status=500)
    authorization = str(headers.get("authorization", ""))
    supplied = authorization.removeprefix("Bearer ").strip()
    if not hmac.compare_digest(supplied, expected):
        raise ProducerError("The inference service token is invalid", status=401)


class ProducerHandler(BaseHTTPRequestHandler):
    """Handle active v2 and legacy v1 model plus ffsimulator requests."""

    _prediction_services: dict[str, PredictionService] = {}
    _prediction_service_v2: PredictionServiceV2 | None = None
    _ffsimulator_service: FfsimulatorService | None = None
    _service_lock = Lock()

    def do_POST(self) -> None:  # noqa: N802
        route = urlsplit(self.path).path.rstrip("/")
        model_match = re.search(r"/v1/models/(p15|p85)/predict$", route)
        is_v2_model = route.endswith(V2_MODEL_ENDPOINT)
        is_ffsimulator = route.endswith("/v1/ffsimulator/predict")
        if not model_match and not is_v2_model and not is_ffsimulator:
            self._write_json(404, {"error": "Unknown producer route"})
            return
        try:
            _check_token(self.headers)
            length = int(self.headers.get("content-length", "0"))
            if length <= 0 or length > MAX_BODY_BYTES:
                raise ProducerError("The request body is empty or too large", fields=["content-length"])
            request = json.loads(self.rfile.read(length))
            if not isinstance(request, dict):
                raise ProducerError("The request body must be a JSON object")
            if is_v2_model:
                response = self._get_prediction_service_v2().predict(request)
                print(f"[producer] release={V2_MODEL_RELEASE} endpoint={V2_MODEL_ENDPOINT} position={response['position']} rows={response['prediction_count']} crossings={response['quantile_crossing_count']}")
            elif model_match:
                quantile = model_match.group(1)
                service = self._get_prediction_service(quantile)
                response = service.predict(request)
            else:
                response = self._get_ffsimulator_service().simulate(request)
        except ProducerError as error:
            self._write_json(error.status, error.payload())
            return
        except (json.JSONDecodeError, UnicodeDecodeError, ValueError) as error:
            self._write_json(400, {"error": f"Request JSON is invalid: {error}"})
            return
        except Exception as error:  # pragma: no cover - the function boundary reports unexpected faults
            print(f"[producer] unexpected error: {error}", file=sys.stderr)
            self._write_json(500, {"error": "The producer failed while serving the request."})
            return
        self._write_json(200, response)

    @classmethod
    def _get_prediction_service(cls, quantile: str) -> PredictionService:
        with cls._service_lock:
            service = cls._prediction_services.get(quantile)
            if service is None:
                service = PredictionService(quantile)
                cls._prediction_services[quantile] = service
            return service

    @classmethod
    def _get_prediction_service_v2(cls) -> PredictionServiceV2:
        with cls._service_lock:
            if cls._prediction_service_v2 is None:
                cls._prediction_service_v2 = PredictionServiceV2()
            return cls._prediction_service_v2

    @classmethod
    def _get_ffsimulator_service(cls) -> FfsimulatorService:
        with cls._service_lock:
            if cls._ffsimulator_service is None:
                cls._ffsimulator_service = FfsimulatorService()
            return cls._ffsimulator_service

    def _write_json(self, status: int, payload: dict[str, Any]) -> None:
        encoded = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, format_string: str, *args: Any) -> None:
        return


class handler(ProducerHandler):
    """Vercel Python runtime entrypoint."""
