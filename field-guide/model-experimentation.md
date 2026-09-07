# Direct P15 and P85 Model Experiments and SHAP

## Rule

Keep direct projection-based P15 and P85 experiments separate from the
rank-conditioned simulation baseline. Train and evaluate one quantile model per
position with season-level walk-forward splits, then compare each position
against the baseline with the matching coverage and pinball loss.

## Why

Positions have different scoring distributions and different relationships
between projected opportunity and realized fantasy points. A direct model can
improve ranking while damaging p85 coverage. A separate experiment boundary
keeps that tradeoff visible and prevents an uncalibrated candidate from
changing the production path.

## Apply This When

- Testing a direct P15 or P85 model with Footballguys or another projection source.
- Adding raw stat projections or derived projection features to a floor or ceiling model.
- Tuning an XGBoost quantile model or selecting a position-specific model.
- Explaining a saved tree model with SHAP before using its features to guide
  product changes.

## Preferred Shape

- Build the modeling panel with the explicit key
  `season`, `week`, `fbg_id`, and `position`. Select the intended Footballguys
  set by `set_id` through
  `backtest_fbg_2023_2025/data/derived/fbg_set_selection.csv`, then filter to
  QB, RB, WR, and TE and remove free-agent rows.
- Use realized weekly `actual_score` as the target and the matching quantile
  objective. Use `quantile_alpha = 0.15` for a floor and `0.85` for a ceiling.
  Keep actual outcomes, player identifiers, names, teams, and target-season
  rows out of the feature set.
- Use one model per position. Tune settings on a validation slice from the
  latest training season, refit on prior seasons, and score later seasons out
  of sample. Use a bounded, reproducible grid with fixed seeds.
- Audit features before fitting. Remove one member of any exact duplicate pair
  before interpreting feature importance. Keep raw projection stats and any
  derived point estimate clearly named so their source and scoring formula are
  traceable.
- Write separate model files, selected settings, predictions, metrics,
  calibration summaries, and a run manifest under an experiment-specific
  output directory. Compare a P85 candidate with P85 coverage, P85 pinball
  loss, bias, rank correlation, and boom capture. Compare a P15 candidate with
  P15 coverage, P15 pinball loss, bias, rank correlation, and bust capture.
- For XGBoost explanations, use `shap.TreeExplainer` on raw model output.
  Write global mean absolute importance, low and high feature direction,
  local waterfall data, and additivity checks. Treat SHAP as model association,
  not causal evidence.

## Limits

Two target seasons are useful for a screening experiment but do not establish
long-term forecast quality. Keep the baseline as the production control until
the candidate is stable across more seasons and improves the relevant quantile
scorecard without materially moving coverage away from its target.

Correlated features can share attribution, and exact duplicates can split it
arbitrarily. Do not interpret an individual SHAP value from a duplicate pair.
Inspect unusual directions, such as a negative football interpretation that
the model maps to a positive p85 contribution, as stability questions.

## Related Code or Enforcement

- `backtest_fbg_2023_2025/scripts/08_xgb_p85_projection_experiment.py`
- `backtest_fbg_2023_2025/scripts/08_xgb_p15_projection_experiment.py`
- `backtest_fbg_2023_2025/scripts/09_explain_xgb_p85_shap.py`
- `backtest_fbg_2023_2025/scripts/09_explain_xgb_p15_shap.py`
- `backtest_fbg_2023_2025/scripts/requirements-xgb.txt`
- `backtest_fbg_2023_2025/README.md`
- `backtest_fbg_2023_2025/outputs/xgb_p85_projection/metrics.csv`
- `backtest_fbg_2023_2025/outputs/xgb_p85_projection/selected_models.csv`
- `backtest_fbg_2023_2025/outputs/xgb_p85_projection/shap/model_checks.csv`
- `backtest_fbg_2023_2025/outputs/xgb_p15_projection/metrics.csv`
- `backtest_fbg_2023_2025/outputs/xgb_p15_projection/selected_models.csv`
- `backtest_fbg_2023_2025/outputs/xgb_p15_projection/shap/model_checks.csv`
- `.agent-sessions/2026-09-04-xgb-p85-projection.md`
- `.agent-sessions/2026-09-04-xgb-p85-shap.md`
