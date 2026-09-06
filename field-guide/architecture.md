# Ranking, Simulation, and NFL Output Boundaries

## Rule

Keep provider adaptation, player simulation, and NFL game conversion as
separate stages:

```text
provider export -> normalized BYOR rankings -> ffsimulator draws
               -> player ranges -> team signals -> experimental nflseedR results
```

`fffloorceiling` owns the orchestration and contracts. The installed internal
`ffsimulator` package remains the rank-conditioned fantasy outcome engine.
`nflseedR` is a downstream consumer of experimental team signals.

## Why

The rank-conditioned sampler gives useful marginal player ranges. Separate
players with the same simulation ID can still draw from different historical
game environments. Team totals and game results can therefore combine
incoherent player outcomes and require a separate calibration boundary.

## Apply This When

- Adding FantasyPros, ETR, Footballguys, or another ranking provider.
- Changing player-to-team aggregation or the `nflseedR` adapter.
- Interpreting a team or game table as an NFL prediction.

## Preferred Shape

- Normalize every provider to `player_id`, `player_name`, `position`, `team`,
  `rank`, `rank_uncertainty`, `bye_week`, `as_of`, and `source`.
- Keep player range output separate from team and game output.
- Describe game output as simulated margin and win probability unless a
  calibrated score model exists.
- Keep the `nflseedR` path explicitly experimental while player outcomes are
  independently sampled.
- Keep the QB skill-position conditioning path backtest-only until its
  strength is selected with walk-forward validation and its ceiling metrics
  improve against the independent baseline.

The QB experiment fits a prior-season team-week model of QB points from RB,
WR, and TE points. It uses a bounded conditioning strength to mix the
independent QB draw with a standardized team environment. A strength of 0
leaves the current sampler unchanged. Positive strengths write separate
`_qb_conditioned` or tagged output files.

## Limits

The current team signal is a prototype. It maps standardized team fantasy
totals to expected margin and does not produce a calibrated game score total.
FantasyLabs-style correlation data is stored but inactive in v0.

The current Week 1 FBG snapshot uses a Week 1 ranking snapshot with the local
season outcome pool. The available weekly pool does not cover TE, so this is a
known calibration limitation.

The 2026-09-04 QB conditioning sweep did not support production use. At
strength 0.1, the 10,000-simulation run had 85.53% QB p85 coverage versus
85.87% for the independent baseline. It had higher p85 pinball loss and lower
top-fifth boom capture. The independent baseline remains the default.

## Related Code or Enforcement

- `R/01_rankings.R`, `R/02_ffsimulator.R`, `R/03_summaries.R`
- `R/04_team_signals.R`, `R/05_nflseedr.R`
- `scripts/week1_2026.R`
- `tests/testthat/test-team-and-nflseedr.R`
- `backtest_fbg_2023_2025/R/simulation.R::fit_qb_skill_model()`
- `backtest_fbg_2023_2025/R/simulation.R::condition_qb_scores()`
- `backtest_fbg_2023_2025/scripts/07_calibrate_qb_conditioning.R`
