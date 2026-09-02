#!/usr/bin/env Rscript

source(file.path(dirname(dirname(normalizePath(sub("^--file=", "", grep("^--file=", commandArgs(FALSE), value = TRUE)[[1L]]), winslash = "/"))), "R", "common.R"), local = TRUE)
require_packages(c("curl", "data.table"))

usage <- function() {
  cat(paste0(
    "Download weekly Footballguys projection exports.\n\n",
    "Usage:\n",
    "  Rscript scripts/01_download_fbg.R [options]\n\n",
    "Options:\n",
    "  --years 2023,2024,2025\n",
    "  --weeks 1:17\n",
    "  --delay-min 2\n",
    "  --delay-max 5\n",
    "  --force\n"
  ))
}

args <- commandArgs(trailingOnly = TRUE)
if (has_cli_flag(args, "--help")) {
  usage()
  quit(status = 0L)
}

years <- parse_int_list(read_cli_value(args, "--years", "2023,2024,2025"), "--years")
weeks <- parse_int_list(read_cli_value(args, "--weeks", "1:17"), "--weeks")
delay_min <- as.numeric(read_cli_value(args, "--delay-min", "2"))
delay_max <- as.numeric(read_cli_value(args, "--delay-max", "5"))
if (!is.finite(delay_min) || !is.finite(delay_max) || delay_min < 0 || delay_max < delay_min) {
  abort("Delay values must be finite, non-negative, and ordered.")
}
if (any(years < 2000L) || any(weeks < 1L | weeks > 18L)) abort("Years or weeks are outside the expected NFL range.")

manifest_path <- path_in_project("data", "raw", "fbg", "manifest.csv")
old_manifest <- if (file.exists(manifest_path)) data.table::fread(manifest_path, showProgress = FALSE) else data.table::data.table()
manifest_rows <- list()
set.seed(20260902L)

for (season in years) {
  for (week in weeks) {
    path <- fbg_raw_path(season, week)
    url <- sprintf("https://www.footballguys.com/projections/download/weekly/all/%d/%d", season, week)
    cached <- file.exists(path) && !has_cli_flag(args, "--force")
    downloaded_at <- format(Sys.time(), tz = "UTC", usetz = TRUE)

    if (!cached) {
      ensure_dir(dirname(path))
      part <- paste0(path, ".part")
      if (file.exists(part)) unlink(part)
      message(sprintf("Downloading FBG %d week %02d", season, week))
      tryCatch(
        curl::curl_download(
          url,
          destfile = part,
          handle = curl::new_handle(useragent = "ff-floor-ceiling historical backtest")
        ),
        error = function(error) abort("FBG download failed for ", season, " week ", week, ": ", conditionMessage(error))
      )
      check_fbg_file(part)
      if (file.exists(path)) unlink(path)
      if (!file.rename(part, path)) abort("Could not publish FBG file: ", path)
      if (delay_max > 0) Sys.sleep(stats::runif(1L, delay_min, delay_max))
    } else {
      message(sprintf("Using cached FBG %d week %02d", season, week))
      tryCatch(check_fbg_file(path), error = function(error) abort("Cached FBG file is invalid: ", path, ". Use --force to replace it."))
    }

    x <- data.table::fread(path, showProgress = FALSE)
    manifest_rows[[length(manifest_rows) + 1L]] <- data.table::data.table(
      season = season,
      week = week,
      url = url,
      path = normalizePath(path, winslash = "/"),
      cached = cached,
      downloaded_at_utc = downloaded_at,
      bytes = file.info(path)$size,
      rows = nrow(x),
      set_count = data.table::uniqueN(x[["set-id"]]),
      set_name_count = data.table::uniqueN(x[["set-name"]])
    )
  }
}

manifest <- data.table::rbindlist(c(list(old_manifest), manifest_rows), fill = TRUE, use.names = TRUE)
manifest <- manifest[!duplicated(manifest[, .(season, week)], fromLast = TRUE)]
data.table::setorder(manifest, season, week)
write_csv_local(manifest, manifest_path)
message("FBG download manifest: ", manifest_path)
message("FBG files available: ", nrow(manifest))
