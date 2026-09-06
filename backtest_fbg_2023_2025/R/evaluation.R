# Calibration and scoring summaries for player and team backtests.

safe_log_loss <- function(probability, outcome) {
  probability <- pmin(pmax(as.numeric(probability), 1e-6), 1 - 1e-6)
  -mean(outcome * log(probability) + (1 - outcome) * log(1 - probability), na.rm = TRUE)
}

evaluate_qb_conditioning <- function(predictions, p85_increment = 1) {
  check_columns(predictions, c("actual_score", "p15", "p50", "p85", "position", "season"), "player predictions")
  if (length(p85_increment) != 1L || !is.finite(p85_increment) || p85_increment <= 0) {
    abort("p85_increment must be one positive finite number.")
  }
  x <- data.table::as.data.table(data.table::copy(predictions))[
    toupper(as.character(position)) == "QB" &
    is.finite(actual_score) & is.finite(p15) & is.finite(p50) & is.finite(p85)
  ]
  if (!nrow(x)) abort("No complete QB predictions are available for evaluation.")
  x[, `:=`(
    p85_exceeded = actual_score > p85,
    p85_bin = round_to_increment(p85, increment = p85_increment)
  )]
  boom_cutoffs <- x[, .(boom_cutoff = stats::quantile(actual_score, 0.85, names = FALSE, type = 7)), by = season]
  x <- merge(x, boom_cutoffs, by = "season", all.x = TRUE, sort = FALSE)
  x[, boom := actual_score >= boom_cutoff]
  x[, p85_rank := data.table::frank(-p85, ties.method = "first"), by = season]
  x[, top_p85_fifth := p85_rank <= ceiling(.N * 0.20), by = season]

  pinball <- mean((0.85 - as.integer(x$actual_score < x$p85)) * (x$actual_score - x$p85))
  top <- x[top_p85_fifth == TRUE]
  detail <- x[
    , .(
      n = .N,
      observed_p85 = stats::quantile(actual_score, 0.85, names = FALSE, type = 7),
      predicted_p85 = mean(p85)
    ),
    by = p85_bin
  ]
  detail[, bias := observed_p85 - predicted_p85]
  data.table::data.table(
    n = nrow(x),
    p85_coverage = mean(!x$p85_exceeded),
    p85_coverage_error = mean(!x$p85_exceeded) - 0.85,
    p85_pinball_loss = pinball,
    p85_bin_bias = sum(detail$n * detail$bias) / sum(detail$n),
    p85_bin_abs_bias = sum(detail$n * abs(detail$bias)) / sum(detail$n),
    mean_p50 = mean(x$p50),
    p50_mae = mean(abs(x$actual_score - x$p50)),
    p50_bias = mean(x$p50 - x$actual_score),
    interval_coverage = mean(x$actual_score >= x$p15 & x$actual_score <= x$p85),
    top_p85_fifth_boom_rate = if (nrow(top)) mean(top$boom) else NA_real_,
    top_p85_fifth_boom_capture = if (sum(x$boom)) sum(top$boom) / sum(x$boom) else NA_real_,
    top_p85_fifth_boom_lift = if (mean(x$boom) > 0) mean(top$boom) / mean(x$boom) else NA_real_,
    p85_rank_spearman = stats::cor(x$p85, x$actual_score, method = "spearman")
  )
}

evaluate_qb_conditioning_by_season <- function(predictions, p85_increment = 1) {
  check_columns(predictions, c("actual_score", "p15", "p50", "p85", "position", "season"), "player predictions")
  x <- data.table::as.data.table(data.table::copy(predictions))[
    toupper(as.character(position)) == "QB" &
    is.finite(actual_score) & is.finite(p15) & is.finite(p50) & is.finite(p85)
  ]
  if (!nrow(x)) abort("No complete QB predictions are available for evaluation.")
  data.table::rbindlist(lapply(sort(unique(x$season)), function(season_value) {
    result <- evaluate_qb_conditioning(x[season == season_value], p85_increment)
    result[, season := season_value]
    result
  }), fill = TRUE)
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

player_scorecard_metrics <- function(predictions, model_name = "ffsimulator") {
  check_columns(
    predictions,
    c(
      "actual_score", "p15", "p50", "p85", "mean_above_p85", "p85_tail_excess",
      "position", "season"
    ),
    "player predictions"
  )
  assert_ppr_artifact(predictions, "player predictions")
  x <- data.table::as.data.table(data.table::copy(predictions))[
    is.finite(actual_score) & is.finite(p15) & is.finite(p50) & is.finite(p85)
  ]
  if (!nrow(x)) abort("No complete player predictions are available for the PPR scorecard.")
  x[, position := toupper(as.character(position))]

  summarize_group <- function(group, season_value, position_value) {
    actual <- as.numeric(group$actual_score)
    p15 <- as.numeric(group$p15)
    p50 <- as.numeric(group$p50)
    p85 <- as.numeric(group$p85)
    above <- actual > p85
    calibration <- if (length(unique(p85)) > 1L) {
      stats::coef(stats::lm(actual ~ p85))
    } else {
      c(`(Intercept)` = NA_real_, p85 = NA_real_)
    }
    data.table::data.table(
      model = model_name,
      scoring_format = SCORING_FORMAT,
      scoring_contract_version = SCORING_CONTRACT_VERSION,
      season = as.integer(season_value),
      position = as.character(position_value),
      n = nrow(group),
      p15_coverage = mean(actual <= p15),
      p50_coverage = mean(actual <= p50),
      p85_coverage = mean(actual <= p85),
      interval_coverage = mean(actual >= p15 & actual <= p85),
      p15_pinball_loss = mean((0.15 - as.integer(actual < p15)) * (actual - p15)),
      p50_pinball_loss = mean((0.50 - as.integer(actual < p50)) * (actual - p50)),
      p85_pinball_loss = mean((0.85 - as.integer(actual < p85)) * (actual - p85)),
      calibration_slope = unname(calibration[["p85"]]),
      calibration_intercept = unname(calibration[["(Intercept)"]]),
      p50_mae = mean(abs(actual - p50)),
      p50_rmse = sqrt(mean((actual - p50)^2)),
      p85_mae = mean(abs(actual - p85)),
      p85_rmse = sqrt(mean((actual - p85)^2)),
      low_side_miss_rate = mean(actual < p15),
      high_side_miss_rate = mean(actual > p85),
      mean_score_above_p85 = if (any(above)) mean(actual[above]) else NA_real_,
      average_tail_excess = if (any(above)) mean(actual[above] - p85[above]) else NA_real_,
      n_above_p85 = sum(above),
      predicted_mean_above_p85 = mean(group$mean_above_p85, na.rm = TRUE),
      predicted_average_tail_excess = mean(group$p85_tail_excess, na.rm = TRUE)
    )
  }

  rows <- list()
  row_index <- 0L
  add_row <- function(group, season_value, position_value) {
    row_index <<- row_index + 1L
    rows[[row_index]] <<- summarize_group(group, season_value, position_value)
  }

  add_row(x, NA_integer_, "ALL")
  for (season_value in sort(unique(x$season))) {
    season_rows <- x[season == season_value]
    add_row(season_rows, season_value, "ALL")
    for (position_value in sort(unique(season_rows$position))) {
      add_row(season_rows[position == position_value], season_value, position_value)
    }
  }
  for (position_value in sort(unique(x$position))) {
    add_row(x[position == position_value], NA_integer_, position_value)
  }
  data.table::rbindlist(rows, fill = TRUE)
}

player_p85_tail_calibration <- function(
    predictions,
    group_by = c("season", "position"),
    p85_increment = 1) {
  check_columns(
    predictions,
    c("actual_score", "p85", "mean_above_p85", "p85_tail_excess", "position", "season", "week"),
    "player predictions"
  )
  if (!length(group_by) || any(!group_by %in% names(predictions))) {
    abort("group_by must contain columns from player predictions.")
  }
  if (length(p85_increment) != 1L || !is.finite(p85_increment) || p85_increment <= 0) {
    abort("p85_increment must be one positive finite number.")
  }

  x <- data.table::as.data.table(data.table::copy(predictions))[
    is.finite(actual_score) & is.finite(p85) &
      is.finite(mean_above_p85) & is.finite(p85_tail_excess)
  ]
  if (!nrow(x)) abort("No complete p85 tail predictions are available for evaluation.")
  x[, `:=`(
    actual_above_p85 = actual_score > p85,
    actual_tail_excess = actual_score - p85,
    p85_bin = round_to_increment(p85, increment = p85_increment)
  )]

  by_columns <- c(group_by, "p85_bin")
  output <- x[
    , {
      tail_rows <- actual_above_p85
      data.table::data.table(
        n = .N,
        n_actual_above_p85 = sum(tail_rows),
        observed_coverage = mean(!tail_rows),
        observed_exceedance_rate = mean(tail_rows),
        predicted_p85 = mean(p85),
        predicted_mean_above_p85 = mean(mean_above_p85),
        predicted_p85_tail_excess = mean(p85_tail_excess),
        observed_tail_mean = if (any(tail_rows)) mean(actual_score[tail_rows]) else NA_real_,
        observed_tail_excess = if (any(tail_rows)) mean(actual_tail_excess[tail_rows]) else NA_real_,
        tail_mean_error = if (any(tail_rows)) {
          mean(actual_score[tail_rows]) - mean(mean_above_p85)
        } else {
          NA_real_
        },
        tail_excess_error = if (any(tail_rows)) {
          mean(actual_tail_excess[tail_rows]) - mean(p85_tail_excess)
        } else {
          NA_real_
        }
      )
    },
    by = by_columns
  ]
  data.table::setorderv(output, by_columns)
  output[]
}

player_p85_tail_explanation <- function(predictions, positions = BACKTEST_POSITIONS) {
  check_columns(
    predictions,
    c("actual_score", "p85", "mean_above_p85", "p85_tail_excess", "position", "season"),
    "player predictions"
  )
  x <- data.table::as.data.table(data.table::copy(predictions))[
    position %in% positions & is.finite(actual_score) & is.finite(p85) &
      is.finite(mean_above_p85) & is.finite(p85_tail_excess)
  ]
  x[, actual_above_p85 := actual_score > p85]
  seasons <- sort(unique(x$season))
  result <- list()
  result_index <- 0L

  for (target_season in seasons) {
    train <- x[season < target_season & actual_above_p85]
    test <- x[season == target_season & actual_above_p85]
    if (!nrow(train) || !nrow(test)) next

    for (position_value in positions) {
      train_position <- train[position == position_value]
      test_position <- test[position == position_value]
      if (nrow(train_position) < 20L || !nrow(test_position)) next

      p85_only_model <- stats::lm(actual_score ~ p85, data = train_position)
      p85_plus_tail_excess_model <- stats::lm(
        actual_score ~ p85 + p85_tail_excess,
        data = train_position
      )
      predictions <- list(
        p85_only_linear = as.numeric(stats::predict(p85_only_model, newdata = test_position)),
        p85_plus_prior_tail_excess = test_position$p85 +
          mean(train_position$actual_score - train_position$p85),
        mean_above_p85_raw = test_position$mean_above_p85,
        p85_plus_tail_excess_linear = as.numeric(
          stats::predict(p85_plus_tail_excess_model, newdata = test_position)
        )
      )
      for (method in names(predictions)) {
        predicted <- as.numeric(predictions[[method]])
        actual <- test_position$actual_score
        result_index <- result_index + 1L
        result[[result_index]] <- data.table::data.table(
          target_season = target_season,
          position = position_value,
          method = method,
          n_training_exceedances = nrow(train_position),
          n_test_exceedances = nrow(test_position),
          rmse = sqrt(mean((actual - predicted)^2)),
          mae = mean(abs(actual - predicted)),
          mean_error = mean(predicted - actual),
          correlation = if (length(unique(predicted)) > 1L && length(unique(actual)) > 1L) {
            stats::cor(predicted, actual)
          } else {
            NA_real_
          }
        )
      }
    }
  }

  if (!length(result)) {
    return(data.table::data.table(
      target_season = integer(), position = character(), method = character(),
      n_training_exceedances = integer(), n_test_exceedances = integer(),
      rmse = numeric(), mae = numeric(), mean_error = numeric(), correlation = numeric()
    ))
  }
  data.table::rbindlist(result, fill = TRUE)
}

fit_team_calibration <- function(games, training_seasons, target_season = NULL) {
  if (!is.null(target_season)) {
    invalid <- sort(unique(as.integer(training_seasons[training_seasons >= target_season])))
    if (length(invalid)) {
      abort(
        "Team calibration for target season ", target_season,
        " contains target or future seasons: ", paste(invalid, collapse = ","), "."
      )
    }
  }
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
