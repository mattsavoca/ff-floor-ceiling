#' Convert normalized rankings to the ffsimulator input shape
#'
#' This adapter keeps the historical rank-conditioned outcome pools in
#' `ffsimulator` unchanged. A non-FantasyPros player ID is used as the
#' `fantasypros_id` join key for the current simulation.
#'
#' @param rankings A normalized ranking table, or a provider data frame.
#' @param source Source name when `rankings` is not normalized.
#' @param ... Arguments passed to [normalize_rankings].
#'
#' @return A data frame accepted by `ffsimulator::ffs_generate_projections()`.
#' @export
as_ffsimulator_rankings <- function(rankings, source = NULL, ...) {
  if (ff_is_normalized_rankings(rankings)) {
    normalized <- as.data.frame(rankings, stringsAsFactors = FALSE)
    ff_validate_normalized_rankings(normalized)
  } else {
    if (is.null(source)) source <- "generic"
    normalized <- normalize_rankings(rankings, source = source, ...)
  }

  out <- data.frame(
    player = normalized$player_name,
    pos = normalized$position,
    team = normalized$team,
    ecr = normalized$rank,
    sd = normalized$rank_uncertainty,
    bye = ifelse(is.na(normalized$bye_week), 0, normalized$bye_week),
    fantasypros_id = as.character(normalized$player_id),
    scrape_date = normalized$as_of,
    stringsAsFactors = FALSE,
    check.names = FALSE
  )

  attr(out, "normalized_rankings") <- normalized
  class(out) <- c("ffsimulator_rankings", class(out))
  out
}

ff_validate_adp_outcomes <- function(adp_outcomes) {
  ff_require_data_frame(adp_outcomes, "adp_outcomes")
  ff_require_columns(adp_outcomes, c("pos", "rank", "prob_gp", "week_outcomes"), "adp_outcomes")
  if (any(!vapply(adp_outcomes$week_outcomes, is.numeric, logical(1)))) {
    stop("Each `week_outcomes` value must be a numeric vector.", call. = FALSE)
  }
  invisible(adp_outcomes)
}

ff_validate_draws <- function(draws) {
  ff_require_data_frame(draws, "draws")
  ff_require_columns(
    draws,
    c("simulation_id", "player_id", "player_name", "position", "team", "week", "projected_score", "active"),
    "draws"
  )
  if (nrow(draws) == 0L) stop("`draws` must contain at least one row.", call. = FALSE)
  if (anyNA(draws$simulation_id) || anyNA(draws$player_id) || anyNA(draws$week)) {
    stop("`draws` keys cannot contain missing values.", call. = FALSE)
  }
  if (anyNA(draws$projected_score) || any(!is.finite(as.numeric(draws$projected_score)))) {
    stop("`projected_score` must contain finite values.", call. = FALSE)
  }
  if (anyNA(draws$active) || any(!as.numeric(draws$active) %in% c(0, 1))) {
    stop("`active` must contain only 0 or 1.", call. = FALSE)
  }
  invisible(draws)
}

ff_standardize_ffsimulator_draws <- function(x) {
  ff_require_columns(
    x,
    c("season", "week", "fantasypros_id", "player", "pos", "team", "rank", "projected_score", "gp_model", "bye"),
    "ffsimulator output"
  )
  data.frame(
    simulation_id = x$season,
    player_id = as.character(x$fantasypros_id),
    player_name = as.character(x$player),
    position = as.character(x$pos),
    team = as.character(x$team),
    week = x$week,
    rank = x$rank,
    projected_score = as.numeric(x$projected_score),
    active = as.integer(x$gp_model > 0 & x$week != x$bye),
    stringsAsFactors = FALSE,
    check.names = FALSE
  )
}

ff_validate_week_outcomes <- function(adp_outcomes) {
  ff_require_data_frame(adp_outcomes, "adp_outcomes")
  ff_require_columns(adp_outcomes, c("pos", "rank", "week_outcomes"), "adp_outcomes")
  if (any(!vapply(adp_outcomes$week_outcomes, is.numeric, logical(1)))) {
    stop("Each `week_outcomes` value must be a numeric vector.", call. = FALSE)
  }
  invisible(adp_outcomes)
}

ff_standardize_ffsimulator_week_draws <- function(x, week) {
  ff_require_columns(
    x,
    c("week", "fantasypros_id", "player", "pos", "team", "rank", "projected_score"),
    "ffsimulator weekly output"
  )
  data.frame(
    simulation_id = as.integer(x$week),
    player_id = as.character(x$fantasypros_id),
    player_name = as.character(x$player),
    position = as.character(x$pos),
    team = as.character(x$team),
    week = as.integer(week),
    rank = x$rank,
    projected_score = as.numeric(x$projected_score),
    active = 1L,
    stringsAsFactors = FALSE,
    check.names = FALSE
  )
}

#' Generate player outcome draws with ffsimulator
#'
#' `ffsimulator` samples a rank-conditioned historical outcome pool. This
#' function adds a stable simulation key and retains the provider-neutral IDs.
#'
#' @param rankings A normalized ranking table, or a provider data frame.
#' @param adp_outcomes An outcome pool from `ffsimulator::ffs_adp_outcomes()`.
#' @param n_simulations Number of simulated seasons.
#' @param weeks Numeric week values to sample.
#' @param seed Optional random seed.
#' @param source Source name when `rankings` is not normalized.
#' @param rosters Optional roster table with `player_id` or `fantasypros_id`.
#' @param strict If `TRUE`, error when the historical pools do not support all
#'   sampled rank draws. If `FALSE`, fill unsupported rows with zero points.
#'
#' @return A data frame with one row per player, simulation, and week.
#' @export
simulate_player_outcomes <- function(
    rankings,
    adp_outcomes,
    n_simulations = 1000L,
    weeks = 1:17,
    seed = NULL,
    source = NULL,
    rosters = NULL,
    strict = TRUE) {
  if (!requireNamespace("ffsimulator", quietly = TRUE)) {
    stop("Install `ffsimulator` to generate player outcome draws.", call. = FALSE)
  }
  if (length(n_simulations) != 1L || is.na(n_simulations) || n_simulations < 1 || n_simulations != as.integer(n_simulations)) {
    stop("`n_simulations` must be a positive integer.", call. = FALSE)
  }
  if (length(weeks) == 0L || anyNA(weeks) || any(!is.finite(as.numeric(weeks))) || any(weeks < 1) || any(weeks != as.integer(weeks))) {
    stop("`weeks` must contain positive integers.", call. = FALSE)
  }
  if (!is.logical(strict) || length(strict) != 1L || is.na(strict)) {
    stop("`strict` must be TRUE or FALSE.", call. = FALSE)
  }
  ff_validate_adp_outcomes(adp_outcomes)

  normalized <- if (ff_is_normalized_rankings(rankings)) {
    normalized <- as.data.frame(rankings, stringsAsFactors = FALSE)
    ff_validate_normalized_rankings(normalized)
    normalized
  } else {
    if (is.null(source)) source <- "generic"
    normalize_rankings(rankings, source = source)
  }

  latest_rankings <- as_ffsimulator_rankings(normalized)
  if (is.null(rosters)) {
    roster_ids <- latest_rankings$fantasypros_id
  } else if ("player_id" %in% names(rosters)) {
    roster_ids <- as.character(rosters$player_id)
  } else if ("fantasypros_id" %in% names(rosters)) {
    roster_ids <- as.character(rosters$fantasypros_id)
  } else {
    stop("`rosters` must contain `player_id` or `fantasypros_id`.", call. = FALSE)
  }
  normalized <- normalized[normalized$player_id %in% roster_ids, , drop = FALSE]
  if (nrow(normalized) == 0L) {
    stop("`rosters` does not match any ranking IDs.", call. = FALSE)
  }
  rosters_for_ffsimulator <- data.frame(fantasypros_id = roster_ids, stringsAsFactors = FALSE)

  if (!is.null(seed)) set.seed(seed)
  raw <- ffsimulator::ffs_generate_projections(
    adp_outcomes = adp_outcomes,
    latest_rankings = latest_rankings,
    n_seasons = as.integer(n_simulations),
    weeks = unique(weeks),
    rosters = rosters_for_ffsimulator
  )
  sampled <- ff_standardize_ffsimulator_draws(raw)

  expected_keys <- expand.grid(
    simulation_id = seq_len(n_simulations),
    player_id = normalized$player_id,
    week = unique(weeks),
    KEEP.OUT.ATTRS = FALSE,
    stringsAsFactors = FALSE
  )
  expected_key <- paste(expected_keys$simulation_id, expected_keys$player_id, expected_keys$week, sep = "\r")
  sampled_key <- paste(sampled$simulation_id, sampled$player_id, sampled$week, sep = "\r")
  if (anyDuplicated(sampled_key)) {
    stop("`ffsimulator` returned duplicate player draw keys.", call. = FALSE)
  }
  missing_keys <- setdiff(expected_key, sampled_key)

  if (length(missing_keys) > 0L && isTRUE(strict)) {
    stop(
      "`ffsimulator` did not return ", length(missing_keys),
      " player draws. Extend `adp_outcomes` to cover the rank uncertainty,",
      " or call with `strict = FALSE`.",
      call. = FALSE
    )
  }

  metadata <- normalized[, c("player_id", "player_name", "position", "team"), drop = FALSE]
  draws <- merge(expected_keys, metadata, by = "player_id", all.x = TRUE, sort = FALSE)
  draws <- merge(
    draws,
    sampled,
    by = c("simulation_id", "player_id", "week"),
    all.x = TRUE,
    sort = FALSE,
    suffixes = c("", ".sampled")
  )
  missing_draw <- is.na(draws$projected_score)
  draws$projected_score[missing_draw] <- 0
  draws$active[missing_draw] <- 0L
  draws$position <- ifelse(is.na(draws$position.sampled), draws$position, draws$position.sampled)
  draws$player_name <- ifelse(is.na(draws$player_name.sampled), draws$player_name, draws$player_name.sampled)
  draws$team <- ifelse(is.na(draws$team.sampled), draws$team, draws$team.sampled)
  draws$position.sampled <- NULL
  draws$player_name.sampled <- NULL
  draws$team.sampled <- NULL
  draws <- draws[order(draws$simulation_id, draws$week, draws$player_id), , drop = FALSE]
  rownames(draws) <- NULL
  ff_validate_draws(draws)
  draws
}

#' Generate one-week player outcome draws with ffsimulator
#'
#' This uses `ffsimulator::ffs_generate_projections_week()` and returns one
#' weekly score per player and simulation. The historical pool must contain
#' `pos`, `rank`, and nested numeric `week_outcomes` columns. A season pool
#' from `ffsimulator::ffs_adp_outcomes()` is also accepted because it has the
#' same rank-conditioned score columns.
#'
#' @param rankings A normalized ranking table, or a provider data frame.
#' @param adp_outcomes A weekly outcome pool from `ffsimulator`.
#' @param n_simulations Number of weekly simulations.
#' @param week Week number to attach to every returned draw.
#' @param seed Optional random seed.
#' @param source Source name when `rankings` is not normalized.
#' @param rosters Optional roster table with `player_id` or `fantasypros_id`.
#' @param strict If `TRUE`, error when the historical pool does not support all
#'   sampled rank draws. If `FALSE`, fill unsupported rows with zero points.
#'
#' @return A data frame with one row per player and simulation.
#' @export
simulate_player_week_outcomes <- function(
    rankings,
    adp_outcomes,
    n_simulations = 1000L,
    week = 1L,
    seed = NULL,
    source = NULL,
    rosters = NULL,
    strict = TRUE) {
  if (!requireNamespace("ffsimulator", quietly = TRUE)) {
    stop("Install `ffsimulator` to generate player outcome draws.", call. = FALSE)
  }
  if (length(n_simulations) != 1L || is.na(n_simulations) || n_simulations < 1 || n_simulations != as.integer(n_simulations)) {
    stop("`n_simulations` must be a positive integer.", call. = FALSE)
  }
  if (length(week) != 1L || is.na(week) || !is.finite(as.numeric(week)) || week < 1 || week != as.integer(week)) {
    stop("`week` must be a positive integer.", call. = FALSE)
  }
  if (!is.logical(strict) || length(strict) != 1L || is.na(strict)) {
    stop("`strict` must be TRUE or FALSE.", call. = FALSE)
  }
  ff_validate_week_outcomes(adp_outcomes)

  normalized <- if (ff_is_normalized_rankings(rankings)) {
    normalized <- as.data.frame(rankings, stringsAsFactors = FALSE)
    ff_validate_normalized_rankings(normalized)
    normalized
  } else {
    if (is.null(source)) source <- "generic"
    normalize_rankings(rankings, source = source)
  }

  latest_rankings <- as_ffsimulator_rankings(normalized)
  if (is.null(rosters)) {
    roster_ids <- latest_rankings$fantasypros_id
  } else if ("player_id" %in% names(rosters)) {
    roster_ids <- as.character(rosters$player_id)
  } else if ("fantasypros_id" %in% names(rosters)) {
    roster_ids <- as.character(rosters$fantasypros_id)
  } else {
    stop("`rosters` must contain `player_id` or `fantasypros_id`.", call. = FALSE)
  }
  normalized <- normalized[normalized$player_id %in% roster_ids, , drop = FALSE]
  if (nrow(normalized) == 0L) {
    stop("`rosters` does not match any ranking IDs.", call. = FALSE)
  }
  rosters_for_ffsimulator <- data.frame(fantasypros_id = roster_ids, stringsAsFactors = FALSE)

  if (!is.null(seed)) set.seed(seed)
  raw <- ffsimulator::ffs_generate_projections_week(
    adp_outcomes = adp_outcomes,
    latest_rankings = latest_rankings,
    n = as.integer(n_simulations),
    rosters = rosters_for_ffsimulator
  )
  sampled <- ff_standardize_ffsimulator_week_draws(raw, week = week)

  expected_keys <- expand.grid(
    simulation_id = seq_len(n_simulations),
    player_id = normalized$player_id,
    week = as.integer(week),
    KEEP.OUT.ATTRS = FALSE,
    stringsAsFactors = FALSE
  )
  expected_key <- paste(expected_keys$simulation_id, expected_keys$player_id, expected_keys$week, sep = "\r")
  sampled_key <- paste(sampled$simulation_id, sampled$player_id, sampled$week, sep = "\r")
  if (anyDuplicated(sampled_key)) {
    stop("`ffsimulator` returned duplicate player draw keys.", call. = FALSE)
  }
  missing_keys <- setdiff(expected_key, sampled_key)

  if (length(missing_keys) > 0L && isTRUE(strict)) {
    stop(
      "`ffsimulator` did not return ", length(missing_keys),
      " player draws. Extend `adp_outcomes` to cover the rank uncertainty,",
      " or call with `strict = FALSE`.",
      call. = FALSE
    )
  }

  metadata <- normalized[, c("player_id", "player_name", "position", "team", "bye_week"), drop = FALSE]
  draws <- merge(expected_keys, metadata, by = "player_id", all.x = TRUE, sort = FALSE)
  draws <- merge(
    draws,
    sampled,
    by = c("simulation_id", "player_id", "week"),
    all.x = TRUE,
    sort = FALSE,
    suffixes = c("", ".sampled")
  )
  missing_draw <- is.na(draws$projected_score)
  draws$projected_score[missing_draw] <- 0
  draws$active[missing_draw] <- 0L
  draws$position <- ifelse(is.na(draws$position.sampled), draws$position, draws$position.sampled)
  draws$player_name <- ifelse(is.na(draws$player_name.sampled), draws$player_name, draws$player_name.sampled)
  draws$team <- ifelse(is.na(draws$team.sampled), draws$team, draws$team.sampled)
  draws$active <- as.integer(
    draws$active == 1L &
      (is.na(draws$bye_week) | as.integer(week) != as.integer(draws$bye_week))
  )
  draws$position.sampled <- NULL
  draws$player_name.sampled <- NULL
  draws$team.sampled <- NULL
  draws$bye_week <- NULL
  draws <- draws[order(draws$simulation_id, draws$week, draws$player_id), , drop = FALSE]
  rownames(draws) <- NULL
  ff_validate_draws(draws)
  draws
}
