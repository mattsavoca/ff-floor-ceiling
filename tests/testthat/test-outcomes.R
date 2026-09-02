test_that("player draws keep one row per player, simulation, and week", {
  skip_if_not_installed("ffsimulator")
  draws <- simulate_player_outcomes(
    test_rankings(),
    test_adp_outcomes(),
    n_simulations = 8,
    weeks = 1:3,
    seed = 42
  )
  expect_equal(nrow(draws), 4 * 8 * 3)
  expect_equal(nrow(unique(draws[c("player_id", "simulation_id", "week")])), nrow(draws))
  expect_true(all(draws$active == 1L))

  repeat_draws <- simulate_player_outcomes(
    test_rankings(),
    test_adp_outcomes(),
    n_simulations = 8,
    weeks = 1:3,
    seed = 42
  )
  expect_identical(draws, repeat_draws)
})

test_that("weekly player draws attach the requested week", {
  skip_if_not_installed("ffsimulator")
  draws <- simulate_player_week_outcomes(
    test_rankings(),
    test_adp_outcomes(),
    n_simulations = 8,
    week = 1,
    seed = 42
  )
  expect_equal(nrow(draws), 4 * 8)
  expect_equal(unique(draws$week), 1)
  expect_equal(nrow(unique(draws[c("player_id", "simulation_id", "week")])), nrow(draws))
  expect_true(all(draws$active == 1L))
})

test_that("unsupported rank outcomes fail in strict mode", {
  skip_if_not_installed("ffsimulator")
  rankings <- test_rankings()
  rankings$rank[1] <- 6
  expect_error(
    simulate_player_outcomes(rankings, test_adp_outcomes(), n_simulations = 2, weeks = 1),
    "did not return"
  )
})

test_that("summary tables report marginal and active-game ranges", {
  draws <- data.frame(
    simulation_id = rep(1:4, 2),
    player_id = rep(c("p1", "p2"), each = 4),
    player_name = rep(c("One", "Two"), each = 4),
    position = rep("RB", 8),
    team = rep("AAA", 8),
    week = rep(1, 8),
    projected_score = c(0, 10, 20, 30, 0, 0, 5, 15),
    active = c(0, 1, 1, 1, 0, 0, 1, 1),
    stringsAsFactors = FALSE
  )
  out <- summarize_player_outcomes(draws)
  expect_true(all(c("mean", "median", "p10", "p15", "p25", "p75", "p85", "p90", "probability_zero", "probability_active", "probability_top_12") %in% names(out$weekly)))
  expect_true(all(c("season_p15", "season_p85") %in% names(out$season)))
  expect_equal(nrow(out$season_draws), 8)
  expect_equal(nrow(out$weekly), 2)
  expect_equal(out$season$expected_games_played, c(0.75, 0.5))
})

test_that("coverage reports interval and zero-score calibration", {
  predictions <- data.frame(
    player_id = rep("p1", 4),
    week = 1:4,
    position = rep("RB", 4),
    p10 = c(0, 0, 0, 0),
    p15 = c(0, 0, 0, 0),
    p25 = c(0, 0, 0, 0),
    p75 = c(10, 10, 10, 10),
    p85 = c(15, 15, 15, 15),
    p90 = c(20, 20, 20, 20),
    probability_zero = rep(0.25, 4),
    stringsAsFactors = FALSE
  )
  realized <- data.frame(player_id = "p1", week = 1:4, actual_score = c(0, 5, 15, 30))
  out <- evaluate_interval_coverage(predictions, realized, levels = c(0.50, 0.70, 0.80))
  expect_equal(nrow(out$interval_coverage), 3)
  expect_equal(out$zero_calibration$observed_zero, 0.25)
})
