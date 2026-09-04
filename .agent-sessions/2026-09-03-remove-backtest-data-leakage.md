# Remove Backtest Data Leakage

Date: 2026-09-03
Branch: master
Status: Complete

## Objective

Assess the historical backtest for score leakage. Make sure that each player
outcome pool and team calibration use only seasons before the target season.

## Relevant Field-Guide Entries

- `field-guide/architecture.md` - keep the `ffsimulator` boundary explicit
- `field-guide/backtesting.md` - verify the historical pool and output fields
- `field-guide/testing.md` - run the focused backtest checks
- `field-guide/tooling.md` - use the local Windows R commands and caches

## Inspection and Proposed Approach

The player outcome pool used `season != target_season`. It included future
seasons. The team calibration used the same leave-one-season-out rule. The
backtest also reimplemented the outcome builder instead of passing a checked
scoring-history table to `ffsimulator`.

Use 2012 through 2022 player scores as the initial history. For each target,
filter the scoring history to `season < target_season`. Check that condition
immediately before the `ffsimulator` call. Use the same strict earlier-season
rule for team calibration. Skip 2023 team calibration because no earlier team
sample exists in this backtest.

## Meaningful Conversation and Decisions

### User

The user required the scoring-history document passed to `ffsimulator` to
exclude the target season and all future seasons.

### Agent

The agent found future-season leakage in the player pool and team calibration.
The implementation uses a walk-forward cutoff and stores the maximum training
season in the output.

### Reasoning Preserved

A leave-one-season-out test can train an earlier target on later results. A
forecast backtest must use a one-way time cutoff. The target season must be
greater than every season in each predictive input.

## Verification

- `Rscript tests/testthat.R` - 23 checks passed with no failures, warnings, or skips.
- `Rscript scripts/02_download_nflreadr.R --years 2023:2025 --history-years 2012:2022` - cached 11 pre-2023 player-stat seasons and refreshed the manifest.
- Direct real-pool check - `ffsimulator` built QB, RB, TE, and WR pools from 59,572 score rows. Each target received seasons 2012 through 2022.
- `Rscript scripts/04_run_player_backtest.R --n-simulations 1000` - wrote 13,378 player predictions and 1,548,000 initial team draws.
- `Rscript scripts/05_run_team_backtest.R` - skipped 2023 team calibration, fit 2024 on 2023, fit 2025 on 2023 and 2024, and wrote 512 game predictions.
- `Rscript scripts/06_make_plots.R` - refreshed all plots and summaries.
- Saved-output checks - every player and team score-history maximum was less than its target season. Every team calibration maximum was also less than its target season.
- Direct p15 aggregation - all 43 saved p15 bins matched a new aggregation from 13,378 player rows.
- `git diff --check` - no whitespace errors. Git reported the existing Windows line-ending notices.

## Commits

None.

## Final Outcome

The backtest sends only earlier-season score rows to `ffsimulator`. The current
player pool uses 2012 through 2022 for targets 2023 through 2025. Runtime checks
reject a target or future season at the player and team boundaries. Output
fields record the scoring-history cutoff and the walk-forward mode.

The team stage has no valid training season for its 2023 target. It records a
skipped calibration for 2023. It produces walk-forward game predictions for
2024 and 2025.

## Open Questions

None.

## Field-Guide Review

Proposed

### Initial Misunderstandings

- The prior guide described leave-one-season-out player pools as sufficient.
  That method leaks future results into earlier targets.
- The backtest did not use the `ffsimulator` outcome builder. It sampled scores
  from the target panel with a local copy of the rank logic.

### Durable Lessons

- Every predictive score or calibration season must be less than the target
  season.
- Check the time cutoff at the function that consumes the historical data.
- Store the maximum training season with predictions so output checks can find
  a cutoff regression.

### Task-Specific Details

- The current `ffsimulator` weekly ranking history covers 2012 through 2022.
  This version limit belongs in the session and README, not in the durable rule.
- Team game predictions now contain 2024 and 2025. The 2023 player result is the
  first team calibration sample.

### Existing Coverage

- `backtest_fbg_2023_2025/tests/testthat/test_helpers.R` records the exact
  scoring-history seasons received by an injected outcome builder.
- The same test file checks the player and team cutoff errors.
- Saved player, team-draw, run-metric, calibration, and game tables contain
  cutoff fields for direct checks.

### Proposed Changes

- Replace the leave-one-season-out statement in `field-guide/backtesting.md`
  with the strict earlier-season rule.
- Update `field-guide/testing.md` to record the 23 checks and the output cutoff
  assertions.
- Update `field-guide/tooling.md` with the 2012 through 2022 history-cache input.

### Potential Enforcement

The player and team regression tests now enforce the cutoff. The saved-output
check gives a small integration test that can move into the test suite if the
project starts checking generated artifacts in continuous integration.
