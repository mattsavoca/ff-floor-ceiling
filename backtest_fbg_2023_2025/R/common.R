# Shared paths, validation, and small data helpers for the FBG backtest.

BACKTEST_YEARS <- 2023:2025
OUTCOME_HISTORY_YEARS <- 2012:2022
BACKTEST_WEEKS <- 1:17
BACKTEST_POSITIONS <- c("QB", "RB", "WR", "TE")

project_root <- function() {
  args <- commandArgs(trailingOnly = FALSE)
  file_arg <- grep("^--file=", args, value = TRUE)
  if (length(file_arg) == 1L) {
    script_arg <- sub("^--file=", "", file_arg)
    if (file.exists(script_arg)) {
      script_path <- normalizePath(script_arg, winslash = "/")
      return(dirname(dirname(script_path)))
    }
  }
  normalizePath(".", winslash = "/")
}

BACKTEST_ROOT <- project_root()

path_in_project <- function(...) file.path(BACKTEST_ROOT, ...)

ensure_dir <- function(path) {
  dir.create(path, recursive = TRUE, showWarnings = FALSE)
  invisible(path)
}

abort <- function(...) stop(paste0(...), call. = FALSE)

require_packages <- function(packages) {
  missing <- packages[!vapply(packages, requireNamespace, logical(1), quietly = TRUE)]
  if (length(missing)) abort("Install required R packages: ", paste(missing, collapse = ", "))
  invisible(packages)
}

check_columns <- function(data, columns, label = "data") {
  missing <- setdiff(columns, names(data))
  if (length(missing)) abort(label, " is missing columns: ", paste(missing, collapse = ", "))
  invisible(data)
}

read_cli_value <- function(args, flag, default = NULL) {
  index <- match(flag, args)
  if (is.na(index)) return(default)
  if (index == length(args)) abort(flag, " needs a value.")
  args[[index + 1L]]
}

has_cli_flag <- function(args, flag) flag %in% args

parse_int_list <- function(value, label) {
  if (is.null(value) || !nzchar(value)) abort(label, " cannot be empty.")
  pieces <- unlist(strsplit(value, ",", fixed = TRUE), use.names = FALSE)
  output <- integer()
  for (piece in pieces) {
    piece <- trimws(piece)
    if (grepl("^[0-9]+:[0-9]+$", piece)) {
      ends <- as.integer(strsplit(piece, ":", fixed = TRUE)[[1L]])
      output <- c(output, seq.int(ends[[1L]], ends[[2L]]))
    } else {
      output <- c(output, suppressWarnings(as.integer(piece)))
    }
  }
  output <- sort(unique(output))
  if (!length(output) || anyNA(output)) abort(label, " must contain integers or ranges.")
  output
}

normalize_team <- function(value) {
  value <- toupper(trimws(as.character(value)))
    value[value %in% c("LAR", "STL")] <- "LA"
    value[value %in% c("OAK", "RAI", "LVR")] <- "LV"
    value[value %in% c("SD")] <- "LAC"
    value[value %in% c("JAC")] <- "JAX"
    value[value %in% c("WAS", "WSH")] <- "WAS"
    value[value %in% c("SFO")] <- "SF"
    value[value %in% c("GNB")] <- "GB"
    value[value %in% c("NWE")] <- "NE"
    value[value %in% c("NOR")] <- "NO"
    value[value %in% c("KAN")] <- "KC"
    value[value %in% c("TAM")] <- "TB"
    value[value %in% c("CLV")] <- "CLE"
    value[value %in% c("HST")] <- "HOU"
    value[value %in% c("BLT")] <- "BAL"
    value[value %in% c("OTI")] <- "TEN"
  value[is.na(value) | !nzchar(value)] <- NA_character_
  value
}

round_to_increment <- function(value, increment = 0.5) {
  if (!is.finite(increment) || increment <= 0) {
    abort("increment must be a positive finite number.")
  }
  floor(as.numeric(value) / increment + 0.5) * increment
}

round_to_half <- function(value) {
  round_to_increment(value, increment = 0.5)
}

normalize_name <- function(value) {
  value <- iconv(as.character(value), from = "", to = "ASCII//TRANSLIT", sub = "")
  value[is.na(value)] <- ""
  value <- tolower(value)
  value <- gsub("['’]", "", value)
  value <- gsub("\\b(jr|sr|ii|iii|iv|v)\\b", "", value, perl = TRUE)
  gsub("[^a-z0-9]", "", value, perl = TRUE)
}

as_numeric_or_na <- function(value) suppressWarnings(as.numeric(as.character(value)))

read_parquet_local <- function(path) {
  require_packages("arrow")
  if (!file.exists(path)) abort("File does not exist: ", path)
  data.table::as.data.table(arrow::read_parquet(path))
}

write_parquet_local <- function(data, path, overwrite = TRUE) {
  require_packages("arrow")
  ensure_dir(dirname(path))
  temp_path <- paste0(path, ".part")
  if (file.exists(temp_path)) unlink(temp_path)
  arrow::write_parquet(data, temp_path, compression = "zstd", compression_level = 3)
  if (overwrite && file.exists(path)) unlink(path)
  if (!file.rename(temp_path, path)) abort("Could not publish parquet file: ", path)
  invisible(path)
}

write_csv_local <- function(data, path, overwrite = TRUE) {
  ensure_dir(dirname(path))
  if (overwrite && file.exists(path)) unlink(path)
  data.table::fwrite(data, path, na = "")
  invisible(path)
}

write_json_local <- function(data, path, overwrite = TRUE) {
  require_packages("jsonlite")
  ensure_dir(dirname(path))
  if (overwrite && file.exists(path)) unlink(path)
  jsonlite::write_json(
    data,
    path,
    auto_unbox = TRUE,
    pretty = TRUE,
    digits = 15,
    na = "null"
  )
  invisible(path)
}

assert_ppr_artifact <- function(data, label = "artifact") {
  check_columns(data, c("scoring_format", "scoring_contract_version"), label)
  formats <- unique(as.character(data$scoring_format))
  contracts <- unique(as.character(data$scoring_contract_version))
  if (length(formats) != 1L || formats[[1L]] != SCORING_FORMAT) {
    abort(label, " has a non-PPR scoring format.")
  }
  if (length(contracts) != 1L || contracts[[1L]] != SCORING_CONTRACT_VERSION) {
    abort(label, " has an unknown scoring contract.")
  }
  invisible(data)
}

fbg_raw_path <- function(season, week) {
  path_in_project("data", "raw", "fbg", sprintf("season=%d", season), sprintf("week=%02d.csv", week))
}

stats_raw_path <- function(season) {
  path_in_project("data", "raw", "nflreadr", "player_stats", sprintf("season=%d.parquet", season))
}

schedule_raw_path <- function(season) {
  path_in_project("data", "raw", "nflreadr", "schedules", sprintf("season=%d.parquet", season))
}

roster_raw_path <- function(season) {
  path_in_project("data", "raw", "nflreadr", "rosters_weekly", sprintf("season=%d.parquet", season))
}

players_raw_path <- function() {
  path_in_project("data", "raw", "nflreadr", "players.parquet")
}

check_fbg_file <- function(path) {
  require_packages("data.table")
  header <- data.table::fread(path, nrows = 0L, showProgress = FALSE)
  check_columns(header, c("id", "name", "pos", "team", "set-id", "set-name"), basename(path))
  invisible(header)
}

message_counts <- function(label, data) {
  message(label, ": ", format(nrow(data), big.mark = ","), " rows")
  invisible(data)
}
