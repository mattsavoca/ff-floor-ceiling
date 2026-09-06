"""Explain the direct XGBoost PPR p85 models with Tree SHAP.

The experiment models raw PPR p85 points. This script explains those point
predictions with exact tree attributions for each position and target season.
It does not explain probabilities or make causal claims.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path
from typing import Any

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import shap
import xgboost as xgb

SCORING_FORMAT = "PPR"
SCORING_CONTRACT_VERSION = "ppr_v1"


def load_experiment_module(root: Path) -> Any:
    """Load the shared p85 experiment helpers."""
    script_path = root / "backtest_fbg_2023_2025" / "scripts" / "08_xgb_p85_projection_experiment.py"
    spec = importlib.util.spec_from_file_location("xgb_p85_experiment", script_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot load experiment helpers from {script_path}.")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def parse_args() -> argparse.Namespace:
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--target-seasons",
        default="2024,2025",
        help="Comma-separated target seasons to explain.",
    )
    parser.add_argument(
        "--sample-size",
        type=int,
        default=1500,
        help="Maximum target rows used for each plot.",
    )
    parser.add_argument(
        "--top-features",
        type=int,
        default=10,
        help="Number of features shown in summary plots.",
    )
    args = parser.parse_args()
    args.target_seasons = tuple(
        sorted({int(value.strip()) for value in args.target_seasons.split(",") if value.strip()})
    )
    if not args.target_seasons:
        parser.error("--target-seasons must contain at least one season.")
    if args.sample_size < 50:
        parser.error("--sample-size must be at least 50.")
    if args.top_features < 1:
        parser.error("--top-features must be positive.")
    return args


def save_plot(path: Path) -> None:
    """Save and close the current matplotlib figure."""
    plt.savefig(path, dpi=180, bbox_inches="tight")
    plt.close("all")


def high_low_direction(values: pd.Series, shap_values: np.ndarray) -> dict[str, float | str]:
    """Summarize SHAP direction at low and high feature values."""
    numeric = pd.to_numeric(values, errors="coerce").to_numpy(dtype=float)
    valid = np.isfinite(numeric) & np.isfinite(shap_values)
    if not valid.any():
        return {
            "low_value": np.nan,
            "high_value": np.nan,
            "low_mean_shap": np.nan,
            "high_mean_shap": np.nan,
            "direction": "unavailable",
        }
    numeric = numeric[valid]
    contributions = shap_values[valid]
    low_cutoff, high_cutoff = np.quantile(numeric, [0.20, 0.80])
    low_mask = numeric <= low_cutoff
    high_mask = numeric >= high_cutoff
    low_mean = float(np.mean(contributions[low_mask]))
    high_mean = float(np.mean(contributions[high_mask]))
    if high_mean - low_mean > 0.10:
        direction = "higher values push p85 higher"
    elif low_mean - high_mean > 0.10:
        direction = "higher values push p85 lower"
    else:
        direction = "nonlinear or weak direction"
    return {
        "low_value": float(np.mean(numeric[low_mask])),
        "high_value": float(np.mean(numeric[high_mask])),
        "low_mean_shap": low_mean,
        "high_mean_shap": high_mean,
        "direction": direction,
    }


def importance_rows(
    explanation: shap.Explanation,
    frame: pd.DataFrame,
    position: str,
    target_season: int,
) -> pd.DataFrame:
    """Build global mean absolute and signed SHAP summaries."""
    values = np.asarray(explanation.values, dtype=float)
    rows = []
    for index, feature in enumerate(explanation.feature_names):
        direction = high_low_direction(frame[feature], values[:, index])
        rows.append(
            {
                "target_season": target_season,
                "position": position,
                "scoring_format": SCORING_FORMAT,
                "scoring_contract_version": SCORING_CONTRACT_VERSION,
                "feature": feature,
                "mean_abs_shap": float(np.mean(np.abs(values[:, index]))),
                "mean_shap": float(np.mean(values[:, index])),
                "median_abs_shap": float(np.median(np.abs(values[:, index]))),
                "feature_mean": float(pd.to_numeric(frame[feature], errors="coerce").mean()),
                "feature_median": float(pd.to_numeric(frame[feature], errors="coerce").median()),
                **direction,
            }
        )
    output = pd.DataFrame(rows)
    output["importance_rank"] = output["mean_abs_shap"].rank(method="first", ascending=False).astype(int)
    return output.sort_values("importance_rank")


def local_rows(
    explanation: shap.Explanation,
    frame: pd.DataFrame,
    target: pd.DataFrame,
    position: str,
    target_season: int,
    local_type: str,
    row_index: int,
    top_features: int,
) -> pd.DataFrame:
    """Build feature-level rows for one local waterfall explanation."""
    values = np.asarray(explanation.values[row_index], dtype=float)
    base_value = float(np.asarray(explanation.base_values[row_index]).reshape(-1)[0])
    prediction = float(base_value + values.sum())
    order = np.argsort(-np.abs(values))[:top_features]
    rows = []
    for feature_index in order:
        feature = explanation.feature_names[feature_index]
        rows.append(
            {
                "target_season": target_season,
                "position": position,
                "local_type": local_type,
                "fbg_id": str(target.iloc[row_index]["fbg_id"]),
                "player_name": str(target.iloc[row_index].get("player_name", "")),
                "actual_score": float(target.iloc[row_index]["actual_score"]),
                "scoring_format": SCORING_FORMAT,
                "scoring_contract_version": SCORING_CONTRACT_VERSION,
                "baseline_p85": float(target.iloc[row_index]["p85"]),
                "model_p85": prediction,
                "base_value": base_value,
                "feature": feature,
                "feature_value": float(frame.iloc[row_index][feature]),
                "shap_value": float(values[feature_index]),
            }
        )
    return pd.DataFrame(rows)


def write_summary(
    output_dir: Path,
    importance: pd.DataFrame,
    metadata: dict[str, Any],
) -> None:
    """Write a compact Markdown summary from the SHAP results."""
    lines = [
        "# SHAP explanation for direct XGBoost p85 models",
        "",
        "The model output is raw PPR p85 points. SHAP values use the same unit.",
        "Positive values increase the predicted p85. Negative values decrease it.",
        "SHAP shows model association. It does not show causation.",
        "",
        "## Global drivers",
        "",
        "| Target season | Position | Feature | Mean absolute SHAP | Direction |",
        "| --- | --- | --- | ---: | --- |",
    ]
    top = importance[importance["importance_rank"] <= 5]
    for row in top.itertuples(index=False):
        lines.append(
            f"| {row.target_season} | {row.position} | `{row.feature}` | "
            f"{row.mean_abs_shap:.3f} | {row.direction} |"
        )
    lines.extend(
        [
            "",
            "## Method",
            "",
            f"- Explainer: `TreeExplainer` with tree-path-dependent perturbation.",
            f"- Models explained: {metadata['models_explained']}.",
            f"- Held-out rows explained: {metadata['rows_explained']:,}.",
            f"- Maximum additivity error: {metadata['max_additivity_error']:.8f} points.",
            "- `consensus_projected_score` and `projection_fpts` are exact duplicate inputs in this dataset. Interpret their combined importance. Do not interpret either column's split as a unique effect.",
            "- Correlated projection features can share or split attribution.",
        ]
    )
    (output_dir / "summary.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def run(args: argparse.Namespace) -> None:
    """Run SHAP explanations for every selected target model."""
    root = Path(__file__).resolve().parents[2]
    base_output = root / "backtest_fbg_2023_2025" / "outputs" / "xgb_p85_projection"
    output_dir = base_output / "shap"
    output_dir.mkdir(parents=True, exist_ok=True)
    plot_dir = output_dir / "plots"
    plot_dir.mkdir(parents=True, exist_ok=True)

    experiment = load_experiment_module(root)
    data, _ = experiment.build_dataset(root)
    if experiment.SCORING_FORMAT != SCORING_FORMAT or experiment.SCORING_CONTRACT_VERSION != SCORING_CONTRACT_VERSION:
        raise ValueError("SHAP and XGBoost scoring contracts do not match.")
    experiment.require_ppr_artifact(data, "XGBoost SHAP dataset")
    names = pd.read_parquet(
        root / "backtest_fbg_2023_2025" / "data" / "derived" / "fbg_rank_summary.parquet",
        columns=[*experiment.KEY_COLUMNS, "player_name"],
    )
    data = data.merge(names, on=list(experiment.KEY_COLUMNS), how="left", validate="one_to_one")
    selected_models = pd.read_csv(base_output / "selected_models.csv")
    selected_models = selected_models[selected_models["target_season"].isin(args.target_seasons)]
    if selected_models.empty:
        raise ValueError("No selected models match the requested target seasons.")

    importance_parts = []
    local_parts = []
    model_checks = []
    for model_row in selected_models.sort_values(["target_season", "position"]).itertuples(index=False):
        target_season = int(model_row.target_season)
        position = str(model_row.position)
        model_path = base_output / "models" / f"xgb_p85_{position.lower()}_through_{target_season - 1}.json"
        target = data[
            data["season"].eq(target_season) & data["position"].eq(position)
        ].sort_values(list(experiment.KEY_COLUMNS)).reset_index(drop=True)
        features = [value for value in str(model_row.features).split(",") if value]
        experiment.assert_feature_columns(features)
        X = target[features].astype(float)
        model = xgb.Booster()
        model.load_model(str(model_path))
        explainer = shap.TreeExplainer(
            model,
            feature_perturbation="tree_path_dependent",
            model_output="raw",
        )
        explanation = explainer(X, check_additivity=False)
        model_prediction = model.predict(xgb.DMatrix(X, feature_names=features))
        explained_prediction = np.asarray(explanation.base_values).reshape(-1) + explanation.values.sum(axis=1)
        additivity_error = float(np.max(np.abs(explained_prediction - model_prediction)))
        importance = importance_rows(explanation, X, position, target_season)
        importance_parts.append(importance)

        sample_size = min(args.sample_size, len(X))
        sample_index = np.random.default_rng(20260904 + target_season).choice(
            len(X), size=sample_size, replace=False
        )
        plot_explanation = explanation[sample_index]
        top_features = importance.head(args.top_features)["feature"].tolist()
        label = f"{position} target {target_season}"

        shap.plots.beeswarm(plot_explanation, max_display=args.top_features, show=False)
        plt.title(f"SHAP beeswarm, {label}")
        save_plot(plot_dir / f"beeswarm_{position.lower()}_{target_season}.png")

        shap.plots.bar(plot_explanation, max_display=args.top_features, show=False)
        plt.title(f"Mean absolute SHAP, {label}")
        save_plot(plot_dir / f"bar_{position.lower()}_{target_season}.png")

        for feature in top_features[:3]:
            shap.plots.scatter(plot_explanation[:, feature], show=False)
            plt.title(f"SHAP dependence, {feature}, {label}")
            safe_feature = feature.replace("-", "_")
            save_plot(plot_dir / f"dependence_{position.lower()}_{target_season}_{safe_feature}.png")

        top_row_index = int(np.argmax(model_prediction))
        shap.plots.waterfall(explanation[top_row_index], max_display=args.top_features, show=False)
        plt.title(f"Highest model p85, {label}")
        save_plot(plot_dir / f"waterfall_highest_{position.lower()}_{target_season}.png")
        local_parts.append(
            local_rows(
                explanation,
                X,
                target,
                position,
                target_season,
                "highest_model_p85",
                top_row_index,
                args.top_features,
            )
        )

        underprediction_index = int(np.argmax(target["actual_score"].to_numpy() - model_prediction))
        shap.plots.waterfall(explanation[underprediction_index], max_display=args.top_features, show=False)
        plt.title(f"Largest actual minus model p85, {label}")
        save_plot(plot_dir / f"waterfall_underprediction_{position.lower()}_{target_season}.png")
        local_parts.append(
            local_rows(
                explanation,
                X,
                target,
                position,
                target_season,
                "largest_actual_minus_model_p85",
                underprediction_index,
                args.top_features,
            )
        )
        model_checks.append(
            {
                "target_season": target_season,
                "position": position,
                "rows": len(target),
                "features": len(features),
                "base_value": float(np.asarray(explanation.base_values).reshape(-1)[0]),
                "mean_model_p85": float(np.mean(model_prediction)),
                "max_additivity_error": additivity_error,
            }
        )
        print(
            f"{label}: {len(target):,} rows, top feature {importance.iloc[0]['feature']}, "
            f"mean abs SHAP {importance.iloc[0]['mean_abs_shap']:.3f}.",
            flush=True,
        )

    importance = pd.concat(importance_parts, ignore_index=True)
    local = pd.concat(local_parts, ignore_index=True)
    checks = pd.DataFrame(model_checks)
    metadata = {
        "scoring_format": SCORING_FORMAT,
        "scoring_contract_version": SCORING_CONTRACT_VERSION,
        "explainer": "shap.TreeExplainer",
        "feature_perturbation": "tree_path_dependent",
        "model_output": "raw PPR p85 points",
        "models_explained": int(len(checks)),
        "rows_explained": int(checks["rows"].sum()),
        "max_additivity_error": float(checks["max_additivity_error"].max()),
        "target_seasons": list(args.target_seasons),
        "max_historical_season_used": int(max(args.target_seasons) - 1),
        "feature_leakage_check": "passed",
        "plot_sample_size": args.sample_size,
        "top_features": args.top_features,
        "shap_version": shap.__version__,
        "xgboost_version": xgb.__version__,
        "model_checks": checks.to_dict(orient="records"),
    }
    importance.to_csv(output_dir / "global_importance.csv", index=False)
    local.to_csv(output_dir / "local_explanations.csv", index=False)
    checks.to_csv(output_dir / "model_checks.csv", index=False)
    (output_dir / "metadata.json").write_text(
        json.dumps(metadata, indent=2), encoding="utf-8"
    )
    write_summary(output_dir, importance, metadata)
    print(f"Wrote SHAP artifacts to {output_dir}", flush=True)


if __name__ == "__main__":
    run(parse_args())
