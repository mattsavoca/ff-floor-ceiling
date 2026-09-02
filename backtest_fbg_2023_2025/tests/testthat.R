if (!requireNamespace("testthat", quietly = TRUE)) {
  stop("Install the testthat package before running tests.", call. = FALSE)
}

testthat::test_dir("tests/testthat", reporter = "progress")
