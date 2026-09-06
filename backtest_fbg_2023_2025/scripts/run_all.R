#!/usr/bin/env Rscript

file_arg <- grep("^--file=", commandArgs(trailingOnly = FALSE), value = TRUE)
if (length(file_arg) != 1L) stop("Run this script with Rscript.", call. = FALSE)
script_dir <- dirname(normalizePath(sub("^--file=", "", file_arg[[1L]]), winslash = "/"))
rscript <- file.path(R.home("bin"), "Rscript.exe")
if (!file.exists(rscript)) rscript <- file.path(R.home("bin"), "Rscript")

run <- function(script, script_args = character()) {
  script_path <- normalizePath(file.path(script_dir, script), winslash = "/")
  status <- system2(rscript, c(shQuote(script_path), script_args))
  if (!identical(as.integer(status), 0L)) stop("Stage failed: ", script, call. = FALSE)
}

run("01_download_fbg.R")
run("02_download_nflreadr.R")
run("03_build_panel.R")
run("04_run_player_backtest.R")
run("05_run_team_backtest.R")
run("06_make_plots.R")
message("Full PPR player, team, and chart backtest finished.")
