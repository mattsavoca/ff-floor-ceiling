# Known Fidelity and Calibration Risks

## Missing Footballguys Rank Uncertainty

Footballguys exports can omit both explicit positional rank and standard
deviation. The current adapter derives rank from the ordered consensus export
after filtering and uses historical FantasyPros weekly rank uncertainty as a
proxy. Never silently treat missing uncertainty as a zero-width rank.

This proxy is an implementation bridge. Backtests must later test interval
coverage by position and rank, then replace or recalibrate the mapping if it
does not cover the intended range.

Related code: `R/01_rankings.R`, `byor_fbg()`, and the FBG fixture test.

## Small Simulation Counts

One hundred simulations are a pipeline smoke test. Their p15, p85, means, and
win probabilities can move materially between seeds. Use 10,000 or more for a
reported snapshot after the adapter and output contracts pass.

More draws reduce Monte Carlo noise. They do not establish calibration.
Use `evaluate_interval_coverage()` with out-of-sample results to measure the
50 percent, 70 percent, and 80 percent interval coverage.

## Independent Player Environments

The current player draws share an ID but do not share a causal team or game
state. Treat team aggregates and `nflseedR` game results as experimental until
a shared team or game random effect is added and validated. FantasyLabs
correlations are available for a later joint-outcome stage and are inactive in
v0.

## Footballguys Set Selection

Footballguys files can repeat a set name across offensive, defensive, kicker,
and team-defense sets. Selecting by name alone can mix incompatible rows. The
adapter selects the largest matching set within the four offensive positions,
then filters positions and free agents before deriving rank.

## Related Code or Enforcement

- `R/01_rankings.R`
- `R/03_summaries.R`
- `R/06_correlations.R`
- `tests/testthat/test-rankings.R`
- `tests/testthat/test-outcomes.R`
