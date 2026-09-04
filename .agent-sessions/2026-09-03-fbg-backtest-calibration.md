# FBG Historical Backtest and Tail Calibration

Date: 2026-09-03
Branch: unavailable, parent repository has no commits
Status: Complete

## Objective

Build and document a historical Footballguys backtest for the bottom-up
projection to rank to player simulation to team simulation path. Add position
calibration plots for the p50 estimate and empirical p15 and p85 outcomes.
Preserve cached 2023, 2024, and 2025 weekly inputs for weeks 1 through 17.

## Relevant Field-Guide Entries

- `field-guide/architecture.md` - provider, player, team, and game boundaries
- `field-guide/code-conventions.md` - normalized ranking and p15/p85 output contracts
- `field-guide/recurring-problems.md` - identity, uncertainty, and calibration risks
- `field-guide/testing.md` - package and backtest verification commands
- `field-guide/tooling.md` - Windows R commands and cached artifacts
- `field-guide/backtesting.md` - historical inputs, quantile bins, and chart rules

## Inspection and Proposed Approach

The project had a field guide for the original Week 1 FBG proof of concept,
but it had no entry for the larger historical backtest. The new work belongs
in `backtest_fbg_2023_2025/`, with raw downloaded files cached separately from
derived panel data and ignored output artifacts.

The backtest uses `data.table` for ETL and summaries, `arrow` for parquet
storage, and `ggplot2` for static position-faceted plots. The player panel uses
the sibling PFR-to-GSIS crosswalk, normalized name/position/team matching,
weekly rosters, the nflreadr player master, and reviewed overrides. The panel
contains 14,985 audited rows, with 14,980 mapped rows and five unresolved rows,
all Je'Quan Thomas entries from 2024.

## Meaningful Conversation and Decisions

### User

The user requested a full 2023 to 2025 FBG and nflreadr backtest with cached
downloads, polite delays between FBG requests, careful identity reconciliation,
player and team stages, fast R code, and ggplot diagnostics.

The user corrected the first chart definition. The mean calibration must group
by the rounded estimate on the x-axis and calculate the average observed score
for that group. The requested whole-point version removes the connecting line,
uses a dotted `y = x` reference, and keeps the white visual style.

The user then requested separate tail charts. The p85 chart groups whole-point
rounded `xfpts_p85` and plots the empirical 85th percentile of observed
`actual_score`. The p85 chart removes auxiliary model p15/p85 dots and zooms the
QB panel to x = 10 and above. The p15 chart applies the same process at the
15th percentile.

The user reported that the p15 dots needed to be visible. Points at zero and
other panel limits were clipped by `coord_cartesian(expand = FALSE)`. The p15
chart now uses small x and y scale expansions. The p85 chart keeps its prior
QB zoom and display behavior.

### Agent

The player output now stores half-point fields for p50 calibration,
whole-point fields for the whole-point p50 chart, and whole-point `xfpts_p15`
and `xfpts_p85` fields for tail calibration. The helper
`round_to_increment()` implements half-up rounding with
`floor(value / increment + 0.5)`.

The tail summaries use `stats::quantile(actual_score, probs, type = 7)` within
each `position` and rounded simulation estimate group. Each summary includes
`n`. The tail plots use black points, a dotted slope-one reference, no
connecting line, no auxiliary model dots, position facets, and a white
background.

The field guide gained a dedicated backtesting entry, a backtest index link,
backtest testing and tooling instructions, and a regression test for the
rounding helper.

## Reasoning Preserved

- The y-value in a p15 or p85 calibration chart is a grouped empirical outcome
  quantile. It is the observed quantile for the bin, rather than the average
  of each player's model-tail estimate.
- The complete summary retains all estimate bins. A QB-only p85 x-axis crop is
  applied to plotting data after summarization.
- P15 estimates cluster near zero, so the p15 chart must retain natural
  low-end ranges and include display padding for edge points.
- Half-point ties require an explicit project helper because base R `round()`
  uses even-number tie behavior.
- The p15 and p85 chart summaries are diagnostics. They need `n` and should be
  read with sample size and leave-one-season-out assumptions in mind.

## Verification

- `Rscript scripts/04_run_player_backtest.R --n-simulations 1000` - completed,
  13,378 player predictions and 1,548,000 team simulation draws written.
- `Rscript scripts/06_make_plots.R` - completed and wrote all plots, including
  `position_xfpts_p15_calibration.png`.
- Direct `data.table` aggregation against
  `outputs/player_predictions.parquet` - passed for 43 p15 bins.
- `Rscript tests/testthat.R` - 14 passing checks, zero test failures, skips,
  or test warnings after adding the rounding regression test. R printed the
  known startup and package-version warnings.
- Manual image inspection - p15 edge points are visible after scale padding;
  p85 remains separate and retains its QB display crop.
- Windows R emitted the known `C.UTF-8` startup warnings. The scripts still
  completed successfully.

## Commits

- None. The parent repository has no commits yet.

## Final Outcome

The historical backtest has cached FBG and nflreadr inputs, audited player
linking, player and team simulation outputs, p50 calibration summaries, and
separate empirical p15 and p85 calibration charts. The field guide now records
the data contracts, quantile definitions, rounding rule, chart conventions,
identity audit steps, and validation commands from this work.

## Open Questions

- Review the five unresolved Je'Quan Thomas rows and decide whether a durable
  identity override is appropriate.
- Evaluate tail calibration by sample size and season before treating the
  simulation p15 and p85 values as calibrated.
- Assess whether shared team or game effects improve the team-stage validity.

## Field-Guide Review

Accepted

### Initial Misunderstandings

- The first requested calibration chart was interpreted as average observed
  score grouped by rounded prediction. The user clarified that the tail charts
  require empirical observed p15 or p85 within rounded model-tail bins.
- The initial p15 chart used zero-width coordinate expansion. The user needed
  edge dots visible, so padding was added to the p15 axes.

### Durable Lessons

- Historical FBG calibration needs its own documented data, identity, binning,
  and visualization contract.
- Tail calibration must use grouped empirical quantiles of raw observed scores
  and retain bin counts.
- Display-only panel zooms must preserve the full summary table.
- Numeric padding is required when a position-faceted chart contains estimates
  at the axis boundary.

### Task-Specific Details

- The 1,000 simulation count was used for the current output refresh. Reported
  model metrics may require a larger count.
- The five unresolved rows are specific to the cached 2024 data and should be
  reviewed before becoming a permanent override rule.
- The exact chart titles and output filenames are current project artifact
  choices, while the quantile and bin definitions are the durable contract.

### Existing Coverage

- `backtest_fbg_2023_2025/README.md` documents the pipeline, source caches,
  output files, identity review files, and calibration definitions.
- `backtest_fbg_2023_2025/tests/testthat/test_helpers.R` now enforces the
  half-up rounding behavior.
- The direct p15 summary validation checks the persisted field and grouped
  quantile output.

### Proposed Changes

- Added `field-guide/backtesting.md` and linked it from `field-guide/init.md`.
- Extended `field-guide/testing.md` and `field-guide/tooling.md` with the
  historical backtest workflow and checks.
- Added this session log to preserve the corrections and implementation
  reasons.

### Potential Enforcement

- Keep the rounding regression test and direct p15/p85 aggregation checks.
- Add a future integration test that fails when unresolved or ambiguous player
  links enter the player prediction table.
