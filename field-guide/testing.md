# Testing the FBG Pipeline

## Rule

Test provider normalization and output shape before increasing simulation
count or treating downstream NFL results as calibrated.

## Why

The primary v0 objective is a robust marginal player range. Adapter errors can
silently change the player population or rank mapping, while 100-simulation
outputs are too noisy to validate model quality.

## Apply This When

- Adding a provider or changing its column mapping.
- Changing rank uncertainty or outcome-pool selection.
- Changing the Week 1 snapshot script or game adapter.
- Changing the DST panel, PBP history window, or forward scoring bridge.

## Preferred Shape

The Footballguys fixture test should assert:

- 400 rows after selecting the offensive consensus set and removing FA rows,
- only QB, RB, WR, and TE,
- no `FA` teams,
- finite uncertainty values with the configured floor, and
- expected first positional ranks and player names.

The current test suite has 47 passing tests. Run it with the package loaded:

```powershell
& 'C:\Program Files\R\R-4.4.2\bin\Rscript.exe' -e "library(fffloorceiling); testthat::test_dir('tests/testthat', reporter='progress')"
```

Run `scripts/week1_2026.R` with 100 simulations as a smoke test. Verify 400
player rows, 32 team rows, 16 game rows, zero FA rows, and the four positions.
Increase the count to 10,000 only after these checks pass.

## Limits

The fixture verifies the current FBG export shape. It does not prove that the
historical FantasyPros uncertainty proxy is calibrated or that the
`nflseedR` game mapping predicts real scores.

## Historical Backtest Checks

The separate historical backtest suite currently reports 42 passing checks. Run it from the
backtest directory:

```powershell
& 'C:\Program Files\R\R-4.4.2\bin\Rscript.exe' tests/testthat.R
```

After changing calibration code, run `scripts/06_make_plots.R` and compare the
generated summary with a direct `data.table` aggregation from
`outputs/player_predictions.parquet`. The p15 and p85 checks must use raw
`actual_score`, `stats::quantile()` with `type = 7`, the matching rounded tail
estimate, and a position grouping. The summary must include `n`.

The current backtest validation covers 13,378 player prediction rows and 43
p15 estimate bins. It also confirms that the persisted `xfpts_p15` field and
the p15 summary agree row for row.

For QB conditioning work, run the strength sweep after the focused tests:

```powershell
& 'C:\Program Files\R\R-4.4.2\bin\Rscript.exe' scripts/07_calibrate_qb_conditioning.R --n-simulations 1000
```

Verify 6 tagged prediction files, 13,378 rows per file, and separate 10,000
simulation confirmation runs for the baseline and the selected candidate.
Treat a strength as viable only when it improves the ceiling scorecard without
moving p85 coverage away from 85 percent.

## Backtest Limits

The backtest checks validate joins, output shape, bin definitions, and summary
math. They do not establish forecast quality. Use larger simulation counts for
reported model metrics after the data and identity checks pass.

For the DST path, run the Python unit tests before a real data build:

```powershell
python -m pytest -q backtest_fbg_2023_2025/tests/test_dst_xgb.py
```

The checks must cover the points-allowed buckets, PBP event assignment, team
rest polarity, `DST` and `TD` aliases, target-week QB exclusion, grouped game
splits, and rejection of experimental FBG draw modes. A panel audit must show
one row per simulation, team, and game. The target table must show one row per
team and game.
The forward scorer must report prior-QB-history availability. A `--no-pbp` run
is a documented fallback, and target-week PBP must never feed the QB feature.

## Related Code or Enforcement

- `tests/testthat.R`
- `tests/testthat/test-rankings.R`
- `tests/testthat/test-outcomes.R`
- `tests/testthat/test-team-and-nflseedr.R`
- `scripts/week1_2026.R`
- `backtest_fbg_2023_2025/tests/testthat.R`
- `backtest_fbg_2023_2025/scripts/06_make_plots.R`
- `backtest_fbg_2023_2025/scripts/07_calibrate_qb_conditioning.R`
- `backtest_fbg_2023_2025/tests/testthat/test_helpers.R`
