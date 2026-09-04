#!/usr/bin/env Rscript

source(file.path(dirname(dirname(normalizePath(sub("^--file=", "", grep("^--file=", commandArgs(FALSE), value = TRUE)[[1L]]), winslash = "/"))), "R", "common.R"), local = TRUE)
source(path_in_project("R", "scoring.R"), local = TRUE)
require_packages(c("data.table", "arrow", "nflreadr"))
options(nflreadr.prefer = "csv")

usage <- function() {
  cat(paste0(
    "Cache nflreadr player stats, weekly rosters, players, and schedules.\n\n",
    "Usage:\n",
    "  Rscript scripts/02_download_nflreadr.R [options]\n\n",
    "Options:\n",
    "  --years 2023,2024,2025\n",
    "  --history-years 2012:2022\n",
    "  --force\n"
  ))
}

args <- commandArgs(trailingOnly = TRUE)
if (has_cli_flag(args, "--help")) {
  usage()
  quit(status = 0L)
}
years <- parse_int_list(read_cli_value(args, "--years", "2023,2024,2025"), "--years")
history_years <- parse_int_list(read_cli_value(args, "--history-years", "2012:2022"), "--history-years")
force <- has_cli_flag(args, "--force")

manifest <- list()

for (season in sort(unique(c(years, history_years)))) {
  stats_path <- stats_raw_path(season)
  if (file.exists(stats_path) && !force) {
    stats <- read_parquet_local(stats_path)
    message("Using cached nflreadr player stats for ", season)
  } else {
    message("Loading nflreadr weekly player stats for ", season)
    raw <- tryCatch(
      nflreadr::load_player_stats(seasons = season, summary_level = "week", file_type = "csv"),
      error = function(error) abort("nflreadr player stats failed for ", season, ": ", conditionMessage(error))
    )
    raw <- data.table::as.data.table(raw)
    check_columns(raw, c("player_id", "player_name", "position", "season", "week", "season_type", "team", "game_id", "fantasy_points", "receptions", "receiving_first_downs"), "nflreadr player stats")
    keep <- c("player_id", "player_name", "player_display_name", "position", "position_group", "season", "week", "season_type", "game_id", "team", "opponent_team", "fantasy_points", "fantasy_points_ppr", "receptions", "receiving_first_downs")
    keep <- intersect(keep, names(raw))
    stats <- raw[, ..keep]
    stats <- stats[season_type == "REG" & week %in% BACKTEST_WEEKS & position %in% BACKTEST_POSITIONS]
    write_parquet_local(stats, stats_path)
  }
  manifest[[length(manifest) + 1L]] <- data.table::data.table(source = "player_stats", season = season, rows = nrow(stats), path = normalizePath(stats_path, winslash = "/"))

  if (!season %in% years) next

  schedule_path <- schedule_raw_path(season)
  if (file.exists(schedule_path) && !force) {
    schedule <- read_parquet_local(schedule_path)
    message("Using cached nflreadr schedule for ", season)
  } else {
    message("Loading nflreadr schedule for ", season)
    schedule <- data.table::as.data.table(tryCatch(
      nflreadr::load_schedules(seasons = season),
      error = function(error) abort("nflreadr schedule failed for ", season, ": ", conditionMessage(error))
    ))
    check_columns(schedule, c("game_id", "season", "game_type", "week", "away_team", "home_team", "location", "away_score", "home_score", "result", "spread_line", "total_line", "away_moneyline", "home_moneyline"), "nflreadr schedule")
    keep <- c("game_id", "season", "game_type", "week", "gameday", "weekday", "gametime", "away_team", "away_score", "home_team", "home_score", "location", "result", "total", "away_moneyline", "home_moneyline", "spread_line", "away_spread_odds", "home_spread_odds", "total_line", "under_odds", "over_odds")
    schedule <- schedule[, intersect(keep, names(schedule)), with = FALSE]
    schedule <- schedule[game_type == "REG" & week %in% BACKTEST_WEEKS]
    schedule[, `:=`(away_team = normalize_team(away_team), home_team = normalize_team(home_team))]
    write_parquet_local(schedule, schedule_path)
  }
  manifest[[length(manifest) + 1L]] <- data.table::data.table(source = "schedules", season = season, rows = nrow(schedule), path = normalizePath(schedule_path, winslash = "/"))

  roster_path <- roster_raw_path(season)
  if (file.exists(roster_path) && !force) {
    roster <- read_parquet_local(roster_path)
    message("Using cached nflreadr weekly rosters for ", season)
  } else {
    message("Loading nflreadr weekly rosters for ", season)
    raw <- data.table::as.data.table(tryCatch(
      nflreadr::load_rosters_weekly(seasons = season, file_type = "csv"),
      error = function(error) abort("nflreadr weekly rosters failed for ", season, ": ", conditionMessage(error))
    ))
    check_columns(raw, c("season", "team", "position", "full_name", "gsis_id", "week", "game_type"), "nflreadr weekly rosters")
    keep <- c("season", "team", "position", "depth_chart_position", "status", "full_name", "first_name", "last_name", "gsis_id", "sleeper_id", "week", "game_type", "status_description_abbr")
    roster <- raw[, intersect(keep, names(raw)), with = FALSE]
    roster <- roster[game_type == "REG" & week %in% BACKTEST_WEEKS & position %in% BACKTEST_POSITIONS]
    roster[, team := normalize_team(team)]
    write_parquet_local(roster, roster_path)
  }
  manifest[[length(manifest) + 1L]] <- data.table::data.table(source = "rosters_weekly", season = season, rows = nrow(roster), path = normalizePath(roster_path, winslash = "/"))
}

players_path <- players_raw_path()
if (file.exists(players_path) && !force) {
  players <- read_parquet_local(players_path)
  message("Using cached nflreadr players")
} else {
  message("Loading nflreadr players")
  raw <- data.table::as.data.table(tryCatch(
    nflreadr::load_players(file_type = "csv"),
    error = function(error) abort("nflreadr players failed: ", conditionMessage(error))
  ))
  check_columns(raw, c("gsis_id", "display_name", "first_name", "last_name", "football_name", "position", "latest_team"), "nflreadr players")
  keep <- c("gsis_id", "display_name", "common_first_name", "first_name", "last_name", "football_name", "position", "latest_team", "status", "last_season", "rookie_season")
  players <- raw[, intersect(keep, names(raw)), with = FALSE]
  players <- players[position %in% BACKTEST_POSITIONS & !is.na(gsis_id)]
  write_parquet_local(players, players_path)
}
manifest[[length(manifest) + 1L]] <- data.table::data.table(source = "players", season = NA_integer_, rows = nrow(players), path = normalizePath(players_path, winslash = "/"))

write_csv_local(data.table::rbindlist(manifest, fill = TRUE), path_in_project("data", "raw", "nflreadr", "manifest.csv"))
message("nflreadr cache is ready.")
