#!/usr/bin/env Rscript

source(file.path(dirname(dirname(normalizePath(sub("^--file=", "", grep("^--file=", commandArgs(FALSE), value = TRUE)[[1L]]), winslash = "/"))), "R", "common.R"), local = TRUE)
source(path_in_project("R", "scoring.R"), local = TRUE)
source(path_in_project("R", "identity.R"), local = TRUE)
require_packages(c("data.table", "arrow"))

args <- commandArgs(trailingOnly = TRUE)
if (has_cli_flag(args, "--help")) {
  cat("Build FBG rank panels, identity links, and actual-score joins.\n\nUsage:\n  Rscript scripts/03_build_panel.R [--min-set-players 100]\n")
  quit(status = 0L)
}
min_set_players <- as.integer(read_cli_value(args, "--min-set-players", "100"))
if (is.na(min_set_players) || min_set_players < 1L) abort("--min-set-players must be a positive integer.")

read_fbg_week <- function(season, week) {
  path <- fbg_raw_path(season, week)
  if (!file.exists(path)) abort("Missing FBG file: ", path, ". Run 01_download_fbg.R first.")
  x <- data.table::fread(path, showProgress = FALSE)
  check_columns(x, c("id", "name", "pos", "team", "set-id", "set-name"), basename(path))
  data.table::setnames(x, c("set-id", "set-name", "set-userid"), c("set_id", "set_name", "set_userid"), skip_absent = TRUE)
  x[, `:=`(
    season = season,
    week = week,
    raw_row = seq_len(.N),
    fbg_id = trimws(as.character(id)),
    player_name = trimws(as.character(name)),
    position = toupper(trimws(as.character(pos))),
    team = normalize_team(team),
    set_id = as.character(set_id),
    set_name = trimws(as.character(set_name))
  )]
  x[
    position %in% BACKTEST_POSITIONS & !is.na(team) & team != "FA" &
      !is.na(fbg_id) & nzchar(fbg_id) & !is.na(set_id) & nzchar(set_id)
  ]
}

fbg_rows <- data.table::rbindlist(lapply(BACKTEST_YEARS, function(season) {
  data.table::rbindlist(lapply(BACKTEST_WEEKS, function(week) read_fbg_week(season, week)), fill = TRUE)
}), fill = TRUE, use.names = TRUE)
message_counts("FBG offensive rows", fbg_rows)

set_summary <- fbg_rows[
  , .(
    set_name = set_name[[1L]],
    set_userid = if ("set_userid" %in% names(fbg_rows)) as.character(set_userid[[1L]]) else NA_character_,
    n_players = data.table::uniqueN(fbg_id),
    n_positions = data.table::uniqueN(position),
    positions = paste(sort(unique(position)), collapse = ",")
  ),
  by = .(season, week, set_id)
]
set_summary[, is_bottom_line := grepl("bottom line", tolower(set_name), fixed = TRUE)]
set_summary[, selected := n_positions == length(BACKTEST_POSITIONS) & n_players >= min_set_players & !is_bottom_line]
if (!any(set_summary$selected)) abort("No FBG offensive projector sets passed the selection rule.")
selected_sets <- set_summary[selected == TRUE, .(season, week, set_id)]

rank_rows <- fbg_rows[selected_sets, on = .(season, week, set_id), nomatch = 0L]
data.table::setorder(rank_rows, season, week, set_id, position, raw_row)
rank_rows[, projector_rank := seq_len(.N), by = .(season, week, set_id, position)]
rank_rows[, `:=`(
  is_consensus = tolower(set_name) == "projections consensus",
  consensus_projected_score = score_projection_rows(rank_rows)
)]
rank_rows <- rank_rows[, .(
  season, week, fbg_id, player_name, position, team, set_id, set_name, set_userid,
  projector_rank, is_consensus, consensus_projected_score
)]

rosters <- data.table::rbindlist(lapply(BACKTEST_YEARS, function(season) read_parquet_local(roster_raw_path(season))), fill = TRUE)
stats <- data.table::rbindlist(lapply(BACKTEST_YEARS, function(season) read_parquet_local(stats_raw_path(season))), fill = TRUE)
players <- read_parquet_local(players_raw_path())

identity_input <- unique(rank_rows[, .(season, week, fbg_id, player_name, position, team)])
identity_map <- map_fbg_to_gsis(identity_input, rosters = rosters, stats = stats, players = players)
rank_rows <- merge(
  rank_rows,
  identity_map[, .(season, week, fbg_id, player_name, position, team, gsis_id, match_method, candidate_count)],
  by = c("season", "week", "fbg_id", "player_name", "position", "team"),
  all.x = TRUE,
  sort = FALSE
)

rank_rows[, fbg_team := team]
# FBG team values can reflect a stale roster. Use the historical team attached
# to the linked GSIS ID for the team simulation, while retaining the FBG value.
stats_team <- stats[
  !is.na(player_id) & season_type == "REG" & week %in% BACKTEST_WEEKS,
  .(resolved_team = normalize_team(team)[[1L]]),
  by = .(season, week, gsis_id = as.character(player_id))
]
roster_team <- rosters[
  !is.na(gsis_id) & game_type == "REG" & week %in% BACKTEST_WEEKS,
  .(resolved_team = normalize_team(team)[[1L]]),
  by = .(season, week, gsis_id = as.character(gsis_id))
]
team_lookup <- data.table::rbindlist(list(stats_team, roster_team), fill = TRUE)
team_lookup <- team_lookup[!is.na(resolved_team) & !duplicated(team_lookup[, c("season", "week", "gsis_id"), with = FALSE])]
rank_rows[team_lookup, on = .(season, week, gsis_id), team := i.resolved_team]

actual <- score_nflreadr_weekly(stats)
actual[, actual_record := 1L]
rank_summary <- rank_rows[
  , {
    consensus <- projector_rank[is_consensus]
    consensus_score <- consensus_projected_score[is_consensus]
    list(
      player_name = player_name[[1L]],
      team = team[[1L]],
      gsis_id = as.character(gsis_id[[1L]]),
      match_method = match_method[[1L]],
      candidate_count = candidate_count[[1L]],
      ecr = mean(projector_rank),
      rank_sd = if (.N > 1L) stats::sd(projector_rank) else 0,
      n_projectors = .N,
      rank_min = min(projector_rank),
      rank_max = max(projector_rank),
      consensus_rank = if (length(consensus)) consensus[[1L]] else NA_real_,
      consensus_projected_score = if (length(consensus_score)) consensus_score[[1L]] else NA_real_
    )
  },
  by = .(season, week, fbg_id, position)
]
rank_summary[, actual_score := NA_real_]
rank_summary[, actual_record := 0L]
rank_summary[actual, on = .(season, week, gsis_id = player_id), `:=`(
  actual_score = i.actual_score,
  actual_record = i.actual_record
)]
rank_summary[!is.na(gsis_id) & is.na(actual_score), actual_score := 0]
rank_summary[, team := normalize_team(team)]

team_actual <- rank_summary[!is.na(gsis_id), .(
  actual_projected_player_points = sum(actual_score, na.rm = TRUE),
  projected_player_count = .N
), by = .(season, week, team)]
full_team_actual <- actual[, .(actual_full_skill_points = sum(actual_score, na.rm = TRUE)), by = .(season, week, team)]
team_actual <- merge(team_actual, full_team_actual, by = c("season", "week", "team"), all = TRUE)

identity_audit <- unique(rank_rows[, .(
  season, week, fbg_id, player_name, position, fbg_team,
  resolved_team = team, gsis_id, match_method, candidate_count
)])
set_summary_path <- path_in_project("data", "derived", "fbg_set_selection.csv")
identity_path <- path_in_project("data", "derived", "identity_audit.csv")
panel_rows_path <- path_in_project("data", "derived", "fbg_rank_rows.parquet")
panel_path <- path_in_project("data", "derived", "fbg_rank_summary.parquet")
team_actual_path <- path_in_project("data", "derived", "team_actuals.parquet")
write_csv_local(set_summary, set_summary_path)
write_csv_local(identity_audit, identity_path)
write_parquet_local(rank_rows, panel_rows_path)
write_parquet_local(rank_summary, panel_path)
write_parquet_local(team_actual, team_actual_path)

diagnostics <- identity_audit[
  , .(
    projected_players = .N,
    mapped_players = sum(!is.na(gsis_id)),
    unmatched_players = sum(is.na(gsis_id)),
    mapped_rate = mean(!is.na(gsis_id)),
    ambiguous_players = sum(candidate_count > 1L, na.rm = TRUE)
  ),
  by = .(season, week, match_method)
]
write_csv_local(diagnostics, path_in_project("outputs", "identity_diagnostics.csv"))

message("Selected FBG projector rows: ", format(nrow(rank_rows), big.mark = ","))
message("Rank summary rows: ", format(nrow(rank_summary), big.mark = ","))
message("Mapped rank-summary rows: ", sum(!is.na(rank_summary$gsis_id)), " of ", nrow(rank_summary))
if (mean(!is.na(rank_summary$gsis_id)) < 0.90) warning("Less than 90% of FBG rank-summary rows mapped to GSIS IDs. Review identity_audit.csv.")
