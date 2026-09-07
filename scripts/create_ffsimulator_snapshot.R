#!/usr/bin/env Rscript

options(stringsAsFactors = FALSE)
suppressPackageStartupMessages({
  library(ffsimulator)
  library(jsonlite)
})

output_directory <- file.path("artifacts", "ffsimulator")
dir.create(output_directory, recursive = TRUE, showWarnings = FALSE)

rankings <- ffsimulator::ffs_latest_rankings(type = "week")
if (!nrow(rankings)) stop("ffsimulator returned no weekly rankings.", call. = FALSE)
required <- c("player", "fantasypros_id", "pos", "team", "ecr", "sd", "scrape_date")
missing <- setdiff(required, names(rankings))
if (length(missing)) stop("The weekly ranking response is missing: ", paste(missing, collapse = ", "), call. = FALSE)

retrieved_at <- format(Sys.time(), tz = "UTC", usetz = TRUE)
snapshot_date <- format(max(as.Date(rankings$scrape_date), na.rm = TRUE), "%Y-%m-%d")
snapshot_id <- paste0("ffs_latest_rankings_week_", snapshot_date)
saveRDS(rankings, file.path(output_directory, "ffs_latest_rankings_week.rds"))
write.csv(
  data.frame(
    position = toupper(as.character(rankings$pos)),
    rank = as.numeric(rankings$ecr),
    rank_sd = as.numeric(rankings$sd),
    stringsAsFactors = FALSE
  ),
  file.path(output_directory, "ffs_latest_rankings_week.csv"),
  row.names = FALSE,
  qmethod = "double"
)
write_json(
  list(
    snapshot_id = snapshot_id,
    source_url = "https://github.com/dynastyprocess/data/raw/master/files/fp_latest_weekly.rds",
    retrieval_time = retrieved_at,
    package = "ffsimulator",
    package_version = as.character(utils::packageVersion("ffsimulator")),
    row_count = nrow(rankings),
    source_scrape_date = snapshot_date,
    raw_snapshot = "artifacts/ffsimulator/ffs_latest_rankings_week.rds",
    serving_snapshot = "artifacts/ffsimulator/ffs_latest_rankings_week.csv",
    outcome_pool = "artifacts/ffsimulator/adp_outcomes.json"
  ),
  file.path(output_directory, "ffs_latest_rankings_week.metadata.json"),
  auto_unbox = TRUE,
  pretty = TRUE
)

outcome_pool_path <- file.path("..", "ffsimulator", "inst", "cache", "adp_outcomes.rds")
if (!file.exists(outcome_pool_path)) stop("The ffsimulator outcome pool is missing: ", outcome_pool_path, call. = FALSE)
outcome_pool <- readRDS(outcome_pool_path)
required_outcome_columns <- c("pos", "rank", "prob_gp", "week_outcomes")
missing_outcome_columns <- setdiff(required_outcome_columns, names(outcome_pool))
if (length(missing_outcome_columns)) stop("The ffsimulator outcome pool is missing: ", paste(missing_outcome_columns, collapse = ", "), call. = FALSE)
outcome_rows <- unname(lapply(seq_len(nrow(outcome_pool)), function(index) {
  row <- outcome_pool[index, , drop = FALSE]
  list(
    pos = toupper(as.character(row$pos[[1]])),
    rank = as.integer(row$rank[[1]]),
    prob_gp = as.numeric(row$prob_gp[[1]]),
    week_outcomes = as.numeric(row$week_outcomes[[1]])
  )
}))
write_json(
  outcome_rows,
  file.path(output_directory, "adp_outcomes.json"),
  auto_unbox = TRUE,
  pretty = FALSE,
  na = "null"
)
cat(jsonlite::toJSON(list(snapshot_id = snapshot_id, row_count = nrow(rankings)), auto_unbox = TRUE), "\n")
