# PPR scoring applied to nflreadr weekly player statistics.

SCORING_FORMAT <- "PPR"
SCORING_CONTRACT_VERSION <- "ppr_v1"
PPR_RECEPTION_POINTS <- 1

default_scoring <- function() {
  list(
    format = SCORING_FORMAT,
    contract_version = SCORING_CONTRACT_VERSION,
    reception_points = PPR_RECEPTION_POINTS,
    fumbles_lost_points = -2
  )
}

validate_scoring_contract <- function(scoring = default_scoring()) {
  required <- c("format", "contract_version", "reception_points", "fumbles_lost_points")
  missing <- setdiff(required, names(scoring))
  if (length(missing)) {
    stop(
      sprintf("Scoring contract is missing: %s", paste(missing, collapse = ", ")),
      call. = FALSE
    )
  }
  if (!identical(as.character(scoring$format), SCORING_FORMAT)) {
    stop("Only the PPR scoring contract is active.", call. = FALSE)
  }
  if (!isTRUE(all.equal(as.numeric(scoring$reception_points), PPR_RECEPTION_POINTS))) {
    stop("PPR scoring requires one point per reception.", call. = FALSE)
  }
  if (!isTRUE(all.equal(as.numeric(scoring$fumbles_lost_points), -2))) {
    stop("PPR scoring requires minus two points per fumble lost.", call. = FALSE)
  }
  invisible(TRUE)
}

validate_ppr_parity <- function(stats, tolerance = 1e-8) {
  check_columns(
    stats,
    c(
      "season", "season_type", "week", "position", "fantasy_points",
      "fantasy_points_ppr", "receptions", "receiving_first_downs"
    ),
    "nflreadr player stats"
  )

  x <- data.table::copy(data.table::as.data.table(stats))
  x[, position := toupper(trimws(as.character(position)))]
  x[, season_type := toupper(trimws(as.character(season_type)))]
  x[, week := suppressWarnings(as.integer(week))]
  x[, base_points := as_numeric_or_na(fantasy_points)]
  x[, ppr_points := as_numeric_or_na(fantasy_points_ppr)]
  x[, receptions_num := as_numeric_or_na(receptions)]
  x[, receiving_first_downs_num := as_numeric_or_na(receiving_first_downs)]

  scoped <- x[
    season_type == "REG" &
      week %in% BACKTEST_WEEKS &
      position %in% BACKTEST_POSITIONS
  ]
  if (!nrow(scoped)) abort("PPR parity check found no regular-season offensive rows.")

  required_numeric <- c("base_points", "ppr_points", "receptions_num", "receiving_first_downs_num")
  missing_numeric <- vapply(
    scoped[, ..required_numeric],
    function(value) any(!is.finite(value)),
    logical(1)
  )
  if (any(missing_numeric)) {
    stop(
      sprintf(
        "PPR parity check found missing or non-finite values in: %s",
        paste(names(missing_numeric)[missing_numeric], collapse = ", ")
      ),
      call. = FALSE
    )
  }

  difference <- scoped$ppr_points - scoped$base_points - scoped$receptions_num
  bad <- !is.finite(difference) | abs(difference) > tolerance
  if (any(bad)) {
    stop(
      sprintf(
        "PPR parity check failed for %d rows. Maximum absolute difference: %.12g.",
        sum(bad),
        max(abs(difference), na.rm = TRUE)
      ),
      call. = FALSE
    )
  }

  data.table::data.table(
    scoring_format = SCORING_FORMAT,
    scoring_contract_version = SCORING_CONTRACT_VERSION,
    rows_checked = nrow(scoped),
    max_abs_difference = max(abs(difference), na.rm = TRUE),
    rows_with_receiving_first_downs = sum(scoped$receiving_first_downs_num > 0),
    receiving_first_down_points_used = 0,
    tight_end_reception_bonus_used = 0
  )
}

score_nflreadr_weekly <- function(stats, scoring = default_scoring()) {
  validate_scoring_contract(scoring)
  check_columns(
    stats,
    c(
      "player_id", "player_name", "position", "season", "week", "season_type",
      "team", "game_id", "fantasy_points", "fantasy_points_ppr", "receptions",
      "receiving_first_downs"
    ),
    "nflreadr player stats"
  )
  validate_ppr_parity(stats)

  x <- data.table::copy(data.table::as.data.table(stats))
  x[, position := toupper(trimws(as.character(position)))]
  x[, season_type := toupper(trimws(as.character(season_type)))]
  x <- x[
    season_type == "REG" & week %in% BACKTEST_WEEKS &
      position %in% BACKTEST_POSITIONS & !is.na(player_id)
  ]
  if (!nrow(x)) abort("nflreadr returned no regular-season skill-position stats.")

  x[, base_points := as_numeric_or_na(fantasy_points)]
  x[is.na(base_points), base_points := 0]
  x[, ppr_points := as_numeric_or_na(fantasy_points_ppr)]
  x[is.na(ppr_points), ppr_points := 0]
  x[, receptions_num := as_numeric_or_na(receptions)]
  x[is.na(receptions_num), receptions_num := 0]
  x[, receiving_first_downs_num := as_numeric_or_na(receiving_first_downs)]
  x[is.na(receiving_first_downs_num), receiving_first_downs_num := 0]
  x[, team := normalize_team(team)]

  output <- x[
    , .(
      player_name = as.character(player_name[[1L]]),
      position = as.character(position[[1L]]),
      team = as.character(team[[1L]]),
      actual_score = sum(ppr_points, na.rm = TRUE),
      ppr_points = sum(ppr_points, na.rm = TRUE),
      standard_points = sum(base_points, na.rm = TRUE),
      receptions = sum(receptions_num, na.rm = TRUE),
      receiving_first_downs = sum(receiving_first_downs_num, na.rm = TRUE),
      games_in_week = data.table::uniqueN(game_id)
    ),
    by = .(season, week, player_id)
  ]
  output[, player_id := as.character(player_id)]
  output[, scoring_format := SCORING_FORMAT]
  output[, scoring_contract_version := SCORING_CONTRACT_VERSION]
  output
}

score_projection_rows <- function(x, scoring = default_scoring()) {
  validate_scoring_contract(scoring)
  fields <- c(
    "pass-yds", "pass-td", "pass-int", "pass-2pt", "rush-yds", "rush-td",
    "rush-2pt", "rec-yds", "rec-td", "rec-2pt", "rec-rec", "fum-lost"
  )
  for (field in fields) if (!field %in% names(x)) x[[field]] <- 0
  num <- function(field) {
    value <- as_numeric_or_na(x[[field]])
    value[is.na(value)] <- 0
    value
  }
  num("pass-yds") / 25 + num("pass-td") * 4 + num("pass-int") * -1 + num("pass-2pt") * 2 +
    num("rush-yds") / 10 + num("rush-td") * 6 + num("rush-2pt") * 2 +
    num("rec-yds") / 10 + num("rec-td") * 6 + num("rec-2pt") * 2 +
    num("rec-rec") * scoring$reception_points +
    num("fum-lost") * scoring$fumbles_lost_points
}
