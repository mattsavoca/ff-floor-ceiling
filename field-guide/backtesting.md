# Historical FBG Backtesting and Calibration

## Rule

Keep historical Footballguys inputs cached, audit identity links before
calibration, and define each observed and simulated quantile in the output
schema before making a chart.

## Why

The backtest joins provider-specific weekly projection rows to nflreadr player
outcomes, schedules, lines, and game results. A name or binning error can look
like model error. Explicit fields and audit tables make the calibration result
reproducible.

## Apply This When

- Downloading or refreshing the 2023 to 2025 FBG weekly backtest inputs.
- Linking FBG player rows to nflreadr weekly outcomes.
- Adding player calibration metrics or position-faceted plots.
- Comparing the player simulation output with team or game outcomes.
- Testing a shared QB environment from RB, WR, and TE simulation draws.

## Preferred Shape

- Use `backtest_fbg_2023_2025/` for this work. Cache FBG CSV files under
  `data/raw/fbg/` and nflreadr files under `data/raw/nflreadr/`. The downloader
  waits a varied 2 to 5 seconds between new FBG requests.
- Build the panel with the sibling PFR-to-GSIS crosswalk first, then use
  normalized name, position, and team matching. Keep weekly roster matches,
  master-player matches, and reviewed exceptions as separate match methods.
  Review `data/derived/identity_audit.csv` and
  `outputs/identity_diagnostics.csv` before using the panel for calibration.
- Use `R/common.R::round_to_increment()` for estimate bins. It uses half-up
  rounding, which puts exact half values in the higher bin and avoids the
  even-number tie behavior of base R `round()`.
- Persist the following player fields:
  - `ffpts_rounded` and `xfpts_rounded` for half-point p50 calibration.
  - `ffpts_rounded_total` and `xfpts_rounded_total` for whole-point p50
    calibration.
  - `xfpts_p15` and `xfpts_p85` for whole-point simulation-tail bins.
- For p15 and p85 calibration, group by `position` and the rounded simulation
  tail estimate. Calculate `ffpts_p15` or `ffpts_p85` as the empirical
  percentile of raw `actual_score` in that bin with
  `stats::quantile(..., type = 7)`. Include `n` in every summary.
- Use position facets, black empirical points, a dotted `y = x` reference,
  and a white `theme_bw()` background for the tail calibration charts. Keep
  model auxiliary dots and connecting lines out of these charts.
- Apply display-only zooms after creating the full summary. The p85 chart
  starts the QB panel at `xfpts_p85 = 10` while retaining all summary bins.
  The p15 chart keeps its natural low-end range and adds axis padding so bins
  at zero remain visible.
- For QB environment experiments, fit the QB model with seasons before the
  target season. Sweep conditioning strength with the same seeds and write
  each run to a separate tagged output file. Compare the independent baseline
  with p85 coverage, p85 pinball loss, binned empirical p85 bias, interval
  coverage, rank correlation, and top-fifth boom capture.

## Limits

Whole-point bins reduce resolution and can contain few observations. Interpret
tail calibration with the `n` column and inspect the raw summary. The empirical
observed percentile is a grouped outcome diagnostic. It does not measure the
coverage of the full p15 to p85 interval.

The player simulation uses leave-one-season-out outcome pools for the target
season. The team stage aggregates independently drawn player outcomes, so team
and game calibration remains experimental until shared team or game effects are
validated.

The QB conditioning experiment uses a standardized blend. The strength is a
tuning parameter, not the regression R2 and not a fitted coefficient. The
2026-09-04 six-point sweep used strengths 0 through 0.5. Coverage moved from
85.39% at strength 0 to 83.03% at strength 0.5. A 10,000-simulation check
found no broader ceiling improvement at strength 0.1. Do not enable the path
in production from this experiment alone.

## Related Code or Enforcement

- `backtest_fbg_2023_2025/R/common.R`
- `backtest_fbg_2023_2025/scripts/03_build_panel.R`
- `backtest_fbg_2023_2025/scripts/04_run_player_backtest.R`
- `backtest_fbg_2023_2025/scripts/06_make_plots.R`
- `backtest_fbg_2023_2025/scripts/07_calibrate_qb_conditioning.R`
- `backtest_fbg_2023_2025/tests/testthat/test_helpers.R`
- `backtest_fbg_2023_2025/outputs/position_xfpts_p15_calibration_summary.csv`
- `backtest_fbg_2023_2025/outputs/position_xfpts_p85_calibration_summary.csv`
- `backtest_fbg_2023_2025/outputs/qb_conditioning_calibration.csv`
- `backtest_fbg_2023_2025/outputs/qb_conditioning_calibration_by_season.csv`
