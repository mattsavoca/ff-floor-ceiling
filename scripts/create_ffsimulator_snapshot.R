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
    serving_snapshot = "artifacts/ffsimulator/ffs_latest_rankings_week.csv"
  ),
  file.path(output_directory, "ffs_latest_rankings_week.metadata.json"),
  auto_unbox = TRUE,
  pretty = TRUE
)
cat(jsonlite::toJSON(list(snapshot_id = snapshot_id, row_count = nrow(rankings)), auto_unbox = TRUE), "\n")
