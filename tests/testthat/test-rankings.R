test_that("generic rankings use the provider-neutral schema", {
  out <- byor_generic(test_rankings())
  expect_identical(names(out), c("player_id", "player_name", "position", "team", "rank", "rank_uncertainty", "bye_week", "as_of", "source"))
  expect_equal(out$position, c("QB", "RB", "WR", "TE"))
  expect_equal(out$source, rep("generic", 4))
})

test_that("FantasyPros rankings filter to positional rows", {
  rankings <- data.frame(
    fantasypros_id = c("1", "1", "2"),
    player = c("Player One", "Player One", "Player Two"),
    pos = c("RB", "RB", "WR"),
    team = c("AAA", "AAA", "BBB"),
    ecr = c(1, 1, 2),
    sd = c(0, 0, 0),
    bye = c(5, 5, 6),
    scrape_date = rep("2026-09-01", 3),
    ecr_type = c("rp", "overall", "rp"),
    page_type = c("RB", "overall", "WR"),
    stringsAsFactors = FALSE
  )
  out <- byor_fantasypros(rankings)
  expect_equal(out$player_id, c("1", "2"))
  expect_equal(out$source, rep("fantasypros", 2))
})

test_that("ETR rankings accept format and positional filters", {
  rankings <- data.frame(
    id = c("1", "1", "2"),
    player_name = c("Player One", "Player One", "Player Two"),
    position = c("RB", "RB", "WR"),
    team_abbr = c("AAA", "AAA", "BBB"),
    positional_rank = c(1, 1, 2),
    scoring_format = c("PPR", "Half-PPR", "PPR"),
    rank_type = c("positional", "positional", "overall"),
    stringsAsFactors = FALSE
  )
  out <- byor_etr(rankings, scoring_format = "PPR")
  expect_equal(out$player_id, "1")
  expect_equal(out$rank_uncertainty, 0)
})

test_that("Footballguys rankings select the offensive set and remove free agents", {
  skip_if_not_installed("ffsimulator")
  path <- file.path("..", "test-data", "wk1-26-fbg-08-31-26.csv")
  rankings <- read.csv(path, stringsAsFactors = FALSE, check.names = FALSE)
  out <- byor_fbg(rankings, as_of = "2026-08-31")
  expect_equal(nrow(out), 400)
  expect_equal(sort(unique(out$position)), c("QB", "RB", "TE", "WR"))
  expect_false(any(out$team == "FA"))
  expect_true(all(is.finite(out$rank_uncertainty)))
  expect_true(all(out$rank_uncertainty >= 0.5))
  expect_equal(out$rank[out$position == "QB"][1], 1)
  expect_equal(out$player_name[out$position == "QB"][1], "Joe Burrow")
  expect_equal(out$source, rep("fbg", nrow(out)))
})

test_that("the ffsimulator adapter emits the required input columns", {
  out <- as_ffsimulator_rankings(test_rankings())
  expect_true(inherits(out, "ffsimulator_rankings"))
  expect_identical(names(out), c("player", "pos", "team", "ecr", "sd", "bye", "fantasypros_id", "scrape_date"))
})
