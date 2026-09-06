# Team defense XGBoost rebuild PRD

## Objective

Assess whether the team defense model from
`mattsavoca/rostership-model-4for4` can fit this repository. Document the ETL,
feature data, historical backtest plan, forward plan, and Python XGBoost design.

## Repository context

- The upstream repository is private and was inspected through the user’s
  authenticated GitHub CLI session.
- The upstream DST artifacts are R `tidymodels` workflows with embedded data
  and XGBoost boosters.
- The local player adapter keeps `QB`, `RB`, `WR`, and `TE`.
- The sibling `ffsimulator` package accepts `QB`, `RB`, `WR`, `TE`, and `K`.
- The local backtest cache has no play-by-play data.
- The local FBG fixture contains `td` rows and `tmd-*` fields.

## Decisions

- Treat the upstream repository as a reference implementation and parity
  source, not as a runtime dependency.
- Build a separate team-game prediction table before extending the player
  outcome sampler.
- Use canonical `DST` identity and accept `TD` as a provider alias.
- Rebuild the target and features in Python with explicit pregame as-of rules.
- Use grouped temporal splits by `game_id`.
- Use native XGBoost with `DMatrix`, `hist`, early stopping, and saved model
  metadata.
- Evaluate a point model before adding direct `p15`, `p50`, and `p85` models.

## Audit findings

- The upstream training ETL derives retained `sim_*` values from realized
  same-week player statistics. The forward path uses projected values.
- The original 80/20 row split divides the two rows for
  `2021_02_MIN_ARI` between train and test.
- The upstream recipe uses `Sys.Date()` for `days_in_past`.
- The final upstream select assigns the same `rest` value to defense and
  opponent rest fields.
- The tuning function uses random 5-fold resampling and selects by R-squared.
- The upstream repository has no raw data cache or runnable model training
  script.
- The saved DK workflow has 5,414 raw rows, 32 model features, and 1,744
  boosting rounds. The FD workflow has 1,922 rounds.

## Output

- Added `docs/PRD_dst_xgboost_python_reimplementation.md`.
- The PRD records data dependencies, risks, proposed package layout, model
  modes, backtest metrics, acceptance criteria, integration phases, and effort.

## Verification

- Read the local `forward-implementation-first`, `xgboost`, and
  `xgboost-expert` guidance.
- Read the local technical writing, prose, and anti-slop guidance.
- Loaded the upstream DK artifact with R and inspected its data, recipe,
  feature names, metrics, and XGBoost booster.
- Checked the chronological split and found 1 shared game ID.
- Checked the raw target and retained offense feature correlation: `-0.786`.
- Checked the PRD for em dashes, semicolons, curly quotes, and selected banned
  words. All checks passed after revision.
- No commit was created.

## Implementation continuation

- Added `backtest_fbg_2023_2025/dst_xgb/` with ingestion, team keys, schedule
  orientation, PBP scoring, QB history, FBG scenario aggregation, feature
  contracts, XGBoost training, prediction, and evaluation modules.
- Added scripts `10_download_dst_data.py` through `14_score_dst_from_fbg_sims.py`.
- Added `simulation_to_player_draws()` to preserve the original R simulation
  matrix as scenario rows. The Python bridge rejects QB-conditioned experiment
  rows.
- Added an optional `DST_MODEL_DIR` bridge to `scripts/week1_2026.R`.
- Added Python and R tests for scoring, aliases, timing, split isolation, and
  draw-key stability.
- Installed and used `nflreadpy`, `polars`, and `pyarrow` for the expanded data
  path.

## Verification continuation

- Cached full 2023 to 2025 player statistics, schedules, rosters, players, and
  play-by-play under the ignored `data/raw/dst/` path.
- Built a PBP-backed panel with 30,718 rows from 768 regular-season games and
  20 original FBG simulations.
- Trained point and p15, p50, and p85 XGBoost models with native `DMatrix`.
- Ran 2024 and 2025 holdouts with game-disjoint temporal training.
- Ran the Week 1 R bridge and verified 3,200 DST rows, 32 teams, and one DST
  row for each simulation and team.
- Initial Python tests: 8 passed. R tests: all existing helper tests passed.
- No commit was created.

## Final implementation verification

- Added automatic prior-PBP discovery to the forward scorer, a visible QB
  history availability field, and an optional `DST_RAW_DIR` override for the
  Week 1 bridge.
- Added a leakage-free market baseline, error breakdowns by market, home
  status, roof, and wind, and separate quantile-round validation metadata.
- Set the default XGBoost thread count to a fixed four threads for repeatable
  runs.
- Rebuilt the final compact panel with 30,718 rows, 768 games, 20 original
  FBG simulations, 1,710 targets, and 96.1% QB-history availability.
- Final 2024 holdout RMSE was 7.450 versus 7.399 for the historical mean and
  6.860 for the market baseline. Final 2025 holdout RMSE was 7.696 versus
  7.889 for the historical mean and 7.389 for the market baseline.
- The forward batch smoke test loaded prior PBP seasons and produced 640
  unique DST rows for 20 simulations and 32 teams. The earlier Week 1 R
  bridge test produced 3,200 rows for 100 simulations and 32 teams.
- Final checks: 10 Python tests, all R helper tests, Python compilation, and
  Week 1 bridge parsing passed.
- The current local FBG export has no kicker rows. The K feature remains in
  the versioned contract and is zero-filled until the source simulator adds K
  outcomes.
- No commit was created.
