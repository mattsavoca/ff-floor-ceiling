# FFFL-style scoring applied to nflreadr weekly player statistics.

default_scoring <- function() {
  list(
    reception_points = 0.5,
    te_reception_bonus = 0.5,
    receiving_first_down_points = 0.5,
    fumbles_lost_points = -2
  )
}

score_nflreadr_weekly <- function(stats, scoring = default_scoring()) {
  check_columns(
    stats,
    c(
      "player_id", "player_name", "position", "season", "week", "season_type",
      "team", "game_id", "fantasy_points", "receptions", "receiving_first_downs"
    ),
    "nflreadr player stats"
  )
  x <- data.table::copy(data.table::as.data.table(stats))
  x <- x[
    season_type == "REG" & week %in% BACKTEST_WEEKS &
      position %in% BACKTEST_POSITIONS & !is.na(player_id)
  ]
  if (!nrow(x)) abort("nflreadr returned no regular-season skill-position stats.")

  x[, base_points := as_numeric_or_na(fantasy_points)]
  x[is.na(base_points), base_points := 0]
  x[, receptions_num := as_numeric_or_na(receptions)]
  x[is.na(receptions_num), receptions_num := 0]
  x[, receiving_first_downs_num := as_numeric_or_na(receiving_first_downs)]
  x[is.na(receiving_first_downs_num), receiving_first_downs_num := 0]
  x[, position := toupper(trimws(as.character(position)))]
  x[, team := normalize_team(team)]
  x[, actual_score := base_points + scoring$reception_points * receptions_num +
    scoring$te_reception_bonus * receptions_num * (position == "TE") +
    scoring$receiving_first_down_points * receiving_first_downs_num]

  output <- x[
    , .(
      player_name = as.character(player_name[[1L]]),
      position = as.character(position[[1L]]),
      team = as.character(team[[1L]]),
      actual_score = sum(actual_score, na.rm = TRUE),
      standard_points = sum(base_points, na.rm = TRUE),
      receptions = sum(receptions_num, na.rm = TRUE),
      receiving_first_downs = sum(receiving_first_downs_num, na.rm = TRUE),
      games_in_week = data.table::uniqueN(game_id)
    ),
    by = .(season, week, player_id)
  ]
  output[, player_id := as.character(player_id)]
  output
}

score_projection_rows <- function(x, scoring = default_scoring()) {
  fields <- c(
    "pass-yds", "pass-td", "pass-int", "pass-2pt", "rush-yds", "rush-td",
    "rush-2pt", "rec-yds", "rec-td", "rec-2pt", "rec-rec", "rec-1d", "fum-lost"
  )
  for (field in fields) if (!field %in% names(x)) x[[field]] <- 0
  pos <- toupper(as.character(x$pos))
  num <- function(field) {
    value <- as_numeric_or_na(x[[field]])
    value[is.na(value)] <- 0
    value
  }
  num("pass-yds") / 25 + num("pass-td") * 4 + num("pass-int") * -1 + num("pass-2pt") * 2 +
    num("rush-yds") / 10 + num("rush-td") * 6 + num("rush-2pt") * 2 +
    num("rec-yds") / 10 + num("rec-td") * 6 + num("rec-2pt") * 2 +
    num("rec-rec") * scoring$reception_points +
    num("rec-rec") * scoring$te_reception_bonus * (pos == "TE") +
    num("rec-1d") * scoring$receiving_first_down_points +
    num("fum-lost") * scoring$fumbles_lost_points
}
