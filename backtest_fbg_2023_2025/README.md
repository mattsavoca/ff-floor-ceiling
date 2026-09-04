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
