"""Compare canonical and repeated seeded ffsimulator and XGBoost outputs."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pandas as pd

def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def compare_team_draw_content(canonical: Path, repeat: Path) -> dict[str, object]:
    """Compare the raw repeated draws with the scheduled canonical subset.

    The team stage adds schedule-complete rows and therefore has a different
    row set from the raw player-stage team draw file. The shared rows must
    still match exactly.
    """
    canonical_frame = pd.read_parquet(canonical)
    repeat_frame = pd.read_parquet(repeat)
    keys = ["season", "week", "simulation_id", "team"]
    canonical_keys = canonical_frame[keys].drop_duplicates()
    repeat_keys = repeat_frame[keys].drop_duplicates()
    common_keys = canonical_keys.merge(repeat_keys, on=keys, how="inner", validate="one_to_one")
    canonical_common = canonical_frame.merge(common_keys, on=keys, how="inner", validate="one_to_one")
    repeat_common = repeat_frame.merge(common_keys, on=keys, how="inner", validate="one_to_one")
    columns = sorted(set(canonical_common.columns).intersection(repeat_common.columns))
    canonical_common = canonical_common[columns].sort_values(keys).reset_index(drop=True)
    repeat_common = repeat_common[columns].sort_values(keys).reset_index(drop=True)
    if not canonical_common.equals(repeat_common):
        raise AssertionError("Common team-draw rows changed on repeat.")
    return {
        "row_scope": "shared scheduled team-draw rows",
        "canonical_rows": int(len(canonical_frame)),
        "repeat_rows": int(len(repeat_frame)),
        "common_rows": int(len(common_keys)),
        "repeat_only_rows": int(len(repeat_keys) - len(common_keys)),
        "match": True,
    }


def main() -> None:
    output = Path(__file__).resolve().parents[1] / "outputs"
    tag = "_repro"
    pairs = [
        ("player_predictions.parquet", f"player_predictions{tag}.parquet"),
        ("team_draws.parquet", f"team_draws{tag}.parquet"),
        ("fbg_player_draws.parquet", f"fbg_player_draws{tag}.parquet"),
        ("player_run_metrics.csv", f"player_run_metrics{tag}.csv"),
    ]
    comparisons = []
    for canonical_name, repeat_name in pairs:
        canonical = output / canonical_name
        repeat = output / repeat_name
        if not canonical.exists() or not repeat.exists():
            raise FileNotFoundError(f"Missing reproducibility file pair: {canonical_name}, {repeat_name}")
        if canonical_name == "team_draws.parquet":
            comparison = compare_team_draw_content(canonical, repeat)
            comparison.update(
                {
                    "canonical": canonical_name,
                    "repeat": repeat_name,
                    "canonical_sha256": sha256(canonical),
                    "repeat_sha256": sha256(repeat),
                }
            )
            comparisons.append(comparison)
            continue
        canonical_hash = sha256(canonical)
        repeat_hash = sha256(repeat)
        comparisons.append(
            {
                "canonical": canonical_name,
                "repeat": repeat_name,
                "canonical_sha256": canonical_hash,
                "repeat_sha256": repeat_hash,
                "match": canonical_hash == repeat_hash,
            }
        )
    xgb_comparisons = []
    xgb_a = output / "xgb_p85_repro_a"
    xgb_b = output / "xgb_p85_repro_b"
    xgb_files = [
        "predictions.parquet",
        "selected_models.csv",
        "grid_results.csv",
        "feature_importance.csv",
        "metrics.csv",
        "boom_capture.csv",
        "p85_calibration.csv",
    ]
    for name in xgb_files:
        left = xgb_a / name
        right = xgb_b / name
        if not left.exists() or not right.exists():
            raise FileNotFoundError(f"Missing XGBoost reproducibility file pair: {name}")
        left_hash = sha256(left)
        right_hash = sha256(right)
        xgb_comparisons.append(
            {
                "canonical": str(left.relative_to(output)),
                "repeat": str(right.relative_to(output)),
                "canonical_sha256": left_hash,
                "repeat_sha256": right_hash,
                "match": left_hash == right_hash,
            }
        )
    for left in sorted((xgb_a / "models").glob("*.json")):
        right = xgb_b / "models" / left.name
        if not right.exists():
            raise FileNotFoundError(f"Missing repeated XGBoost model: {right}")
        left_hash = sha256(left)
        right_hash = sha256(right)
        xgb_comparisons.append(
            {
                "canonical": str(left.relative_to(output)),
                "repeat": str(right.relative_to(output)),
                "canonical_sha256": left_hash,
                "repeat_sha256": right_hash,
                "match": left_hash == right_hash,
            }
        )
    passed = all(item["match"] for item in comparisons + xgb_comparisons)
    receipt = {
        "status": "passed" if passed else "failed",
        "seed_policy": "100000 + target_season * 100 + target_week",
        "repeat_output_tag": tag,
        "comparisons": comparisons,
        "xgb_smoke_comparisons": xgb_comparisons,
    }
    (output / "reproducibility_check.json").write_text(
        json.dumps(receipt, indent=2), encoding="utf-8"
    )
    if not passed:
        raise AssertionError("At least one seeded model output changed on repeat.")
    print("Seeded ffsimulator output hashes match.")


if __name__ == "__main__":
    main()
