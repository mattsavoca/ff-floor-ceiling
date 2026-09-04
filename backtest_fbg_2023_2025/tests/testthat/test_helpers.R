source(testthat::test_path("..", "..", "R", "common.R"), local = TRUE)
source(testthat::test_path("..", "..", "R", "scoring.R"), local = TRUE)
source(testthat::test_path("..", "..", "R", "simulation.R"), local = TRUE)
source(testthat::test_path("..", "..", "R", "evaluation.R"), local = TRUE)

test_that("name and team normalization support common historical aliases", {
  expect_equal(normalize_name("D'Andre Swift Jr."), "dandreswift")
  expect_equal(normalize_team(c("LAR", "STL", "SD", "JAX")), c("LA", "LA", "LAC", "JAX"))
})

test_that("calibration bins use half-up increment rounding", {
  expect_equal(
    round_to_increment(c(0.49, 0.50, 0.51, 1.49, 1.50), increment = 1),
    c(0, 1, 1, 1, 2)
  )
  expect_equal(round_to_half(c(0.24, 0.25, 0.26)), c(0, 0.5, 0.5))
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

test_that("ffsimulator receives only seasons before the target season", {
  scoring_history <- data.table::data.table(
    gsis_id = paste0("p", 1:4),
    week = 1L,
    season = 2022:2025,
    points = c(10, 20, 30, 40)
  )
  received_seasons <- integer()
  builder <- function(scoring_history, pos_filter) {
    received_seasons <<- sort(unique(scoring_history$season))
    data.table::data.table(
      pos = pos_filter,
      rank = 1L,
      week_outcomes = lapply(seq_along(pos_filter), function(index) c(index, NA_real_))
    )
  }

  pool <- make_outcome_pool(
    scoring_history,
    target_season = 2024L,
    outcome_builder = builder
  )

  expect_equal(received_seasons, c(2022L, 2023L))
  expect_true(all(received_seasons < 2024L))
  expect_equal(attr(pool, "scoring_history_seasons"), c(2022L, 2023L))
  expect_equal(attr(pool, "scoring_history_rows"), 2L)
})

test_that("the scoring-history guard rejects target and future seasons", {
  leaked_history <- data.table::data.table(
    gsis_id = c("past", "target", "future"),
    week = 1L,
    season = c(2023L, 2024L, 2025L),
    points = c(1, 2, 3)
  )

  expect_error(
    assert_scoring_history_precedes_target(leaked_history, 2024L),
    "contains target or future seasons: 2024,2025",
    fixed = TRUE
  )
})

test_that("the scoring-history builder keeps the score season", {
  stats <- data.table::data.table(
    player_id = "p1", player_name = "One", position = "RB",
    season = 2022L, week = 1L, season_type = "REG", team = "BUF",
    game_id = "g1", fantasy_points = 10, receptions = 2,
    receiving_first_downs = 1
  )

  history <- make_scoring_history(stats)

  expect_equal(history$gsis_id, "p1")
  expect_equal(history$season, 2022L)
  expect_equal(history$points, 11.5)
})

test_that("player summaries preserve p15, p50, and p85", {
  players <- data.table::data.table(
    player_id = "p1", player_name = "One", position = "RB", team = "BUF",
    ecr = 1, rank_sd = 0, actual_score = 10
  )
  simulation <- list(scores = matrix(c(0, 10, 20, 30, 40), ncol = 1), ranks = matrix(rep(1, 5), ncol = 1))
  out <- summarize_player_week(players, simulation)
  expect_equal(out$p50, 20)
  expect_equal(out$mean_above_p85, 40)
  expect_equal(out$p85_tail_excess, 6)
  expect_true(out$p15 < out$p50 && out$p50 < out$p85)
})

test_that("mean above threshold returns NA when no draw exceeds threshold", {
  expect_true(is.na(mean_above_threshold(c(1, 2, 3), 3)))
  expect_equal(mean_above_threshold(c(1, 2, 3, 4), 2), 3.5)
})

test_that("p85 tail calibration compares observed and simulated conditional means", {
  predictions <- data.table::data.table(
    season = rep(2023L, 4), week = 1:4, position = rep("RB", 4),
    p85 = c(10, 10, 20, 20), mean_above_p85 = c(15, 15, 30, 30),
    p85_tail_excess = c(5, 5, 10, 10), actual_score = c(5, 15, 10, 30)
  )
  out <- player_p85_tail_calibration(predictions, group_by = "position")
  expect_equal(nrow(out), 2)
  expect_equal(out$n_actual_above_p85, c(1L, 1L))
  expect_equal(out$observed_tail_mean, c(15, 30))
  expect_equal(out$predicted_mean_above_p85, c(15, 30))
})

test_that("p85 tail explanation uses prior-season exceedances only", {
  predictions <- data.table::rbindlist(lapply(2023:2025, function(season) {
    data.table::data.table(
      season = season,
      position = "RB",
      actual_score = c(rep(20, 12), rep(5, 8)),
      p85 = c(rep(10, 12), rep(10, 8)),
      mean_above_p85 = c(rep(18, 12), rep(18, 8)),
      p85_tail_excess = c(rep(8, 12), rep(8, 8))
    )
  }))
  out <- player_p85_tail_explanation(predictions)
  expect_true(all(out$target_season %in% c(2024L, 2025L)))
  expect_true(all(out$n_training_exceedances >= 20L))
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

test_that("team calibration rejects target and future training seasons", {
  games <- data.table::data.table(
    season = rep(c(2023L, 2024L), each = 20),
    team_diff_p50 = seq(-19, 20),
    actual_margin = seq(-19, 20) + 2,
    spread_line = seq(-19, 20) + 1
  )

  expect_error(
    fit_team_calibration(
      games,
      training_seasons = c(2023L, 2024L),
      target_season = 2024L
    ),
    "contains target or future seasons: 2024",
    fixed = TRUE
  )
})
