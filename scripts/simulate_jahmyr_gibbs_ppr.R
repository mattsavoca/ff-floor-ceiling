#!/usr/bin/env Rscript

options(stringsAsFactors = FALSE, warn = 1)
suppressPackageStartupMessages({
  library(data.table)
  library(fffloorceiling)
  library(htmlwidgets)
  library(plotly)
})

read_arg <- function(name, default = NULL) {
  prefix <- paste0("--", name, "=")
  values <- commandArgs(trailingOnly = TRUE)
  match <- values[startsWith(values, prefix)]
  if (!length(match)) return(default)
  sub(prefix, "", match[[1]], fixed = TRUE)
}

script_args <- commandArgs(trailingOnly = FALSE)
file_arg <- script_args[startsWith(script_args, "--file=")]
script_path <- if (length(file_arg)) sub("^--file=", "", file_arg[[1]]) else file.path("scripts", "simulate_jahmyr_gibbs_ppr.R")
repo_root <- normalizePath(file.path(dirname(script_path), ".."), winslash = "/", mustWork = TRUE)
setwd(repo_root)

default_projection_path <- file.path(
  Sys.getenv("USERPROFILE"),
  ".t3",
  "userdata",
  "attachments",
  "e00d5db5-4322-4357-8043-698288256540-5aa57ce4-f3a6-46a2-8b54-28ce0c2f2903-csv.csv"
)
projection_path <- read_arg("projections", default_projection_path)
output_path <- read_arg(
  "out",
  file.path("outputs", "jahmyr_gibbs_ppr_distribution.html")
)
set_name <- read_arg("set-name", "")
n_simulations <- as.integer(read_arg("n-simulations", "10000"))
simulation_seed <- as.integer(read_arg("seed", "20260908"))
week_number <- as.integer(read_arg("week", "1"))

if (!file.exists(projection_path)) {
  stop(
    "Projection file not found. Pass --projections=<path> or use the attached CSV at ",
    default_projection_path,
    call. = FALSE
  )
}
if (length(n_simulations) != 1L || is.na(n_simulations) || n_simulations < 1L) {
  stop("--n-simulations must be a positive integer.", call. = FALSE)
}
if (length(simulation_seed) != 1L || is.na(simulation_seed) || simulation_seed < 0L) {
  stop("--seed must be a non-negative integer.", call. = FALSE)
}
if (length(week_number) != 1L || is.na(week_number) || week_number < 1L || week_number > 18L) {
  stop("--week must be an integer from 1 through 18.", call. = FALSE)
}

projection_doc <- read.csv(
  projection_path,
  check.names = FALSE,
  stringsAsFactors = FALSE
)
required_projection_columns <- c(
  "id", "name", "pos", "team", "set-name", "rush-2pt", "rush-td", "rush-yds",
  "rec-2pt", "rec-rec", "rec-td", "rec-yds", "fum-lost"
)
missing_projection_columns <- setdiff(required_projection_columns, names(projection_doc))
if (length(missing_projection_columns)) {
  stop(
    "Projection file is missing: ",
    paste(missing_projection_columns, collapse = ", "),
    call. = FALSE
  )
}

available_sets <- unique(trimws(as.character(projection_doc[["set-name"]])))
available_sets <- available_sets[!is.na(available_sets) & nzchar(available_sets)]
if (!nzchar(set_name)) {
  if (length(available_sets) != 1L) {
    stop(
      "The projection file has multiple sets. Pass --set-name=<set name>. Available sets: ",
      paste(available_sets, collapse = ", "),
      call. = FALSE
    )
  }
  set_name <- available_sets[[1L]]
}

source_row <- projection_doc[
  trimws(as.character(projection_doc[["name"]])) == "Jahmyr Gibbs" &
    trimws(as.character(projection_doc[["set-name"]])) == set_name,
  ,
  drop = FALSE
]
if (nrow(source_row) != 1L) {
  stop(
    "Expected one Jahmyr Gibbs row in set `", set_name, "`; found ", nrow(source_row), ".",
    call. = FALSE
  )
}

projection_number <- function(column) as.numeric(source_row[[column]][[1L]])
source_projection_ppr <- sum(
  projection_number("rush-yds") / 10,
  projection_number("rush-td") * 6,
  projection_number("rush-2pt") * 2,
  projection_number("rec-rec"),
  projection_number("rec-yds") / 10,
  projection_number("rec-td") * 6,
  projection_number("rec-2pt") * 2,
  -projection_number("fum-lost") * 2
)

# Build a full-PPR outcome history from nflverse weekly player stats. The
# checked-in ffsimulator cache is half-PPR, so it is not used for this run.
weekly_stats <- suppressMessages(
  nflreadr::load_player_stats(
    seasons = 2019:2020,
    summary_level = "week"
  )
)
weekly_stats <- data.table::as.data.table(weekly_stats)
weekly_stats <- weekly_stats[
  season_type == "REG" &
    week <= 17 &
    position %in% c("QB", "RB", "WR", "TE") &
    !is.na(player_id)
]

ppr_scoring_history <- weekly_stats[
  , .(
    gsis_id = as.character(player_id),
    week = as.integer(week),
    season = as.integer(season),
    points = as.numeric(fantasy_points_ppr)
  )
]
if (anyNA(ppr_scoring_history$points) || any(!is.finite(ppr_scoring_history$points))) {
  stop("The full-PPR source contains missing or non-finite points.", call. = FALSE)
}
duplicate_history_keys <- ppr_scoring_history[
  , .N,
  by = .(gsis_id, season, week)
][N > 1L]
if (nrow(duplicate_history_keys)) {
  stop("The full-PPR source has duplicate player-week keys.", call. = FALSE)
}

outcome_pool <- ffsimulator::ffs_adp_outcomes_week(
  scoring_history = ppr_scoring_history,
  pos_filter = c("QB", "RB", "WR", "TE")
)
if (!nrow(outcome_pool)) stop("The full-PPR outcome pool is empty.", call. = FALSE)

rankings <- byor_fbg(
  projection_doc,
  set_name = set_name,
  as_of = as.Date("2026-09-08")
)
gibbs_rankings <- rankings[rankings$player_name == "Jahmyr Gibbs", , drop = FALSE]
if (nrow(gibbs_rankings) != 1L) stop("The normalized rankings do not contain one Gibbs row.", call. = FALSE)

draws <- simulate_player_week_outcomes(
  rankings = rankings,
  adp_outcomes = outcome_pool,
  n_simulations = n_simulations,
  week = week_number,
  seed = simulation_seed,
  rosters = data.frame(player_id = gibbs_rankings$player_id, stringsAsFactors = FALSE),
  strict = TRUE
)
if (nrow(draws) != n_simulations) {
  stop("The simulator returned ", nrow(draws), " draws; expected ", n_simulations, ".", call. = FALSE)
}
if (anyNA(draws$projected_score) || any(draws$projected_score < 0)) {
  stop("The simulator returned invalid Gibbs scores.", call. = FALSE)
}

weekly_summary <- summarize_player_outcomes(draws)$weekly
if (nrow(weekly_summary) != 1L) stop("Expected one Gibbs summary row.", call. = FALSE)
summary_row <- weekly_summary[1L, , drop = FALSE]

output_directory <- dirname(output_path)
dir.create(output_directory, recursive = TRUE, showWarnings = FALSE)
output_stem <- tools::file_path_sans_ext(basename(output_path))
draws_path <- file.path(output_directory, paste0(output_stem, "_draws.csv"))
summary_path <- file.path(output_directory, paste0(output_stem, "_summary.csv"))
metadata_path <- file.path(output_directory, paste0(output_stem, "_metadata.txt"))

draw_output <- data.table::as.data.table(draws)[
  , .(
    simulation_id,
    player_id,
    player_name,
    position,
    team,
    week,
    rank,
    ppr_score = projected_score,
    active
  )
]
write.csv(draw_output, draws_path, row.names = FALSE, na = "")

summary_output <- data.frame(
  player_id = as.character(summary_row$player_id[[1L]]),
  player_name = as.character(summary_row$player_name[[1L]]),
  position = as.character(summary_row$position[[1L]]),
  team = as.character(summary_row$team[[1L]]),
  week = as.integer(summary_row$week[[1L]]),
  scoring_format = "PPR",
  projection_source = set_name,
  source_projection_ppr = source_projection_ppr,
  simulation_count = as.integer(summary_row$n_simulations[[1L]]),
  mean = as.numeric(summary_row$mean[[1L]]),
  median = as.numeric(summary_row$median[[1L]]),
  p10 = as.numeric(summary_row$p10[[1L]]),
  p15 = as.numeric(summary_row$p15[[1L]]),
  p25 = as.numeric(summary_row$p25[[1L]]),
  p75 = as.numeric(summary_row$p75[[1L]]),
  p85 = as.numeric(summary_row$p85[[1L]]),
  p90 = as.numeric(summary_row$p90[[1L]]),
  probability_zero = as.numeric(summary_row$probability_zero[[1L]]),
  stringsAsFactors = FALSE
)
write.csv(summary_output, summary_path, row.names = FALSE, na = "")

line_spec <- function(x, color, dash = "solid", width = 2) {
  list(
    type = "line",
    x0 = x,
    x1 = x,
    y0 = 0,
    y1 = 1,
    yref = "paper",
    line = list(color = color, dash = dash, width = width)
  )
}
label_spec <- function(x, label, color, y = 1.03) {
  list(
    x = x,
    xref = "x",
    y = y,
    yref = "paper",
    text = label,
    showarrow = FALSE,
    font = list(color = color, size = 11),
    bgcolor = "rgba(255,255,255,0.82)",
    bordercolor = color,
    borderwidth = 1,
    borderpad = 3
  )
}

histogram <- plot_ly(
  x = draws$projected_score,
  type = "histogram",
  xbins = list(
    start = floor(min(draws$projected_score)),
    end = ceiling(max(draws$projected_score)) + 1,
    size = 1
  ),
  marker = list(
    color = "#0f766e",
    line = list(color = "#ffffff", width = 0.5)
  ),
  hovertemplate = "PPR points: %{x:.1f}<br>Simulations: %{y}<extra></extra>"
) %>%
  layout(
    title = list(
      text = paste0(
        "Jahmyr Gibbs full-PPR outcome distribution",
        "<br><sup>", formatC(n_simulations, format = "d", big.mark = ","),
        " ffsimulator draws, Week ", week_number, "</sup>"
      ),
      x = 0.03
    ),
    xaxis = list(
      title = "Fantasy points (PPR)",
      zeroline = FALSE,
      rangemode = "tozero"
    ),
    yaxis = list(title = "Number of simulations", rangemode = "tozero"),
    bargap = 0.04,
    hovermode = "x unified",
    plot_bgcolor = "#f8fafc",
    paper_bgcolor = "#ffffff",
    font = list(family = "Arial, sans-serif", color = "#0f172a"),
    margin = list(l = 70, r = 35, b = 65, t = 105),
    shapes = list(
      list(
        type = "rect",
        x0 = summary_output$p15,
        x1 = summary_output$p85,
        y0 = 0,
        y1 = 1,
        yref = "paper",
        fillcolor = "#14b8a6",
        opacity = 0.08,
        line = list(width = 0)
      ),
      line_spec(summary_output$p15, "#2563eb", "dot"),
      line_spec(summary_output$median, "#0f172a", "solid", 2),
      line_spec(summary_output$p85, "#dc2626", "dot"),
      line_spec(source_projection_ppr, "#7c3aed", "dash", 2)
    ),
    annotations = list(
      label_spec(summary_output$p15, paste0("P15 floor: ", round(summary_output$p15, 1)), "#2563eb"),
      label_spec(summary_output$median, paste0("Median: ", round(summary_output$median, 1)), "#0f172a", 0.96),
      label_spec(summary_output$p85, paste0("P85 ceiling: ", round(summary_output$p85, 1)), "#dc2626"),
      label_spec(source_projection_ppr, paste0("Source projection: ", round(source_projection_ppr, 1)), "#7c3aed", 0.89)
    )
  ) %>%
  config(displaylogo = FALSE, responsive = TRUE)

saveWidget(
  histogram,
  file = output_path,
  selfcontained = TRUE,
  title = "Jahmyr Gibbs PPR outcome distribution"
)

writeLines(
  c(
    "Jahmyr Gibbs ffsimulator full-PPR experiment",
    paste0("projection_input=", normalizePath(projection_path, winslash = "/")),
    paste0("projection_set=", set_name),
    paste0("player=Jahmyr Gibbs"),
    paste0("team=", gibbs_rankings$team[[1L]]),
    paste0("position_rank=", gibbs_rankings$rank[[1L]]),
    paste0("rank_uncertainty=", gibbs_rankings$rank_uncertainty[[1L]]),
    paste0("source_projection_ppr=", round(source_projection_ppr, 4)),
    "scoring_format=PPR",
    "ppr_history_source=nflreadr::load_player_stats",
    "ppr_history_seasons=2019,2020",
    "ppr_history_scope=regular season weeks 1 through 17",
    "ppr_history_field=fantasy_points_ppr",
    paste0("outcome_pool_rows=", nrow(outcome_pool)),
    paste0("outcome_pool_rb_rank_max=", max(outcome_pool$rank[outcome_pool$pos == "RB"])),
    paste0("simulator=fffloorceiling::simulate_player_week_outcomes -> ffsimulator::ffs_generate_projections_week"),
    paste0("ffsimulator_version=", as.character(utils::packageVersion("ffsimulator"))),
    paste0("simulations=", n_simulations),
    paste0("seed=", simulation_seed),
    paste0("week=", week_number),
    paste0("distribution_html=", normalizePath(output_path, winslash = "/")),
    paste0("draws_csv=", normalizePath(draws_path, winslash = "/")),
    paste0("summary_csv=", normalizePath(summary_path, winslash = "/"))
  ),
  metadata_path
)

message("Wrote ", output_path)
message("Gibbs summary: mean=", round(summary_output$mean, 2),
        ", median=", round(summary_output$median, 2),
        ", p15=", round(summary_output$p15, 2),
        ", p85=", round(summary_output$p85, 2))
