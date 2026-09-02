test_that("team totals become standardized signals", {
  draws <- data.frame(
    simulation_id = rep(1:2, 2),
    player_id = c("a", "a", "b", "b"),
    player_name = c("A", "A", "B", "B"),
    position = c("RB", "RB", "WR", "WR"),
    team = c("AAA", "AAA", "BBB", "BBB"),
    week = 1,
    projected_score = c(10, 20, 5, 15),
    active = 1,
    stringsAsFactors = FALSE
  )
  team_draws <- aggregate_team_fantasy(draws)
  signals <- standardize_team_fantasy(
    team_draws,
    expected = c(AAA = 10, BBB = 10),
    historical_sd = c(AAA = 5, BBB = 5)
  )
  expect_equal(signals$z_team[signals$team == "AAA"], c(0, 2))
  expect_equal(signals$z_team[signals$team == "BBB"], c(-1, 1))
})

test_that("the nflseedR function changes current missing results only", {
  signals <- data.frame(
    simulation_id = c(1, 1),
    week = c(1, 1),
    team = c("AAA", "BBB"),
    z_team = c(1, -1),
    stringsAsFactors = FALSE
  )
  compute <- make_nflseedr_compute_results(
    signals,
    base_team_rating = c(AAA = 0, BBB = 0),
    beta = 3,
    home_field = 0,
    margin_sd = 1
  )
  games <- data.frame(
    sim = 1,
    game_type = c("REG", "REG"),
    week = c(1, 2),
    away_team = c("BBB", "AAA"),
    home_team = c("AAA", "BBB"),
    location = c("Home", "Home"),
    result = c(NA, 7),
    stringsAsFactors = FALSE
  )
  set.seed(1)
  out <- compute(NULL, games, 1)
  expect_true(is.list(out))
  expect_true(!is.na(out$games$result[1]))
  expect_equal(out$games$result[2], 7)
  expect_true(all(c("ff_expected_margin", "ff_win_probability") %in% names(out$games)))
})

test_that("game summaries report home-margin ranges", {
  games <- data.frame(
    game_type = rep("REG", 4),
    sim = 1:4,
    week = 1,
    away_team = rep("AAA", 4),
    home_team = rep("BBB", 4),
    result = c(-3, 2, 7, -1),
    ff_expected_margin = c(1, 1, 1, 1),
    stringsAsFactors = FALSE
  )
  out <- summarize_nfl_game_outcomes(games)
  expect_equal(nrow(out), 1)
  expect_equal(out$expected_margin, 1)
  expect_equal(out$home_win_probability, 0.5)
  expect_equal(out$away_win_probability, 0.5)
  expect_true(all(c("p15_margin", "p85_margin", "predicted_winner") %in% names(out)))
})

test_that("correlation matrices remain inactive in v0", {
  layer <- new_correlation_layer(diag(2), player_ids = c("a", "b"))
  expect_false(layer$active)
  expect_equal(dim(layer$matrix), c(2, 2))
})

test_that("the nflseedR verification contract accepts the adapter", {
  skip_if_not_installed("nflseedR")
  games <- nflseedR::sims_games_example
  teams <- unique(c(games$away_team, games$home_team))
  signals <- expand.grid(
    simulation_id = 1,
    week = sort(unique(games$week[games$game_type == "REG"])),
    team = teams,
    KEEP.OUT.ATTRS = FALSE,
    stringsAsFactors = FALSE
  )
  signals$z_team <- 0
  compute <- make_nflseedr_compute_results(signals, margin_sd = 13, missing_signal = "zero")
  expect_true(nflseedR::simulations_verify_fct(
    compute_results = compute,
    games = games,
    teams = data.frame(sim = 1, team = teams, stringsAsFactors = FALSE)
  ))
})
