#!/usr/bin/env Rscript

source(file.path(dirname(dirname(normalizePath(sub("^--file=", "", grep("^--file=", commandArgs(FALSE), value = TRUE)[[1L]]), winslash = "/"))), "R", "common.R"), local = TRUE)
require_packages(c("data.table", "arrow", "ggplot2", "scales"))

predictions <- read_parquet_local(path_in_project("outputs", "player_predictions.parquet"))
games <- read_parquet_local(path_in_project("outputs", "game_predictions.parquet"))
ensure_dir(path_in_project("outputs", "plots"))

p1 <- ggplot2::ggplot(predictions, ggplot2::aes(x = p50, y = actual_score, colour = position)) +
  ggplot2::geom_point(alpha = 0.22, size = 0.8) +
  ggplot2::geom_abline(slope = 1, intercept = 0, linetype = 2) +
  ggplot2::facet_wrap(~position, scales = "free") +
  ggplot2::labs(title = "FBG rank-conditioned player simulations", x = "Simulated p50", y = "Actual FFFL-style score") +
  ggplot2::theme_minimal(base_size = 11) +
  ggplot2::theme(legend.position = "none")
ggplot2::ggsave(path_in_project("outputs", "plots", "player_p50_vs_actual.png"), p1, width = 10, height = 7, dpi = 160)

predictions[, `:=`(
  ffpts_rounded = round_to_half(actual_score),
  xfpts_rounded = round_to_half(p50)
)]

position_calibration <- predictions[
  is.finite(ffpts_rounded) & is.finite(xfpts_rounded),
  .(
    avg_ffpts_rounded = mean(ffpts_rounded),
    n = .N
  ),
  by = .(position, xfpts_rounded)
]
data.table::setorder(position_calibration, position, xfpts_rounded)
data.table::fwrite(
  position_calibration,
  path_in_project("outputs", "position_xfpts_calibration_summary.csv")
)
data.table::fwrite(
  position_calibration,
  path_in_project("outputs", "position_fantasy_points_summary.csv")
)

p_position <- ggplot2::ggplot(
  position_calibration,
  ggplot2::aes(
    x = xfpts_rounded,
    y = avg_ffpts_rounded
  )
) +
  ggplot2::geom_abline(slope = 1, intercept = 0, linetype = 2, colour = "grey50") +
  ggplot2::geom_line(colour = "#2C7FB8", linewidth = 0.7) +
  ggplot2::geom_point(colour = "#2C7FB8", size = 1.8) +
  ggplot2::facet_wrap(~position, scales = "free") +
  ggplot2::labs(
    title = "Observed fantasy points by rounded simulation estimate",
    subtitle = "Each panel is a position. Each point averages rounded observed scores for one rounded p50 estimate.",
    x = "Simulation estimate, xfpts_rounded",
    y = "Average observed score, avg_ffpts_rounded"
  ) +
  ggplot2::theme_bw(base_size = 11) +
  ggplot2::theme(
    legend.position = "none",
    panel.background = ggplot2::element_rect(fill = "white", colour = NA),
    plot.background = ggplot2::element_rect(fill = "white", colour = NA)
)
ggplot2::ggsave(
  path_in_project("outputs", "plots", "position_xfpts_calibration.png"),
  p_position,
  width = 8,
  height = 6,
  dpi = 160,
  bg = "white"
)
ggplot2::ggsave(
  path_in_project("outputs", "plots", "position_average_estimated_vs_observed.png"),
  p_position,
  width = 8,
  height = 6,
  dpi = 160,
  bg = "white"
)

predictions[, `:=`(
  ffpts_rounded_total = round_to_increment(actual_score, increment = 1),
  xfpts_rounded_total = round_to_increment(p50, increment = 1),
  p15_rounded_total = round_to_increment(p15, increment = 1),
  p85_rounded_total = round_to_increment(p85, increment = 1)
)]

position_calibration_integer <- predictions[
  is.finite(ffpts_rounded_total) & is.finite(xfpts_rounded_total),
  .(
    avg_ffpts_rounded = mean(ffpts_rounded_total),
    avg_p15_rounded = mean(p15_rounded_total),
    avg_p85_rounded = mean(p85_rounded_total),
    n = .N
  ),
  by = .(position, xfpts_rounded = xfpts_rounded_total)
]
data.table::setorder(position_calibration_integer, position, xfpts_rounded)
data.table::fwrite(
  position_calibration_integer,
  path_in_project("outputs", "position_xfpts_calibration_integer_summary.csv")
)

p_position_integer <- ggplot2::ggplot(
  position_calibration_integer,
  ggplot2::aes(x = xfpts_rounded, y = avg_ffpts_rounded)
) +
  ggplot2::geom_abline(
    slope = 1,
    intercept = 0,
    linetype = "dotted",
    linewidth = 0.6,
    colour = "grey50"
  ) +
  ggplot2::geom_point(
    ggplot2::aes(y = avg_p15_rounded, colour = "avg_p15_rounded"),
    size = 1.1
  ) +
  ggplot2::geom_point(
    ggplot2::aes(y = avg_p85_rounded, colour = "avg_p85_rounded"),
    size = 1.1
  ) +
  ggplot2::geom_point(
    ggplot2::aes(colour = "avg_ffpts_rounded"),
    size = 2.1
  ) +
  ggplot2::facet_wrap(~position, scales = "free") +
  ggplot2::scale_colour_manual(
    name = NULL,
    values = c(
      avg_ffpts_rounded = "black",
      avg_p15_rounded = "#969696",
      avg_p85_rounded = "#2C7FB8"
    ),
    labels = c(
      avg_ffpts_rounded = "Average observed",
      avg_p15_rounded = "Average p15",
      avg_p85_rounded = "Average p85"
    )
  ) +
  ggplot2::labs(
    title = "Observed fantasy points by whole-point simulation estimate",
    subtitle = "Small dots show the average rounded p15 and p85 values for each estimate bin.",
    x = "Simulation estimate, xfpts_rounded",
    y = "Average observed score, avg_ffpts_rounded"
  ) +
  ggplot2::theme_bw(base_size = 11) +
  ggplot2::theme(
    panel.background = ggplot2::element_rect(fill = "white", colour = NA),
    plot.background = ggplot2::element_rect(fill = "white", colour = NA),
    legend.position = "bottom"
  )
ggplot2::ggsave(
  path_in_project("outputs", "plots", "position_xfpts_calibration_integer.png"),
  p_position_integer,
  width = 9,
  height = 7,
  dpi = 160,
  bg = "white"
)

position_calibration_p85 <- predictions[
  is.finite(actual_score) & is.finite(p85),
  .(
    ffpts_p85 = as.numeric(stats::quantile(actual_score, probs = 0.85, names = FALSE, type = 7)),
    avg_p15_rounded = mean(round_to_increment(p15, increment = 1)),
    avg_p85_rounded = mean(round_to_increment(p85, increment = 1)),
    n = .N
  ),
  by = .(position, xfpts_p85 = round_to_increment(p85, increment = 1))
]
data.table::setorder(position_calibration_p85, position, xfpts_p85)
data.table::fwrite(
  position_calibration_p85,
  path_in_project("outputs", "position_xfpts_p85_calibration_summary.csv")
)

# facet_wrap applies coord_cartesian x limits to every panel. Keep all bins in
# the summary, then restrict only the QB plotting data so its free scale starts at 10.
p85_plot_data <- position_calibration_p85[
  position != "QB" | xfpts_p85 >= 10
]

p_position_p85 <- ggplot2::ggplot(
  p85_plot_data,
  ggplot2::aes(x = xfpts_p85, y = ffpts_p85)
) +
  ggplot2::geom_abline(
    slope = 1,
    intercept = 0,
    linetype = "dotted",
    linewidth = 0.6,
    colour = "grey50"
  ) +
  ggplot2::geom_point(colour = "black", size = 2.1) +
  ggplot2::facet_wrap(~position, scales = "free") +
  ggplot2::coord_cartesian(expand = FALSE) +
  ggplot2::labs(
    title = "Observed p85 fantasy points by p85 simulation estimate",
    subtitle = "Each point is an estimate bin. The QB panel is zoomed to simulation p85 estimates from 10 upward.",
    x = "Simulation p85 estimate, xfpts_p85",
    y = "Observed p85 fantasy points, ffpts_p85"
  ) +
  ggplot2::theme_bw(base_size = 11) +
  ggplot2::theme(
    panel.background = ggplot2::element_rect(fill = "white", colour = NA),
    plot.background = ggplot2::element_rect(fill = "white", colour = NA),
    legend.position = "none"
  )
ggplot2::ggsave(
  path_in_project("outputs", "plots", "position_xfpts_p85_calibration.png"),
  p_position_p85,
  width = 9,
  height = 7,
  dpi = 160,
  bg = "white"
)

position_calibration_p15 <- predictions[
  is.finite(actual_score) & is.finite(p15),
  .(
    ffpts_p15 = as.numeric(stats::quantile(actual_score, probs = 0.15, names = FALSE, type = 7)),
    n = .N
  ),
  by = .(position, xfpts_p15 = round_to_increment(p15, increment = 1))
]
data.table::setorder(position_calibration_p15, position, xfpts_p15)
data.table::fwrite(
  position_calibration_p15,
  path_in_project("outputs", "position_xfpts_p15_calibration_summary.csv")
)

p_position_p15 <- ggplot2::ggplot(
  position_calibration_p15,
  ggplot2::aes(x = xfpts_p15, y = ffpts_p15)
) +
  ggplot2::geom_abline(
    slope = 1,
    intercept = 0,
    linetype = "dotted",
    linewidth = 0.6,
    colour = "grey50"
  ) +
  ggplot2::geom_point(colour = "black", size = 2.1) +
  ggplot2::facet_wrap(~position, scales = "free") +
  ggplot2::scale_x_continuous(
    expand = ggplot2::expansion(mult = 0.05, add = 0.5)
  ) +
  ggplot2::scale_y_continuous(
    expand = ggplot2::expansion(mult = 0.05, add = 0.5)
  ) +
  ggplot2::labs(
    title = "Observed p15 fantasy points by p15 simulation estimate",
    subtitle = "Each point is an estimate bin.",
    x = "Simulation p15 estimate, xfpts_p15",
    y = "Observed p15 fantasy points, ffpts_p15"
  ) +
  ggplot2::theme_bw(base_size = 11) +
  ggplot2::theme(
    panel.background = ggplot2::element_rect(fill = "white", colour = NA),
    plot.background = ggplot2::element_rect(fill = "white", colour = NA),
    legend.position = "none"
  )
ggplot2::ggsave(
  path_in_project("outputs", "plots", "position_xfpts_p15_calibration.png"),
  p_position_p15,
  width = 9,
  height = 7,
  dpi = 160,
  bg = "white"
)

coverage <- predictions[, .(
  coverage = mean(actual_score >= p15 & actual_score <= p85),
  mean_width = mean(p85 - p15),
  n = .N
), by = .(season, position)]
p2 <- ggplot2::ggplot(coverage, ggplot2::aes(x = season, y = coverage, colour = position, group = position)) +
  ggplot2::geom_hline(yintercept = 0.70, linetype = 2) +
  ggplot2::geom_line() + ggplot2::geom_point() +
  ggplot2::scale_y_continuous(labels = scales::percent_format(accuracy = 1), limits = c(0, 1)) +
  ggplot2::labs(title = "Observed coverage of the p15 to p85 interval", y = "Coverage", x = NULL) +
  ggplot2::theme_minimal(base_size = 11)
ggplot2::ggsave(path_in_project("outputs", "plots", "player_interval_coverage.png"), p2, width = 9, height = 6, dpi = 160)

game_long <- data.table::melt(
  games,
  id.vars = c("game_id", "season", "actual_margin"),
  measure.vars = c("sim_margin_p50", "market_margin_p50", "blend_margin_p50"),
  variable.name = "method",
  value.name = "predicted_margin"
)
game_long[, method := sub("_margin_p50$", "", method)]
p3 <- ggplot2::ggplot(game_long, ggplot2::aes(x = predicted_margin, y = actual_margin, colour = method)) +
  ggplot2::geom_point(alpha = 0.35, size = 0.8) +
  ggplot2::geom_abline(slope = 1, intercept = 0, linetype = 2) +
  ggplot2::facet_wrap(~method) +
  ggplot2::labs(title = "Game margin predictions", x = "Predicted home margin", y = "Actual home margin") +
  ggplot2::theme_minimal(base_size = 11) + ggplot2::theme(legend.position = "none")
ggplot2::ggsave(path_in_project("outputs", "plots", "game_margin_predictions.png"), p3, width = 10, height = 7, dpi = 160)

message("Plots written to outputs/plots.")
