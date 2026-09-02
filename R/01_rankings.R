#' Normalize a ranking provider data frame
#'
#' The normalized table is the provider-neutral boundary for this project.
#' `rank` means positional rank. Use `rank_type = "any"` only when the input
#' already contains one positional row per player.
#'
#' @param rankings A provider data frame.
#' @param source One of `"generic"`, `"fantasypros"`, `"etr"`, or `"fbg"`.
#' @param rank_type Keep positional ranks by default. Use `"any"` for an
#'   input that has already been filtered.
#' @param scoring_format Optional scoring format to keep.
#' @param as_of Optional date or value to use when the source has no date.
#'
#' @return A data frame with the provider-neutral BYOR columns.
#' @export
normalize_rankings <- function(
    rankings,
    source = c("generic", "fantasypros", "etr", "fbg"),
    rank_type = c("positional", "any"),
    scoring_format = NULL,
    as_of = NULL) {
  source <- match.arg(source)
  rank_type <- match.arg(rank_type)
  ff_require_data_frame(rankings, "rankings")

  x <- as.data.frame(rankings, stringsAsFactors = FALSE)
  if (nrow(x) == 0L) {
    stop("`rankings` must contain at least one row.", call. = FALSE)
  }

  mapping <- switch(
    source,
    generic = list(
      player_id = c("player_id"),
      player_name = c("player_name"),
      position = c("position"),
      team = c("team"),
      rank = c("rank"),
      rank_uncertainty = c("rank_uncertainty"),
      bye_week = c("bye_week"),
      as_of = c("as_of")
    ),
    fantasypros = list(
      player_id = c("fantasypros_id", "player_id", "id"),
      player_name = c("player", "player_name", "name"),
      position = c("pos", "position"),
      team = c("team", "tm", "team_abbr"),
      rank = c("ecr", "rank"),
      rank_uncertainty = c("sd", "rank_uncertainty"),
      bye_week = c("bye", "bye_week"),
      as_of = c("scrape_date", "as_of")
    ),
    etr = list(
      player_id = c("player_id", "id", "etr_id"),
      player_name = c("player_name", "player", "name"),
      position = c("position", "pos"),
      team = c("team", "team_abbr", "tm"),
      rank = c("rank", "positional_rank", "ecr"),
      rank_uncertainty = c("rank_uncertainty", "sd"),
      bye_week = c("bye_week", "bye"),
      as_of = c("as_of", "scrape_date")
    ),
    fbg = list(
      player_id = c("player_id", "id", "fbg_id"),
      player_name = c("player_name", "player", "name"),
      position = c("position", "pos"),
      team = c("team", "team_abbr", "tm"),
      rank = c("rank", "positional_rank", "pos_rank"),
      rank_uncertainty = c("rank_uncertainty", "rank_sd", "sd"),
      bye_week = c("bye_week", "bye"),
      as_of = c("as_of", "scrape_date", "date", "datetime")
    )
  )

  position_column <- ff_find_column(x, mapping$position, "position")
  keep <- ff_rank_type_rows(x, position_column, rank_type)

  if (!is.null(scoring_format)) {
    format_column <- ff_find_column(
      x,
      c("scoring_format", "format", "scoring"),
      "scoring format",
      required = FALSE
    )
    if (is.null(format_column)) {
      stop(
        "`scoring_format` was supplied, but the input has no scoring format column.",
        call. = FALSE
      )
    }
    keep <- keep & tolower(trimws(as.character(x[[format_column]]))) ==
      tolower(trimws(as.character(scoring_format)))
  }

  x <- x[keep, , drop = FALSE]
  if (nrow(x) == 0L) {
    stop("The ranking filters returned no rows.", call. = FALSE)
  }

  get_value <- function(field, required = TRUE) {
    column <- ff_find_column(x, mapping[[field]], field, required = required)
    if (is.null(column)) return(NULL)
    x[[column]]
  }

  player_id <- as.character(get_value("player_id"))
  player_name <- as.character(get_value("player_name"))
  position <- toupper(trimws(as.character(get_value("position"))))
  team <- toupper(trimws(as.character(get_value("team"))))
  rank <- ff_numeric(get_value("rank"), "rank", allow_na = FALSE)

  uncertainty_value <- get_value("rank_uncertainty", required = FALSE)
  rank_uncertainty <- if (is.null(uncertainty_value)) {
    rep(0, nrow(x))
  } else {
    ff_numeric(uncertainty_value, "rank_uncertainty", allow_na = FALSE)
  }

  bye_value <- get_value("bye_week", required = FALSE)
  bye_week <- if (is.null(bye_value)) {
    rep(NA_real_, nrow(x))
  } else {
    ff_numeric(bye_value, "bye_week", allow_na = TRUE)
  }

  as_of_value <- if (is.null(as_of)) {
    source_as_of <- get_value("as_of", required = FALSE)
    if (is.null(source_as_of)) rep(NA_character_, nrow(x)) else source_as_of
  } else {
    ff_recycle(as_of, nrow(x), "as_of")
  }

  out <- data.frame(
    player_id = player_id,
    player_name = player_name,
    position = position,
    team = team,
    rank = rank,
    rank_uncertainty = rank_uncertainty,
    bye_week = bye_week,
    as_of = ff_normalize_as_of(as_of_value, nrow(x)),
    source = rep(source, nrow(x)),
    stringsAsFactors = FALSE,
    check.names = FALSE
  )

  ff_validate_normalized_rankings(out)
  out
}

#' Normalize FantasyPros rankings
#'
#' @param rankings A FantasyPros-shaped data frame.
#' @param ... Arguments passed to [normalize_rankings].
#' @return A normalized ranking data frame.
#' @export
byor_fantasypros <- function(rankings, ...) {
  normalize_rankings(rankings, source = "fantasypros", ...)
}

#' Normalize ETR rankings
#'
#' @param rankings An ETR-shaped data frame.
#' @param ... Arguments passed to [normalize_rankings].
#' @return A normalized ranking data frame.
#' @export
byor_etr <- function(rankings, ...) {
  normalize_rankings(rankings, source = "etr", ...)
}

ff_fbg_historical_rank_sd <- function(position, rank, historical_rankings = NULL) {
  if (is.null(historical_rankings)) {
    if (!requireNamespace("ffsimulator", quietly = TRUE)) {
      stop(
        "Install `ffsimulator`, or supply `historical_rankings`, to derive FBG rank uncertainty.",
        call. = FALSE
      )
    }
    historical_rankings <- ffsimulator::fp_rankings_history_week
  }
  ff_require_data_frame(historical_rankings, "historical_rankings")
  ff_require_columns(historical_rankings, c("pos", "rank", "sd"), "historical_rankings")

  historical_position <- toupper(trimws(as.character(historical_rankings$pos)))
  historical_rank <- ff_numeric(historical_rankings$rank, "historical rank", allow_na = FALSE)
  historical_sd <- ff_numeric(historical_rankings$sd, "historical rank uncertainty", allow_na = TRUE)
  historical_keep <- historical_position %in% unique(position) &
    is.finite(historical_rank) & is.finite(historical_sd) & historical_sd >= 0
  if (!any(historical_keep)) {
    stop("`historical_rankings` has no usable positional rank uncertainty values.", call. = FALSE)
  }

  lookup <- vector("list", length(unique(position)))
  names(lookup) <- unique(position)
  for (current_position in names(lookup)) {
    keep <- historical_keep & historical_position == current_position
    values <- tapply(
      historical_sd[keep],
      historical_rank[keep],
      stats::median,
      na.rm = TRUE
    )
    values <- values[is.finite(values)]
    if (length(values) == 0L) next
    lookup[[current_position]] <- list(
      rank = as.numeric(names(values)),
      sd = as.numeric(values)
    )
  }

  out <- rep(NA_real_, length(rank))
  for (i in seq_along(rank)) {
    values <- lookup[[position[[i]]]]
    if (is.null(values)) next
    out[[i]] <- stats::approx(
      x = values$rank,
      y = values$sd,
      xout = rank[[i]],
      rule = 2,
      ties = "ordered"
    )$y
  }
  out
}

#' Normalize Footballguys weekly projections
#'
#' Footballguys exports use one row per player in positional rank order, but
#' may omit explicit rank and standard-deviation columns. This adapter selects
#' the offensive consensus set, removes free agents, derives positional rank
#' from row order, and maps historical FantasyPros weekly uncertainty to each
#' positional rank.
#'
#' @param rankings A Footballguys projection export.
#' @param set_id Optional Footballguys set ID. When omitted, the largest set
#'   matching `set_name` and containing the four in-scope positions is used.
#' @param set_name Set name used to find the consensus set when `set_id` is
#'   omitted.
#' @param historical_rankings Optional historical table with `pos`, `rank`, and
#'   `sd`. Defaults to `ffsimulator::fp_rankings_history_week`.
#' @param uncertainty_floor Minimum rank uncertainty passed to `ffsimulator`.
#' @param as_of Optional date or value for the normalized ranking snapshot.
#'
#' @return A provider-neutral ranking data frame.
#' @export
byor_fbg <- function(
    rankings,
    set_id = NULL,
    set_name = "Projections Consensus",
    historical_rankings = NULL,
    uncertainty_floor = 0.5,
    as_of = NULL) {
  ff_require_data_frame(rankings, "rankings")
  if (length(uncertainty_floor) != 1L || is.na(uncertainty_floor) ||
      !is.finite(uncertainty_floor) || uncertainty_floor < 0) {
    stop("`uncertainty_floor` must be finite and non-negative.", call. = FALSE)
  }

  x <- as.data.frame(rankings, stringsAsFactors = FALSE)
  set_id_column <- ff_find_column(
    x,
    c("set-id", "set_id", "setid"),
    "Footballguys set ID",
    required = FALSE
  )
  set_name_column <- ff_find_column(
    x,
    c("set-name", "set_name", "setname"),
    "Footballguys set name",
    required = FALSE
  )
  position_column <- ff_find_column(x, c("pos", "position"), "position")
  team_column <- ff_find_column(x, c("team", "team_abbr", "tm"), "team")
  player_id_column <- ff_find_column(x, c("id", "player_id", "fbg_id"), "player ID")

  x$.fbg_row_order <- seq_len(nrow(x))
  x$.fbg_position <- toupper(trimws(as.character(x[[position_column]])))
  x$.fbg_team <- toupper(trimws(as.character(x[[team_column]])))
  position_keep <- x$.fbg_position %in% c("QB", "RB", "WR", "TE")
  team_keep <- !is.na(x$.fbg_team) & x$.fbg_team != "FA"

  if (is.null(set_id) && !is.null(set_name_column)) {
    set_name_value <- trimws(as.character(set_name))
    set_name_keep <- trimws(as.character(x[[set_name_column]])) == set_name_value
    candidates <- x[set_name_keep & position_keep & team_keep, , drop = FALSE]
    if (nrow(candidates) == 0L) {
      stop("No Footballguys rows matched `set_name` in the in-scope positions.", call. = FALSE)
    }
    if (!is.null(set_id_column)) {
      counts <- sort(table(as.character(candidates[[set_id_column]])), decreasing = TRUE)
      set_id <- names(counts)[[1L]]
    } else {
      set_id <- set_name_value
    }
  }

  set_keep <- rep(TRUE, nrow(x))
  if (!is.null(set_id)) {
    if (is.null(set_id_column)) {
      stop("`set_id` was supplied, but the input has no set ID column.", call. = FALSE)
    }
    set_keep <- as.character(x[[set_id_column]]) == as.character(set_id)
  } else if (!is.null(set_name_column) && !is.null(set_name)) {
    set_keep <- trimws(as.character(x[[set_name_column]])) == trimws(as.character(set_name))
  }

  x <- x[set_keep & position_keep & team_keep, , drop = FALSE]
  if (nrow(x) == 0L) {
    stop("The Footballguys filters returned no in-scope players.", call. = FALSE)
  }
  if (anyDuplicated(x[c(player_id_column, ".fbg_position")])) {
    stop("The Footballguys set must contain one row per player and position.", call. = FALSE)
  }

  rank_column <- ff_find_column(
    x,
    c("rank", "positional_rank", "pos_rank"),
    "positional rank",
    required = FALSE
  )
  rank <- if (is.null(rank_column)) {
    stats::ave(x$.fbg_row_order, x$.fbg_position, FUN = seq_along)
  } else {
    ff_numeric(x[[rank_column]], "rank", allow_na = FALSE)
  }

  uncertainty_column <- ff_find_column(
    x,
    c("rank_uncertainty", "rank_sd", "sd"),
    "rank uncertainty",
    required = FALSE
  )
  rank_uncertainty <- if (is.null(uncertainty_column)) {
    rank_uncertainty <- ff_fbg_historical_rank_sd(
      position = x$.fbg_position,
      rank = rank,
      historical_rankings = historical_rankings
    )
    if (anyNA(rank_uncertainty)) {
      stop("The historical rank uncertainty mapping does not cover every FBG position.", call. = FALSE)
    }
    rank_uncertainty
  } else {
    ff_numeric(x[[uncertainty_column]], "rank_uncertainty", allow_na = FALSE)
  }
  rank_uncertainty <- pmax(as.numeric(uncertainty_floor), rank_uncertainty)

  as_of_column <- ff_find_column(
    x,
    c("as_of", "scrape_date", "date", "datetime"),
    "as-of date",
    required = FALSE
  )
  as_of_value <- if (is.null(as_of)) {
    if (is.null(as_of_column)) NA_character_ else x[[as_of_column]]
  } else {
    as_of
  }

  prepared <- data.frame(
    player_id = as.character(x[[player_id_column]]),
    player_name = as.character(x[[ff_find_column(x, c("name", "player", "player_name"), "player name")]]),
    position = x$.fbg_position,
    team = x$.fbg_team,
    rank = rank,
    rank_uncertainty = rank_uncertainty,
    bye_week = NA_real_,
    as_of = as_of_value,
    source = "fbg",
    stringsAsFactors = FALSE,
    check.names = FALSE
  )
  normalize_rankings(prepared, source = "fbg", rank_type = "any")
}

#' Validate and normalize generic rankings
#'
#' @param rankings A data frame with provider-neutral ranking columns.
#' @param ... Arguments passed to [normalize_rankings].
#' @return A normalized ranking data frame.
#' @export
byor_generic <- function(rankings, ...) {
  normalize_rankings(rankings, source = "generic", ...)
}
