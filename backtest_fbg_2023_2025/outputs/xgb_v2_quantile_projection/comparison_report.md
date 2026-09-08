# XGBoost v2 comparison report

Release: `forecast-ppr-v2`  
Scoring contract: `PPR` / `ppr_v1`  
Common held-out comparison rows: **9,376**  
Raw XGBoost quantile crossing events: **0**

Pinball loss is the primary floor, median, and ceiling comparison metric. Lower is better. Coverage is the share of actual scores at or below each quantile. Interval coverage is the share between p15 and p85. Interval width is p85 minus p15.

## Model winner by position

| Position | Floor winner | Ceiling winner | Median winner | XGB p15 loss | ffsim p15 loss | XGB p85 loss | ffsim p85 loss |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: |
| QB | xgboost_v2 | xgboost_v2 | xgboost_v2 | 1.7283 | 1.7844 | 1.9024 | 1.9373 |
| RB | xgboost_v2 | xgboost_v2 | xgboost_v2 | 1.0333 | 1.1330 | 1.6065 | 1.9027 |
| WR | ffsimulator | xgboost_v2 | xgboost_v2 | 1.2695 | 1.1836 | 1.7548 | 1.9466 |
| TE | ffsimulator | xgboost_v2 | xgboost_v2 | 1.0708 | 0.7592 | 1.3710 | 1.4624 |

## Position metrics

| Position | Model | N | p15 coverage | p50 coverage | p85 coverage | p15 loss | p50 loss | p85 loss | p50 MAE | p50 bias | Interval coverage | Width | Crossings |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| QB | ffsimulator | 987 | 0.1733 | 0.4965 | 0.8278 | 1.7844 | 3.2436 | 1.9373 | 6.4872 | -0.4353 | 0.6545 | 15.6642 | 0 |
| QB | xgboost_v2 | 987 | 0.1692 | 0.4762 | 0.8369 | 1.7283 | 3.1268 | 1.9024 | 6.2537 | -0.7224 | 0.6677 | 14.9756 | 0 |
| RB | ffsimulator | 2478 | 0.3015 | 0.5981 | 0.8668 | 1.1330 | 2.6217 | 1.9027 | 5.2434 | -0.6952 | 0.6170 | 12.7824 | 0 |
| RB | xgboost_v2 | 2478 | 0.3212 | 0.6049 | 0.8729 | 1.0333 | 2.1988 | 1.6065 | 4.3975 | -0.5392 | 0.5517 | 10.9135 | 0 |
| TE | ffsimulator | 2282 | 0.3304 | 0.5855 | 0.8642 | 0.7592 | 1.8954 | 1.4624 | 3.7908 | -0.8566 | 0.7713 | 9.5212 | 0 |
| TE | xgboost_v2 | 2282 | 0.4435 | 0.6547 | 0.8861 | 1.0708 | 1.8364 | 1.3710 | 3.6727 | 0.3028 | 0.4426 | 8.4469 | 0 |
| WR | ffsimulator | 3629 | 0.2838 | 0.5966 | 0.8788 | 1.1836 | 2.6990 | 1.9466 | 5.3980 | -0.3142 | 0.6823 | 13.7363 | 0 |
| WR | xgboost_v2 | 3629 | 0.3486 | 0.6324 | 0.8796 | 1.2695 | 2.4690 | 1.7548 | 4.9379 | 0.2905 | 0.5310 | 11.6375 | 0 |

## Season metrics

| Season | Model | N | p15 coverage | p50 coverage | p85 coverage | p15 loss | p50 loss | p85 loss | Interval coverage | Width | Crossings |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2024.0 | ffsimulator | 4569 | 0.3047 | 0.6028 | 0.8770 | 1.1049 | 2.5007 | 1.7801 | 0.6831 | 12.7508 | 0 |
| 2024.0 | xgboost_v2 | 4569 | 0.3506 | 0.6087 | 0.8617 | 1.2018 | 2.2876 | 1.6267 | 0.5111 | 10.5946 | 0 |
| 2025.0 | ffsimulator | 4807 | 0.2725 | 0.5656 | 0.8569 | 1.1541 | 2.5780 | 1.8504 | 0.6844 | 12.5761 | 0 |
| 2025.0 | xgboost_v2 | 4807 | 0.3408 | 0.6193 | 0.8875 | 1.2120 | 2.3369 | 1.6482 | 0.5467 | 11.4263 | 0 |

## Top projected player metrics

| Model | N | p15 coverage | p50 coverage | p85 coverage | p15 loss | p50 loss | p85 loss | p50 MAE | p50 bias | Interval coverage | Width | Crossings |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ffsimulator | 4714 | 0.1252 | 0.4294 | 0.7972 | 1.5406 | 3.1607 | 2.1146 | 6.3214 | -2.4139 | 0.6784 | 14.5017 | 0 |
| xgboost_v2 | 4714 | 0.2005 | 0.5178 | 0.8362 | 1.4949 | 2.9388 | 1.9679 | 5.8776 | -0.6804 | 0.6358 | 13.9355 | 0 |

## Data quality gate

Gate status: **PASS_WITH_OUTCOME_WARNINGS**.
Top-player identity coverage: **100.00%**.
Top-player observed-outcome coverage: **98.41%**.
Top-player imputed-zero rows: **112**.
Top-player groups below the requested limit because the approved non-FA source had fewer available rows: **28**.
The missing-outcome rows and all identity conflict notes are in `outcome_errors.csv` and `identity_resolution_audit.csv`.

## Evaluation files

- `comparison_metrics.csv` contains the full position, season, season-position, and top-player slices.
- `quantile_crossings.csv` preserves raw XGBoost outputs for every crossing event.
- `predictions.parquet` contains the common XGBoost and ffsimulator row-level comparison data.
