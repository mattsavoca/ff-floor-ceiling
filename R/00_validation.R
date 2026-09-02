BYOR_COLUMNS <- c(
  "player_id",
  "player_name",
  "position",
  "team",
  "rank",
  "rank_uncertainty",
  "bye_week",
  "as_of",
  "source"
)

utils::globalVariables(c(
  "active",
  "actual_score",
  "actual_zero",
  "away_team",
  "away_win_probability",
  "covered",
  "expected_team_total",
  "expected_margin",
  "ff_expected_margin",
  "games_played",
  "probability_zero",
  "p15_margin",
  "p85_margin",
  "projected_score",
  "result",
  "realized_rank",
  "season_score",
  "signal_key",
  "sim",
  "simulation_id",
  "team",
  "team_fantasy_total",
  "tie_probability",
  "z_team",
  "home_team",
  "home_win_probability",
  "median_margin",
  "n_simulations",
  "predicted_winner"
))

ff_require_data_frame <- function(x, name) {
  if (!is.data.frame(x)) {
    stop("`", name, "` must be a data frame.", call. = FALSE)
  }
  invisible(x)
}

ff_require_columns <- function(x, columns, name = "data") {
  missing_columns <- setdiff(columns, names(x))
  if (length(missing_columns) > 0L) {
    stop(
      "`", name, "` is missing required columns: ",
      paste(missing_columns, collapse = ", "), ".",
      call. = FALSE
    )
  }
  invisible(x)
}

ff_find_column <- function(x, candidates, field, required = TRUE) {
  found <- candidates[candidates %in% names(x)]
  if (length(found) == 0L) {
    if (required) {
      stop(
        "Could not find a column for `", field, "`. Tried: ",
        paste(candidates, collapse = ", "), ".",
        call. = FALSE
      )
    }
    return(NULL)
  }
  found[[1L]]
}

ff_recycle <- function(x, n, field) {
  if (is.null(x)) return(rep(NA, n))
  if (length(x) == 1L) return(rep(x, n))
  if (length(x) != n) {
    stop("`", field, "` must have length 1 or ", n, ".", call. = FALSE)
  }
  x
}

ff_numeric <- function(x, field, allow_na = TRUE) {
  out <- suppressWarnings(as.numeric(x))
  if (!allow_na && anyNA(out)) {
    stop("`", field, "` contains a non-numeric value.", call. = FALSE)
  }
  out
}

ff_rank_type_rows <- function(x, position_column, rank_type) {
  if (rank_type == "any") return(rep(TRUE, nrow(x)))

  type_column <- ff_find_column(
    x,
    c("rank_type", "ecr_type", "type"),
    field = "rank type",
    required = FALSE
  )
  page_column <- ff_find_column(
    x,
    c("page_type"),
    field = "page type",
    required = FALSE
  )

  keep <- rep(TRUE, nrow(x))
  if (!is.null(type_column)) {
    values <- tolower(trimws(as.character(x[[type_column]])))
    keep <- values %in% c("positional", "position", "pos", "rp", "qb", "rb", "wr", "te", "k")
  }

  if (!is.null(page_column)) {
    values <- tolower(trimws(as.character(x[[page_column]])))
    positions <- tolower(trimws(as.character(x[[position_column]])))
    page_keep <- mapply(
      function(page, pos) {
        !is.na(page) && !is.na(pos) && (page == pos || grepl(paste0(pos, "$"), page))
      },
      values,
      positions,
      USE.NAMES = FALSE
    )
    keep <- keep & page_keep
  }

  keep
}

ff_normalize_as_of <- function(x, n) {
  if (inherits(x, "Date")) return(ff_recycle(x, n, "as_of"))
  ff_recycle(as.character(x), n, "as_of")
}

ff_is_normalized_rankings <- function(x) {
  is.data.frame(x) && all(BYOR_COLUMNS %in% names(x))
}

ff_validate_normalized_rankings <- function(rankings) {
  ff_require_data_frame(rankings, "rankings")
  ff_require_columns(rankings, BYOR_COLUMNS, "rankings")

  if (nrow(rankings) == 0L) {
    stop("`rankings` must contain at least one row.", call. = FALSE)
  }
  if (anyNA(rankings$player_id) || any(!nzchar(trimws(as.character(rankings$player_id))))) {
    stop("`player_id` must contain a value for every player.", call. = FALSE)
  }
  if (anyNA(rankings$player_name) || any(!nzchar(trimws(as.character(rankings$player_name))))) {
    stop("`player_name` must contain a value for every player.", call. = FALSE)
  }
  if (anyNA(rankings$position) || any(!nzchar(trimws(as.character(rankings$position))))) {
    stop("`position` must contain a value for every player.", call. = FALSE)
  }
  if (anyNA(rankings$team) || any(!nzchar(trimws(as.character(rankings$team))))) {
    stop("`team` must contain a value for every player.", call. = FALSE)
  }

  rank <- ff_numeric(rankings$rank, "rank", allow_na = FALSE)
  uncertainty <- ff_numeric(rankings$rank_uncertainty, "rank_uncertainty", allow_na = FALSE)
  if (any(!is.finite(rank)) || any(rank <= 0)) {
    stop("`rank` must contain finite values greater than 0.", call. = FALSE)
  }
  if (any(!is.finite(uncertainty)) || any(uncertainty < 0)) {
    stop("`rank_uncertainty` must contain finite values greater than or equal to 0.", call. = FALSE)
  }
  if (anyDuplicated(as.character(rankings$player_id))) {
    stop("`rankings` must contain one positional rank per `player_id`.", call. = FALSE)
  }
  invisible(rankings)
}
