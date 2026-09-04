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

The separate historical backtest suite currently reports 14 passing checks. Run it from the
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

## Backtest Limits

The backtest checks validate joins, output shape, bin definitions, and summary
math. They do not establish forecast quality. Use larger simulation counts for
reported model metrics after the data and identity checks pass.

## Related Code or Enforcement

- `tests/testthat.R`
- `tests/testthat/test-rankings.R`
- `tests/testthat/test-outcomes.R`
- `tests/testthat/test-team-and-nflseedr.R`
- `scripts/week1_2026.R`
- `backtest_fbg_2023_2025/tests/testthat.R`
- `backtest_fbg_2023_2025/scripts/06_make_plots.R`
