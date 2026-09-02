source(testthat::test_path("..", "..", "R", "common.R"), local = TRUE)
source(testthat::test_path("..", "..", "R", "scoring.R"), local = TRUE)
source(testthat::test_path("..", "..", "R", "simulation.R"), local = TRUE)
source(testthat::test_path("..", "..", "R", "evaluation.R"), local = TRUE)

test_that("name and team normalization support common historical aliases", {
  expect_equal(normalize_name("D'Andre Swift Jr."), "dandreswift")
  expect_equal(normalize_team(c("LAR", "STL", "SD", "JAX")), c("LA", "LA", "LAC", "JAX"))
})

test_that("projection scoring uses the configured FFFL additions", {
  row <- data.table::data.table(
    pos = "te", `pass-yds` = 0, `pass-td` = 0, `pass-int` = 0, `pass-2pt` = 0,
    `rush-yds` = 0, `rush-td` = 0, `rush-2pt` = 0, `rec-yds` = 100,
    `rec-td` = 1, `rec-2pt` = 0, `rec-rec` = 5, `rec-1d` = 3, `fum-lost` = 0
  )
  expect_equal(score_projection_rows(row), 10 + 6 + 2.5 + 2.5 + 1.5)
})

test_that("nflreadr scores aggregate multiple team rows for one player-week", {
  stats <- data.table::data.table(
    player_id = c("p1", "p1"), player_name = c("A", "A"), position = c("TE", "TE"),
    season = c(2025L, 2025L), week = c(1L, 1L), season_type = c("REG", "REG"),
    team = c("LAR", "LA"), game_id = c("g1", "g1"), fantasy_points = c(10, 5),
    receptions = c(4, 1), receiving_first_downs = c(2, 1)
  )
  out <- score_nflreadr_weekly(stats)
  expect_equal(nrow(out), 1)
  expect_equal(out$team, "LA")
  expect_equal(out$actual_score, 15 + 2.5 + 2.5 + 1.5)
})

test_that("rank-conditioned sampling falls back to the nearest rank", {
  pool <- list(RB = list(values = list(`1` = c(10, 12), `3` = c(2, 4)), ranks = c(1L, 3L)))
  set.seed(1)
  sampled <- sample_rank_conditioned_scores("RB", ecr = 2, rank_sd = 0, n_simulations = 20, pool = pool, sd_multiplier = 1)
  expect_true(all(sampled$scores %in% c(10, 12)))
  expect_equal(unique(sampled$ranks), 2)
})

test_that("player summaries preserve p15, p50, and p85", {
  players <- data.table::data.table(
    player_id = "p1", player_name = "One", position = "RB", team = "BUF",
    ecr = 1, rank_sd = 0, actual_score = 10
  )
  simulation <- list(scores = matrix(c(0, 10, 20, 30), ncol = 1), ranks = matrix(c(1, 1, 1, 1), ncol = 1))
  out <- summarize_player_week(players, simulation)
  expect_equal(out$p50, 15)
  expect_true(out$p15 < out$p50 && out$p50 < out$p85)
})

test_that("team calibration returns a finite simulation slope", {
  games <- data.table::data.table(
    season = rep(c(2023L, 2024L), each = 20),
    team_diff_p50 = seq(-19, 20),
    actual_margin = seq(-19, 20) + 2,
    spread_line = seq(-19, 20) + 1
  )
  out <- fit_team_calibration(games, training_seasons = c(2023L, 2024L))
  expect_true(is.finite(out$sim_beta))
  expect_equal(out$n_training_games, 40)
})
