# Identity reconciliation between FBG names and nflreadr GSIS IDs.

load_identity_overrides <- function() {
  path <- path_in_project("data", "player_id_overrides.csv")
  if (!file.exists(path)) {
    return(data.table::data.table(fbg_id = character(), position = character(), gsis_id = character()))
  }
  overrides <- data.table::fread(path, na.strings = c("", "NA"), showProgress = FALSE)
  check_columns(overrides, c("fbg_id", "position", "gsis_id"), "player_id_overrides.csv")
  overrides[, `:=`(
    fbg_id = trimws(as.character(fbg_id)),
    position = toupper(trimws(as.character(position))),
    gsis_id = trimws(as.character(gsis_id))
  )]
  overrides[!nzchar(fbg_id) | !nzchar(position) | !nzchar(gsis_id),
    `:=`(fbg_id = NA_character_, position = NA_character_, gsis_id = NA_character_)]
  overrides <- overrides[!is.na(fbg_id) & position %in% BACKTEST_POSITIONS & !is.na(gsis_id)]
  if (!nrow(overrides)) {
    return(data.table::data.table(fbg_id = character(), position = character(), gsis_id = character()))
  }
  overrides[, .(gsis_id = gsis_id[[1L]]), by = .(fbg_id, position)]
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
  x[!is.na(team_key) & nzchar(name_key), .(gsis_id = gsis_id[[1L]]),
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
  x[!is.na(team_key) & nzchar(name_key), .(gsis_id = gsis_id[[1L]]),
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
  variants[nzchar(name_key), .(gsis_id = gsis_id[[1L]], latest_team_key = latest_team_key[[1L]]),
    by = .(position_key, name_key)]
}

load_drafter_crosswalk <- function() {
  path <- file.path(dirname(dirname(BACKTEST_ROOT)), "ff_drafter_2026", "raw", "dynastyprocess", "db_playerids.csv")
  if (!file.exists(path)) {
    return(data.table::data.table(fbg_id = character(), gsis_id = character()))
  }
  x <- data.table::fread(path, na.strings = c("", "NA"), showProgress = FALSE)
  check_columns(x, c("pfr_id", "gsis_id"), "drafter player crosswalk")
  x[, `:=`(fbg_id = trimws(as.character(pfr_id)), gsis_id = trimws(as.character(gsis_id)))]
  x <- x[!is.na(fbg_id) & nzchar(fbg_id) & !is.na(gsis_id) & nzchar(gsis_id)]
  x[, ids := data.table::uniqueN(gsis_id), by = fbg_id]
  x[ids == 1L, .(gsis_id = gsis_id[[1L]]), by = fbg_id]
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

  roster_by_key <- roster_candidates[, .(candidate_ids = list(unique(gsis_id))),
    by = .(season, week, team_key, position_key, name_key)]
  stats_by_key <- stats_candidates[, .(candidate_ids = list(unique(gsis_id))),
    by = .(season, week, team_key, position_key, name_key)]
  roster_by_name <- roster_candidates[, .(candidate_ids = list(unique(gsis_id))),
    by = .(season, week, position_key, name_key)]
  stats_by_name <- stats_candidates[, .(candidate_ids = list(unique(gsis_id))),
    by = .(season, week, position_key, name_key)]
  players_by_name <- player_candidates[, .(candidate_ids = list(unique(gsis_id))),
    by = .(position_key, name_key)]

  x[roster_by_key, on = .(season, week, team_key, position_key, name_key), roster_ids := i.candidate_ids]
  x[stats_by_key, on = .(season, week, team_key, position_key, name_key), stats_ids := i.candidate_ids]
  x[roster_by_name, on = .(season, week, position_key, name_key), roster_name_ids := i.candidate_ids]
  x[stats_by_name, on = .(season, week, position_key, name_key), stats_name_ids := i.candidate_ids]
  x[players_by_name, on = .(position_key, name_key), player_ids := i.candidate_ids]

  x[, `:=`(gsis_id = NA_character_, match_method = "unmatched", candidate_count = 0L)]
  if (nrow(drafter_crosswalk)) {
    x[drafter_crosswalk, on = .(fbg_id), `:=`(
      gsis_id = i.gsis_id,
      match_method = "pfr_crosswalk",
      candidate_count = 1L
    )]
  }
  for (i in seq_len(nrow(x))) {
    if (!is.na(x$gsis_id[[i]]) && nzchar(x$gsis_id[[i]])) next
    candidates <- x$roster_ids[[i]]
    method <- "weekly_roster_name_position_team"
    if (is.null(candidates) || !length(candidates)) {
      candidates <- x$stats_ids[[i]]
      method <- "weekly_stats_name_position_team"
    }
    if (is.null(candidates) || !length(candidates)) {
      candidates <- unique(c(x$roster_name_ids[[i]], x$stats_name_ids[[i]]))
      candidates <- candidates[!is.na(candidates)]
      method <- "weekly_name_position"
    }
    if (is.null(candidates) || !length(candidates)) {
      candidates <- x$player_ids[[i]]
      method <- "master_name_position"
    }
    candidates <- unique(as.character(candidates))
    candidates <- candidates[!is.na(candidates) & nzchar(candidates)]
    x$candidate_count[[i]] <- length(candidates)
    if (length(candidates) == 1L) {
      x$gsis_id[[i]] <- candidates[[1L]]
      x$match_method[[i]] <- method
    }
  }

  if (nrow(overrides)) {
    x[overrides, on = .(fbg_id, position_key = position), `:=`(
      gsis_id = i.gsis_id,
      match_method = "manual_override",
      candidate_count = 1L
    )]
  }

  x[, c("position_key", "team_key", "name_key", "row_id", "roster_ids", "stats_ids", "roster_name_ids", "stats_name_ids", "player_ids") := NULL]
  x[]
}
