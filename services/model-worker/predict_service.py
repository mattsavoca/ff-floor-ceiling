"""Serve the released P15 and P85 XGBoost models.

The service accepts one batch per position. It loads released Booster files and
does not train, tune, or alter a model during a prediction request.
"""

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


MODEL_POSITIONS = {"RB", "WR", "TE"}
FEATURE_VERSION = "fbg_rank_projection_v1"
SCORING_CONTRACT_VERSION = "ppr_v1"
QUANTILES = {"p15": 0.15, "p85": 0.85}


class PredictionError(ValueError):
    """Represent a client-visible validation failure."""

    def __init__(self, message: str, *, fields: list[str] | None = None, player_ids: list[str] | None = None) -> None:
        super().__init__(message)
        self.fields = fields or []
        self.player_ids = player_ids or []

    def payload(self) -> dict[str, Any]:
        """Return the stable error contract."""

        return {
            "error": str(self),
            "missing_features": self.fields,
            "affected_player_ids": self.player_ids,
        }


@dataclass(frozen=True)
class ModelRecord:
    """Describe one released position and target-season model."""

    target_season: int
    position: str
    model_path: Path
    features: tuple[str, ...]
    quantile_label: str


class PredictionService:
    """Load released models and produce checked prediction batches."""

    def __init__(self, model_root: Path, release: str) -> None:
        self.model_root = model_root.resolve()
        self.release = release
        self.metadata_path = self.model_root / "metadata.json"
        self.metadata = self._load_metadata()
        self.records = self._load_records()
        self._booster_cache: dict[Path, xgb.Booster] = {}
        self._cache_lock = Lock()

    def _load_metadata(self) -> dict[str, Any]:
        """Read the immutable model metadata file."""

        try:
            return json.loads(self.metadata_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise RuntimeError(f"Cannot read model metadata at {self.metadata_path}: {error}") from error

    def _load_records(self) -> tuple[ModelRecord, ...]:
        """Validate metadata and resolve model file paths."""

        metadata_label = self.metadata.get("quantile_label")
        quantile_label = str(metadata_label or f"p{round(float(self.metadata.get('quantile_alpha', 0)) * 100):.0f}")
        if quantile_label not in QUANTILES:
            raise RuntimeError(f"Unsupported quantile label in metadata: {quantile_label}")
        records: list[ModelRecord] = []
        for item in self.metadata.get("model_records", []):
            position = str(item.get("position", "")).upper()
            if position not in MODEL_POSITIONS:
                continue
            features = tuple(str(item.get("features", "")).split(","))
            relative_path = str(item.get("model_path", "")).replace("\\", "/")
            model_path = (self.model_root / relative_path).resolve()
            if not model_path.is_file():
                raise RuntimeError(f"Released model file is missing: {model_path}")
            records.append(
                ModelRecord(
                    target_season=int(item["target_season"]),
                    position=position,
                    model_path=model_path,
                    features=features,
                    quantile_label=quantile_label,
                )
            )
        if not records:
            raise RuntimeError("The model release has no RB, WR, or TE model records")
        return tuple(records)

    def _select_record(self, position: str, season: int) -> ModelRecord:
        """Select the newest walk-forward model available for a season."""

        candidates = [record for record in self.records if record.position == position]
        if not candidates:
            raise PredictionError(f"No released model exists for position {position}")
        eligible = [record for record in candidates if record.target_season <= season]
        return max(eligible or candidates, key=lambda record: record.target_season)

    def _load_booster(self, path: Path) -> xgb.Booster:
        """Load a Booster once for the process."""

        with self._cache_lock:
            if path not in self._booster_cache:
                booster = xgb.Booster()
                booster.load_model(str(path))
                self._booster_cache[path] = booster
            return self._booster_cache[path]

    @staticmethod
    def _validate_base_request(request: dict[str, Any], quantile_label: str) -> tuple[str, int, int, list[dict[str, Any]]]:
        """Validate request identity, contract versions, and row IDs."""

        if request.get("model_release") is None:
            raise PredictionError("model_release is required", fields=["model_release"])
        if request.get("scoring_contract_version") != SCORING_CONTRACT_VERSION:
            raise PredictionError("The scoring contract is unsupported", fields=["scoring_contract_version"])
        if request.get("feature_version") != FEATURE_VERSION:
            raise PredictionError("The feature version is unsupported", fields=["feature_version"])
        position = str(request.get("position", "")).upper()
        if position not in MODEL_POSITIONS:
            raise PredictionError("XGBoost services accept RB, WR, and TE only", fields=["position"])
        try:
            season = int(request["season"])
            week = int(request["week"])
        except (KeyError, TypeError, ValueError) as error:
            raise PredictionError("season and week must be integers", fields=["season", "week"]) from error
        if not 2020 <= season <= 2100 or not 1 <= week <= 18:
            raise PredictionError("season or week is outside the supported range", fields=["season", "week"])
        rows = request.get("rows")
        if not isinstance(rows, list) or not rows:
            raise PredictionError("rows must contain at least one feature row", fields=["rows"])
        ids: list[str] = []
        for row in rows:
            if not isinstance(row, dict) or not row.get("stable_player_id"):
                raise PredictionError("Every row needs a stable_player_id", fields=["stable_player_id"])
            ids.append(str(row["stable_player_id"]))
        if len(ids) != len(set(ids)):
            duplicates = sorted({player_id for player_id in ids if ids.count(player_id) > 1})
            raise PredictionError("Prediction request contains duplicate stable IDs", player_ids=duplicates)
        return position, season, week, rows

    def predict(self, quantile_label: str, request: dict[str, Any]) -> dict[str, Any]:
        """Predict a checked batch for one position and quantile."""

        if quantile_label not in QUANTILES:
            raise PredictionError("The requested quantile is unsupported", fields=["quantile"])
        position, season, week, rows = self._validate_base_request(request, quantile_label)
        if request.get("model_release") != self.release:
            raise PredictionError("The requested model release is unavailable", fields=["model_release"])
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
            raise PredictionError(
                "One or more prediction rows are missing valid model features",
                fields=fields,
                player_ids=sorted(missing_by_player),
            )

        matrix = xgb.DMatrix(np.asarray(values, dtype=np.float32), feature_names=list(record.features))
        raw_predictions = self._load_booster(record.model_path).predict(matrix)
        predictions = np.maximum(0.0, np.asarray(raw_predictions, dtype=np.float64))
        if len(predictions) != len(ids) or not np.isfinite(predictions).all():
            raise RuntimeError("The released model returned an invalid prediction batch")
        key = quantile_label
        return {
            "schema_version": "model-prediction.v1",
            "model_release": self.release,
            "feature_version": FEATURE_VERSION,
            "scoring_contract_version": SCORING_CONTRACT_VERSION,
            "quantile": key,
            "position": position,
            "season": season,
            "week": week,
            "model_target_season": record.target_season,
            "feature_names": list(record.features),
            "prediction_count": len(ids),
            "predictions": [
                {"stable_player_id": player_id, key: float(value)}
                for player_id, value in zip(ids, predictions, strict=True)
            ],
        }


def build_handler(service: PredictionService):
    """Build an HTTP handler bound to one loaded service."""

    class Handler(BaseHTTPRequestHandler):
        """Handle model prediction requests."""

        def do_POST(self) -> None:  # noqa: N802
            route = self.path.rstrip("/").split("/")
            if len(route) != 5 or route[:3] != ["", "v1", "models"] or route[4] != "predict":
                self._write_json(404, {"error": "Unknown model route"})
                return
            quantile_label = route[3]
            try:
                length = int(self.headers.get("content-length", "0"))
                request = json.loads(self.rfile.read(length))
                response = service.predict(quantile_label, request)
            except PredictionError as error:
                self._write_json(400, error.payload())
                return
            except (json.JSONDecodeError, UnicodeDecodeError) as error:
                self._write_json(400, {"error": f"Request JSON is invalid: {error}"})
                return
            except Exception as error:  # pragma: no cover - the process boundary reports unexpected faults
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

        def log_message(self, format_string: str, *args: Any) -> None:
            return

    return Handler


def default_model_root(quantile_label: str) -> Path:
    """Return the repository release directory for a quantile."""

    repository_root = Path(__file__).resolve().parents[2]
    return repository_root / "backtest_fbg_2023_2025" / "outputs" / f"xgb_{quantile_label}_projection"


def main() -> int:
    """Run one stdin prediction or an HTTP service."""

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--quantile", choices=sorted(QUANTILES), default="p15")
    parser.add_argument("--model-root", type=Path)
    parser.add_argument("--release", default=None)
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--serve", action="store_true")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    model_root = args.model_root or default_model_root(args.quantile)
    release = args.release or f"xgb_{args.quantile}_projection"
    service = PredictionService(model_root, release)
    if args.once or not args.serve:
        request = json.load(sys.stdin)
        try:
            response = service.predict(args.quantile, request)
        except PredictionError as error:
            print(json.dumps(error.payload()))
            return 2
        print(json.dumps(response))
        return 0

    server = HTTPServer((args.host, args.port), build_handler(service))
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
