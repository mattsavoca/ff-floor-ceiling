# Range of Outcomes for Fantasy Football

*this README was made with assistance from CODEX*

This package turns provider rankings into player fantasy outcome ranges.
It uses the rank-conditioned sampling process in `ffsimulator`.

The package has five parts:

1. `byor_generic()`, `byor_fantasypros()`, `byor_etr()`, and `byor_fbg()` return one
   provider-neutral ranking shape.
2. `simulate_player_outcomes()` returns one draw for each player, simulation,
   and week.
3. `simulate_player_week_outcomes()` returns one-week player draws.
4. `summarize_player_outcomes()` returns weekly and season range tables.
5. `aggregate_team_fantasy()`, `standardize_team_fantasy()`, and
   `simulate_nfl_from_fantasy()` form the experimental `nflseedR` path.

## Ranking schema

The normalized table has these columns:

```text
player_id, player_name, position, team, rank, rank_uncertainty,
bye_week, as_of, source
```

`rank` is a positional rank. The adapters filter provider tables to one
positional row per player. A deterministic ranking can use
`rank_uncertainty = 0`.

`byor_fbg()` selects the Footballguys offensive consensus set, keeps only QB,
RB, WR, and TE, removes rows with `team = "FA"`, and uses source row order
within each position as rank when no explicit rank column exists. When the
export has no uncertainty column, it maps rank to median historical
FantasyPros weekly `sd` for the same position and rank.

## Player ranges

```r
rankings <- byor_generic(my_rankings)
adp_outcomes <- ffsimulator::ffs_adp_outcomes_week(scoring_history)
draws <- simulate_player_week_outcomes(
  rankings,
  adp_outcomes = adp_outcomes,
  n_simulations = 1000,
  week = 1,
  seed = 42
)
```

Use `simulate_player_outcomes()` with `ffsimulator::ffs_adp_outcomes()` when
you need a season simulation across several weeks.

The installed `ffsimulator` package must provide the outcome pool passed to
`adp_outcomes`. The pool must cover the ranks that the ranking uncertainty can
produce. Set `strict = FALSE` to fill unsupported ranks with zero points.

The weekly summary includes `mean`, `median`, `p10`, `p15`, `p25`, `p75`,
`p85`, `p90`, `probability_zero`, `probability_active`,
`probability_top_12`, and conditional active-game fields. Use `p15` as the
floor and `p85` as the ceiling for the Week 1 range. The season summary
includes season p15 and p85 fields as well.

## Calibration

Use out-of-sample scores with `evaluate_interval_coverage()`. It reports
observed coverage for the 50 percent, 70 percent, and 80 percent intervals.
The 70 percent interval is the p15 to p85 range. It also reports zero-score
calibration when the prediction table has `probability_zero`.

More draws reduce Monte Carlo noise. They do not prove that the intervals are
calibrated. Use historical backtests to measure coverage by position and rank.

## Experimental NFL output

```r
team_draws <- aggregate_team_fantasy(draws)
team_signals <- standardize_team_fantasy(team_draws)

nfl <- simulate_nfl_from_fantasy(
  games = nflseedR::sims_games_example,
  team_signals = team_signals,
  simulations = 1000,
  chunks = 1,
  sim_include = "REG",
  verbosity = "NONE"
)
```

The adapter maps a one-standard-deviation team fantasy signal to an expected
margin with `beta`, then samples a game margin. Supply base team ratings and
historical team reference values for a calibrated model.

`summarize_nfl_game_outcomes()` reports the expected home-team margin, the p15
to p85 margin range, and simulated win probabilities. The v0 adapter reports
margin outcomes. It does not estimate a game score total.

The adapter is experimental. Independent player draws do not create one shared
game environment. The package stores FantasyLabs-style correlation matrices
with `new_correlation_layer()`, but v0 does not apply them.

## Web forecast app

The production forecast workflow is in [`web/README.md`](web/README.md). It accepts a checked CSV, preserves the selected source order, runs the released ffsimulator and XGBoost inference contracts, and publishes a validated `forecast-result.v2` result.

Local development uses the R and Python producers in [`services/model-worker`](services/model-worker). Vercel uses the Python producer at `web/api/producer.py`, private Vercel Blob state, and the checked-in producer assets. Regenerate those assets with `scripts/create_ffsimulator_snapshot.R` and `scripts/prepare_vercel_worker_assets.ps1` after a model or outcome-pool release changes.

## Week 1 2026 FBG snapshot

Run `scripts/week1_2026.R` to reproduce the committed FBG snapshot in
`outputs/`. It uses the Footballguys file dated 2026-08-31, the local
historical `ffsimulator` outcome pool, and 100 simulations. The player table
covers QB, RB, WR, and TE. The game table reports home-team margin outcomes,
not expected game scores.
