"""Evaluation and data-contract checks for DST model releases."""

from __future__ import annotations

import numpy as np
import pandas as pd

from .schemas import FEATURE_COLUMNS, SCENARIO_KEYS, TEAM_GAME_KEYS, assert_unique, require_columns


def pinball_loss(actual: np.ndarray, predicted: np.ndarray, quantile: float) -> float:
    error = actual - predicted
    return float(np.mean(np.maximum(quantile * error, (quantile - 1.0) * error)))


def evaluate_predictions(predictions: pd.DataFrame) -> pd.DataFrame:
    """Return point, interval, coverage, and baseline metrics by season."""

    require_columns(predictions, ["season", "dst_fd_pts", "dst_point", "dst_p15", "dst_p50", "dst_p85"], "DST predictions")
    source = predictions.copy()
    source["actual"] = pd.to_numeric(source["dst_fd_pts"], errors="coerce")
    source = source[source["actual"].notna()].copy()

    def one_frame(frame: pd.DataFrame, label: str) -> dict[str, object]:
        actual = frame["actual"].to_numpy(dtype=float)
        point = frame["dst_point"].to_numpy(dtype=float)
        p15 = frame["dst_p15"].to_numpy(dtype=float)
        p50 = frame["dst_p50"].to_numpy(dtype=float)
        p85 = frame["dst_p85"].to_numpy(dtype=float)
        baseline = np.full_like(actual, np.nanmean(actual)) if len(actual) else actual
        if "game_id" in frame.columns:
            game = (
                frame.groupby(["season", "week", "game_id", "team"], as_index=False)
                .agg(
                    actual=("actual", "first"),
                    point=("dst_point", "mean"),
                    p15=("dst_p15", "mean"),
                    p50=("dst_p50", "mean"),
                    p85=("dst_p85", "mean"),
                )
            )
        else:
            game = pd.DataFrame({"actual": actual, "point": point, "p15": p15, "p50": p50, "p85": p85})
        rank_correlation = game["actual"].corr(game["point"], method="spearman") if len(game) > 1 else np.nan
        boom_capture_parts: list[float] = []
        for _, week in game.groupby(["season", "week"]):
            n_top = max(1, int(np.ceil(len(week) * 0.20)))
            selected = week.nlargest(n_top, "point")
            total_booms = int((week["actual"] >= 10).sum())
            boom_capture_parts.append(float((selected["actual"] >= 10).sum() / total_booms) if total_booms else np.nan)
        valid_boom_capture = [value for value in boom_capture_parts if np.isfinite(value)]
        boom_capture = float(np.mean(valid_boom_capture)) if valid_boom_capture else np.nan
        return {
            "season": label,
            "rows": len(frame),
            "games": frame["game_id"].nunique() if "game_id" in frame.columns else np.nan,
            "rmse": float(np.sqrt(np.mean((point - actual) ** 2))) if len(actual) else np.nan,
            "mae": float(np.mean(np.abs(point - actual))) if len(actual) else np.nan,
            "bias": float(np.mean(point - actual)) if len(actual) else np.nan,
            "r2": _r2(actual, point),
            "baseline_rmse": float(np.sqrt(np.mean((baseline - actual) ** 2))) if len(actual) else np.nan,
            "market_baseline_rmse": (
                float(np.sqrt(np.mean((pd.to_numeric(frame["market_baseline"], errors="coerce").to_numpy(dtype=float) - actual) ** 2)))
                if "market_baseline" in frame.columns and len(actual)
                else np.nan
            ),
            "qb_history_fallback_rows": (
                int(
                    len(frame)
                    - pd.to_numeric(frame["opponent_qb_history_available"], errors="coerce").fillna(0).sum()
                )
                if "opponent_qb_history_available" in frame.columns
                else np.nan
            ),
            "p15_pinball": pinball_loss(actual, p15, 0.15) if len(actual) else np.nan,
            "p50_pinball": pinball_loss(actual, p50, 0.50) if len(actual) else np.nan,
            "p85_pinball": pinball_loss(actual, p85, 0.85) if len(actual) else np.nan,
            "interval_coverage": float(np.mean((actual >= p15) & (actual <= p85))) if len(actual) else np.nan,
            "mean_interval_width": float(np.mean(p85 - p15)) if len(actual) else np.nan,
            "actual_boom_rate": float(np.mean(actual >= 10)) if len(actual) else np.nan,
            "predicted_boom_rate": float(np.mean(point >= 10)) if len(actual) else np.nan,
            "rank_correlation": float(rank_correlation) if pd.notna(rank_correlation) else np.nan,
            "top_fifth_boom_capture": boom_capture,
            "missing_feature_rate": float(frame.get("missing_feature_count", pd.Series(0, index=frame.index)).gt(0).mean()) if len(frame) else np.nan,
        }

    rows = [one_frame(source, "all")]
    rows.extend(one_frame(group, str(season)) for season, group in source.groupby("season", sort=True))
    return pd.DataFrame(rows)


def fit_market_baseline(panel: pd.DataFrame) -> dict[str, object]:
    """Fit a leakage-free linear baseline from market and schedule fields."""

    required = [*TEAM_GAME_KEYS, "target"]
    require_columns(panel, required, "market baseline panel")
    candidate_columns = [
        "opponent_implied_team_total",
        "total_line",
        "dst_home_game",
        "rest_differential",
    ]
    available_columns = [column for column in candidate_columns if column in panel.columns]
    if not available_columns:
        return {"columns": [], "coefficients": [float(panel["target"].mean())], "fallback": True}
    source = panel.loc[:, [*TEAM_GAME_KEYS, "target", *available_columns]].drop_duplicates(list(TEAM_GAME_KEYS)).copy()
    for column in available_columns:
        source[column] = pd.to_numeric(source[column], errors="coerce")
    source["target"] = pd.to_numeric(source["target"], errors="coerce")
    source = source.dropna(subset=["target"])
    usable_columns = [column for column in available_columns if source[column].notna().any()]
    if not usable_columns or source.empty:
        return {"columns": [], "coefficients": [float(source["target"].mean()) if len(source) else 0.0], "fallback": True}
    source = source.dropna(subset=usable_columns)
    if len(source) < len(usable_columns) + 2:
        return {"columns": [], "coefficients": [float(source["target"].mean()) if len(source) else 0.0], "fallback": True}
    design = np.column_stack([np.ones(len(source)), source.loc[:, usable_columns].to_numpy(dtype=float)])
    coefficients, _, _, _ = np.linalg.lstsq(design, source["target"].to_numpy(dtype=float), rcond=None)
    return {
        "columns": usable_columns,
        "coefficients": coefficients.astype(float).tolist(),
        "fallback": False,
    }


def predict_market_baseline(frame: pd.DataFrame, model: dict[str, object]) -> np.ndarray:
    """Apply a market baseline, using its training mean when inputs are absent."""

    columns = [str(value) for value in model.get("columns", [])]
    coefficients = np.asarray(model.get("coefficients", [0.0]), dtype=float)
    if not columns or len(coefficients) != len(columns) + 1:
        return np.full(len(frame), float(coefficients[0]) if len(coefficients) else 0.0)
    values = frame.reindex(columns=columns).apply(pd.to_numeric, errors="coerce")
    valid = values.notna().all(axis=1)
    output = np.full(len(frame), float(coefficients[0]))
    if valid.any():
        design = np.column_stack([np.ones(int(valid.sum())), values.loc[valid].to_numpy(dtype=float)])
        output[valid.to_numpy()] = design @ coefficients
    return output


def evaluate_breakdowns(predictions: pd.DataFrame) -> pd.DataFrame:
    """Report point error by market, venue, and weather buckets."""

    require_columns(predictions, ["season", "dst_fd_pts", "dst_point"], "DST predictions")
    source = predictions.copy()
    source["actual"] = pd.to_numeric(source["dst_fd_pts"], errors="coerce")
    source["point"] = pd.to_numeric(source["dst_point"], errors="coerce")
    source = source.dropna(subset=["actual", "point"])
    if source.empty:
        return pd.DataFrame(columns=["breakdown", "bucket", "rows", "games", "rmse", "mae", "bias", "market_baseline_rmse"])

    def column_or_missing(name: str) -> pd.Series:
        if name in source.columns:
            return source[name]
        return pd.Series(np.nan, index=source.index)

    opponent_total = pd.to_numeric(column_or_missing("opponent_implied_team_total"), errors="coerce")
    source["opponent_total_bucket"] = pd.cut(
        opponent_total,
        bins=[-np.inf, 20.0, 24.0, 28.0, 32.0, np.inf],
        labels=["<20", "20-24", "24-28", "28-32", "32+"],
    ).astype("string").fillna("missing")
    source["home_bucket"] = pd.to_numeric(column_or_missing("dst_home_game"), errors="coerce").map(
        {0.0: "away", 1.0: "home"}
    ).fillna("missing")
    source["roof_bucket"] = column_or_missing("roof").astype("string").str.lower().fillna("missing")
    wind = pd.to_numeric(column_or_missing("wind"), errors="coerce")
    source["wind_bucket"] = pd.cut(
        wind,
        bins=[-np.inf, 15.0, 20.0, np.inf],
        labels=["low_or_missing", "moderate", "high"],
    ).astype("string").fillna("missing")

    output: list[dict[str, object]] = []
    for breakdown, column in [
        ("opponent_total", "opponent_total_bucket"),
        ("home_status", "home_bucket"),
        ("roof", "roof_bucket"),
        ("wind", "wind_bucket"),
    ]:
        for bucket, group in source.groupby(column, dropna=False, sort=True, observed=True):
            error = group["point"] - group["actual"]
            row: dict[str, object] = {
                "breakdown": breakdown,
                "bucket": str(bucket),
                "rows": int(len(group)),
                "games": int(group["game_id"].nunique()) if "game_id" in group.columns else np.nan,
                "rmse": float(np.sqrt(np.mean(error**2))),
                "mae": float(np.mean(np.abs(error))),
                "bias": float(np.mean(error)),
                "market_baseline_rmse": np.nan,
            }
            if "market_baseline" in group.columns:
                market = pd.to_numeric(group["market_baseline"], errors="coerce")
                valid = market.notna()
                if valid.any():
                    row["market_baseline_rmse"] = float(np.sqrt(np.mean((market[valid] - group.loc[valid, "actual"]) ** 2)))
            output.append(row)
    return pd.DataFrame(output)


def _r2(actual: np.ndarray, predicted: np.ndarray) -> float:
    if len(actual) == 0:
        return np.nan
    total = np.sum((actual - np.mean(actual)) ** 2)
    return float(1.0 - np.sum((predicted - actual) ** 2) / total) if total > 0 else np.nan


def validate_panel(panel: pd.DataFrame) -> dict[str, object]:
    """Validate keys, feature completeness, target timing, and null rates."""

    require_columns(panel, [*SCENARIO_KEYS, "target", *FEATURE_COLUMNS], "DST scenario panel")
    assert_unique(panel, SCENARIO_KEYS, "DST scenario panel")
    if "target_available" in panel.columns and panel["target_available"].astype(bool).any():
        unavailable_target = panel.loc[panel["target_available"].astype(bool), "target"].isna().sum()
        if unavailable_target:
            raise ValueError(f"{unavailable_target:,} available target rows have missing labels")
    if "game_date_time" in panel.columns and "feature_as_of" in panel.columns:
        timing = pd.to_datetime(panel["feature_as_of"], errors="coerce") > pd.to_datetime(panel["game_date_time"], errors="coerce")
        if timing.fillna(False).any():
            raise ValueError("Feature as-of timestamps occur after kickoff")
    null_rates = panel.loc[:, FEATURE_COLUMNS].isna().mean().sort_values(ascending=False)
    qb_history = panel.get("opponent_qb_history_available", pd.Series(0, index=panel.index))
    return {
        "rows": int(len(panel)),
        "games": int(panel["game_id"].nunique()),
        "seasons": sorted(int(value) for value in pd.to_numeric(panel["season"], errors="coerce").dropna().unique()),
        "simulations": int(panel["simulation_id"].nunique()),
        "missing_feature_rows": int(panel.loc[:, FEATURE_COLUMNS].isna().any(axis=1).sum()),
        "missing_feature_rate": float(panel.loc[:, FEATURE_COLUMNS].isna().any(axis=1).mean()) if len(panel) else np.nan,
        "qb_history_available_rate": float(pd.to_numeric(qb_history, errors="coerce").fillna(0).mean()) if len(panel) else np.nan,
        "feature_null_rates": {str(key): float(value) for key, value in null_rates.items()},
    }
