#' Validate and store an inactive player correlation layer
#'
#' The v0 player summaries use marginal draws only. This object records a
#' FantasyLabs-style correlation matrix for later joint simulation work.
#'
#' @param correlation_matrix A square numeric matrix with values from -1 to 1.
#' @param player_ids Optional player IDs for the rows and columns.
#' @param source Name of the matrix source.
#'
#' @return An object with `active = FALSE`.
#' @export
new_correlation_layer <- function(
    correlation_matrix,
    player_ids = NULL,
    source = "fantasylabs") {
  matrix_value <- as.matrix(correlation_matrix)
  if (!is.numeric(matrix_value) || length(dim(matrix_value)) != 2L || nrow(matrix_value) != ncol(matrix_value)) {
    stop("`correlation_matrix` must be a square numeric matrix.", call. = FALSE)
  }
  if (anyNA(matrix_value) || any(matrix_value < -1 | matrix_value > 1)) {
    stop("`correlation_matrix` values must be finite and between -1 and 1.", call. = FALSE)
  }
  if (!isTRUE(all.equal(matrix_value, t(matrix_value), tolerance = 1e-8))) {
    stop("`correlation_matrix` must be symmetric.", call. = FALSE)
  }
  if (any(abs(diag(matrix_value) - 1) > 1e-8)) {
    stop("The diagonal of `correlation_matrix` must contain 1.", call. = FALSE)
  }
  if (is.null(player_ids)) {
    player_ids <- rownames(matrix_value)
  }
  if (is.null(player_ids)) player_ids <- as.character(seq_len(nrow(matrix_value)))
  if (length(player_ids) != nrow(matrix_value) || anyNA(player_ids) || anyDuplicated(player_ids)) {
    stop("`player_ids` must identify each matrix row exactly once.", call. = FALSE)
  }
  dimnames(matrix_value) <- list(as.character(player_ids), as.character(player_ids))
  structure(
    list(
      matrix = matrix_value,
      player_ids = as.character(player_ids),
      source = as.character(source),
      active = FALSE
    ),
    class = "ff_correlation_layer"
  )
}
