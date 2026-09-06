#!/usr/bin/env Rscript

script_file <- grep("^--file=", commandArgs(FALSE), value = TRUE)[[1L]]
backtest_root <- dirname(dirname(normalizePath(sub("^--file=", "", script_file), winslash = "/")))
source(file.path(backtest_root, "R", "common.R"), local = TRUE)
source(file.path(backtest_root, "R", "evaluation.R"), local = TRUE)
require_packages(c("data.table", "arrow"))

args <- commandArgs(trailingOnly = TRUE)
n_simulations <- as.integer(read_cli_value(args, "--n-simulations", "1000"))
strength_text <- read_cli_value(args, "--strengths", "0,0.1,0.2,0.3,0.4,0.5")
strengths <- as.numeric(strsplit(strength_text, ",", fixed = TRUE)[[1L]])
if (is.na(n_simulations) || n_simulations < 20L) abort("--n-simulations must be at least 20.")
if (!length(strengths) || any(!is.finite(strengths)) || any(strengths < 0 | strengths > 1)) {
  abort("--strengths must contain values from 0 to 1.")
}
strengths <- sort(unique(strengths))

runner <- file.path(backtest_root, "scripts", "04_run_player_backtest.R")
rscript <- file.path(R.home("bin"), if (.Platform$OS.type == "windows") "Rscript.exe" else "Rscript")
output_tags <- sprintf("_qb_calibration_s%03d", round(strengths * 100))

for (index in seq_along(strengths)) {
  status <- system2(
    rscript,
    c(
      shQuote(runner),
      "--n-simulations", as.character(n_simulations),
      "--qb-conditioning-strength", format(strengths[[index]], trim = TRUE),
      "--output-tag", output_tags[[index]]
    )
  )
  if (!identical(status, 0L)) abort("The player run failed for strength ", strengths[[index]], ".")
}

overall <- data.table::rbindlist(lapply(seq_along(strengths), function(index) {
  predictions <- read_parquet_local(path_in_project("outputs", paste0("player_predictions", output_tags[[index]], ".parquet")))
  result <- evaluate_qb_conditioning(predictions)
  result[, `:=`(
    conditioning_strength = strengths[[index]],
    n_simulations = n_simulations
  )]
  result
}), fill = TRUE)

by_season <- data.table::rbindlist(lapply(seq_along(strengths), function(index) {
  predictions <- read_parquet_local(path_in_project("outputs", paste0("player_predictions", output_tags[[index]], ".parquet")))
  result <- evaluate_qb_conditioning_by_season(predictions)
  result[, `:=`(
    conditioning_strength = strengths[[index]],
    n_simulations = n_simulations
  )]
  result
}), fill = TRUE)

data.table::setorder(overall, conditioning_strength)
data.table::setorder(by_season, conditioning_strength, season)
write_csv_local(overall, path_in_project("outputs", "qb_conditioning_calibration.csv"))
write_csv_local(by_season, path_in_project("outputs", "qb_conditioning_calibration_by_season.csv"))
message("QB conditioning calibration complete.")
