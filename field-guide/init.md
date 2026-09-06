# Project Field Guide

This guide stores durable lessons for the `fffloorceiling` project. Read this
index at the start of substantial work, then read only the entries that match
the task. Current code, tests, configuration, and explicit user instructions
remain authoritative. Record each substantial session in `.agent-sessions/`,
then promote reusable lessons into this guide after review.

## Architecture

- [Architecture](architecture.md)
  - Read when changing provider adapters, simulation stages, team aggregation,
    or the `nflseedR` boundary.
  - Keywords: BYOR, ffsimulator, player draws, team signals, game outcomes,
    shared environment

## Backtesting and Calibration

- [Historical FBG backtesting and calibration](backtesting.md)
  - Read when downloading historical FBG data, reconciling player identities,
    defining calibration summaries, or changing position plots.
  - Keywords: backtest, FBG, nflreadr, identity, quantile, p15, p85,
    rounding, calibration, QB conditioning, boom capture, ggplot

## Conventions

- [Code conventions](code-conventions.md)
  - Read when adding a ranking source or changing public output fields.
  - Keywords: normalized schema, FBG, rank, uncertainty, floor, ceiling, p15,
    p85

## Testing

- [Testing](testing.md)
  - Read when changing adapters, sampling, summaries, or snapshot scripts.
  - Keywords: testthat, fixture, smoke test, 100 simulations, coverage, check

## Tooling

- [Tooling](tooling.md)
  - Read when installing, testing, building, checking, or reproducing a
    snapshot on Windows.
  - Keywords: R 4.4.2, R CMD, sibling repository, output files, locale

## Recurring Problems

- [Recurring problems](recurring-problems.md)
  - Read when a provider omits uncertainty, a simulation count changes, or
    team and game results are interpreted.
  - Keywords: missing sd, rank mapping, Monte Carlo noise, independent draws,
    QB conditioning, repeated set names, calibration
