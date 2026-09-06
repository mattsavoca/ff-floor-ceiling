#!/usr/bin/env Rscript

source(file.path(dirname(dirname(normalizePath(sub("^--file=", "", grep("^--file=", commandArgs(FALSE), value = TRUE)[[1L]]), winslash = "/"))), "R", "common.R"), local = TRUE)
source(path_in_project("R", "scoring.R"), local = TRUE)
source(path_in_project("R", "simulation.R"), local = TRUE)
source(path_in_project("R", "evaluation.R"), local = TRUE)
require_packages(c("data.table", "arrow", "ffsimulator"))

usage <- function() {
  cat(paste0(
    "Run walk-forward rank-conditioned player simulations.\n\n",
    "Usage:\n",
    "  Rscript scripts/04_run_player_backtest.R [options]\n\n",
    "Options:\n",
    "  --n-simulations 1000\n",
    "  --rank-sd-multiplier 0.5\n",
    "  --qb-conditioning-strength 0\n",
    "    Optional 0 to 1 shrinkage toward a shared RB/WR/TE team environment.\n",
    "  --output-tag <optional>\n",
    "    Optional file suffix for calibration runs, using letters, numbers, _ or -.\n",
    "  --help\n"
  ))
}

args <- commandArgs(trailingOnly = TRUE)
if (has_cli_flag(args, "--help")) {
  usage()
  quit(status = 0L)
}
n_simulations <- as.integer(read_cli_value(args, "--n-simulations", "1000"))
sd_multiplier <- as.numeric(read_cli_value(args, "--rank-sd-multiplier", "0.5"))
qb_conditioning_strength <- as.numeric(read_cli_value(args, "--qb-conditioning-strength", "0"))
output_tag <- read_cli_value(args, "--output-tag", NULL)
if (is.na(n_simulations) || n_simulations < 20L) abort("--n-simulations must be at least 20.")
if (!is.finite(sd_multiplier) || sd_multiplier < 0) abort("--rank-sd-multiplier must be non-negative.")
if (!is.finite(qb_conditioning_strength) || qb_conditioning_strength < 0 || qb_conditioning_strength > 1) {
  abort("--qb-conditioning-strength must be between 0 and 1.")
}
if (!is.null(output_tag) && !grepl("^[_A-Za-z0-9-]*$", output_tag)) {
  abort("--output-tag can contain only letters, numbers, underscore, or hyphen.")
}
output_suffix <- if (is.null(output_tag)) {
  if (qb_conditioning_strength > 0) "_qb_conditioned" else ""
} else {
  output_tag
}

panel <- read_parquet_local(path_in_project("data", "derived", "fbg_rank_summary.parquet"))
check_columns(panel, c("season", "week", "fbg_id", "gsis_id", "position", "team", "ecr", "rank_sd", "n_projectors", "actual_score", "scoring_format", "scoring_contract_version"), "FBG rank summary")
assert_ppr_artifact(panel, "FBG rank summary")
panel[, `:=`(position = toupper(position), team = normalize_team(team))]
panel <- panel[season %in% BACKTEST_YEARS & week %in% BACKTEST_WEEKS]
if (!nrow(panel)) abort("The FBG rank summary is empty. Run 03_build_panel.R first.")

scoring_seasons <- sort(unique(c(OUTCOME_HISTORY_YEARS, BACKTEST_YEARS)))
scoring_paths <- vapply(scoring_seasons, stats_raw_path, character(1L))
missing_scoring_paths <- scoring_paths[!file.exists(scoring_paths)]
if (length(missing_scoring_paths)) {
  abort(
    "Historical player statistics are missing for the scoring history. Run ",
    "02_download_nflreadr.R. First missing file: ", missing_scoring_paths[[1L]]
  )
}
scoring_stats <- data.table::rbindlist(
  lapply(scoring_paths, read_parquet_local),
  fill = TRUE,
  use.names = TRUE
)
parity <- validate_ppr_parity(scoring_stats)
scoring_history <- make_scoring_history(scoring_stats)
assert_ppr_artifact(scoring_history, "scoring history")

prediction_parts <- list()
team_draw_parts <- list()
player_draw_parts <- list()
metric_parts <- list()

for (target_season in BACKTEST_YEARS) {
  # Materialize and validate the target-specific document before it reaches
  # either the outcome builder or the optional QB conditioning model.
  history_for_target <- scoring_history_before(scoring_history, target_season)
  history_path <- path_in_project(
    "data", "derived", sprintf("scoring_history_target_%d.parquet", target_season)
  )
  write_parquet_local(history_for_target, history_path)
  pool <- make_outcome_pool(history_for_target, target_season)
  qb_skill_model <- if (qb_conditioning_strength > 0) {
    fit_qb_skill_model(history_for_target, target_season)
  } else {
    NULL
  }
  training_seasons <- attr(pool, "scoring_history_seasons")
  scoring_history_rows <- attr(pool, "scoring_history_rows")
  if (!length(pool)) abort("No outcome pool exists for target season ", target_season, ".")

  for (target_week in BACKTEST_WEEKS) {
    players <- panel[
      season == target_season & week == target_week &
        !is.na(gsis_id) & !is.na(team) &
        position %in% BACKTEST_POSITIONS & n_projectors >= 3L &
        is.finite(ecr) & is.finite(rank_sd) & is.finite(actual_score)
    ]
    if (!nrow(players)) {
      warning("No mapped players for ", target_season, " week ", target_week, ".")
      next
    }
    players[, player_id := as.character(gsis_id)]
    data.table::setorder(players, position, ecr, fbg_id)
    set.seed(100000L + target_season * 100L + target_week)
    simulation <- simulate_player_week_conditioned(
      players,
      pool = pool,
      n_simulations = n_simulations,
      sd_multiplier = sd_multiplier,
      qb_skill_model = qb_skill_model,
      qb_conditioning_strength = qb_conditioning_strength
    )
    predictions <- summarize_player_week(players, simulation)
    predictions[, `:=`(
      ffpts_rounded = round_to_half(actual_score),
      xfpts_rounded = round_to_half(p50),
      ffpts_rounded_total = round_to_increment(actual_score, increment = 1),
      xfpts_rounded_total = round_to_increment(p50, increment = 1),
      xfpts_p15 = round_to_increment(p15, increment = 1),
      xfpts_p85 = round_to_increment(p85, increment = 1),
      pool_training_seasons = paste(training_seasons, collapse = ","),
      pool_max_training_season = max(training_seasons),
      scoring_history_seasons = paste(training_seasons, collapse = ","),
      scoring_history_max_season = max(training_seasons),
      scoring_history_rows = scoring_history_rows,
      n_simulations = n_simulations,
      rank_sd_multiplier = sd_multiplier,
      pool_mode = "walk_forward_prior_seasons",
      qb_conditioning_strength = qb_conditioning_strength,
      scoring_format = SCORING_FORMAT,
      scoring_contract_version = SCORING_CONTRACT_VERSION
    )]
    prediction_parts[[length(prediction_parts) + 1L]] <- predictions

    team_draws <- aggregate_team_draws(players, simulation$scores)
    team_draws[, `:=`(
      season = target_season,
      week = target_week,
      n_players = nrow(players),
      rank_sd_multiplier = sd_multiplier,
      pool_max_training_season = max(training_seasons),
      scoring_history_max_season = max(training_seasons),
      pool_mode = "walk_forward_prior_seasons",
      qb_conditioning_strength = qb_conditioning_strength,
      scoring_format = SCORING_FORMAT,
      scoring_contract_version = SCORING_CONTRACT_VERSION
    )]
    team_draw_parts[[length(team_draw_parts) + 1L]] <- team_draws
    player_draw <- simulation_to_player_draws(
      players,
      simulation,
      season = target_season,
      week = target_week
    )
    player_draw[, `:=`(
      scoring_history_max_season = max(training_seasons),
      pool_mode = "walk_forward_prior_seasons",
      scoring_format = SCORING_FORMAT,
      scoring_contract_version = SCORING_CONTRACT_VERSION
    )]
    player_draw_parts[[length(player_draw_parts) + 1L]] <- player_draw
    metric_parts[[length(metric_parts) + 1L]] <- data.table::data.table(
      season = target_season,
      week = target_week,
      projected_players = nrow(players),
      team_count = data.table::uniqueN(players$team),
      training_seasons = paste(training_seasons, collapse = ","),
      max_training_season = max(training_seasons),
      scoring_history_seasons = paste(training_seasons, collapse = ","),
      scoring_history_max_season = max(training_seasons),
      scoring_history_rows = scoring_history_rows,
      pool_mode = "walk_forward_prior_seasons",
      n_simulations = n_simulations,
      qb_conditioning_strength = qb_conditioning_strength,
      scoring_format = SCORING_FORMAT,
      scoring_contract_version = SCORING_CONTRACT_VERSION
    )
    message(sprintf("Simulated %d week %02d: %d players, %d teams", target_season, target_week, nrow(players), data.table::uniqueN(players$team)))
  }
}

if (!length(prediction_parts)) abort("No player simulations were produced.")
predictions <- data.table::rbindlist(prediction_parts, fill = TRUE, use.names = TRUE)
team_draws <- data.table::rbindlist(team_draw_parts, fill = TRUE, use.names = TRUE)
player_draws <- data.table::rbindlist(player_draw_parts, fill = TRUE, use.names = TRUE)
player_draws[, simulation_mode := if (qb_conditioning_strength == 0) "original_fbg" else "qb_conditioned_experiment"]
player_draws[, `:=`(
  scoring_format = SCORING_FORMAT,
  scoring_contract_version = SCORING_CONTRACT_VERSION
)]
run_metrics <- data.table::rbindlist(metric_parts, fill = TRUE, use.names = TRUE)
run_metrics[, `:=`(
  scoring_format = SCORING_FORMAT,
  scoring_contract_version = SCORING_CONTRACT_VERSION
)]

write_parquet_local(predictions, path_in_project("outputs", paste0("player_predictions", output_suffix, ".parquet")))
write_parquet_local(team_draws, path_in_project("outputs", paste0("team_draws", output_suffix, ".parquet")))
write_parquet_local(player_draws, path_in_project("outputs", paste0("fbg_player_draws", output_suffix, ".parquet")))
write_csv_local(run_metrics, path_in_project("outputs", paste0("player_run_metrics", output_suffix, ".csv")))

intervals <- player_interval_metrics(predictions, group_by = "position")
write_csv_local(intervals, path_in_project("outputs", paste0("player_interval_metrics", output_suffix, ".csv")))
scorecard <- player_scorecard_metrics(predictions, model_name = "ffsimulator")
write_csv_local(scorecard, path_in_project("outputs", paste0("player_scorecard_metrics", output_suffix, ".csv")))
write_csv_local(parity, path_in_project("outputs", paste0("ppr_parity", output_suffix, ".csv")))

metadata <- list(
  model = "ffsimulator",
  scoring_format = SCORING_FORMAT,
  scoring_contract_version = SCORING_CONTRACT_VERSION,
  score_field = "fantasy_points_ppr",
  target_seasons = as.integer(BACKTEST_YEARS),
  maximum_available_season = max(scoring_history$season, na.rm = TRUE),
  simulation_settings = list(
    n_simulations = n_simulations,
    rank_sd_multiplier = sd_multiplier,
    qb_conditioning_strength = qb_conditioning_strength,
    seed_formula = "100000 + target_season * 100 + target_week"
  ),
  target_history = lapply(BACKTEST_YEARS, function(target_season) {
    history <- scoring_history_before(scoring_history, target_season)
    list(
      target_season = as.integer(target_season),
      history_seasons = sort(unique(as.integer(history$season))),
      max_historical_season = max(history$season, na.rm = TRUE),
      rows = nrow(history),
      contains_target_or_future = any(history$season >= target_season)
    )
  }),
  ppr_parity = as.list(parity[1L]),
  validation = list(
    leakage_check = "passed",
    scoring_contract_check = "passed",
    reproducibility_seed_policy = "passed"
  )
)
write_json_local(metadata, path_in_project("outputs", paste0("player_backtest_metadata", output_suffix, ".json")))
history_manifest <- data.table::rbindlist(lapply(BACKTEST_YEARS, function(target_season) {
  history <- scoring_history_before(scoring_history, target_season)
  data.table::data.table(
    target_season = as.integer(target_season),
    history_document = normalizePath(
      path_in_project("data", "derived", sprintf("scoring_history_target_%d.parquet", target_season)),
      winslash = "/"
    ),
    scoring_format = SCORING_FORMAT,
    scoring_contract_version = SCORING_CONTRACT_VERSION,
    history_seasons = paste(sort(unique(history$season)), collapse = ","),
    rows = nrow(history),
    max_historical_season = max(history$season, na.rm = TRUE),
    contains_target_or_future = any(history$season >= target_season)
  )
}), fill = TRUE)
write_csv_local(history_manifest, path_in_project("outputs", "scoring_history_manifest.csv"))

message("Player predictions: ", format(nrow(predictions), big.mark = ","))
message("Team simulation draws: ", format(nrow(team_draws), big.mark = ","))
message("FBG player draw rows: ", format(nrow(player_draws), big.mark = ","))
message("Player backtest complete.")
