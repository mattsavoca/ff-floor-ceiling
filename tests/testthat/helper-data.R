test_rankings <- function() {
  data.frame(
    player_id = c("qb1", "rb1", "wr1", "te1"),
    player_name = c("Quarterback One", "Running Back One", "Receiver One", "Tight End One"),
    position = c("QB", "RB", "WR", "TE"),
    team = c("AAA", "AAA", "AAA", "BBB"),
    rank = c(1, 1, 1, 1),
    rank_uncertainty = c(0, 0, 0, 0),
    bye_week = c(NA, NA, NA, NA),
    as_of = rep("2026-09-01", 4),
    source = rep("generic", 4),
    stringsAsFactors = FALSE
  )
}

test_adp_outcomes <- function() {
  positions <- c("QB", "RB", "WR", "TE")
  rows <- do.call(rbind, lapply(positions, function(position) {
    data.frame(
      pos = position,
      rank = 1:5,
      prob_gp = 1,
      week_outcomes = I(lapply(1:5, function(rank) as.numeric(rank + 0:20))),
      stringsAsFactors = FALSE
    )
  }))
  rownames(rows) <- NULL
  rows
}
