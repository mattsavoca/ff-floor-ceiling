# XGBoost p85 projection experiment

## Objective

Test a separate direct p85 model that uses Footballguys projection data. Train
one XGBoost quantile model for each of QB, RB, WR, and TE. Compare it with the
current rank-conditioned simulation ceiling.

## Repository context

The field-guide entries that shaped this work were:

- `field-guide/architecture.md`, which keeps player ranges separate from
  downstream team and game outputs.
- `field-guide/backtesting.md`, which requires prior-season data, explicit
  quantile definitions, and position-level calibration.
- `field-guide/testing.md`, which requires focused tests and output checks.
- `field-guide/recurring-problems.md`, which documents rank uncertainty,
  Monte Carlo noise, and calibration limits.
- `field-guide/tooling.md`, which defines the Windows R and backtest paths.

The current baseline uses rank-conditioned historical outcomes. It stores the
FBG consensus projected score but does not fit a direct model from raw stat
projections.

## Decisions

- Use XGBoost `reg:quantileerror` with `quantile_alpha = 0.85`.
- Use p85 pinball loss for early stopping and grid selection.
- Use raw FBG consensus stat projections, derived FFFL projection points, rank
  summary fields, and week number as inputs.
- Exclude player IDs, names, teams, actual outcomes, and target-season rows
  from features.
- Select grid settings on weeks 14 through 17 of the latest training season.
- Refit the selected settings on all prior-season rows before scoring the next
  season.
- Treat 2023 as a warm-up season because earlier FBG projection files are not
  cached. Score 2024 and 2025 out of sample.
- Use a 144-candidate grid for each position and target season.
- Keep the new output separate from the production baseline.

## Corrections during implementation

The raw FBG files contain repeated set names with different set IDs. The first
loader would have mixed the selected consensus set with a smaller unselected
set. The loader now uses `data/derived/fbg_set_selection.csv` and filters out
free-agent rows, matching the existing panel builder.

The derived projection score was checked against
`consensus_projected_score`. The maximum absolute difference was zero.

## Implementation

- Added `backtest_fbg_2023_2025/scripts/08_xgb_p85_projection_experiment.py`.
- Added `backtest_fbg_2023_2025/scripts/requirements-xgb.txt`.
- Added the direct XGBoost experiment section to
  `backtest_fbg_2023_2025/README.md`.
- Wrote model files, selected settings, grid results, predictions, calibration,
  boom capture, feature importance, metrics, and metadata under
  `backtest_fbg_2023_2025/outputs/xgb_p85_projection/`.

## Verification

Commands and results:

- Python syntax check: passed.
- One-candidate smoke run for 2024: passed for all four positions.
- Full run: 1,152 fits, 8 selected models, 9,390 OOS prediction rows.
- Projection join: 14,985 of 14,985 keys matched.
- OOS prediction keys: unique.
- OOS prediction values: finite and nonnegative.
- Backtest tests: 42 passed, 0 failed.
- Package tests: 47 passed, 0 failed.

## Results

Combined 2024 and 2025 OOS p85 results:

| Position | Model | Rows | Coverage | Pinball | Bias | Rank Spearman |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| QB | Simulation baseline | 987 | 0.840 | 1.986 | 8.719 | 0.126 |
| QB | XGBoost projection | 987 | 0.775 | 2.018 | 6.463 | 0.242 |
| RB | Simulation baseline | 2,478 | 0.878 | 1.824 | 7.494 | 0.548 |
| RB | XGBoost projection | 2,478 | 0.849 | 1.564 | 5.216 | 0.680 |
| TE | Simulation baseline | 2,282 | 0.871 | 1.618 | 6.175 | 0.510 |
| TE | XGBoost projection | 2,282 | 0.843 | 1.426 | 4.751 | 0.599 |
| WR | Simulation baseline | 3,643 | 0.895 | 1.917 | 8.762 | 0.425 |
| WR | XGBoost projection | 3,643 | 0.853 | 1.697 | 6.062 | 0.524 |

The direct model improves pinball loss for RB, WR, and TE. It reduces their
baseline overcoverage and improves p85 rank correlation. QB coverage and
pinball loss are worse, although QB p85 rank correlation and absolute error
improve. The experiment does not support a full replacement yet.

## Field-guide review status

The durable experiment workflow was consolidated in
`field-guide/model-experimentation.md` on 2026-09-06. The mixed position
results and current QB limitation remain specific to this session.

No commit was created.
