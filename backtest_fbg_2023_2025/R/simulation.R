# Rank-conditioned player and team simulation helpers.

make_outcome_pool <- function(panel, target_season) {
  check_columns(panel, c("season", "position", "ecr", "actual_score"), "backtest panel")
  x <- data.table::as.data.table(data.table::copy(panel))[
    season != target_season & position %in% BACKTEST_POSITIONS &
      is.finite(ecr) & is.finite(actual_score)
  ]
  x[, rank_key := pmax(1L, as.integer(round(ecr)))]
  pool <- x[
    , .(scores = list(as.numeric(actual_score))),
    by = .(position, rank_key)
  ]
  by_position <- split(pool, pool$position)
  lapply(by_position, function(z) {
    values <- z$scores
    names(values) <- as.character(z$rank_key)
    list(
      values = values,
      ranks = sort(as.integer(z$rank_key))
    )
  })
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
  output <- data.table::copy(data.table::as.data.table(players))
  output[, `:=`(
    p15 = apply(scores, 2L, stats::quantile, probs = 0.15, names = FALSE, type = 7),
    p50 = apply(scores, 2L, stats::quantile, probs = 0.50, names = FALSE, type = 7),
    p85 = apply(scores, 2L, stats::quantile, probs = 0.85, names = FALSE, type = 7),
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
