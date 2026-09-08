# Identity reconciliation between FBG names and nflreadr GSIS IDs.

load_identity_overrides <- function() {
  path <- path_in_project("data", "player_id_overrides.csv")
  if (!file.exists(path)) {
    return(data.table::data.table(
      fbg_id = character(), position = character(), gsis_id = character(), reason = character()
    ))
  }
  overrides <- data.table::fread(path, na.strings = c("", "NA"), showProgress = FALSE)
  check_columns(overrides, c("fbg_id", "position", "gsis_id"), "player_id_overrides.csv")
  overrides[, `:=`(
    fbg_id = trimws(as.character(fbg_id)),
    position = toupper(trimws(as.character(position))),
    gsis_id = trimws(as.character(gsis_id)),
    reason = if ("reason" %in% names(overrides)) trimws(as.character(reason)) else NA_character_
  )]
  overrides[!nzchar(fbg_id) | !nzchar(position) | !nzchar(gsis_id) | is.na(reason) | !nzchar(reason),
    `:=`(fbg_id = NA_character_, position = NA_character_, gsis_id = NA_character_, reason = NA_character_)]
  overrides <- overrides[!is.na(fbg_id) & position %in% BACKTEST_POSITIONS & !is.na(gsis_id)]
  if (!nrow(overrides)) {
    return(data.table::data.table(
      fbg_id = character(), position = character(), gsis_id = character(), reason = character()
    ))
  }
  duplicate_keys <- overrides[, data.table::uniqueN(gsis_id), by = .(fbg_id, position)][V1 > 1L]
  if (nrow(duplicate_keys)) {
    abort("player_id_overrides.csv has conflicting GSIS IDs for: ", paste(duplicate_keys$fbg_id, collapse = ", "))
  }
  overrides[, .(gsis_id = gsis_id[[1L]], reason = reason[[1L]]), by = .(fbg_id, position)]
}

prepare_roster_candidates <- function(rosters) {
  check_columns(rosters, c("season", "team", "position", "full_name", "gsis_id", "week", "game_type"), "weekly rosters")
  x <- data.table::as.data.table(data.table::copy(rosters))[
    game_type == "REG" & week %in% BACKTEST_WEEKS & position %in% BACKTEST_POSITIONS & !is.na(gsis_id)
  ]
  x[, `:=`(
    team_key = normalize_team(team),
    position_key = toupper(trimws(as.character(position))),
    name_key = normalize_name(full_name),
    gsis_id = as.character(gsis_id)
  )]
  x[!is.na(team_key) & nzchar(name_key), .(candidate_ids = list(sort(unique(gsis_id)))),
    by = .(season, week, team_key, position_key, name_key)]
}

prepare_stats_candidates <- function(stats) {
  check_columns(stats, c("season", "week", "team", "position", "player_name", "player_id"), "player stats")
  x <- data.table::as.data.table(data.table::copy(stats))[
    season_type == "REG" & week %in% BACKTEST_WEEKS & position %in% BACKTEST_POSITIONS & !is.na(player_id)
  ]
  x[, `:=`(
    team_key = normalize_team(team),
    position_key = toupper(trimws(as.character(position))),
    name_key = normalize_name(player_name),
    gsis_id = as.character(player_id)
  )]
  x[!is.na(team_key) & nzchar(name_key), .(candidate_ids = list(sort(unique(gsis_id)))),
    by = .(season, week, team_key, position_key, name_key)]
}

prepare_player_candidates <- function(players) {
  check_columns(players, c("gsis_id", "display_name", "first_name", "last_name", "football_name", "position"), "nflreadr players")
  x <- data.table::as.data.table(data.table::copy(players))[
    position %in% BACKTEST_POSITIONS & !is.na(gsis_id)
  ]
  x[, `:=`(
    position_key = toupper(trimws(as.character(position))),
    gsis_id = as.character(gsis_id),
    latest_team_key = normalize_team(latest_team)
  )]
  variants <- data.table::rbindlist(list(
    x[, .(gsis_id, position_key, name_key = normalize_name(display_name), latest_team_key)],
    x[, .(gsis_id, position_key, name_key = normalize_name(paste(first_name, last_name)), latest_team_key)],
    x[, .(gsis_id, position_key, name_key = normalize_name(paste(football_name, last_name)), latest_team_key)]
  ), use.names = TRUE, fill = TRUE)
  variants[nzchar(name_key), .(
    candidate_ids = list(sort(unique(gsis_id))),
    latest_team_keys = list(sort(unique(latest_team_key[!is.na(latest_team_key) & nzchar(latest_team_key)])))
  ),
    by = .(position_key, name_key)]
}

load_drafter_crosswalk <- function() {
  path <- file.path(dirname(dirname(BACKTEST_ROOT)), "ff_drafter_2026", "raw", "dynastyprocess", "db_playerids.csv")
  if (!file.exists(path)) {
    return(data.table::data.table(
      fbg_id = character(), gsis_id = character(), name_key = character(),
      position_key = character(), team_key = character()
    ))
  }
  x <- data.table::fread(path, na.strings = c("", "NA"), showProgress = FALSE)
  check_columns(x, c("pfr_id", "gsis_id", "name", "position", "team"), "drafter player crosswalk")
  x[, `:=`(fbg_id = trimws(as.character(pfr_id)), gsis_id = trimws(as.character(gsis_id)))]
  x[, `:=`(
    name_key = normalize_name(name),
    position_key = toupper(trimws(as.character(position))),
    team_key = normalize_team(team)
  )]
  x <- x[
    !is.na(fbg_id) & nzchar(fbg_id) & !is.na(gsis_id) & nzchar(gsis_id) &
      nzchar(name_key) & position_key %in% BACKTEST_POSITIONS & !is.na(team_key)
  ]
  x[]
}

map_fbg_to_gsis <- function(rank_rows, rosters, stats, players, overrides = load_identity_overrides()) {
  check_columns(rank_rows, c("season", "week", "fbg_id", "player_name", "position", "team"), "FBG rank rows")
  x <- data.table::as.data.table(data.table::copy(rank_rows))
  x[, `:=`(
    position_key = toupper(trimws(as.character(position))),
    team_key = normalize_team(team),
    name_key = normalize_name(player_name)
  )]
  x[, row_id := .I]

  roster_candidates <- prepare_roster_candidates(rosters)
  stats_candidates <- prepare_stats_candidates(stats)
  player_candidates <- prepare_player_candidates(players)
  drafter_crosswalk <- load_drafter_crosswalk()

  x[stats_candidates, on = .(season, week, team_key, position_key, name_key), stats_ids := i.candidate_ids]
  x[roster_candidates, on = .(season, week, team_key, position_key, name_key), roster_ids := i.candidate_ids]
  x[player_candidates, on = .(position_key, name_key), player_ids := i.candidate_ids]

  # The crosswalk is keyed by FBG/PFR ID only after its name, position, and
  # team fields have already been normalized. This prevents an ID collision
  # from assigning a player whose fields disagree with the projection row.
  if (nrow(drafter_crosswalk)) {
    crosswalk_by_key <- drafter_crosswalk[
      , .(candidate_ids = list(sort(unique(gsis_id)))),
      by = .(fbg_id, name_key, position_key, team_key)
    ]
    x[crosswalk_by_key, on = .(fbg_id, name_key, position_key, team_key), crosswalk_ids := i.candidate_ids]
    x[, crosswalk_has_id := fbg_id %in% drafter_crosswalk$fbg_id]
  } else {
    x[, crosswalk_has_id := FALSE]
  }

  x[, `:=`(
    gsis_id = NA_character_,
    match_method = "unmatched",
    candidate_count = 0L,
    override_reason = NA_character_,
    resolution_notes = NA_character_
  )]
  for (i in seq_len(nrow(x))) {
    stats_ids <- unique(as.character(x$stats_ids[[i]]))
    roster_ids <- unique(as.character(x$roster_ids[[i]]))
    master_ids <- unique(as.character(x$player_ids[[i]]))
    crosswalk_ids <- unique(as.character(x$crosswalk_ids[[i]]))
    sources <- list(
      weekly_stats_name_position_team = stats_ids,
      weekly_roster_name_position_team = roster_ids,
      master_name_position = master_ids,
      pfr_crosswalk_verified = crosswalk_ids
    )
    sources <- lapply(sources, function(ids) ids[!is.na(ids) & nzchar(ids)])
    chosen <- character()
    method <- "unmatched"
    for (source_name in names(sources)) {
      candidates <- sources[[source_name]]
      if (length(candidates) == 1L) {
        chosen <- candidates
        method <- source_name
        break
      }
    }
    source_ids <- unique(unlist(sources, use.names = FALSE))
    x$candidate_count[[i]] <- length(if (length(chosen)) chosen else source_ids)
    notes <- character()
    exact_ids <- unique(c(stats_ids, roster_ids))
    if (length(exact_ids) > 1L) notes <- c(notes, "conflicting_weekly_source_ids")
    if (isTRUE(x$crosswalk_has_id[[i]]) && !length(crosswalk_ids)) {
      notes <- c(notes, "crosswalk_fields_disagree")
    }
    if (length(chosen)) {
      x$gsis_id[[i]] <- chosen[[1L]]
      x$match_method[[i]] <- method
    }
    override <- overrides[fbg_id == x$fbg_id[[i]] & position == x$position_key[[i]]]
    if (nrow(override)) {
      x$gsis_id[[i]] <- override$gsis_id[[1L]]
      x$match_method[[i]] <- "manual_override"
      x$candidate_count[[i]] <- 1L
      x$override_reason[[i]] <- override$reason[[1L]]
      notes <- c(notes, "manual_override_applied")
    }
    if (length(notes)) x$resolution_notes[[i]] <- paste(unique(notes), collapse = ";")
  }

  x[, c("position_key", "team_key", "name_key", "row_id", "roster_ids", "stats_ids", "player_ids", "crosswalk_ids", "crosswalk_has_id") := NULL]
  x[]
}
