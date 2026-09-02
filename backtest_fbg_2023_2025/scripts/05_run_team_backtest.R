#!/usr/bin/env Rscript

source(file.path(dirname(dirname(normalizePath(sub("^--file=", "", grep("^--file=", commandArgs(FALSE), value = TRUE)[[1L]]), winslash = "/"))), "R", "common.R"), local = TRUE)
source(path_in_project("R", "simulation.R"), local = TRUE)
source(path_in_project("R", "evaluation.R"), local = TRUE)
require_packages(c("data.table", "arrow"))

args <- commandArgs(trailingOnly = TRUE)
if (has_cli_flag(args, "--help")) {
  cat("Build team fantasy simulations, calibrate them to game margins, and score the results.\n\nUsage:\n  Rscript scripts/05_run_team_backtest.R\n")
  quit(status = 0L)
}

team_draws <- read_parquet_local(path_in_project("outputs", "team_draws.parquet"))
player_predictions <- read_parquet_local(path_in_project("outputs", "player_predictions.parquet"))
check_columns(team_draws, c("season", "week", "simulation_id", "team", "team_fantasy_points"), "team draws")
check_columns(player_predictions, c("season", "week", "team", "actual_score"), "player predictions")
team_draws[, team := normalize_team(team)]

schedules <- data.table::rbindlist(lapply(BACKTEST_YEARS, function(season) read_parquet_local(schedule_raw_path(season))), fill = TRUE)
schedules <- schedules[game_type == "REG" & week %in% BACKTEST_WEEKS]
schedules[, `:=`(
  away_team = normalize_team(away_team),
  home_team = normalize_team(home_team),
  actual_margin = as_numeric_or_na(result),
  actual_home_win = as.integer(as_numeric_or_na(result) > 0)
)]

# Create zero-valued rows for teams with no FBG-projected skill player.
# This preserves all schedule games and makes missing projection coverage visible.
team_keys <- unique(data.table::rbindlist(list(
  schedules[, .(season, week, team = home_team)],
  schedules[, .(season, week, team = away_team)]
)))
simulation_keys <- unique(team_draws[, .(season, week, simulation_id)])
team_grid <- merge(simulation_keys, team_keys, by = c("season", "week"), allow.cartesian = TRUE)
team_draws <- merge(team_grid, team_draws, by = c("season", "week", "simulation_id", "team"), all.x = TRUE)
team_draws[is.na(team_fantasy_points), team_fantasy_points := 0]
team_draws[is.na(n_players), n_players := 0L]
write_parquet_local(team_draws, path_in_project("outputs", "team_draws.parquet"))

team_summary <- summarize_team_draws(team_draws)
actual_projected <- player_predictions[
  , .(
    actual_projected_player_points = sum(actual_score, na.rm = TRUE),
    projected_player_count = .N
  ),
  by = .(season, week, team)
]
team_summary <- merge(team_summary, actual_projected, by = c("season", "week", "team"), all.x = TRUE)
team_summary[is.na(actual_projected_player_points), actual_projected_player_points := 0]
team_summary[is.na(projected_player_count), projected_player_count := 0L]
team_actual_path <- path_in_project("data", "derived", "team_actuals.parquet")
if (file.exists(team_actual_path)) {
  team_actual <- read_parquet_local(team_actual_path)
  team_summary <- merge(team_summary, team_actual, by = c("season", "week", "team"), all.x = TRUE)
}

home <- team_draws[
  schedules,
  on = .(season, week, team = home_team),
  .(game_id = i.game_id, season = i.season, week = i.week, simulation_id, home_fantasy = x.team_fantasy_points),
  nomatch = 0L
]
away <- team_draws[
  schedules,
  on = .(season, week, team = away_team),
  .(game_id = i.game_id, season = i.season, week = i.week, simulation_id, away_fantasy = x.team_fantasy_points),
  nomatch = 0L
]
game_sims <- merge(home, away, by = c("game_id", "season", "week", "simulation_id"), all = FALSE)
game_sims[, team_diff := home_fantasy - away_fantasy]

game_features <- game_sims[
  , .(
    team_diff_p15 = stats::quantile(team_diff, 0.15, names = FALSE, type = 7),
    team_diff_p50 = stats::quantile(team_diff, 0.50, names = FALSE, type = 7),
    team_diff_p85 = stats::quantile(team_diff, 0.85, names = FALSE, type = 7),
    team_diff_mean = mean(team_diff),
    n_simulations = data.table::uniqueN(simulation_id)
  ),
  by = .(game_id, season, week)
]
game_features <- merge(
  game_features,
  schedules[, .(game_id, away_team, home_team, spread_line, total_line, actual_margin, actual_home_win, away_score, home_score)],
  by = "game_id",
  all.x = TRUE
)

prediction_parts <- list()
calibration_parts <- list()
set.seed(20260902L)
for (target_season in BACKTEST_YEARS) {
  training_seasons <- sort(setdiff(BACKTEST_YEARS, target_season))
  calibration <- fit_team_calibration(game_features, training_seasons)
  calibration_parts[[length(calibration_parts) + 1L]] <- data.table::data.table(
    target_season = target_season,
    sim_intercept = calibration$sim_intercept,
    sim_beta = calibration$sim_beta,
    sim_residual_sd = calibration$sim_residual_sd,
    blend_residual_sd = calibration$blend_residual_sd,
    market_residual_sd = calibration$market_residual_sd,
    n_training_games = calibration$n_training_games,
    training_seasons = calibration$training_seasons
  )
  current <- data.table::copy(game_features[season == target_season])
  current[, `:=`(
    sim_margin_p15 = calibration$sim_intercept + calibration$sim_beta * team_diff_p15,
    sim_margin_p50 = calibration$sim_intercept + calibration$sim_beta * team_diff_p50,
    sim_margin_p85 = calibration$sim_intercept + calibration$sim_beta * team_diff_p85,
    market_margin_p50 = spread_line
  )]
  if (!is.null(calibration$blend_model)) {
    current[, `:=`(
      blend_margin_p15 = as.numeric(stats::predict(calibration$blend_model, newdata = data.frame(spread_line = spread_line, team_diff_p50 = team_diff_p15))),
      blend_margin_p50 = as.numeric(stats::predict(calibration$blend_model, newdata = data.frame(spread_line = spread_line, team_diff_p50 = team_diff_p50))),
      blend_margin_p85 = as.numeric(stats::predict(calibration$blend_model, newdata = data.frame(spread_line = spread_line, team_diff_p50 = team_diff_p85)))
    )]
  } else {
    current[, `:=`(blend_margin_p15 = sim_margin_p15, blend_margin_p50 = sim_margin_p50, blend_margin_p85 = sim_margin_p85)]
  }

  current[, `:=`(
    sim_home_win_probability = stats::pnorm(sim_margin_p50 / calibration$sim_residual_sd),
    market_home_win_probability = stats::pnorm(market_margin_p50 / calibration$market_residual_sd),
    blend_home_win_probability = stats::pnorm(blend_margin_p50 / calibration$blend_residual_sd),
    calibration_training_seasons = paste(training_seasons, collapse = ","),
    calibration_training_games = calibration$n_training_games
  )]

  for (current_game_id in current$game_id) {
    draws <- game_sims[game_id == current_game_id]
    if (!nrow(draws)) next
    row_index <- which(current$game_id == current_game_id)[[1L]]
    residual <- stats::rnorm(nrow(draws), mean = 0, sd = calibration$sim_residual_sd)
    margin_draws <- calibration$sim_intercept + calibration$sim_beta * draws$team_diff + residual
    current$sim_margin_p15[[row_index]] <- stats::quantile(margin_draws, 0.15, names = FALSE, type = 7)
    current$sim_margin_p50[[row_index]] <- stats::quantile(margin_draws, 0.50, names = FALSE, type = 7)
    current$sim_margin_p85[[row_index]] <- stats::quantile(margin_draws, 0.85, names = FALSE, type = 7)
    current$sim_home_win_probability[[row_index]] <- mean(margin_draws > 0)
    if (!is.null(calibration$blend_model)) {
      blend_draws <- as.numeric(stats::predict(
        calibration$blend_model,
        newdata = data.frame(
          spread_line = rep(current$spread_line[[row_index]], nrow(draws)),
          team_diff_p50 = draws$team_diff
        )
      )) + stats::rnorm(nrow(draws), mean = 0, sd = calibration$blend_residual_sd)
      current$blend_margin_p15[[row_index]] <- stats::quantile(blend_draws, 0.15, names = FALSE, type = 7)
      current$blend_margin_p50[[row_index]] <- stats::quantile(blend_draws, 0.50, names = FALSE, type = 7)
      current$blend_margin_p85[[row_index]] <- stats::quantile(blend_draws, 0.85, names = FALSE, type = 7)
      current$blend_home_win_probability[[row_index]] <- mean(blend_draws > 0)
    }
  }
  prediction_parts[[length(prediction_parts) + 1L]] <- current
}

games <- data.table::rbindlist(prediction_parts, fill = TRUE, use.names = TRUE)
calibrations <- data.table::rbindlist(calibration_parts, fill = TRUE, use.names = TRUE)
metrics <- evaluate_team_predictions(games)

write_parquet_local(team_summary, path_in_project("outputs", "team_predictions.parquet"))
write_parquet_local(games, path_in_project("outputs", "game_predictions.parquet"))
write_csv_local(calibrations, path_in_project("outputs", "team_calibration.csv"))
write_csv_local(metrics, path_in_project("outputs", "team_metrics.csv"))

message("Team summary rows: ", format(nrow(team_summary), big.mark = ","))
message("Game prediction rows: ", format(nrow(games), big.mark = ","))
message("Team backtest complete.")
