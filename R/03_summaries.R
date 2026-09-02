ff_quantile <- function(x, probability) {
  if (length(x) == 0L) return(NA_real_)
  as.numeric(stats::quantile(x, probs = probability, names = FALSE, type = 7))
}

ff_outcome_summary <- function(x, top_n) {
  active_scores <- x$projected_score[x$active == 1L]
  list(
    n_simulations = nrow(x),
    mean = mean(x$projected_score),
    median = stats::median(x$projected_score),
    p10 = ff_quantile(x$projected_score, 0.10),
    p15 = ff_quantile(x$projected_score, 0.15),
    p25 = ff_quantile(x$projected_score, 0.25),
    p75 = ff_quantile(x$projected_score, 0.75),
    p85 = ff_quantile(x$projected_score, 0.85),
    p90 = ff_quantile(x$projected_score, 0.90),
    probability_zero = mean(x$projected_score == 0),
    probability_active = mean(x$active == 1L),
    probability_top_12 = mean(x$realized_rank <= top_n),
    active_mean = if (length(active_scores)) mean(active_scores) else NA_real_,
    active_median = if (length(active_scores)) stats::median(active_scores) else NA_real_,
    active_p10 = if (length(active_scores)) ff_quantile(active_scores, 0.10) else NA_real_,
    active_p15 = if (length(active_scores)) ff_quantile(active_scores, 0.15) else NA_real_,
    active_p85 = if (length(active_scores)) ff_quantile(active_scores, 0.85) else NA_real_,
    active_p90 = if (length(active_scores)) ff_quantile(active_scores, 0.90) else NA_real_
  )
}

#' Summarize weekly and season player outcomes
#'
#' Weekly percentiles include missed games and bye weeks. The `active_*`
#' columns summarize points only for draws in which the player was active.
#'
#' @param draws A table from [simulate_player_outcomes], or a compatible draw table.
#' @param top_n Rank threshold for `probability_top_12`.
#'
#' @return A list with `weekly`, `season_draws`, and `season` data frames.
#' @export
summarize_player_outcomes <- function(draws, top_n = 12L) {
  ff_validate_draws(draws)
  if (length(top_n) != 1L || is.na(top_n) || top_n < 1 || top_n != as.integer(top_n)) {
    stop("`top_n` must be a positive integer.", call. = FALSE)
  }

  d <- data.table::as.data.table(data.table::copy(draws))
  d[, realized_rank := data.table::frank(-projected_score, ties.method = "min"), by = c("simulation_id", "week", "position")]
  group_columns <- c("player_id", "player_name", "position", "team", "week")
  weekly <- d[
    , data.table::as.data.table(ff_outcome_summary(.SD, top_n)),
    by = group_columns
  ]

  season_draws <- d[
    , list(
      season_score = sum(projected_score),
      games_played = sum(active)
    ),
    by = c("simulation_id", "player_id", "player_name", "position", "team")
  ]
  season_group_columns <- c("player_id", "player_name", "position", "team")
  season <- season_draws[
    , list(
      n_simulations = .N,
      season_mean = mean(season_score),
      season_median = stats::median(season_score),
      season_p10 = ff_quantile(season_score, 0.10),
      season_p15 = ff_quantile(season_score, 0.15),
      season_p85 = ff_quantile(season_score, 0.85),
      season_p90 = ff_quantile(season_score, 0.90),
      expected_games_played = mean(games_played)
    ),
    by = season_group_columns
  ]

  list(
    weekly = data.table::setDF(weekly),
    season_draws = data.table::setDF(season_draws),
    season = data.table::setDF(season)
  )
}

#' Evaluate interval coverage and availability calibration
#'
#' Use this function with out-of-sample realized scores. The 50 percent
#' interval uses `p25` and `p75`. The 70 percent interval uses `p15` and
#' `p85`. The 80 percent interval uses `p10` and `p90`.
#'
#' @param predictions A weekly summary table from [summarize_player_outcomes].
#' @param realized A data frame with `player_id`, `week`, and `actual_score`.
#' @param levels Interval levels. The default checks 50 percent and 80 percent coverage.
#' @param group_by Columns used to report coverage, such as `position`.
#'
#' @return A list with `interval_coverage` and `zero_calibration` tables.
#' @export
evaluate_interval_coverage <- function(
    predictions,
    realized,
    levels = c(0.50, 0.80),
    group_by = "position") {
  ff_require_data_frame(predictions, "predictions")
  ff_require_data_frame(realized, "realized")
  ff_require_columns(predictions, c("player_id", "week"), "predictions")
  ff_require_columns(realized, c("player_id", "week", "actual_score"), "realized")
  if (length(levels) == 0L || anyNA(levels) || any(levels <= 0 | levels >= 1)) {
    stop("`levels` must contain values between 0 and 1.", call. = FALSE)
  }
  if (!all(group_by %in% names(predictions))) {
    stop("`group_by` contains a column that is missing from `predictions`.", call. = FALSE)
  }
  if (anyDuplicated(realized[c("player_id", "week")])) {
    stop("`realized` must contain one score per player and week.", call. = FALSE)
  }

  joined <- merge(
    realized,
    predictions,
    by = c("player_id", "week"),
    all = FALSE,
    sort = FALSE
  )
  if (nrow(joined) == 0L) {
    stop("`predictions` and `realized` have no matching player-week rows.", call. = FALSE)
  }

  interval_rows <- lapply(levels, function(level) {
    lower_probability <- (1 - level) / 2
    upper_probability <- 1 - lower_probability
    lower_column <- paste0("p", round(lower_probability * 100))
    upper_column <- paste0("p", round(upper_probability * 100))
    ff_require_columns(joined, c(lower_column, upper_column), "predictions")

    x <- joined[!is.na(joined[[lower_column]]) & !is.na(joined[[upper_column]]), , drop = FALSE]
    if (nrow(x) == 0L) return(NULL)
    x$covered <- x$actual_score >= x[[lower_column]] & x$actual_score <= x[[upper_column]]
    grouped <- data.table::as.data.table(x)[
      , list(
        target_coverage = level,
        observed_coverage = mean(covered),
        coverage_error = mean(covered) - level,
        mean_interval_width = mean(get(upper_column) - get(lower_column)),
        n = .N
      ),
      by = group_by
    ]
    data.table::setDF(grouped)
  })
  interval_coverage <- do.call(rbind, interval_rows[!vapply(interval_rows, is.null, logical(1))])
  rownames(interval_coverage) <- NULL

  zero_calibration <- NULL
  if ("probability_zero" %in% names(joined)) {
    z <- data.table::as.data.table(joined)
    z[, actual_zero := as.integer(actual_score == 0)]
    zero_calibration <- z[
      , list(
        predicted_zero = mean(probability_zero),
        observed_zero = mean(actual_zero),
        brier_score = mean((probability_zero - actual_zero)^2),
        n = .N
      ),
      by = group_by
    ]
    zero_calibration <- data.table::setDF(zero_calibration)
  }

  list(
    interval_coverage = interval_coverage,
    zero_calibration = zero_calibration
  )
}
