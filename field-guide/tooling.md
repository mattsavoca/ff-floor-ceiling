# Windows R Workflow and Snapshot Artifacts

## Rule

Run package commands from the `ff_floor_ceiling` root. The Week 1 script uses
relative paths to the local FBG fixture and the sibling `ffsimulator` source
tree.

## Preferred Commands

Install the source package:

```powershell
& 'C:\Program Files\R\R-4.4.2\bin\R.exe' CMD INSTALL --no-multiarch --with-keep.source .
```

Reproduce the 100-simulation snapshot:

```powershell
& 'C:\Program Files\R\R-4.4.2\bin\Rscript.exe' scripts/week1_2026.R
```

Build and check the source package:

```powershell
& 'C:\Program Files\R\R-4.4.2\bin\R.exe' CMD build .
cmd /c 'set LC_ALL=C&& set LANG=C&& set LC_CTYPE=C&& "C:\Program Files\R\R-4.4.2\bin\R.exe" CMD check --no-manual fffloorceiling_0.1.0.tar.gz'
```

The clean locale in the check command avoids the local Windows R startup
warning for `C.UTF-8`.

The Python DST data and model commands run from
`backtest_fbg_2023_2025/`. Install `nflreadpy`, `polars`, and `pyarrow` from
`scripts/requirements-xgb.txt`. Use `10_download_dst_data.py` for the ignored
season cache, `11_build_dst_panel.py` for the scored scenario panel,
`12_train_dst_xgb.py` for the model bundle, and
`14_score_dst_from_fbg_sims.py` for a forward batch.
The forward scorer discovers prior-season PBP partitions from the raw cache.
Set `DST_RAW_DIR` when the root Week 1 bridge uses a cache outside the default
`backtest_fbg_2023_2025/data/raw/dst/` path.

## Snapshot Inputs and Outputs

- FBG input: `tests/test-data/wk1-26-fbg-08-31-26.csv`
- Outcome pool: `../ffsimulator/inst/cache/adp_outcomes.rds`
- Script: `scripts/week1_2026.R`
- Player ranges: `outputs/week1_2026_fbg_player_ranges.csv`
- Team ranges: `outputs/week1_2026_fbg_team_ranges.csv`
- Game outcomes: `outputs/week1_2026_fbg_game_outcomes.csv`
- Provenance: `outputs/week1_2026_fbg_metadata.txt`

The package suggests the local `ffsimulator` and `nflseedR` packages. The
current snapshot requires the sibling `ffsimulator` outcome cache, while the
full `nflseedR` simulation interface remains available as an experimental
downstream adapter.

## Historical FBG Backtest

Run these commands from `backtest_fbg_2023_2025/`:

```powershell
& 'C:\Program Files\R\R-4.4.2\bin\Rscript.exe' scripts/01_download_fbg.R
& 'C:\Program Files\R\R-4.4.2\bin\Rscript.exe' scripts/02_download_nflreadr.R
& 'C:\Program Files\R\R-4.4.2\bin\Rscript.exe' scripts/03_build_panel.R
& 'C:\Program Files\R\R-4.4.2\bin\Rscript.exe' scripts/04_run_player_backtest.R --n-simulations 1000
& 'C:\Program Files\R\R-4.4.2\bin\Rscript.exe' scripts/05_run_team_backtest.R
& 'C:\Program Files\R\R-4.4.2\bin\Rscript.exe' scripts/06_make_plots.R
```

`scripts/run_all.R` runs the same sequence. Cached downloads let later runs
skip network requests unless a source file is missing or `--force` is used.
The backtest writes summaries and plots under
`backtest_fbg_2023_2025/outputs/`. Windows R may print `C.UTF-8` startup
warnings while the scripts still complete successfully.

## Limits

The repository is currently inside a parent tree with no commits. Do not record
a commit hash in a session log until a focused commit exists.

## Related Code or Enforcement

- `DESCRIPTION`
- `.gitignore`
- `.Rbuildignore`
- `scripts/week1_2026.R`
- `backtest_fbg_2023_2025/scripts/run_all.R`
- `backtest_fbg_2023_2025/README.md`
