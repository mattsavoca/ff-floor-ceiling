#!/usr/bin/env Rscript

options(stringsAsFactors = FALSE, warn = 1)
suppressPackageStartupMessages({
  library(fffloorceiling)
  library(jsonlite)
})

args <- commandArgs(trailingOnly = TRUE)
read_arg <- function(name, default = NULL) {
  prefix <- paste0("--", name, "=")
  match <- args[startsWith(args, prefix)]
  if (!length(match)) return(default)
  sub(prefix, "", match[[1]], fixed = TRUE)
}

rankings_path <- read_arg("rankings")
output_path <- read_arg("out")
outcome_pool_path <- read_arg("outcome-pool")
n_simulations <- as.integer(read_arg("n-simulations", "1000"))
week <- as.integer(read_arg("week", "1"))
seed <- as.integer(read_arg("seed", "1"))

if (is.null(rankings_path) || is.null(output_path) || is.null(outcome_pool_path)) {
  stop("--rankings, --out, and --outcome-pool are required.", call. = FALSE)
}
if (!is.finite(n_simulations) || n_simulations < 100L || n_simulations > 10000L) {
  stop("--n-simulations must be an integer from 100 through 10000.", call. = FALSE)
}
if (!is.finite(week) || week < 1L || week > 18L) stop("--week must be from 1 through 18.", call. = FALSE)
if (!is.finite(seed) || seed < 0L) stop("--seed must be a non-negative integer.", call. = FALSE)

rankings <- read.csv(rankings_path, check.names = FALSE, stringsAsFactors = FALSE, colClasses = "character")
required_columns <- c("player_id", "player_name", "position", "team", "rank", "rank_uncertainty")
missing_columns <- setdiff(required_columns, names(rankings))
if (length(missing_columns)) stop("Rankings are missing columns: ", paste(missing_columns, collapse = ", "), call. = FALSE)
rankings$player_id <- as.character(rankings$player_id)
rankings$player_name <- as.character(rankings$player_name)
rankings$position <- toupper(as.character(rankings$position))
rankings$team <- toupper(as.character(rankings$team))
rankings$rank <- as.numeric(rankings$rank)
rankings$rank_uncertainty <- as.numeric(rankings$rank_uncertainty)
if (!"source_order" %in% names(rankings)) rankings$source_order <- seq_len(nrow(rankings))
rankings$source_order <- as.integer(rankings$source_order)
if (anyDuplicated(rankings$player_id)) stop("Rankings contain duplicate player IDs.", call. = FALSE)
if (any(!is.finite(rankings$rank)) || any(rankings$rank <= 0)) stop("Rankings contain invalid ranks.", call. = FALSE)
if (any(!is.finite(rankings$rank_uncertainty)) || any(rankings$rank_uncertainty < 0)) stop("Rankings contain invalid rank uncertainty.", call. = FALSE)
if (any(!is.finite(rankings$source_order)) || any(rankings$source_order < 1L)) stop("Rankings contain invalid source order values.", call. = FALSE)

outcome_pool <- readRDS(outcome_pool_path)
draws <- simulate_player_week_outcomes(
  rankings = rankings,
  adp_outcomes = outcome_pool,
  n_simulations = n_simulations,
  week = week,
  seed = seed,
  strict = TRUE
)
summary <- summarize_player_outcomes(draws)$weekly
summary$player_id <- as.character(summary$player_id)
summary <- merge(
  rankings[, c("player_id", "rank", "rank_uncertainty", "source_order"), drop = FALSE],
  summary,
  by = "player_id",
  all.x = TRUE,
  sort = FALSE,
  suffixes = c("", ".summary")
)
summary <- summary[order(summary$source_order), , drop = FALSE]
if (anyNA(summary$p15) || anyNA(summary$mean) || anyNA(summary$median) || anyNA(summary$p85)) {
  stop("The simulator returned incomplete player summaries.", call. = FALSE)
}
if (any(!is.finite(summary$probability_zero)) || any(!is.finite(summary$probability_active)) || any(summary$probability_zero < 0 | summary$probability_zero > 1) || any(summary$probability_active < 0 | summary$probability_active > 1)) {
  stop("The simulator returned invalid activity probabilities.", call. = FALSE)
}
if (any(summary$p15 > summary$median) || any(summary$median > summary$p85)) {
  stop("The simulator returned an invalid percentile order.", call. = FALSE)
}

result <- list(
  schema_version = "ffsimulator-prediction.v1",
  week = week,
  seed = seed,
  simulation_count = n_simulations,
  package_version = as.character(utils::packageVersion("ffsimulator")),
  rows = unname(lapply(seq_len(nrow(summary)), function(index) {
    row <- summary[index, , drop = FALSE]
    list(
      stable_player_id = as.character(row$player_id[[1]]),
      mean = as.numeric(row$mean[[1]]),
      median = as.numeric(row$median[[1]]),
      p15 = as.numeric(row$p15[[1]]),
      p50 = as.numeric(row$median[[1]]),
      p85 = as.numeric(row$p85[[1]]),
      probability_zero = as.numeric(row$probability_zero[[1]]),
      probability_active = as.numeric(row$probability_active[[1]]),
      n_simulations = as.integer(row$n_simulations[[1]])
    )
  }))
)
dir.create(dirname(output_path), recursive = TRUE, showWarnings = FALSE)
write_json(result, output_path, auto_unbox = TRUE, pretty = FALSE, na = "null")
