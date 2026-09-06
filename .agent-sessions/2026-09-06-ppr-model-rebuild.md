# PPR offensive-model rebuild

Date: 2026-09-06  
Branch: master  
Status: Complete

## Objective

Rebuild the historical `ffsimulator` floor and ceiling model and the direct
XGBoost P85 model under one validated standard PPR scoring contract. Preserve
the prior FFFL output in a recoverable local backup. Update the calibration
page with generated PPR evidence.

## Decisions

- Use nflreadr `fantasy_points_ppr` as the raw outcome field.
- Enforce 1 point per reception, no tight-end reception bonus, and no
  receiving first-down points.
- Build one scoring-history document per target season. Every history row must
  have `season < target_season`.
- Keep the existing ffsimulator settings: 1,000 simulations, rank SD
  multiplier 0.5, QB conditioning strength 0, and the existing seed formula.
- Train XGBoost P85 models for QB, RB, WR, and TE with season-level
  walk-forward splits. Remove receiving first downs from active features.
- Keep PPR score parity fields and leakage metadata in generated artifacts.
- Define a low-side miss as an actual score below p15. XGBoost has no lower
  bound, so its low-side and interval metrics remain unavailable.

## Implementation

- Added PPR scoring validation and raw-field parity checks in `R/scoring.R`.
- Added strict scoring-history cutoff checks and target-specific history files.
- Rebuilt the player panel, ffsimulator outcome pools, player draws, team
  artifacts, interval metrics, tail metrics, and charts.
- Added rich XGBoost metrics, model metadata, walk-forward checks, and final
  Tree SHAP artifacts.
- Added generated calibration-page data and a plain-language calibration page.
- Added full validation and reproducibility scripts:
  `scripts/10_build_calibration_page_data.py`,
  `scripts/11_validate_ppr_run.py`, and
  `scripts/12_check_reproducibility.py`.
- Added `scripts/run_ppr_all.ps1` as the complete rerun entry point.

## Validation

- Raw parity: 76,244 rows across 2012 through 2025. Maximum difference from
  `fantasy_points + receptions`: `3.55e-15`. Receiving first-down points used:
  0. Tight-end reception bonus used: 0.
- Scoring history: target 2023 uses through 2022, target 2024 uses through
  2023, and target 2025 uses through 2024. All leakage flags are false.
- XGBoost: eight final fits, with `features_contain_outcomes: false` and PPR
  metadata on every model record.
- Reproducibility: canonical ffsimulator outputs and the two XGBoost smoke
  runs match under their seeded comparison rules.
- Python tests: 14 passed.
- R helper tests: passed.
- Web checks: typecheck, lint, and production build passed.
- Validation command: `python scripts/11_validate_ppr_run.py` reported
  `All PPR validation gates passed.`
- The validation gate checks the lower-bound metric rule and the full metric
  column set.

## Outputs

- Prior FFFL outputs: `backtest_fbg_2023_2025/outputs/legacy_fffl_2026-09-06/`
- PPR player metrics:
  `backtest_fbg_2023_2025/outputs/player_scorecard_metrics.csv`
- PPR XGBoost metrics:
  `backtest_fbg_2023_2025/outputs/xgb_p85_projection/metrics.csv`
- PPR XGBoost metadata:
  `backtest_fbg_2023_2025/outputs/xgb_p85_projection/metadata.json`
- Reproducibility receipt:
  `backtest_fbg_2023_2025/outputs/reproducibility_check.json`
- Calibration page data: `web/lib/calibration-data.ts`
- Rendered charts: `backtest_fbg_2023_2025/outputs/plots/`

## Field-guide review

No permanent field-guide rule was changed. The session log preserves the
implementation and validation evidence for later review.
