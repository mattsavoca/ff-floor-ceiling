# PRD: Rebuild the team defense XGBoost model in Python

**Status:** Implemented, with model promotion review still pending

**Date:** 2026-09-06

**Scope:** Historical backtesting and a forward team defense prediction path

**Decision:** Build this as a separate team-game model first. Do not add `DST`
to the current player outcome sampler until the data contract and forecast
quality pass the backtest.

## Decision summary

The work is feasible. A position filter change can recognize `DST` or `td`, but
that change does not create a usable defense model. Team defense is a team-game
outcome with a different target, data source, and simulation contract.

The work has medium to high difficulty. XGBoost training is a small part of the
work. The main effort is to rebuild historical play-by-play inputs, construct
the target, enforce pregame feature timing, and connect team defense predictions
to the existing team aggregation stage.

The upstream repository is useful as a reference implementation. It saves the
target formula, schedule orientation, defensive event logic, QB metrics, and
the final feature names. It does not provide the raw data, a runnable training
script, or a transformed training table. The new pipeline must therefore
recreate the data stages.

Estimated effort:

- A 2023 to 2025 proof of concept: 5 to 8 engineering days.
- A leakage-safe 2013 to 2025 backtest with a forward prediction bridge: 12 to
  20 engineering days.

The estimate assumes that the required NFL data exports remain available and
that the first release keeps the existing R player sampler unchanged.

## Implementation status

The first implementation is now under
`backtest_fbg_2023_2025/dst_xgb/`. It includes:

- a season-partitioned `nflreadpy` cache for full player statistics, schedules,
  rosters, players, and optional play-by-play.
- PBP target construction that follows the upstream event assignments and
  scoring buckets.
- one canonical defense-oriented team-game row per game.
- pregame QB EPA and CPOE history with a strict season and week cutoff.
- original FBG player-draw export from the R `ffsimulator` path.
- scenario offense aggregation from those draws.
- native Python XGBoost point and quantile models with game-grouped temporal
  validation.
- a backtest command and a forward scorer.
- an optional Week 1 R bridge that adds `DST` rows before team aggregation.

The forward scorer auto-discovers cached PBP seasons before the target season
for the QB history feature. It records whether that history was available on
each output row.

The bridge accepts only draw files marked `original_fbg`. The optional QB
conditioning experiment is rejected as a DST input. The verification used real
2023 to 2025 nflverse data, a compact panel with 20 original FBG simulations,
and a separate 100-simulation forward bridge. It produced one DST row for each
simulation and scheduled team.

The current local FBG draw export covers QB, RB, WR, and TE. The Python feature
contract keeps the upstream K slot, but `sim_k_fpts_share` is zero until the
local source simulator supplies kicker outcomes. This keeps the DST bridge on
the original simulation path and makes the limitation explicit in the model
metadata and feature specification.

## Goals

1. Build one canonical team-game panel for defense outcomes.
2. Recreate the upstream target and feature groups in Python.
3. Use only information available before kickoff for every forecast feature.
4. Run the same feature code for historical rows and forward rows.
5. Train native Python XGBoost models with the existing project’s walk-forward
   evaluation style.
6. Produce point and range predictions that the team aggregation stage can use.
7. Keep the current skill-position baseline available for comparison.

## Non-goals

- Rebuild the full upstream 4for4 application.
- Depend on R, `tidymodels`, `reticulate`, or an RDS workflow at prediction time.
- Add defensive players to the current player outcome pool.
- Treat the current `td` rows in the Footballguys file as historical defense
  outcomes.
- Promote a new defense model to the default production path before the
  backtest passes.

## Current local system

The repository has useful pieces, but it has no current DST model boundary.

| Area | Current state | Effect on this project |
| --- | --- | --- |
| Ranking adapter | `R/01_rankings.R` keeps `QB`, `RB`, `WR`, and `TE`. | `td` rows are removed before simulation. |
| Player sampler | The sibling `ffsimulator` package accepts `QB`, `RB`, `WR`, `TE`, and `K`. | A DST row cannot enter the current outcome pool. |
| Team aggregation | `aggregate_team_fantasy()` sums player outcomes. | A defense prediction needs a separate team-game input or a new DST sampler. |
| Backtest cache | `backtest_fbg_2023_2025/` has player, schedule, roster, and FBG inputs for 2023 to 2025. | The cache has no play-by-play and lacks the defense fields used by the upstream ETL. |
| FBG fixture | `tests/test-data/wk1-26-fbg-08-31-26.csv` contains `td` rows and `tmd-*` fields. | These rows can support a forward identity and projection adapter. They do not supply the historical DST target. |
| Python XGBoost work | `backtest_fbg_2023_2025/scripts/08_xgb_p85_projection_experiment.py` already uses native `DMatrix`, `hist`, and `reg:quantileerror`. | Reuse the model and output patterns, but keep the new target and team-game keys separate. |
| Python dependencies | `backtest_fbg_2023_2025/scripts/requirements-xgb.txt` already includes `xgboost>=3.0`, `numpy`, `pandas`, and `pyarrow`. | Add the ETL dependency only after a small data-read benchmark. |

The lowest-risk integration point is a team-defense prediction table. The
existing R pipeline can consume that table after the Python backtest proves the
model. Extending `ffsimulator` to draw DST outcomes can follow as a separate
change.

## Upstream model map

The source repository is `mattsavoca/rostership-model-4for4`. The key files are:

- [DST ETL and model functions](https://github.com/mattsavoca/rostership-model-4for4/blob/main/R/dst_impute_functions.R)
- [DST forward prediction functions](https://github.com/mattsavoca/rostership-model-4for4/blob/main/R/simulation_functions.R)
- [DraftKings model artifact](https://github.com/mattsavoca/rostership-model-4for4/blob/main/models/dk_dst_predict_model.rds)
- [FanDuel model artifact](https://github.com/mattsavoca/rostership-model-4for4/blob/main/models/fd_dst_predict_model.rds)
- [Defense ID crosswalk](https://github.com/mattsavoca/rostership-model-4for4/blob/main/data/dst_id_db.csv)

The repository was last pushed on 2024-10-17. The saved DST workflows use
training rows from 2013 to 2022.

### ETL stages

The upstream function `generate_dst_impute_model_df()` performs these stages:

1. Load weekly player statistics and add kicker statistics.
2. Load weekly rosters.
3. Load schedules and convert each game into one row per team.
4. Load play-by-play data for historical QB metrics and defense events.
5. Calculate weighted opponent QB EPA and CPOE from plays before the target
   season and week.
6. Aggregate team offense and team defense events by season, week, and team.
7. Add market, rest, venue, weather, and opponent information.
8. Reverse the offense-side row so the model row names the defense as `dst`.
9. Prefix offensive point fields with `sim_` before model training.

The saved raw training table has 5,414 rows and 41 columns. The model recipe
creates 32 XGBoost features. The saved DraftKings model has 1,744 boosting
rounds. The saved FanDuel model has 1,922 rounds. The original workflow reports
RMSE values of 3.62 and 3.81, but those values do not qualify as clean forecast
benchmarks because the feature and split audits below find timing problems.

### Target definition

The upstream target is an FD-style DST score:

```text
dst_fd_pts = sacks
              + 6 * defensive_or_return_touchdowns
              + 2 * (offensive_fumbles_lost
                    + defensive_safeties
                    + interceptions
                    + points_allowed_bucket
                    + defensive_two_point_conversions)
```

The points-allowed conversion is:

| Opponent points allowed | DST points |
| --- | ---: |
| 35 or more | -4 |
| 28 to 34 | -1 |
| 21 to 27 | 0 |
| 14 to 20 | 1 |
| 7 to 13 | 4 |
| 1 to 6 | 7 |
| 0 | 10 |

The offensive feature values use a half non-PPR and half PPR blend by default.
The artifact names include `dk` and `fd`, but the saved target is named
`dst_fd_pts`. The Python version must define the scoring profile in config and
must not infer it from the artifact filename.

### Upstream feature contract

The saved booster uses these feature names:

```text
sim_off_total_fd_points
div_game
total_line
dst_home_game
dst_team_total
opponent_implied_team_total
opponent_team_total
dst_team_spread_prob
opponent_spread_prob
dst_team_moneyline_prob
opponent_moneyline_prob
dst_team_rest
opponent_rest
temp
rest_differential
opponent_qb_epa
opponent_qb_cpoe
game_type_reg
days_in_past
dist_from_onepm
sim_qb_fpts_share
sim_rb_fpts_share
sim_wr_fpts_share
sim_te_fpts_share
sim_k_fpts_share
high_wind
moderate_wind
location_neutral
roof_closed
roof_dome
roof_open
roof_outdoors
```

The recipe removes team names, game IDs, player names, player IDs, coach names,
raw kickoff text, and the raw position-level point totals. It creates position
shares from the `sim_*` values and retains total offense points.

The Python feature specification must keep the feature name, source field,
availability time, type, and transform in one versioned table. A feature is not
valid when the historical builder and the forward builder calculate it in
different ways.

## Data dependency assessment

| Dependency | Upstream use | Local state | Work needed |
| --- | --- | --- | --- |
| Weekly player statistics | Builds offensive point inputs and defense statistics. | The current cache has a small skill-position outcome schema. It does not contain the defense and kicker fields needed for the target. | Download the full stat fields for the chosen seasons. Keep separate raw and derived tables. |
| Kicker statistics | Adds kicker points to the offense total. | The current backtest downloader keeps only the 4 skill positions. | Add kicker rows or remove the kicker feature from a clearly named model variant. |
| Weekly rosters | Maps player statistics to team and week. | The current roster cache covers 2023 to 2025 and the skill positions. | Load the historical roster fields needed for team assignment and QB identity. |
| Schedules | Provides game rows, rest, lines, venue, weather, kickoff, coach, and QB fields. | The local schedule cache has 22 columns and lacks several upstream fields. | Expand the source adapter and store the full schedule contract. |
| Play-by-play | Provides QB EPA and CPOE, sacks, interceptions, safeties, defensive two-point conversions, and return touchdowns. | No play-by-play cache exists in the local backtest project. | This is the largest data task. Cache the required seasons as compressed Parquet and derive event tables once. |
| Starting QB data | Identifies the opposing starter for each game. | The local cache does not provide the upstream starting QB contract. | Use a dated starting QB table. Record the source and the time at which the starter was known. |
| Historical offense projections | Supplies pregame `sim_off_total_fd_points` and position shares in the forward path. | FBG inputs exist for 2023 to 2025. Earlier FBG snapshots do not exist in this repository. | Start with a market and QB baseline. Add projection features only when an as-of historical source exists. |
| Team name and ID maps | Aligns schedule, player, PBP, FBG, and defense rows. | The upstream repository has `data/dst_id_db.csv` and several replacement maps. | Create one canonical team map with effective dates. Do not scatter replacement rules across feature code. |
| FBG defense rows | Provides forward team defense identity and source projections. | The fixture has `td` rows and `tmd-*` fields. The adapter removes them. | Normalize `td` to `DST` at the provider boundary. Keep provider projections separate from model targets. |
| RDS artifacts | Preserve the old recipe, trained booster, raw training data, and tuning result. | Available in the private upstream repository. | Use for parity checks only. Export a standard booster if needed. Do not make RDS a runtime dependency. |

### Historical feasibility

The 2023 to 2025 range is the best first target because this repository already
has the FBG files, schedules, rosters, and player outcome files for those years.
The missing play-by-play and full schedule fields still need a new download.

The 2013 to 2022 range is feasible but needs a fresh data load. The upstream
RDS embeds the old 5,414-row table, which can shorten a parity study. It cannot
replace a clean rebuild because the saved rows contain the feature timing issue.

The forward path is feasible after the pipeline accepts a current schedule,
market fields, starting QB table, environment fields, and simulated or fixed
offensive projections. The forward path must fail clearly when a required
pregame input is missing. It must not fill a missing forecast with a realized
game value.

## Audit findings that affect the design

### Critical: target-period offense values enter model training

`generate_dst_impute_model_df()` loads weekly player statistics for the target
season and week. It aggregates realized QB, RB, WR, TE, and kicker points into
`off_total_fd_points` and position totals. The final step renames point columns
with the `sim_` prefix.

The recipe removes the position totals but keeps `sim_off_total_fd_points` and
the position shares. The training values therefore use realized offense from
the same game week. The forward function uses projected offense values instead.
This creates a train and forecast mismatch.

The saved raw table has a Pearson correlation of about `-0.786` between
`dst_fd_pts` and `sim_off_total_fd_points`. The correlation alone does not prove
leakage, but the ETL code proves that the feature uses target-period data.

The clean pipeline must use one of these options:

1. A historical pregame projection source with a recorded as-of time.
2. A forecast made only from information before kickoff.
3. A model variant that excludes projected offense features.

The first backtest must compare these options. It must not compare a clean
model against the old leaky feature set and call the difference model quality.

### Critical: the original split can divide one game

The upstream model sorts rows by game time and takes the first 80 percent as
training data. The two team rows for `2021_02_MIN_ARI` fall on opposite sides of
the split. This allows one side of the game to inform training while the other
side appears in the test set.

The Python pipeline must split on `game_id`. A temporal split must keep every
team row for a game in the same partition. Tuning folds must use the same rule.

### High: `days_in_past` changes with execution date

The upstream recipe calculates `days_in_past` from `Sys.Date()`. A rerun on a
different date produces different feature values for the same game. This field
must be removed or replaced with a value tied to the forecast as-of time. Week,
season, and kickoff features can remain when their availability is clear.

### High: defense and opponent rest fields need correction

The final upstream select assigns `dst_team_rest = rest` and
`opponent_rest = rest` after the row has been oriented around the defense. The
forward function makes the same assignment. The Python feature builder must
calculate defense rest from the defense side and opponent rest from the offense
side, then compute the difference.

### High: training tuning is not temporal

The upstream function uses random 5-fold resampling inside the historical
training set and selects the model by R-squared. This does not match a weekly
forecast task. The new pipeline must use expanding or rolling temporal folds,
with whole games kept together. It must select models with the metric used by
the output, such as RMSE for point predictions and pinball loss for quantiles.

### Medium: the RDS format is a poor runtime boundary

The saved models are R `tidymodels` workflows with serialized XGBoost boosters.
The current R environment reports an old XGBoost serialization warning when it
loads the artifact. The artifact is useful for a parity test, but the new model
must save an XGBoost JSON or UBJ booster with a separate feature contract and
run metadata.

### Medium: several upstream functions rely on global state

Some preparation functions accept data frames but reference global objects such
as `weekly_game_metrics` and `dst_names`. The Python stages must pass all input
tables as explicit arguments and must write their input schema to the run
manifest.

### Medium: duplicate and ambiguous fields exist

The model includes `opponent_implied_team_total` and `opponent_team_total`,
which are assigned the same value in the upstream select. The Python builder
must remove exact duplicates or keep one field with a documented reason. It must
also use an explicit scoring profile for `FD` and `DK` rather than trust model
file names.

## Proposed Python design

### Pipeline stages

1. **Ingest.** Read schedules, play-by-play, rosters, player statistics,
   starting QBs, FBG inputs, and market data into partitioned Parquet files.
2. **Normalize.** Apply one team map, one game key, one player ID type, and one
   timestamp rule. Record source and as-of fields.
3. **Build targets.** Aggregate defensive sacks, interceptions, safeties,
   defensive two-point conversions, return or defensive touchdowns, fumbles,
   and points allowed. Apply a named scoring profile.
4. **Build pregame context.** Create team rows from each game. Orient defense,
   opponent, home status, rest, lines, weather, venue, and QB fields.
5. **Build historical QB features.** Use play-by-play strictly before the
   target game. Use a cache keyed by QB, season, and week so the same history is
   not scanned for every row.
6. **Build offense inputs.** Use dated historical projections when available.
   Otherwise build a separate pregame forecast from prior information or omit
   the feature group.
7. **Build the model panel.** Join only features that were available before
   kickoff. Write one row per defense and game.
8. **Train and score.** Use grouped temporal folds, early stopping, and saved
   model metadata.
9. **Export predictions.** Write a team-defense table for backtests and a
   forward batch scorer with the same feature contract.

### Suggested package layout

```text
backtest_fbg_2023_2025/
  dst_xgb/
    config.py
    schemas.py
    teams.py
    ingest.py
    targets.py
    qb_metrics.py
    features.py
    train.py
    predict.py
    evaluate.py
  scripts/
    10_build_dst_panel.py
    11_train_dst_xgb.py
    12_backtest_dst_xgb.py
  data/
    raw/
      nfl/
      fbg/
    derived/
      dst_targets.parquet
      dst_pregame_panel.parquet
  outputs/
    dst_xgb/
      models/
      predictions.parquet
      metrics.csv
      feature_manifest.json
      run_manifest.json
```

Use `polars` and `pyarrow` for large reads, joins, and writes if the benchmark
shows a gain over the current pandas path. Use pandas only at a clear boundary
if an existing evaluator needs it. Use the native XGBoost API with one
`DMatrix` per train, validation, and score frame. Set `tree_method` to
`hist`. Use a fixed thread count. Test GPU use as a runtime speed option, not
as a model quality change.

### Model plan

The first release has two model modes:

1. **Scenario point model.** A regression model predicts one team-defense score
   from one pregame scenario. This mode matches the upstream forward design and
   can use simulated offensive inputs.
2. **Direct range models.** Separate quantile models predict `p15`, `p50`, and
   `p85` from one deterministic pregame row. This mode matches the existing
   project’s range and calibration scorecard.

Start with a conservative point baseline using `reg:squarederror` and a large
round limit with early stopping. Train direct quantile models with
`reg:quantileerror` only after the target panel and point baseline pass the
leakage checks. Keep the quantile models separate so each alpha has its own
validation result. Record any quantile crossing before and after the chosen
post-processing rule.

Use the XGBoost tuning order from the project skills:

1. Validate the target, feature timing, and split.
2. Fit a simple schedule and market baseline.
3. Add QB features and test their incremental value.
4. Add projected offense features only with clean historical timing.
5. Compare a small capacity matrix for depth, child weight, and split gain.
6. Test row and feature subsampling.
7. Tune learning rate and boosting rounds together.
8. Test weight regularization after the earlier checks.

Do not begin with a broad random search. The old model has enough signal to
justify a careful rebuild, but the current leakage means its parameter values
are not a good starting point for a clean model.

### Output contract

Write one row per team and game for deterministic predictions. Add
`simulation_id` when scenario mode scores multiple simulated rows.

Required fields:

```text
season
week
game_id
team
opponent
game_date_time
feature_as_of
dst_mean
dst_p15
dst_p50
dst_p85
scoring_profile
model_id
source
```

The model output must use canonical `DST` identity when it crosses the provider
boundary. The provider adapter can accept `DST` and `TD` as input aliases. The
team-game model must use team and game keys, not a player ID as its primary key.

## Backtesting plan

### First experiment

Run the first experiment on 2023 to 2025 with 3 season-level out-of-sample
targets:

- Train through 2022 and score 2023.
- Train through 2023 and score 2024.
- Train through 2024 and score 2025.

Use the same target and feature builder for each split. Keep the full game in
one partition. For each target season, fit settings on prior-season validation
windows only.

The current repository has dated FBG projection files for 2023 to 2025. The
implemented scenario panel therefore supports clean scenario backtests from
those seasons and a forward 2026 bridge. A 2023 scorecard that trains through
2022 requires dated FBG snapshots for the prior seasons, or the separate
market-and-QB feature variant. The pipeline does not substitute realized
offense for a missing historical forecast.

Run these feature variants:

1. Market, schedule, rest, venue, and weather.
2. Variant 1 plus pregame QB EPA and CPOE.
3. Variant 2 plus clean pregame offense projections.
4. The old feature names with realized offense values, marked as a leakage
   diagnostic and excluded from model selection.

The fourth variant can show the cost of the timing error. It must never serve as
the production candidate.

### Metrics

Report results by season and in total. Include:

- RMSE, MAE, and mean bias for point predictions.
- Pinball loss for `p15` and `p85`.
- Coverage for `p15`, `p85`, and the `p15` to `p85` interval.
- Rank correlation for defense selection.
- Top-fifth boom capture for weekly defense rankings.
- Error by opponent implied total, home status, roof type, and weather bucket.
- Prediction count, missing input count, and fallback count.

Compare the candidate with a historical mean baseline and a market-only
baseline. Compare the scenario output with the direct range output before
choosing the integration mode.

### Initial verification scorecard

The first retained panel has 30,718 scenario rows, 768 completed regular-season
games, 20 original FBG simulations, and 1,710 team-game targets. The results
below use the 2024 and 2025 scenario holdouts. The market baseline is a
leakage-free linear fit from prior-season market and schedule fields.

| Target season | Scenario rows | Games | Model RMSE | Historical mean RMSE | Market baseline RMSE | p15 to p85 coverage |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 2024 | 10,240 | 256 | 7.450 | 7.399 | 6.860 | 73.2% |
| 2025 | 10,238 | 256 | 7.696 | 7.889 | 7.389 | 69.9% |

This is a release smoke scorecard, not a promotion decision. The 2024 model
does not beat the simple market baseline. The 2025 model beats the historical
mean baseline but does not beat the market baseline. The 2023 scenario target
needs dated pre-2023 FBG draws or the separate market-and-QB model variant.

### Acceptance criteria

The pipeline can move to a forward integration review when all of these are
true:

- Every model feature has an as-of rule and a source field.
- No target-game outcome field enters the feature panel.
- The grouped temporal split reports zero game IDs shared by train and test.
- The panel has one unique row per team and game.
- The target counts reconcile to source event counts and points-allowed buckets.
- The Python model reproduces the chosen frozen R reference rows within a
  recorded parity tolerance, when the parity test is run.
- The candidate has a documented scorecard for all 3 out-of-sample seasons.
- The range model keeps coverage near its declared quantile target and does not
  pass on one season alone.
- The forward scorer and historical scorer produce the same feature columns and
  dtypes.
- A missing pregame source produces a visible fallback or an error. It never
  uses a postgame value.

No fixed RMSE target is set from the old RDS metrics. Those metrics come from a
leaky feature set and a split that divides one game.

## Integration plan

### Phase 1: separate team-defense table

The Python pipeline writes team-defense predictions keyed by season, week,
game, team, opponent, and optional simulation ID. The current R code joins the
table at the team aggregation boundary. The player sampler remains unchanged.

This phase supports a clean comparison of:

- player-only team totals
- player totals plus a fixed DST baseline
- player totals plus Python scenario predictions
- player totals plus direct DST range predictions.

### Phase 2: optional DST outcome sampler

Extend the sibling `ffsimulator` package only after Phase 1 passes. The sampler
would need a DST outcome history, a team-game identity contract, a position
alias rule, and tests for team totals with exactly one defense per team.

This phase is larger than adding `td` to a position vector. A defense outcome
does not have the same player history and identity rules as QB, RB, WR, TE, or K.

### Phase 3: forward weekly scorer

Add a batch command that accepts the current schedule, market fields, starting QB
table, environment data, and offensive scenario inputs. Return one prediction
row per defense and game. Add a model manifest with source revisions and the
feature contract.

The implemented `14_score_dst_from_fbg_sims.py` command provides this batch
scorer and writes the model ID, scoring profile, source, and feature as-of
fields in its output.

## Work plan and effort

| Phase | Work | Estimate |
| --- | --- | ---: |
| 0 | Freeze the target, scoring profile, keys, and as-of rules. | 1 to 2 days |
| 1 | Download and cache full schedules, rosters, player stats, and play-by-play. | 2 to 4 days |
| 2 | Build target tables, team maps, QB history, and schedule features. | 3 to 5 days |
| 3 | Build Python feature parity checks and train the first point model. | 2 to 3 days |
| 4 | Run grouped walk-forward backtests and range calibration. | 2 to 4 days |
| 5 | Add the team-defense output bridge and forward batch scorer. | 2 to 3 days |
| 6 | Optional `ffsimulator` DST support and production tests. | 3 to 6 days |

The main schedule risk is play-by-play retrieval and schema drift. The main
model risk is the historical projection feature. The main integration risk is
trying to force team defense into a player sampler before the team-game output
contract is stable.

## Recommendation

Keep the Python DST model as a separate release until its full walk-forward
scorecard is reviewed. Use the original FBG simulation export for all scenario
predictions. Keep the optional QB conditioning output out of the DST input
path. Promote the R Week 1 bridge only after the target, timing, and team-key
audits pass for the chosen training range.
