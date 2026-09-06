# FBG bottom-up backtest

This directory tests the player-to-team simulation path with historical
Footballguys weekly projection exports for 2023 through 2025.

The data path is:

```text
FBG projector rows -> positional ranks -> ECR and rank SD
                 -> prior-season scoring history -> ffsimulator outcome pool
                 -> rank-conditioned player score simulations
                 -> team fantasy simulations -> game margin predictions
```

The pipeline stores downloaded source files under `data/raw/`. It stores
derived panels under `data/derived/` and result tables and plots under
`outputs/`. The downloaded files are cached, so later runs do not contact
Footballguys or nflreadr unless a file is missing or `--force` is used.

## Run the pipeline

Install the required packages once:

```r
install.packages(c("arrow", "curl", "data.table", "ggplot2", "nflreadr", "scales"))
```

Run the complete pipeline from this directory:

```text
Rscript scripts/run_all.R
```

The FBG downloader waits a random 2 to 5 seconds after each new download.
Use smaller ranges while you test the code:

```text
Rscript scripts/01_download_fbg.R --years 2025 --weeks 1:2 --delay-min 3 --delay-max 6
Rscript scripts/02_download_nflreadr.R --years 2023:2025 --history-years 2012:2022
Rscript scripts/03_build_panel.R
Rscript scripts/04_run_player_backtest.R --n-simulations 1000
Rscript scripts/05_run_team_backtest.R
Rscript scripts/06_make_plots.R
```

To test the optional quarterback environment experiment, pass a strength from
0 to 1. The setting adds a shared, shrinkage-controlled signal to QB draws
from the simulated RB, WR, and TE team totals. A value of 0 keeps the original
independent-player output. Positive values write files with the
`_qb_conditioned` suffix and do not replace the baseline files:

```text
Rscript scripts/04_run_player_backtest.R --n-simulations 1000 --qb-conditioning-strength 0.35
```

Run the full strength calibration with:

```text
Rscript scripts/07_calibrate_qb_conditioning.R --n-simulations 1000
```

The script tests strengths 0, 0.1, 0.2, 0.3, 0.4, and 0.5. It writes the
comparison tables to `outputs/qb_conditioning_calibration.csv` and
`outputs/qb_conditioning_calibration_by_season.csv`.

## Data choices

The FBG URL returns many sets in one CSV file. The panel keeps offensive sets
with all 4 skill positions and at least 100 players. It excludes the
`Bottom Line Consensus` set because it is a second aggregate and would count
consensus information twice. It keeps `Projections Consensus` as one panel
member. Each projector rank uses the source row order within position.

The `ecr` field is the mean of the selected projector ranks. The `rank_sd`
field is the sample standard deviation across those ranks. The output also
keeps `consensus_rank`, `rank_min`, `rank_max`, and `n_projectors`.

The default actual score is the FFFL-style score used by the sibling projects:
standard nflreadr fantasy points, 0.5 points per reception, a 0.5 TE reception
bonus, and 0.5 points per receiving first down. The scoring code is in
`R/scoring.R`.

The player stage scores nflreadr history with the same FFFL rules and sends it to
`ffsimulator::ffs_adp_outcomes_week()`. It filters this table before each call.
Every row must satisfy `season < target_season`. The initial cache covers 2012
through 2022. The current `ffsimulator` weekly ranking history also ends in
2022, so each target uses those 11 seasons. A later ranking-history update can
add recent prior seasons without changing the cutoff rule.

The simulation draws an integer rank from a normal distribution with mean
`ecr` and standard deviation `rank_sd * 0.5`. It then samples a score from the
nearest rank and position in the `ffsimulator` outcome pool. The player output
stores the scoring-history seasons, maximum season, row count, and pool mode.
The stage keeps rows with at least 3 projectors.

The player range uses the current definitions: `p15` is the floor, `p50` is
the middle estimate, and `p85` is the ceiling. The main coverage target for
the floor-to-ceiling range is 70 percent.

The player output also stores `mean_above_p85`, the mean of simulated scores
strictly above that player's simulated p85. `p85_tail_excess` is the
difference between `mean_above_p85` and `p85`. These fields describe the shape
of the simulated upper tail. They do not change the p85 definition.

The player output stores `ffpts_rounded` and `xfpts_rounded`, which round the
observed score and simulated p50 estimate to 0.5 FPTS. It also stores
whole-point versions with the `_total` suffix and `xfpts_p85`, which rounds
the simulated p85 estimate to one FPTS. The position calibration outputs
group by `position` and the rounded simulation estimate, then calculate
`avg_ffpts_rounded`. The p85 calibration output calculates the empirical 85th
percentile of actual scores within each `xfpts_p85` bin. The p15 calibration
output applies the same process to the empirical 15th percentile within each
`xfpts_p15` bin.

The team stage sums simulated scores for the FBG-projected player universe.
It calibrates simulated home-away fantasy differences to actual game margins
with seasons before the target season. The 2023 player result supplies the
first team training season, so team prediction output starts with 2024. It
reports 3 methods:

| Method | Definition |
| --- | --- |
| `sim` | FBG player simulation converted to a game margin |
| `market` | nflreadr historical spread line |
| `blend` | A training-season regression with spread and simulated difference |

The spread line follows nflreadr's convention. A positive value means the home
team was favored. A home cover means the actual home margin exceeded the line.

## Identity reconciliation

The link uses the sibling drafter PFR-to-GSIS crosswalk when the FBG ID
matches a PFR ID. It then uses weekly nflreadr rosters, weekly player stats,
and the nflreadr player master. Matching uses normalized name, position, and
team.
Team aliases such as `LAR` and `LA` are normalized before matching. The panel
keeps `match_method` and `candidate_count` for audit.

Review these files after the panel stage:

```text
data/derived/identity_audit.csv
outputs/identity_diagnostics.csv
```

Add a reviewed exception to `data/player_id_overrides.csv` when an identity
needs a manual link. The override key is the FBG ID and position.

## Main outputs

| File | Use |
| --- | --- |
| `data/derived/fbg_rank_rows.parquet` | One row per FBG projector, player, and week |
| `data/derived/fbg_rank_summary.parquet` | ECR, rank SD, consensus rank, identity, and actual score |
| `outputs/player_predictions.parquet` | Player p15, p50, p85, rounded FPTS metrics, point error, and zero probability |
| `outputs/player_interval_metrics.csv` | p15 to p85 coverage by position |
| `outputs/position_xfpts_calibration_summary.csv` | Average rounded observed FPTS grouped by rounded simulation estimate and position |
| `outputs/position_xfpts_calibration_integer_summary.csv` | Whole-point estimate bins with average observed, p15, and p85 values by position |
| `outputs/position_xfpts_p85_calibration_summary.csv` | Empirical observed p85 grouped by whole-point p85 simulation estimate and position |
| `outputs/position_xfpts_p85_tail_calibration_summary.csv` | Observed and predicted conditional means above p85 by season, position, and p85 bin |
| `outputs/p85_tail_explanation_metrics.csv` | Walk-forward upper-tail regression comparison for p85 and mean_above_p85 |
| `outputs/position_xfpts_p15_calibration_summary.csv` | Empirical observed p15 grouped by whole-point p15 simulation estimate and position |
| `outputs/team_draws.parquet` | Team fantasy score for each simulation, team, and week |
| `outputs/fbg_player_draws.parquet` | Original FBG player draw rows used by the DST scenario bridge |
| `data/derived/dst_targets.parquet` | One PBP-backed DST target row per completed team-game |
| `data/derived/dst_scenario_panel.parquet` | Scenario-expanded DST training rows |
| `outputs/dst_xgb/models/` | Native XGBoost point and quantile model bundle |
| `outputs/dst_xgb/backtest_predictions.parquet` | Historical DST point and range predictions |
| `outputs/dst_xgb/dst_backtest_metrics.csv` | Historical mean and market-baseline scorecard |
| `outputs/dst_xgb/dst_backtest_breakdowns.csv` | Error by opponent total, home status, roof, and wind |
| `outputs/game_predictions.parquet` | Team-derived game margins and win probabilities |
| `outputs/team_metrics.csv` | Margin, win, and spread metrics |
| `outputs/plots/position_xfpts_calibration.png` | White-background calibration plots by position |
| `outputs/plots/position_xfpts_calibration_integer.png` | Whole-point calibration plots with average p15 and p85 dots |
| `outputs/plots/position_xfpts_p85_calibration.png` | Whole-point p85 calibration plots by position |
| `outputs/plots/position_xfpts_p85_tail_mean_calibration.png` | Observed upper-tail means compared with predicted mean_above_p85 |
| `outputs/plots/position_xfpts_p15_calibration.png` | Whole-point p15 calibration plots by position |
| `outputs/plots/` | Other ggplot player and game diagnostics |

The pipeline is exploratory. It measures whether the rank-conditioned player
simulation is calibrated and whether its team aggregate contains signal for
game outcomes. It does not prove that a forecast is profitable or that team
fantasy totals alone explain game scores.

## Direct XGBoost p85 projection experiment

The separate `scripts/08_xgb_p85_projection_experiment.py` experiment fits a
direct p85 quantile model from Footballguys projection stats. It trains one
XGBoost model for each of QB, RB, WR, and TE. The model uses rank-summary
features, raw consensus projection stats, and derived FFFL projection points.

The experiment uses season-level walk-forward evaluation. The 2023 projection
season is the warm-up season because no earlier Footballguys projection files
are cached. It selects settings on weeks 14 through 17 of the latest training
season, refits on all earlier rows, and scores the next season. It therefore
reports clean out-of-sample results for 2024 and 2025 by default.

Install the Python dependencies from `scripts/requirements-xgb.txt`, then run
the experiment from this directory:

```powershell
& 'C:\Users\matts\AppData\Local\Programs\Python\Python312\python.exe' scripts/08_xgb_p85_projection_experiment.py
```

The default grid has 144 candidates per position and target season. It uses
the XGBoost `reg:quantileerror` objective with `quantile_alpha = 0.85` and
selects candidates by p85 pinball loss. The output is written under
`outputs/xgb_p85_projection/`. It includes row-level predictions, grid scores,
selected settings, model files, feature importance, p85 calibration, boom
capture, metrics, and a run manifest.

This model does not replace the rank-conditioned baseline. Compare
`metrics.csv` and `p85_calibration.csv` before using it in a production path.

Explain the saved models with Tree SHAP:

```powershell
& 'C:\Users\matts\AppData\Local\Programs\Python\Python312\python.exe' scripts/09_explain_xgb_p85_shap.py
```

The SHAP output is written under `outputs/xgb_p85_projection/shap/`. It
contains global mean absolute importance, low and high feature directions,
local waterfall data, model additivity checks, and PNG plots. SHAP values are
in raw p85 fantasy-point units. They describe model association, not causation.

## Quarterback environment experiment

Historical team-week scoring shows a stable relationship between QB scoring
and the same team's skill-position totals. The optional experiment fits a
walk-forward regression of QB points on RB, WR, and TE points using only
seasons before the target season. It then combines the independent QB draw with
the simulated team environment. The strength parameter controls that blend.

This is a dependency experiment, not a calibrated production model. It can
improve QB ceiling ordering while changing marginal p85 coverage. Compare the
conditioned and baseline files with the same simulation count and seed rules,
then evaluate QB p85 coverage, empirical p85 calibration, boom capture, and
interval width before selecting a strength.

## Python team defense model

The `dst_xgb/` package rebuilds the upstream team defense target and feature
contract in Python. It uses full nflverse data through `nflreadpy`, caches each
season as Parquet, derives the DST target from play-by-play when that cache is
available, and falls back to full weekly player statistics.

The DST model uses the original R `ffsimulator` path for offense scenarios.
The backtest script now exports `outputs/fbg_player_draws.parquet`. The Python
panel builder aggregates those rows into simulated QB, RB, WR, TE, and K slots
for each simulation and team. The current four-position FBG export has no K
rows, so the K slot is zero until the source simulator adds kicker outcomes. It
then joins the same scenario rows to one defense target per team-game.

The forward scorer discovers cached play-by-play seasons before the target
season and uses them for the leakage-safe opponent QB features. If no prior PBP
cache exists, it reports the zero QB-history fallback in the command output and
the `opponent_qb_history_available` field.

Run the stages from this directory:

```powershell
python scripts/10_download_dst_data.py --seasons 2023:2025 --pbp-start-season 2023
Rscript scripts/04_run_player_backtest.R --n-simulations 1000
python scripts/11_build_dst_panel.py `
  --seasons 2023:2025 `
  --fbg-draws outputs/fbg_player_draws.parquet `
  --raw-dir data/raw/dst `
  --output data/derived/dst_scenario_panel.parquet
python scripts/12_train_dst_xgb.py `
  --panel data/derived/dst_scenario_panel.parquet `
  --model-dir outputs/dst_xgb/models `
  --target-season 2026
python scripts/13_backtest_dst_xgb.py `
  --panel data/derived/dst_scenario_panel.parquet `
  --target-seasons 2025 `
  --model-dir outputs/dst_xgb/models `
  --output outputs/dst_xgb/backtest_predictions.parquet
```

For a forward batch, run `scripts/14_score_dst_from_fbg_sims.py`. It discovers
prior PBP files under `data/raw/dst/pbp/` and writes one `DST` row per original
FBG simulation and scheduled team. Use `--no-pbp` only when the documented
zero QB-history fallback is acceptable for the run.

```powershell
python scripts/14_score_dst_from_fbg_sims.py `
  --draws outputs/fbg_player_draws.parquet `
  --schedule <pregame-schedule.csv> `
  --model-dir outputs/dst_xgb/models `
  --season 2026 `
  --week 1 `
  --output outputs/dst_xgb/week1_2026_dst.parquet
```

The default XGBoost model uses native `DMatrix` inputs, `hist` tree
construction, grouped temporal validation, and point plus p15, p50, and p85
models. The unstable upstream `days_in_past` feature is excluded. The model
metadata records the feature contract, training seasons, scoring profile, and
package versions.

To add DST rows to the current Week 1 forward output, set
`DST_MODEL_DIR` to the trained model directory before running
`scripts/week1_2026.R`. The R script writes the original FBG player draws,
calls `14_score_dst_from_fbg_sims.py`, and adds the returned `DST` rows before
team aggregation. With no `DST_MODEL_DIR`, the existing skill-position output
is unchanged. Set `DST_RAW_DIR` when the PBP cache is outside the default
`backtest_fbg_2023_2025/data/raw/dst/` path.
