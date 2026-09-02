#' Aggregate player draws by NFL team
#'
#' @param draws A table from [simulate_player_outcomes].
#' @return One row per simulation, week, and team.
#' @export
aggregate_team_fantasy <- function(draws) {
  ff_validate_draws(draws)
  d <- data.table::as.data.table(data.table::copy(draws))
  out <- d[
    , list(
      team_fantasy_total = sum(projected_score),
      active_players = sum(active)
    ),
    by = c("simulation_id", "week", "team")
  ]
  data.table::setDF(out)
}

ff_team_reference <- function(data, value, column, label) {
  if (is.null(value)) return(NULL)
  if (is.data.frame(value)) {
    ff_require_columns(value, c("team", column), label)
    if (anyDuplicated(value[c("team")])) {
      stop("`", label, "` must contain one value per team.", call. = FALSE)
    }
    reference <- data.frame(
      team = as.character(value$team),
      value = as.numeric(value[[column]]),
      stringsAsFactors = FALSE
    )
    names(reference)[2] <- column
    return(reference)
  }
  if (length(value) == 1L) {
    return(data.frame(team = unique(data$team), value = as.numeric(value), stringsAsFactors = FALSE) |>
      setNames(c("team", column)))
  }
  if (is.null(names(value)) || any(!nzchar(names(value)))) {
    stop("`", label, "` must be a scalar, a named vector, or a team table.", call. = FALSE)
  }
  data.frame(team = names(value), value = as.numeric(value), stringsAsFactors = FALSE) |>
    setNames(c("team", column))
}

#' Standardize team fantasy totals for the NFL model
#'
#' The default reference values come from the current simulated sample. Supply
#' team reference tables to use historical expected totals and standard deviations.
#'
#' @param team_draws A table from [aggregate_team_fantasy].
#' @param expected Optional scalar, named vector, or table with `team` and
#'   `expected_team_total`.
#' @param historical_sd Optional scalar, named vector, or table with `team` and
#'   `historical_sd`.
#'
#' @return A table with `z_team`, the standardized team fantasy signal.
#' @export
standardize_team_fantasy <- function(team_draws, expected = NULL, historical_sd = NULL) {
  ff_require_data_frame(team_draws, "team_draws")
  ff_require_columns(team_draws, c("simulation_id", "week", "team", "team_fantasy_total"), "team_draws")
  if (nrow(team_draws) == 0L) stop("`team_draws` must contain at least one row.", call. = FALSE)
  d <- data.table::as.data.table(data.table::copy(team_draws))

  expected_reference <- ff_team_reference(d, expected, "expected_team_total", "expected")
  if (is.null(expected_reference)) {
    d[, expected_team_total := mean(team_fantasy_total), by = c("team", "week")]
  } else if (nrow(expected_reference) == length(unique(d$team))) {
    d <- merge(d, expected_reference, by = "team", all.x = TRUE, sort = FALSE)
  } else {
    ff_require_columns(expected_reference, c("team", "expected_team_total"), "expected")
    d <- merge(d, expected_reference, by = "team", all.x = TRUE, sort = FALSE)
  }

  sd_reference <- ff_team_reference(d, historical_sd, "historical_sd", "historical_sd")
  if (is.null(sd_reference)) {
    d[, historical_sd := stats::sd(team_fantasy_total), by = c("team", "week")]
  } else {
    d <- merge(d, sd_reference, by = "team", all.x = TRUE, sort = FALSE)
  }

  if (anyNA(d$expected_team_total) || anyNA(d$historical_sd)) {
    stop("Every team needs an expected total and a historical standard deviation.", call. = FALSE)
  }
  d[, z_team := ifelse(is.finite(historical_sd) & historical_sd > 0,
                       (team_fantasy_total - expected_team_total) / historical_sd,
                       0)]
  data.table::setorderv(d, c("simulation_id", "week", "team"))
  data.table::setDF(d)
}
