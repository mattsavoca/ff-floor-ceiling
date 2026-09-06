"""Leakage-safe Python team defense XGBoost pipeline."""

from .features import build_model_features, build_scenario_panel
from .predict import score_fbg_scenarios
from .scoring import DstScoringProfile, UPSTREAM_FD_PROFILE, build_dst_targets
from .schedule import build_team_game_schedule
from .schemas import FEATURE_COLUMNS, FEATURE_SPEC
from .teams import normalize_dst_rows, normalize_team, normalize_team_series

__all__ = [
    "DstScoringProfile",
    "FEATURE_COLUMNS",
    "FEATURE_SPEC",
    "UPSTREAM_FD_PROFILE",
    "build_dst_targets",
    "build_model_features",
    "build_scenario_panel",
    "build_team_game_schedule",
    "normalize_team",
    "normalize_team_series",
    "normalize_dst_rows",
    "score_fbg_scenarios",
]
