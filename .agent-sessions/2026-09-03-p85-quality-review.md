# P85 Quality Review

Date: 2026-09-03
Branch: master
Status: Complete

## Objective

Review the p85 player ceiling predictions from the no-leakage backtest by
season and position. Measure upper-tail coverage, quantile loss, empirical
p85 calibration, and the model's ability to identify boom weeks.

## Relevant Field-Guide Entries

- `field-guide/backtesting.md` - p85 bins use raw observed scores and type-7 quantiles
- `field-guide/testing.md` - use the saved player predictions and direct aggregations

## Inspection and Approach

The saved player table contains 13,378 rows with `p15`, `p50`, and `p85`.
The p85 check treats `actual_score <= p85` as coverage, with an 85% target.
The p85 pinball loss uses q = 0.85. The calibration check rounds p85 to whole
points, calculates the empirical type-7 p85 of raw actual scores in each bin,
and compares the two values. Bin errors are weighted by row count.

## Results

Overall p85 coverage is 88.86%, with an 11.14% exceedance rate. The upper bound
is conservative by 3.86 percentage points. Position coverage is 85.39% for QB,
89.14% for RB, 88.36% for TE, and 89.98% for WR.

Season coverage is 91.15% in 2023, 88.60% in 2024, and 87.21% in 2025.
The binned calibration bias is negative for every position overall. The
empirical p85 is lower than the model bin by 0.96 points for QB, 2.70 for RB,
1.52 for TE, and 2.72 for WR.

RB, TE, and WR bin calibration slopes are above 1 with negative intercepts.
This indicates that low and middle p85 estimates are too high, while the
highest estimates move closer to the empirical p85. QB has fewer usable bins
and a lower, less stable slope.

The largest p85 misses are ceiling games: De'Von Achane in 2023 Week 3,
Brock Bowers in 2025 Week 9, Kyle Pitts in 2025 Week 15, and Ja'Marr Chase in
2024 Week 10. The largest miss is 35.785 fantasy points.

The initial review put too much weight on the distance between each actual
score and its p85 estimate. An actual score below p85 is expected about 85% of
the time. That pointwise distance does not measure p85 accuracy. Calibration
must compare groups of similar estimates with their empirical 85th percentile.

The top p85 fifth gives a different and more useful view. It captures 46.2% of
RB boom weeks, 52.1% of TE boom weeks, and 43.6% of WR boom weeks. These groups
contain only 20% of player-weeks. Their boom-rate lift is 2.31 for RB, 2.60 for
TE, and 2.18 for WR. QB has only 1.26 lift and captures 25.2% of QB boom weeks.

Within the top p85 fifth, coverage is 90.6% for QB, 86.6% for RB, 83.2% for TE,
and 87.0% for WR. The empirical p85 differs from the mean estimate by -2.28 QB,
-0.62 RB, +1.14 TE, and -0.88 WR fantasy points. Thus, most aggregate
overcoverage comes from low and middle estimates. High RB, TE, and WR estimates
are close to the target and provide useful boom-week ordering.

## Verification

- Direct `data.table` aggregations from `outputs/player_predictions.parquet`.
- Direct `dplyr` quintile, boom-rate, boom-capture, and lift aggregations from
  `outputs/player_predictions.parquet`.
- Existing `outputs/position_xfpts_p85_calibration_summary.csv` inspected.
- Existing `outputs/plots/position_xfpts_p85_calibration.png` inspected.

## Final Outcome

The p85 estimate has better-than-target aggregate coverage. Low and middle
estimates cause most of that excess coverage. High RB, TE, and WR estimates
are much closer to the nominal target and identify boom weeks well. High QB
estimates remain too high and give weak boom-week separation. A future change
should preserve statistical p85 calibration and assess decision value with a
separate boom-lift and boom-capture scorecard.

## Field-Guide Review

Proposed

### Durable Lessons

- Evaluate p85 with both exceedance coverage and empirical p85-by-bin calibration.
- Do not use pointwise p85 error, p85 mean error, or p85 absolute error as
  quantile-quality measures.
- Treat `actual_score <= p85` as an expected outcome, not an individual forecast miss.
- Measure high-p85 decision value with boom rate, boom lift, boom capture, and
  monotonic ordering across estimate groups.
- Read p85 calibration by position and season. Aggregate coverage hides persistent position bias.

### Potential Enforcement

Add p85 coverage, bin bias, bin absolute error, and conditional exceedance checks
to the historical backtest validation if p85 becomes a production calibration
target.
