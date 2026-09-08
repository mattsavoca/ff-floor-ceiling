"""Serve the v2 four-position multi-quantile XGBoost release."""

from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from threading import Lock
from typing import Any

import numpy as np
import xgboost as xgb


MODEL_POSITIONS = {"QB", "RB", "WR", "TE"}
FEATURE_VERSION = "fbg_rank_projection_v2"
SCORING_CONTRACT_VERSION = "ppr_v1"
QUANTILE_LABELS = ("p15", "p50", "p85")


class PredictionError(ValueError):
    """Represent a client-visible validation failure."""

    def __init__(
        self,
        message: str,
        *,
        fields: list[str] | None = None,
        player_ids: list[str] | None = None,
    ) -> None:
        super().__init__(message)
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
    position: str
    target_season: int
    model_path: Path
    features: tuple[str, ...]


class PredictionServiceV2:
    """Load one v2 booster per position and predict all three quantiles."""

    def __init__(self, model_root: Path, release: str = "forecast-ppr-v2") -> None:
        self.model_root = model_root.resolve()
        self.release = release
        self.metadata_path = self.model_root / "metadata.json"
        self.metadata = self._load_metadata()
        self.records = self._load_records()
        self._booster_cache: dict[Path, xgb.Booster] = {}
        self._cache_lock = Lock()

    def _load_metadata(self) -> dict[str, Any]:
        try:
            metadata = json.loads(self.metadata_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise RuntimeError(f"Cannot read v2 model metadata: {error}") from error
        if metadata.get("model_release") != self.release:
            raise RuntimeError("The requested v2 model release does not match metadata")
        if metadata.get("feature_version") != FEATURE_VERSION:
            raise RuntimeError("The v2 feature version is unsupported")
        if metadata.get("scoring_contract_version") != SCORING_CONTRACT_VERSION:
            raise RuntimeError("The v2 scoring contract is unsupported")
        if metadata.get("objective") != "reg:quantileerror":
            raise RuntimeError("The v2 objective is not reg:quantileerror")
        if metadata.get("quantile_alpha") != [0.15, 0.5, 0.85]:
            raise RuntimeError("The v2 metadata does not declare p15, p50, and p85")
        if metadata.get("target_column") != "actual_score":
            raise RuntimeError("The v2 target column is unsupported")
        if metadata.get("one_prediction_call_returns_all_quantiles") is not True:
            raise RuntimeError("The v2 metadata does not declare one multi-quantile prediction call")
        return metadata

    def _load_records(self) -> tuple[ModelRecord, ...]:
        records: list[ModelRecord] = []
        for item in self.metadata.get("model_records", []):
            position = str(item.get("position", "")).upper()
            if position not in MODEL_POSITIONS:
                continue
            raw_features = item.get("features", [])
            if isinstance(raw_features, str):
                features = tuple(value for value in raw_features.split(",") if value)
            else:
                features = tuple(str(value) for value in raw_features)
            if "n_projectors" in features:
                raise RuntimeError(f"v2 model metadata has an unsupported feature for {position}")
            relative_path = str(item.get("model_path", "")).replace("\\", "/")
            model_path = (self.model_root / relative_path).resolve()
            if not model_path.is_file() or self.model_root not in model_path.parents:
                raise RuntimeError(f"v2 model file is missing: {model_path}")
            declared_features = self.metadata.get("feature_names_by_position", {}).get(position)
            if tuple(str(value) for value in declared_features or []) != features:
                raise RuntimeError(f"v2 feature metadata does not match the {position} model record")
            records.append(
                ModelRecord(
                    position=position,
                    target_season=int(item["target_season"]),
                    model_path=model_path,
                    features=features,
                )
            )
        by_position = {record.position for record in records}
        if by_position != MODEL_POSITIONS or len(records) != len(MODEL_POSITIONS):
            raise RuntimeError(f"v2 model release must contain QB, RB, WR, and TE: {by_position}")
        return tuple(records)

    def _load_booster(self, path: Path) -> xgb.Booster:
        with self._cache_lock:
            if path not in self._booster_cache:
                booster = xgb.Booster()
                booster.load_model(str(path))
                self._booster_cache[path] = booster
            return self._booster_cache[path]

    def _record_for(self, position: str, season: int) -> ModelRecord:
        candidates = [record for record in self.records if record.position == position]
        if not candidates:
            raise PredictionError(f"No v2 booster exists for {position}")
        eligible = [record for record in candidates if record.target_season <= season]
        return max(eligible or candidates, key=lambda record: record.target_season)

    @staticmethod
    def _validate_request(request: dict[str, Any]) -> tuple[str, int, int, list[dict[str, Any]]]:
        if request.get("model_release") is None:
            raise PredictionError("model_release is required", fields=["model_release"])
        if request.get("scoring_contract_version") != SCORING_CONTRACT_VERSION:
            raise PredictionError("The scoring contract is unsupported", fields=["scoring_contract_version"])
        if request.get("feature_version") != FEATURE_VERSION:
            raise PredictionError("The feature version is unsupported", fields=["feature_version"])
        position = str(request.get("position", "")).upper()
        if position not in MODEL_POSITIONS:
            raise PredictionError("v2 accepts QB, RB, WR, and TE", fields=["position"])
        try:
            season = int(request["season"])
            week = int(request["week"])
        except (KeyError, TypeError, ValueError) as error:
            raise PredictionError("season and week must be integers", fields=["season", "week"]) from error
        rows = request.get("rows")
        if not isinstance(rows, list) or not rows:
            raise PredictionError("rows must contain at least one feature row", fields=["rows"])
        ids = []
        for row in rows:
            if not isinstance(row, dict) or not row.get("stable_player_id"):
                raise PredictionError("Every row needs a stable_player_id", fields=["stable_player_id"])
            ids.append(str(row["stable_player_id"]))
        if len(ids) != len(set(ids)):
            duplicates = sorted({value for value in ids if ids.count(value) > 1})
            raise PredictionError("Prediction request contains duplicate stable IDs", player_ids=duplicates)
        if not 2020 <= season <= 2100 or not 1 <= week <= 18:
            raise PredictionError("season or week is outside the supported range", fields=["season", "week"])
        return position, season, week, rows

    def predict(self, request: dict[str, Any]) -> dict[str, Any]:
        position, season, week, rows = self._validate_request(request)
        if request.get("model_release") != self.release:
            raise PredictionError("The requested model release is unavailable", fields=["model_release"])
        record = self._record_for(position, season)
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
            invalid = []
            for feature in record.features:
                if feature not in feature_values:
                    continue
                value = feature_values[feature]
                if isinstance(value, bool) or not isinstance(value, (int, float)):
                    invalid.append(feature)
                elif not math.isfinite(float(value)):
                    invalid.append(feature)
            if missing or invalid or extra:
                errors[player_id] = sorted(set(missing + invalid + [f"unsupported:{feature}" for feature in extra]))
                continue
            values.append([float(feature_values[feature]) for feature in record.features])
        if errors:
            raise PredictionError(
                "One or more v2 prediction rows are missing valid model features",
                fields=sorted({field for fields in errors.values() for field in fields}),
                player_ids=sorted(errors),
            )

        matrix = xgb.DMatrix(np.asarray(values, dtype=np.float32), feature_names=list(record.features))
        raw = np.asarray(self._load_booster(record.model_path).predict(matrix), dtype=np.float64)
        expected_shape = (len(ids), 3)
        if raw.shape != expected_shape or not np.isfinite(raw).all():
            raise RuntimeError(f"The v2 booster returned {raw.shape}, expected finite {expected_shape}")
        crossing_ids = [
            player_id
            for player_id, row in zip(ids, raw, strict=True)
            if row[0] > row[1] or row[1] > row[2] or row[0] > row[2]
        ]
        predictions = [
            {
                "stable_player_id": player_id,
                "p15": float(row[0]),
                "p50": float(row[1]),
                "p85": float(row[2]),
            }
            for player_id, row in zip(ids, raw, strict=True)
        ]
        return {
            "schema_version": "model-prediction.v2",
            "model_release": self.release,
            "feature_version": FEATURE_VERSION,
            "scoring_contract_version": SCORING_CONTRACT_VERSION,
            "position": position,
            "season": season,
            "week": week,
            "model_target_season": record.target_season,
            "model_artifact_version": self.metadata.get("model_artifact_version", self.metadata.get("artifact_version")),
            "feature_names": list(record.features),
            "quantile_output_columns": {"0": "p15", "1": "p50", "2": "p85"},
            "prediction_count": len(predictions),
            "prediction_call_count": 1,
            "quantile_crossing_count": len(crossing_ids),
            "quantile_crossing_player_ids": crossing_ids,
            "negative_prediction_count": sum(bool(np.any(row < 0)) for row in raw),
            "negative_prediction_player_ids": [player_id for player_id, row in zip(ids, raw, strict=True) if np.any(row < 0)],
            "predictions": predictions,
        }


def build_handler(service: PredictionServiceV2):
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802
            if self.path.rstrip("/") != "/v2/models/predict":
                self._write_json(404, {"error": "Unknown v2 model route"})
                return
            try:
                length = int(self.headers.get("content-length", "0"))
                request = json.loads(self.rfile.read(length))
                if not isinstance(request, dict):
                    raise PredictionError("The request body must be a JSON object")
                response = service.predict(request)
            except PredictionError as error:
                self._write_json(400, error.payload())
                return
            except (json.JSONDecodeError, UnicodeDecodeError) as error:
                self._write_json(400, {"error": f"Request JSON is invalid: {error}"})
                return
            except Exception as error:  # pragma: no cover
                self._write_json(500, {"error": str(error)})
                return
            self._write_json(200, response)

        def _write_json(self, status: int, payload: dict[str, Any]) -> None:
            encoded = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

        def log_message(self, format: str, *args: Any) -> None:
            return

    return Handler


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-root", type=Path, required=True)
    parser.add_argument("--release", default="forecast-ppr-v2")
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--serve", action="store_true")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8092)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    service = PredictionServiceV2(args.model_root, args.release)
    if args.once or not args.serve:
        try:
            request = json.load(sys.stdin)
            if not isinstance(request, dict):
                raise PredictionError("The request body must be a JSON object")
            response = service.predict(request)
        except PredictionError as error:
            print(json.dumps(error.payload()))
            raise SystemExit(2) from error
        print(json.dumps(response))
        return
    HTTPServer((args.host, args.port), build_handler(service)).serve_forever()


if __name__ == "__main__":
    main()
