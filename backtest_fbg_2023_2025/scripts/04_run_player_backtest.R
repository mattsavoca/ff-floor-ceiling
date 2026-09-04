#!/usr/bin/env Rscript

source(file.path(dirname(dirname(normalizePath(sub("^--file=", "", grep("^--file=", commandArgs(FALSE), value = TRUE)[[1L]]), winslash = "/"))), "R", "common.R"), local = TRUE)
source(path_in_project("R", "scoring.R"), local = TRUE)
source(path_in_project("R", "simulation.R"), local = TRUE)
source(path_in_project("R", "evaluation.R"), local = TRUE)
require_packages(c("data.table", "arrow", "ffsimulator"))

usage <- function() {
  cat(paste0(
    "Run walk-forward rank-conditioned player simulations.\n\n",
    "Usage:\n",
    "  Rscript scripts/04_run_player_backtest.R [options]\n\n",
    "Options:\n",
    "  --n-simulations 1000\n",
    "  --rank-sd-multiplier 0.5\n",
    "  --help\n"
  ))
}

args <- commandArgs(trailingOnly = TRUE)
if (has_cli_flag(args, "--help")) {
  usage()
  quit(status = 0L)
}
n_simulations <- as.integer(read_cli_value(args, "--n-simulations", "1000"))
sd_multiplier <- as.numeric(read_cli_value(args, "--rank-sd-multiplier", "0.5"))
if (is.na(n_simulations) || n_simulations < 20L) abort("--n-simulations must be at least 20.")
if (!is.finite(sd_multiplier) || sd_multiplier < 0) abort("--rank-sd-multiplier must be non-negative.")

panel <- read_parquet_local(path_in_project("data", "derived", "fbg_rank_summary.parquet"))
check_columns(panel, c("season", "week", "fbg_id", "gsis_id", "position", "team", "ecr", "rank_sd", "n_projectors", "actual_score"), "FBG rank summary")
panel[, `:=`(position = toupper(position), team = normalize_team(team))]
panel <- panel[season %in% BACKTEST_YEARS & week %in% BACKTEST_WEEKS]
if (!nrow(panel)) abort("The FBG rank summary is empty. Run 03_build_panel.R first.")

scoring_seasons <- sort(unique(c(OUTCOME_HISTORY_YEARS, BACKTEST_YEARS)))
scoring_paths <- vapply(scoring_seasons, stats_raw_path, character(1L))
missing_scoring_paths <- scoring_paths[!file.exists(scoring_paths)]
if (length(missing_scoring_paths)) {
  abort(
    "Historical player statistics are missing for the scoring history. Run ",
    "02_download_nflreadr.R. First missing file: ", missing_scoring_paths[[1L]]
  )
}
scoring_stats <- data.table::rbindlist(
  lapply(scoring_paths, read_parquet_local),
  fill = TRUE,
  use.names = TRUE
)
scoring_history <- make_scoring_history(scoring_stats)

prediction_parts <- list()
team_draw_parts <- list()
metric_parts <- list()

for (target_season in BACKTEST_YEARS) {
  pool <- make_outcome_pool(scoring_history, target_season)
  training_seasons <- attr(pool, "scoring_history_seasons")
  scoring_history_rows <- attr(pool, "scoring_history_rows")
  if (!length(pool)) abort("No outcome pool exists for target season ", target_season, ".")

  for (target_week in BACKTEST_WEEKS) {
    players <- panel[
      season == target_season & week == target_week &
        !is.na(gsis_id) & !is.na(team) &
        position %in% BACKTEST_POSITIONS & n_projectors >= 3L &
        is.finite(ecr) & is.finite(rank_sd) & is.finite(actual_score)
    ]
    if (!nrow(players)) {
      warning("No mapped players for ", target_season, " week ", target_week, ".")
      next
    }
    players[, player_id := as.character(gsis_id)]
    data.table::setorder(players, position, ecr, fbg_id)
    set.seed(100000L + target_season * 100L + target_week)
    simulation <- simulate_player_week(
      players,
      pool = pool,
      n_simulations = n_simulations,
      sd_multiplier = sd_multiplier
    )
    predictions <- summarize_player_week(players, simulation)
    predictions[, `:=`(
      ffpts_rounded = round_to_half(actual_score),
      xfpts_rounded = round_to_half(p50),
      ffpts_rounded_total = round_to_increment(actual_score, increment = 1),
      xfpts_rounded_total = round_to_increment(p50, increment = 1),
      xfpts_p15 = round_to_increment(p15, increment = 1),
      xfpts_p85 = round_to_increment(p85, increment = 1),
      pool_training_seasons = paste(training_seasons, collapse = ","),
      pool_max_training_season = max(training_seasons),
      scoring_history_seasons = paste(training_seasons, collapse = ","),
      scoring_history_max_season = max(training_seasons),
      scoring_history_rows = scoring_history_rows,
      n_simulations = n_simulations,
      rank_sd_multiplier = sd_multiplier,
      pool_mode = "walk_forward_prior_seasons"
    )]
    prediction_parts[[length(prediction_parts) + 1L]] <- predictions

    team_draws <- aggregate_team_draws(players, simulation$scores)
    team_draws[, `:=`(
      season = target_season,
      week = target_week,
      n_players = nrow(players),
      rank_sd_multiplier = sd_multiplier,
      pool_max_training_season = max(training_seasons),
      scoring_history_max_season = max(training_seasons),
      pool_mode = "walk_forward_prior_seasons"
    )]
    team_draw_parts[[length(team_draw_parts) + 1L]] <- team_draws
    metric_parts[[length(metric_parts) + 1L]] <- data.table::data.table(
      season = target_season,
      week = target_week,
      projected_players = nrow(players),
      team_count = data.table::uniqueN(players$team),
      training_seasons = paste(training_seasons, collapse = ","),
      max_training_season = max(training_seasons),
      scoring_history_seasons = paste(training_seasons, collapse = ","),
      scoring_history_max_season = max(training_seasons),
      scoring_history_rows = scoring_history_rows,
      pool_mode = "walk_forward_prior_seasons",
      n_simulations = n_simulations
    )
    message(sprintf("Simulated %d week %02d: %d players, %d teams", target_season, target_week, nrow(players), data.table::uniqueN(players$team)))
  }
}

if (!length(prediction_parts)) abort("No player simulations were produced.")
predictions <- data.table::rbindlist(prediction_parts, fill = TRUE, use.names = TRUE)
team_draws <- data.table::rbindlist(team_draw_parts, fill = TRUE, use.names = TRUE)
run_metrics <- data.table::rbindlist(metric_parts, fill = TRUE, use.names = TRUE)

write_parquet_local(predictions, path_in_project("outputs", "player_predictions.parquet"))
write_parquet_local(team_draws, path_in_project("outputs", "team_draws.parquet"))
write_csv_local(run_metrics, path_in_project("outputs", "player_run_metrics.csv"))

intervals <- player_interval_metrics(predictions, group_by = "position")
write_csv_local(intervals, path_in_project("outputs", "player_interval_metrics.csv"))

message("Player predictions: ", format(nrow(predictions), big.mark = ","))
message("Team simulation draws: ", format(nrow(team_draws), big.mark = ","))
message("Player backtest complete.")
