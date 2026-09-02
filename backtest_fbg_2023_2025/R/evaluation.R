# Calibration and scoring summaries for player and team backtests.

safe_log_loss <- function(probability, outcome) {
  probability <- pmin(pmax(as.numeric(probability), 1e-6), 1 - 1e-6)
  -mean(outcome * log(probability) + (1 - outcome) * log(1 - probability), na.rm = TRUE)
}

player_interval_metrics <- function(predictions, levels = 0.70, group_by = "position") {
  check_columns(predictions, c("actual_score", "p15", "p50", "p85", "position", "season", "week"), "player predictions")
  x <- data.table::as.data.table(data.table::copy(predictions))[
    is.finite(actual_score) & is.finite(p15) & is.finite(p50) & is.finite(p85)
  ]
  if (!nrow(x)) abort("No complete player predictions are available for evaluation.")
  if (any(abs(levels - 0.70) > 1e-8)) abort("This output contains only the p15 to p85 interval, which has a 70% target.")
  summarize_group <- function(g, group_value) {
    data.table::data.table(
      interval_level = 0.70,
      n = nrow(g),
      observed_coverage = mean(g$actual_score >= g$p15 & g$actual_score <= g$p85),
      mean_interval_width = mean(g$p85 - g$p15),
      mean_absolute_error_p50 = mean(abs(g$actual_score - g$p50)),
      mean_bias_p50 = mean(g$p50 - g$actual_score),
      group = group_value
    )
  }
  output <- summarize_group(x, "all")
  if (group_by %in% names(x)) {
    grouped <- data.table::rbindlist(lapply(split(x, x[[group_by]]), function(g) {
      summarize_group(g, unique(g[[group_by]])[[1L]])
    }), fill = TRUE)
    return(data.table::rbindlist(list(output, grouped), fill = TRUE, use.names = TRUE))
  }
  output
}

fit_team_calibration <- function(games, training_seasons) {
  x <- data.table::as.data.table(data.table::copy(games))[
    season %in% training_seasons & is.finite(team_diff_p50) & is.finite(actual_margin)
  ]
  if (nrow(x) < 20L) abort("At least 20 training games are needed for team calibration.")

  sim_model <- stats::lm(actual_margin ~ team_diff_p50, data = x)
  blend_data <- x[is.finite(spread_line)]
  blend_model <- if (nrow(blend_data) >= 20L) {
    stats::lm(actual_margin ~ spread_line + team_diff_p50, data = blend_data)
  } else {
    NULL
  }
  market_residual <- x[is.finite(spread_line), actual_margin - spread_line]
  list(
    sim_intercept = unname(stats::coef(sim_model)[[1L]]),
    sim_beta = unname(stats::coef(sim_model)[[2L]]),
    sim_residual_sd = stats::sigma(sim_model),
    blend_model = blend_model,
    blend_residual_sd = if (!is.null(blend_model)) stats::sigma(blend_model) else NA_real_,
    market_residual_sd = stats::sd(market_residual),
    n_training_games = nrow(x),
    training_seasons = paste(sort(unique(training_seasons)), collapse = ",")
  )
}

evaluate_team_predictions <- function(games) {
  x <- data.table::as.data.table(data.table::copy(games))[
    is.finite(actual_margin) & is.finite(actual_home_win)
  ]
  methods <- c("sim", "market", "blend")
  data.table::rbindlist(lapply(methods, function(method) {
    probability <- x[[paste0(method, "_home_win_probability")]]
    margin <- x[[paste0(method, "_margin_p50")]]
    data.table::data.table(
      method = method,
      n_games = nrow(x),
      mean_absolute_error_margin = mean(abs(x$actual_margin - margin), na.rm = TRUE),
      rmse_margin = sqrt(mean((x$actual_margin - margin)^2, na.rm = TRUE)),
      brier_score_home_win = mean((probability - x$actual_home_win)^2, na.rm = TRUE),
      log_loss_home_win = safe_log_loss(probability, x$actual_home_win),
      home_win_accuracy = mean((probability >= 0.5) == (x$actual_home_win == 1), na.rm = TRUE),
      against_spread_accuracy = if (all(!is.finite(x$spread_line))) NA_real_ else {
        mean((margin - x$spread_line > 0) == (x$actual_margin - x$spread_line > 0), na.rm = TRUE)
      }
    )
  }), fill = TRUE)
}
