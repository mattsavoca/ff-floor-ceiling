ff_team_ratings <- function(base_team_rating, teams) {
  if (is.null(base_team_rating)) {
    return(setNames(rep(0, length(unique(teams))), unique(teams)))
  }
  if (is.data.frame(base_team_rating)) {
    rating_column <- ff_find_column(base_team_rating, c("rating", "team_rating"), "team rating")
    ff_require_columns(base_team_rating, c("team", rating_column), "base_team_rating")
    ratings <- as.numeric(base_team_rating[[rating_column]])
    names(ratings) <- as.character(base_team_rating$team)
    return(ratings)
  }
  if (is.null(names(base_team_rating)) || any(!nzchar(names(base_team_rating)))) {
    stop("`base_team_rating` must be a named vector or a team table.", call. = FALSE)
  }
  as.numeric(base_team_rating) |> setNames(names(base_team_rating))
}

#' Summarize simulated NFL game outcomes
#'
#' Margins use the home-team perspective. The p15 and p85 columns give the
#' middle 70 percent range of simulated margins. The function accepts either
#' a game table or an object returned by [simulate_nfl_from_fantasy].
#'
#' @param games An `nflseedR` game table or an `nflseedR` simulation object.
#' @param week Week number to summarize.
#' @param game_type Optional game type filter, such as `"REG"`.
#'
#' @return A data frame with expected margin, margin range, and win
#'   probabilities for each matchup.
#' @export
summarize_nfl_game_outcomes <- function(games, week = 1L, game_type = "REG") {
  x <- if (is.list(games) && is.data.frame(games$games)) games$games else games
  ff_require_data_frame(x, "games")
  ff_require_columns(
    x,
    c("week", "away_team", "home_team", "result"),
    "games"
  )
  if (length(week) != 1L || is.na(week) || week < 1 || week != as.integer(week)) {
    stop("`week` must be a positive integer.", call. = FALSE)
  }
  keep <- as.character(x$week) == as.character(as.integer(week))
  if (!is.null(game_type) && "game_type" %in% names(x)) {
    keep <- keep & as.character(x$game_type) == as.character(game_type)
  }
  x <- x[keep & !is.na(x$result), , drop = FALSE]
  if (nrow(x) == 0L) {
    stop("`games` has no completed results for the requested week.", call. = FALSE)
  }
  if (!"sim" %in% names(x) && !"simulation_id" %in% names(x)) {
    x$sim <- seq_len(nrow(x))
  } else if (!"sim" %in% names(x)) {
    x$sim <- x$simulation_id
  }
  group_columns <- c("away_team", "home_team")
  if ("game_type" %in% names(x)) group_columns <- c("game_type", group_columns)
  out <- data.table::as.data.table(x)[
    , list(
      n_simulations = data.table::uniqueN(sim),
      expected_margin = if ("ff_expected_margin" %in% names(x)) {
        mean(ff_expected_margin, na.rm = TRUE)
      } else {
        mean(result)
      },
      median_margin = stats::median(result),
      p15_margin = ff_quantile(result, 0.15),
      p85_margin = ff_quantile(result, 0.85),
      away_win_probability = mean(result < 0),
      home_win_probability = mean(result > 0),
      tie_probability = mean(result == 0),
      predicted_winner = ifelse(mean(result > 0) >= 0.5, home_team[[1L]], away_team[[1L]])
    ),
    by = group_columns
  ]
  data.table::setDF(out)
}

#' Build an experimental nflseedR game result function
#'
#' The returned function maps team fantasy signals to expected margins. It
#' keeps the signal layer separate from `nflseedR` and does not apply player
#' correlations.
#'
#' @param team_signals A table from [standardize_team_fantasy].
#' @param base_team_rating Optional named team ratings or team table.
#' @param beta Change in expected margin for a one standard deviation team signal.
#' @param home_field Home field margin added to games marked `Home`.
#' @param margin_sd Standard deviation of the simulated margin.
#' @param missing_signal Use `"error"` or replace missing signals with zero.
#'
#' @return A function with the signature required by `nflseedR::nfl_simulations()`.
#' @export
make_nflseedr_compute_results <- function(
    team_signals,
    base_team_rating = NULL,
    beta = 3,
    home_field = 1.5,
    margin_sd = 13,
    missing_signal = c("error", "zero")) {
  ff_require_data_frame(team_signals, "team_signals")
  ff_require_columns(team_signals, c("simulation_id", "week", "team", "z_team"), "team_signals")
  if (anyDuplicated(team_signals[c("simulation_id", "week", "team")])) {
    stop("`team_signals` must contain one signal per simulation, week, and team.", call. = FALSE)
  }
  if (length(beta) != 1L || is.na(beta) || !is.finite(beta)) stop("`beta` must be finite.", call. = FALSE)
  if (length(home_field) != 1L || is.na(home_field) || !is.finite(home_field)) stop("`home_field` must be finite.", call. = FALSE)
  if (length(margin_sd) != 1L || is.na(margin_sd) || !is.finite(margin_sd) || margin_sd <= 0) {
    stop("`margin_sd` must be greater than 0.", call. = FALSE)
  }
  missing_signal <- match.arg(missing_signal)

  signals <- data.table::as.data.table(data.table::copy(team_signals))
  signals[, signal_key := paste(simulation_id, week, team, sep = "\r")]
  signal_lookup <- signals$z_team
  names(signal_lookup) <- signals$signal_key

  all_teams <- unique(as.character(team_signals$team))
  ratings <- ff_team_ratings(base_team_rating, all_teams)

  compute_results <- function(teams, games, week_num, ...) {
    if (!is.data.frame(games)) stop("`games` must be a data frame.", call. = FALSE)
    ff_require_columns(games, c("sim", "game_type", "week", "away_team", "home_team", "location", "result"), "games")
    games_out <- data.table::as.data.table(data.table::copy(games))
    current <- which(as.character(games_out$week) == as.character(week_num) & is.na(games_out$result))
    if (length(current) == 0L) return(list(teams = teams, games = games_out))

    sim <- games_out$sim[current]
    week_key <- rep(as.character(week_num), length(current))
    away_key <- paste(sim, week_key, games_out$away_team[current], sep = "\r")
    home_key <- paste(sim, week_key, games_out$home_team[current], sep = "\r")
    away_z <- unname(signal_lookup[away_key])
    home_z <- unname(signal_lookup[home_key])
    missing <- is.na(away_z) | is.na(home_z)
    if (any(missing) && missing_signal == "error") {
      stop(
        "`team_signals` has no value for ", sum(missing),
        " current game team entries in week ", as.character(week_num), ".",
        call. = FALSE
      )
    }
    away_z[is.na(away_z)] <- 0
    home_z[is.na(home_z)] <- 0

    away_team <- as.character(games_out$away_team[current])
    home_team <- as.character(games_out$home_team[current])
    rating_diff <- unname(ratings[home_team]) - unname(ratings[away_team])
    rating_diff[is.na(rating_diff)] <- 0
    location <- tolower(as.character(games_out$location[current]))
    home_effect <- ifelse(location == "home", home_field, 0)
    expected_margin <- rating_diff + beta * (home_z - away_z) + home_effect
    win_probability <- stats::pnorm(expected_margin / margin_sd)
    result <- round(stats::rnorm(length(current), expected_margin, margin_sd))

    playoff <- tolower(as.character(games_out$game_type[current])) != "reg"
    tied_playoff <- playoff & result == 0
    if (any(tied_playoff)) {
      result[tied_playoff] <- ifelse(stats::runif(sum(tied_playoff)) < win_probability[tied_playoff], 1L, -1L)
    }
    games_out$result[current] <- as.integer(result)
    if (!"ff_expected_margin" %in% names(games_out)) games_out$ff_expected_margin <- NA_real_
    if (!"ff_win_probability" %in% names(games_out)) games_out$ff_win_probability <- NA_real_
    games_out$ff_expected_margin[current] <- expected_margin
    games_out$ff_win_probability[current] <- win_probability

    list(teams = teams, games = games_out)
  }

  class(compute_results) <- c("ff_nflseedr_compute_results", "function")
  compute_results
}

#' Simulate NFL outcomes from fantasy team signals
#'
#' This is a small downstream experiment around [nflseedR::nfl_simulations()].
#' Use regular-season simulations until game-level dependence is calibrated.
#'
#' @param games An `nflseedR` schedule with missing results.
#' @param team_signals A table from [standardize_team_fantasy].
#' @param simulations Number of NFL seasons to simulate.
#' @param chunks Number of `nflseedR` chunks.
#' @param verify Run `nflseedR::simulations_verify_fct()` before the simulation.
#' @param base_team_rating Optional named team ratings or team table.
#' @param beta Change in expected margin for a one standard deviation team signal.
#' @param home_field Home field margin added to games marked `Home`.
#' @param margin_sd Standard deviation of the simulated margin.
#' @param missing_signal Use `"error"` or replace missing signals with zero.
#' @param ... Additional arguments passed to `nflseedR::nfl_simulations()`.
#'
#' @return An `nflseedR_simulation` object.
#' @export
simulate_nfl_from_fantasy <- function(
    games,
    team_signals,
    simulations = 100L,
    chunks = 1L,
    verify = TRUE,
    base_team_rating = NULL,
    beta = 3,
    home_field = 1.5,
    margin_sd = 13,
    missing_signal = "error",
    ...) {
  if (!requireNamespace("nflseedR", quietly = TRUE)) {
    stop("Install `nflseedR` to simulate NFL outcomes.", call. = FALSE)
  }
  if (length(simulations) != 1L || is.na(simulations) || simulations < 1 || simulations != as.integer(simulations)) {
    stop("`simulations` must be a positive integer.", call. = FALSE)
  }
  if (length(chunks) != 1L || is.na(chunks) || chunks < 1 || chunks != as.integer(chunks) || simulations %% chunks != 0) {
    stop("`chunks` must be a positive integer that divides `simulations`.", call. = FALSE)
  }
  compute_results <- make_nflseedr_compute_results(
    team_signals = team_signals,
    base_team_rating = base_team_rating,
    beta = beta,
    home_field = home_field,
    margin_sd = margin_sd,
    missing_signal = missing_signal
  )

  if (isTRUE(verify)) {
    ff_require_data_frame(games, "games")
    ff_require_columns(games, c("week", "away_team", "home_team", "result"), "games")
    simulation_args <- list(...)
    verify_games <- games
    if (identical(simulation_args$sim_include, "REG") && "game_type" %in% names(verify_games)) {
      verify_games <- verify_games[verify_games$game_type == "REG", , drop = FALSE]
    }
    verify_games$sim <- 1L
    verify_teams <- data.frame(
      sim = 1L,
      team = unique(c(as.character(games$away_team), as.character(games$home_team))),
      stringsAsFactors = FALSE
    )
    verify_teams <- verify_teams[!is.na(verify_teams$team), , drop = FALSE]
    nflseedR::simulations_verify_fct(
      compute_results = compute_results,
      games = verify_games,
      teams = verify_teams
    )
  }

  nflseedR::nfl_simulations(
    games = games,
    compute_results = compute_results,
    simulations = as.integer(simulations),
    chunks = as.integer(chunks),
    ...
  )
}
