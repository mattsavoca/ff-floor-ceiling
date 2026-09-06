# Rank-conditioned player and team simulation helpers.

make_scoring_history <- function(stats) {
  scored <- score_nflreadr_weekly(stats)
  scored[, .(
    gsis_id = as.character(player_id),
    position = toupper(as.character(position)),
    week = as.integer(week),
    season = as.integer(season),
    team = as.character(team),
    points = as.numeric(actual_score)
  )]
}

# Fit the historical team environment that links QB scoring to the projected
# skill positions. The target season is excluded by construction.
fit_qb_skill_model <- function(scoring_history, target_season) {
  check_columns(scoring_history, c("gsis_id", "position", "week", "season", "team", "points"), "scoring history")
  history <- scoring_history_before(scoring_history, target_season)
  history <- history[toupper(as.character(position)) %in% BACKTEST_POSITIONS]
  totals <- data.table::as.data.table(data.table::copy(history))
  totals[, position := toupper(as.character(position))]
  totals <- totals[position %in% c("QB", "RB", "WR", "TE") & !is.na(team)]
  totals <- totals[, .(points = sum(points, na.rm = TRUE)), by = .(season, week, team, position)]
  wide <- data.table::dcast(
    totals,
    season + week + team ~ position,
    value.var = "points",
    fill = 0
  )
  for (position in c("QB", "RB", "WR", "TE")) {
    if (!position %in% names(wide)) wide[, (position) := 0]
  }
  if (nrow(wide) < 20L) abort("At least 20 historical team-weeks are required for QB conditioning.")
  model <- stats::lm(QB ~ RB + WR + TE, data = wide)
  structure(
    list(
      coefficients = stats::coef(model),
      training_rows = nrow(wide),
      training_seasons = sort(unique(wide$season)),
      r_squared = unname(summary(model)$r.squared)
    ),
    class = "ff_qb_skill_model"
  )
}

condition_qb_scores <- function(scores, players, model, strength = 0.35) {
  if (!inherits(model, "ff_qb_skill_model")) abort("model must be an ff_qb_skill_model.")
  if (!is.matrix(scores) || nrow(scores) < 2L) abort("scores must be a matrix with at least two simulations.")
  check_columns(players, c("position", "team"), "week players")
  if (ncol(scores) != nrow(players)) abort("scores and players have different player counts.")
  if (length(strength) != 1L || !is.finite(strength) || strength < 0 || strength > 1) {
    abort("strength must be between 0 and 1.")
  }
  if (strength == 0 || !any(toupper(players$position) == "QB")) return(scores)

  skill_positions <- c("RB", "WR", "TE")
  teams <- sort(unique(as.character(players$team)))
  if (length(teams) < 2L) return(scores)
  beta <- model$coefficients
  # Build the prediction by position so missing coefficients cannot silently
  # change the contract when a model is serialized or inspected.
  predicted <- matrix(beta[["(Intercept)"]], nrow = nrow(scores), ncol = length(teams))
  for (position in skill_positions) {
    position_skill <- vapply(teams, function(team) {
      indexes <- which(as.character(players$team) == team & toupper(players$position) == position)
      if (!length(indexes)) return(rep(0, nrow(scores)))
      rowSums(scores[, indexes, drop = FALSE])
    }, numeric(nrow(scores)))
    predicted <- predicted + beta[[position]] * position_skill
  }
  environment_z <- matrix(0, nrow = nrow(scores), ncol = length(teams))
  for (simulation_id in seq_len(nrow(scores))) {
    values <- predicted[simulation_id, ]
    scale <- stats::sd(values)
    if (is.finite(scale) && scale > 0) environment_z[simulation_id, ] <- (values - mean(values)) / scale
  }
  for (index in which(toupper(players$position) == "QB")) {
    baseline <- scores[, index]
    baseline_scale <- stats::sd(baseline)
    team_index <- match(as.character(players$team[[index]]), teams)
    if (!is.finite(baseline_scale) || baseline_scale == 0 || is.na(team_index)) next
    baseline_z <- (baseline - mean(baseline)) / baseline_scale
    combined_z <- sqrt(1 - strength^2) * baseline_z + strength * environment_z[, team_index]
    scores[, index] <- mean(baseline) + baseline_scale * combined_z
  }
  scores
}

simulate_player_week_conditioned <- function(players, pool, n_simulations = 1000L,
                                              sd_multiplier = 0.5,
                                              qb_skill_model = NULL,
                                              qb_conditioning_strength = 0.35) {
  simulation <- simulate_player_week(players, pool, n_simulations, sd_multiplier)
  if (!is.null(qb_skill_model)) {
    simulation$scores <- condition_qb_scores(
      simulation$scores, players, qb_skill_model, qb_conditioning_strength
    )
  }
  simulation
}

assert_scoring_history_precedes_target <- function(scoring_history, target_season) {
  check_columns(scoring_history, c("gsis_id", "week", "season", "points"), "scoring history")
  if (length(target_season) != 1L || is.na(target_season) ||
      !is.finite(target_season) || target_season != as.integer(target_season)) {
    abort("target_season must be one finite integer.")
  }
  seasons <- sort(unique(as.integer(scoring_history$season)))
  seasons <- seasons[!is.na(seasons)]
  if (!length(seasons)) abort("Scoring history has no valid seasons.")
  invalid <- seasons[seasons >= as.integer(target_season)]
  if (length(invalid)) {
    abort(
      "Scoring history for target season ", target_season,
      " contains target or future seasons: ", paste(invalid, collapse = ","), "."
    )
  }
  invisible(scoring_history)
}

scoring_history_before <- function(scoring_history, target_season) {
  check_columns(scoring_history, c("gsis_id", "week", "season", "points"), "scoring history")
  x <- data.table::as.data.table(data.table::copy(scoring_history))[
    season < as.integer(target_season) & !is.na(gsis_id) &
      is.finite(week) & is.finite(points)
  ]
  assert_scoring_history_precedes_target(x, target_season)
  x
}

ffsimulator_outcomes_to_pool <- function(adp_outcomes, positions = BACKTEST_POSITIONS) {
  check_columns(adp_outcomes, c("pos", "rank", "week_outcomes"), "ffsimulator outcomes")
  x <- data.table::as.data.table(data.table::copy(adp_outcomes))[
    toupper(as.character(pos)) %in% positions & is.finite(rank)
  ]
  x[, `:=`(
    position = toupper(as.character(pos)),
    rank_key = pmax(1L, as.integer(round(rank)))
  )]
  pool_rows <- x[
    , .(scores = list({
      values <- as.numeric(unlist(week_outcomes, recursive = TRUE, use.names = FALSE))
      values[is.finite(values)]
    })),
    by = .(position, rank_key)
  ]
  pool_rows <- pool_rows[lengths(scores) > 0L]
  missing_positions <- setdiff(positions, unique(pool_rows$position))
  if (length(missing_positions)) {
    abort("The ffsimulator outcome pool has no scores for: ", paste(missing_positions, collapse = ", "), ".")
  }
  by_position <- split(pool_rows, pool_rows$position)
  lapply(by_position, function(z) {
    values <- z$scores
    names(values) <- as.character(z$rank_key)
    list(
      values = values,
      ranks = sort(as.integer(z$rank_key))
    )
  })
}

make_outcome_pool <- function(
    scoring_history,
    target_season,
    positions = BACKTEST_POSITIONS,
    outcome_builder = NULL) {
  target_history <- scoring_history_before(scoring_history, target_season)
  if (is.null(outcome_builder)) {
    if (!requireNamespace("ffsimulator", quietly = TRUE)) {
      abort("Install ffsimulator to build the historical outcome pool.")
    }
    ranking_seasons <- unique(as.integer(ffsimulator::fp_rankings_history_week$season))
    target_history <- target_history[season %in% ranking_seasons]
    outcome_builder <- ffsimulator::ffs_adp_outcomes_week
  }
  assert_scoring_history_precedes_target(target_history, target_season)
  adp_outcomes <- outcome_builder(
    scoring_history = target_history,
    pos_filter = positions
  )
  pool <- ffsimulator_outcomes_to_pool(adp_outcomes, positions = positions)
  attr(pool, "scoring_history_seasons") <- sort(unique(target_history$season))
  attr(pool, "scoring_history_rows") <- nrow(target_history)
  pool
}

nearest_pool_scores <- function(position, rank, pool) {
  position_pool <- pool[[position]]
  if (is.null(position_pool)) return(numeric())
  key <- as.character(as.integer(rank))
  if (!is.null(position_pool$values[[key]])) return(position_pool$values[[key]])
  nearest <- position_pool$ranks[[which.min(abs(position_pool$ranks - as.integer(rank)))]]
  position_pool$values[[as.character(nearest)]]
}

sample_rank_conditioned_scores <- function(position, ecr, rank_sd, n_simulations, pool, sd_multiplier = 0.5) {
  if (!length(pool[[position]])) abort("No outcome pool exists for position ", position, ".")
  rank_sd <- max(0, as.numeric(rank_sd) * sd_multiplier)
  sampled_ranks <- round(stats::rnorm(n_simulations, mean = ecr, sd = rank_sd))
  sampled_ranks <- pmax(1L, as.integer(sampled_ranks))
  output <- numeric(n_simulations)
  for (rank in unique(sampled_ranks)) {
    index <- which(sampled_ranks == rank)
    scores <- nearest_pool_scores(position, rank, pool)
    if (!length(scores)) abort("The outcome pool has no scores for ", position, " rank ", rank, ".")
    output[index] <- sample(scores, length(index), replace = TRUE)
  }
  list(scores = output, ranks = sampled_ranks)
}

mean_above_threshold <- function(values, threshold) {
  values <- as.numeric(values)
  above <- values[is.finite(values) & values > as.numeric(threshold)]
  if (!length(above)) return(NA_real_)
  mean(above)
}

simulate_player_week <- function(players, pool, n_simulations = 1000L, sd_multiplier = 0.5) {
  check_columns(players, c("player_id", "player_name", "position", "team", "ecr", "rank_sd"), "week players")
  n <- nrow(players)
  if (!n) abort("No mapped players are available for this week.")
  scores <- matrix(0, nrow = n_simulations, ncol = n)
  ranks <- matrix(NA_integer_, nrow = n_simulations, ncol = n)
  for (j in seq_len(n)) {
    sampled <- sample_rank_conditioned_scores(
      position = players$position[[j]],
      ecr = players$ecr[[j]],
      rank_sd = players$rank_sd[[j]],
      n_simulations = n_simulations,
      pool = pool,
      sd_multiplier = sd_multiplier
    )
    scores[, j] <- sampled$scores
    ranks[, j] <- sampled$ranks
  }
  list(scores = scores, ranks = ranks)
}

summarize_player_week <- function(players, simulation) {
  scores <- simulation$scores
  ranks <- simulation$ranks
  p85 <- apply(scores, 2L, stats::quantile, probs = 0.85, names = FALSE, type = 7)
  mean_above_p85 <- vapply(
    seq_len(ncol(scores)),
    function(index) mean_above_threshold(scores[, index], p85[[index]]),
    numeric(1L)
  )
  output <- data.table::copy(data.table::as.data.table(players))
  output[, `:=`(
    p15 = apply(scores, 2L, stats::quantile, probs = 0.15, names = FALSE, type = 7),
    p50 = apply(scores, 2L, stats::quantile, probs = 0.50, names = FALSE, type = 7),
    p85 = p85,
    mean_above_p85 = mean_above_p85,
    p85_tail_excess = mean_above_p85 - p85,
    sim_mean = colMeans(scores),
    sim_sd = apply(scores, 2L, stats::sd),
    probability_zero = colMeans(scores == 0),
    simulated_rank_mean = colMeans(ranks),
    simulated_rank_sd = apply(ranks, 2L, stats::sd)
  )]
  output
}

aggregate_team_draws <- function(players, scores) {
  teams <- sort(unique(players$team))
  team_matrix <- vapply(teams, function(team) {
    rowSums(scores[, players$team == team, drop = FALSE])
  }, numeric(nrow(scores)))
  data.table::data.table(
    simulation_id = rep(seq_len(nrow(scores)), times = length(teams)),
    team = rep(teams, each = nrow(scores)),
    team_fantasy_points = as.vector(team_matrix)
  )
}

summarize_team_draws <- function(team_draws) {
  team_draws <- data.table::as.data.table(team_draws)
  team_draws[
    , .(
      team_p15 = stats::quantile(team_fantasy_points, 0.15, names = FALSE, type = 7),
      team_p50 = stats::quantile(team_fantasy_points, 0.50, names = FALSE, type = 7),
      team_p85 = stats::quantile(team_fantasy_points, 0.85, names = FALSE, type = 7),
      team_mean = mean(team_fantasy_points),
      n_simulations = data.table::uniqueN(simulation_id)
    ),
    by = .(season, week, team)
  ]
}
