# QB skill-position conditioning experiment

Date: 2026-09-04
Branch: master
Status: Implemented as an optional backtest experiment

## Objective

Test whether random draws for RB, WR, and TE can provide a shared team
environment that improves QB ceiling ordering without replacing the existing
independent-player baseline.

## Relevant field-guide entries

- `field-guide/architecture.md`: player draws remain separate from team and
  game interpretation, and shared environments are experimental.
- `field-guide/recurring-problems.md`: independent player environments are a
  known fidelity risk.
- `field-guide/testing.md`: 100 simulations are a smoke test; 1,000 or more
  are needed for reported diagnostics.
- `field-guide/backtesting.md`: use walk-forward history and evaluate p85 with
  coverage, grouped empirical p85, and boom-capture measures.

## Inspection and findings

The latest commits were `72c2329` and `e357e10`. The current backtest sampled
all players independently. `R/06_correlations.R` in the package only stored an
inactive correlation matrix and was not connected to the backtest.

Using cached nflreadr player statistics for 2012 through 2025, same-team
team-week QB scoring correlated 0.133 with RB totals, 0.602 with WR totals,
and 0.328 with TE totals. A regression of QB points on RB, WR, and TE totals
had R2 about 0.52 to 0.61 by season and 0.55 for the 2012 to 2022 training
history used for a 2023 target. The top fifth of skill-position totals captured
about 46% of QB boom weeks.

## Implementation

- `make_scoring_history()` now preserves position and team.
- `fit_qb_skill_model()` fits a target-season-safe walk-forward regression.
- `condition_qb_scores()` adds a bounded shared environment signal to QB draws
  using a strength from 0 to 1. It leaves strength 0 unchanged, and skips
  conditioning when only one team is present.
- `simulate_player_week_conditioned()` wraps the existing sampler.
- `scripts/04_run_player_backtest.R` accepts `--qb-conditioning-strength`.
  Positive values write `_qb_conditioned` output files, so baseline output is
  not overwritten.
- README usage and focused tests were added.

## Verification

- `Rscript tests/testthat.R`: 42 passing checks, zero failures. R emits its
  normal package-version warning.
- `Rscript scripts/04_run_player_backtest.R --help`: passed.
- End-to-end smoke run with 20 simulations and strength 0.35: passed, 13,378
  player rows and 30,960 team draws.
- End-to-end 1,000-simulation run with strength 0.35: passed, 13,378 player
  rows and 1,548,000 team draws.
- Baseline and conditioned player outputs both contain 13,378 rows. In the
  1,000-simulation comparison, QB p85 coverage was 0.8539 for baseline and
  0.8393 for conditioned; mean QB p85 was 24.029 versus 23.869. These are
  exploratory results, not a model-selection claim.
- `git diff --check`: passed.

## Calibration results

The six-strength sweep used 1,000 simulations for strengths 0, 0.1, 0.2,
0.3, 0.4, and 0.5. Aggregate QB p85 coverage was 85.39%, 85.11%, 84.63%,
83.80%, 83.59%, and 83.03%, respectively. The nonzero strength values moved
coverage below the 85% target as strength increased.

The baseline and strength 0.1 candidate were then rerun at 10,000 simulations.
The baseline had 85.87% p85 coverage, 1.965 p85 pinball loss, 1.473 weighted
absolute binned p85 bias, and 29.2% top-fifth boom capture. The strength 0.1
candidate had 85.53% coverage, 1.970 pinball loss, 1.594 binned absolute bias,
and 26.5% boom capture. Its p85 rank Spearman correlation was 0.187 versus
0.196 for the baseline.

The candidate therefore improves aggregate coverage error slightly, but it
does not improve the broader ceiling scorecard. The result does not support
using the current conditioning blend in production.

## Open questions

- Sweep strength values such as 0.15, 0.25, 0.35, and 0.50 with fixed seeds.
- Add a formal walk-forward comparison for QB p85 calibration, pinball loss,
  boom capture, and rank ordering.
- Compare a direct Gaussian-copula or residual-bootstrap model with this simple
  standardized blend.
- Decide whether conditioning belongs in the package API or remains a
  backtest-only experiment.

## Field-guide review

Accepted. Updated the existing architecture, backtesting, testing, recurring-
problems, and index entries. The guide now records the experiment boundary,
the strength-selection rule, the calibration command, the measured results,
and the decision to keep the independent baseline in production.
