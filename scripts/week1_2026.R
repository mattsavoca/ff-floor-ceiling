#!/usr/bin/env Rscript

suppressPackageStartupMessages(library(fffloorceiling))

simulation_count <- 100L
week_number <- 1L
simulation_seed <- 20260901L
output_prefix <- "week1_2026_fbg"

ranking_path <- file.path("tests", "test-data", "wk1-26-fbg-08-31-26.csv")
outcome_path <- file.path("..", "ffsimulator", "inst", "cache", "adp_outcomes.rds")

fbg <- read.csv(ranking_path, stringsAsFactors = FALSE, check.names = FALSE)
rankings <- byor_fbg(fbg, as_of = as.Date("2026-08-31"))
outcome_pool <- readRDS(outcome_path)

player_draws <- simulate_player_week_outcomes(
  rankings = rankings,
  adp_outcomes = outcome_pool,
  n_simulations = simulation_count,
  week = week_number,
  seed = simulation_seed,
  strict = FALSE
)

canonical_team <- function(value) {
  value <- toupper(trimws(as.character(value)))
  value[value %in% c("LAR", "STL")] <- "LA"
  value[value %in% c("OAK", "LVR")] <- "LV"
  value[value %in% c("SD")] <- "LAC"
  value[value %in% c("JAC")] <- "JAX"
  value[value %in% c("SFO")] <- "SF"
  value[value %in% c("GBP")] <- "GB"
  value[value %in% c("NEP")] <- "NE"
  value[value %in% c("NOS")] <- "NO"
  value[value %in% c("TBB")] <- "TB"
  value[value %in% c("WSH")] <- "WAS"
  value
}
player_draws$team <- canonical_team(player_draws$team)
player_draws$simulation_mode <- "original_fbg"

# Persist the original FBG player scenarios. The optional Python DST bridge
# reads these rows and adds one team defense row per simulation and team.
player_draws_path <- file.path("outputs", paste0(output_prefix, "_player_draws.csv"))
write.csv(player_draws, player_draws_path, row.names = FALSE, na = "")

schedule <- data.frame(
  season = 2026L,
  game_type = "REG",
  week = week_number,
  away_team = c(
    "NE", "SF", "CHI", "TB", "NO", "BUF", "BAL", "CLE", "ATL", "NYJ",
    "ARI", "MIA", "GB", "WAS", "DAL", "DEN"
  ),
  home_team = c(
    "SEA", "LA", "CAR", "CIN", "DET", "HOU", "IND", "JAX", "PIT", "TEN",
    "LAC", "LV", "MIN", "PHI", "NYG", "KC"
  ),
  location = c(
    "Home", "Neutral", "Home", "Home", "Home", "Home", "Home", "Home", "Home", "Home",
    "Home", "Home", "Home", "Home", "Home", "Home"
  ),
  result = NA_integer_,
  stringsAsFactors = FALSE
)
schedule$game_id <- paste(
  schedule$season,
  sprintf("%02d", schedule$week),
  schedule$away_team,
  schedule$home_team,
  sep = "_"
)
schedule_path <- file.path("outputs", paste0(output_prefix, "_schedule.csv"))
write.csv(schedule, schedule_path, row.names = FALSE, na = "")

dst_model_dir <- Sys.getenv("DST_MODEL_DIR", "")
dst_raw_dir <- Sys.getenv("DST_RAW_DIR", "")
dst_draws_path <- file.path("outputs", paste0(output_prefix, "_dst_draws.csv"))
dst_enabled <- nzchar(dst_model_dir)
if (dst_enabled) {
  dst_script <- file.path("backtest_fbg_2023_2025", "scripts", "14_score_dst_from_fbg_sims.py")
  dst_args <- c(
    shQuote(dst_script, type = "cmd"),
    "--draws", shQuote(player_draws_path, type = "cmd"),
    "--schedule", shQuote(schedule_path, type = "cmd"),
    "--model-dir", shQuote(dst_model_dir, type = "cmd"),
    "--season", as.character(2026L),
    "--week", as.character(week_number),
    "--output", shQuote(dst_draws_path, type = "cmd")
  )
  if (nzchar(dst_raw_dir)) dst_args <- c(dst_args, "--raw-dir", shQuote(dst_raw_dir, type = "cmd"))
  dst_status <- system2("python", args = dst_args)
  if (!identical(dst_status, 0L)) stop("The Python DST scoring bridge failed with status ", dst_status, ".", call. = FALSE)
  dst_draws <- read.csv(dst_draws_path, stringsAsFactors = FALSE, check.names = FALSE)
  dst_required <- c("simulation_id", "player_id", "player_name", "position", "team", "week", "projected_score", "active")
  dst_missing <- setdiff(dst_required, names(dst_draws))
  if (length(dst_missing)) stop("DST draw output is missing columns: ", paste(dst_missing, collapse = ", "), call. = FALSE)
  player_draws <- data.table::rbindlist(
    list(data.table::as.data.table(player_draws), data.table::as.data.table(dst_draws)),
    fill = TRUE,
    use.names = TRUE
  )
}

player_summary <- summarize_player_outcomes(player_draws)$weekly
player_summary$floor <- player_summary$p15
player_summary$ceiling <- player_summary$p85
player_summary <- player_summary[
  order(-player_summary$mean, player_summary$position, player_summary$player_name),
  c(
    "player_id", "player_name", "position", "team", "week",
    "n_simulations", "mean", "median", "floor", "ceiling", "p15", "p85",
    "probability_zero", "probability_active", "active_mean", "active_p15",
    "active_p85"
  )
]
write.csv(player_summary, file.path("outputs", paste0(output_prefix, "_player_ranges.csv")), row.names = FALSE, na = "")

team_draws <- aggregate_team_fantasy(player_draws)
team_signals <- standardize_team_fantasy(team_draws)
team_data <- data.table::as.data.table(team_draws)
team_summary <- team_data[
  , list(
    n_simulations = data.table::uniqueN(simulation_id),
    mean = mean(team_fantasy_total),
    median = stats::median(team_fantasy_total),
    p15 = as.numeric(stats::quantile(team_fantasy_total, 0.15, names = FALSE)),
    p85 = as.numeric(stats::quantile(team_fantasy_total, 0.85, names = FALSE))
  ),
  by = c("team", "week")
]
data.table::setDF(team_summary)
team_summary$floor <- team_summary$p15
team_summary$ceiling <- team_summary$p85
team_summary <- team_summary[order(-team_summary$mean), ]
write.csv(team_summary, file.path("outputs", paste0(output_prefix, "_team_ranges.csv")), row.names = FALSE, na = "")

# The within-team z signal has mean zero by construction. Use the simulated
# team means as the baseline team rating so game expectations can differ
# across matchups. The three-point scale is an explicit experimental prior.
team_rating_scale <- 3
team_mean <- team_summary$mean
team_rating <- team_rating_scale * (team_mean - mean(team_mean)) / stats::sd(team_mean)
names(team_rating) <- team_summary$team

compute_results <- make_nflseedr_compute_results(
  team_signals = team_signals,
  base_team_rating = team_rating,
  beta = 3,
  home_field = 1.5,
  margin_sd = 13,
  missing_signal = "zero"
)
game_draws <- schedule[rep(seq_len(nrow(schedule)), times = simulation_count), , drop = FALSE]
game_draws$sim <- rep(seq_len(simulation_count), each = nrow(schedule))
game_draws <- game_draws[, c("season", "game_type", "week", "away_team", "home_team", "location", "result", "sim")]
game_result <- compute_results(NULL, game_draws, week_number)
game_summary <- summarize_nfl_game_outcomes(game_result$games, week = week_number, game_type = "REG")
game_summary <- game_summary[
  , c(
    "away_team", "home_team", "n_simulations", "expected_margin", "median_margin",
    "p15_margin", "p85_margin", "away_win_probability", "home_win_probability",
    "tie_probability", "predicted_winner"
  )
]
write.csv(game_summary, file.path("outputs", paste0(output_prefix, "_game_outcomes.csv")), row.names = FALSE, na = "")

writeLines(
  c(
    "Week 1 2026 FBG fffloorceiling run",
    paste0("ranking_snapshot=", normalizePath(ranking_path, winslash = "/")),
    paste0("outcome_pool=", normalizePath(outcome_path, winslash = "/")),
    paste0("simulations=", simulation_count),
    paste0("seed=", simulation_seed),
    paste0("team_rating=", team_rating_scale, " times cross-team fantasy-total standard deviation"),
    paste0("positions=QB,RB,WR,TE", if (dst_enabled) ",DST" else ""),
    "ranking_source=Footballguys Projections Consensus",
    "rank_definition=source row order within position after FA removal",
    "rank_uncertainty=median historical FantasyPros weekly sd by position and rank",
    "schedule_source=https://www.nfl.com/schedules/2026/by-week/week-1",
    paste0("player_ranges=outputs/", output_prefix, "_player_ranges.csv"),
    paste0("player_draws=outputs/", output_prefix, "_player_draws.csv"),
    paste0("team_ranges=outputs/", output_prefix, "_team_ranges.csv"),
    paste0("game_outcomes=outputs/", output_prefix, "_game_outcomes.csv"),
    "game_range_definition=home-team margin p15 to p85",
    paste0("dst_model_status=", if (dst_enabled) "python_xgboost_from_original_fbg_scenarios" else "disabled"),
    "game_model_status=experimental, independently sampled player outcomes"
  ),
  file.path("outputs", paste0(output_prefix, "_metadata.txt"))
)

message("Wrote Week 1 2026 player, team, and game outcome tables.")
