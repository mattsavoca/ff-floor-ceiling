# XGBoost v2 comparison report

Release: `forecast-ppr-v2`  
Scoring contract: `PPR` / `ppr_v1`  
Common held-out comparison rows: **9,376**  
Raw XGBoost quantile crossing events: **0**

Pinball loss is the primary floor, median, and ceiling comparison metric. Lower is better. Coverage is the share of actual scores at or below each quantile. Interval coverage is the share between p15 and p85. Interval width is p85 minus p15.

## Model winner by position

| Position | Floor winner | Ceiling winner | Median winner | XGB p15 loss | ffsim p15 loss | XGB p85 loss | ffsim p85 loss |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: |
| QB | ffsimulator | ffsimulator | ffsimulator | 1.8165 | 1.7844 | 1.9841 | 1.9373 |
| RB | ffsimulator | ffsimulator | ffsimulator | 1.4053 | 1.1330 | 2.3577 | 1.9027 |
| WR | ffsimulator | ffsimulator | ffsimulator | 1.4146 | 1.1836 | 2.2234 | 1.9466 |
| TE | ffsimulator | ffsimulator | ffsimulator | 1.0922 | 0.7592 | 1.7775 | 1.4624 |

## Position metrics

| Position | Model | N | p15 coverage | p50 coverage | p85 coverage | p15 loss | p50 loss | p85 loss | p50 MAE | p50 bias | Interval coverage | Width | Crossings |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| QB | ffsimulator | 987 | 0.1733 | 0.4965 | 0.8278 | 1.7844 | 3.2436 | 1.9373 | 6.4872 | -0.4353 | 0.6545 | 15.6642 | 0 |
| QB | xgboost_v2 | 987 | 0.1722 | 0.5076 | 0.8349 | 1.8165 | 3.2896 | 1.9841 | 6.5791 | -0.1951 | 0.6626 | 16.1270 | 0 |
| RB | ffsimulator | 2478 | 0.3015 | 0.5981 | 0.8668 | 1.1330 | 2.6217 | 1.9027 | 5.2434 | -0.6952 | 0.6170 | 12.7824 | 0 |
| RB | xgboost_v2 | 2478 | 0.3172 | 0.6069 | 0.8902 | 1.4053 | 3.3326 | 2.3577 | 6.6652 | 0.2378 | 0.5730 | 16.9215 | 0 |
| TE | ffsimulator | 2282 | 0.3304 | 0.5855 | 0.8642 | 0.7592 | 1.8954 | 1.4624 | 3.7908 | -0.8566 | 0.7713 | 9.5212 | 0 |
| TE | xgboost_v2 | 2282 | 0.4075 | 0.6543 | 0.8900 | 1.0922 | 2.4060 | 1.7775 | 4.8119 | 0.5454 | 0.4825 | 11.2163 | 0 |
| WR | ffsimulator | 3629 | 0.2838 | 0.5966 | 0.8788 | 1.1836 | 2.6990 | 1.9466 | 5.3980 | -0.3142 | 0.6823 | 13.7363 | 0 |
| WR | xgboost_v2 | 3629 | 0.3125 | 0.6214 | 0.8837 | 1.4146 | 3.1809 | 2.2234 | 6.3618 | 0.4246 | 0.5712 | 15.8618 | 0 |

## Season metrics

| Season | Model | N | p15 coverage | p50 coverage | p85 coverage | p15 loss | p50 loss | p85 loss | Interval coverage | Width | Crossings |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2024.0 | ffsimulator | 4569 | 0.3047 | 0.6028 | 0.8770 | 1.1049 | 2.5007 | 1.7801 | 0.6831 | 12.7508 | 0 |
| 2024.0 | xgboost_v2 | 4569 | 0.3397 | 0.6159 | 0.8755 | 1.3951 | 3.0916 | 2.1215 | 0.5358 | 14.9057 | 0 |
| 2025.0 | ffsimulator | 4807 | 0.2725 | 0.5656 | 0.8569 | 1.1541 | 2.5780 | 1.8504 | 0.6844 | 12.5761 | 0 |
| 2025.0 | xgboost_v2 | 4807 | 0.3054 | 0.6114 | 0.8879 | 1.3577 | 2.9984 | 2.1287 | 0.5825 | 15.1660 | 0 |

## Top projected player metrics

| Model | N | p15 coverage | p50 coverage | p85 coverage | p15 loss | p50 loss | p85 loss | p50 MAE | p50 bias | Interval coverage | Width | Crossings |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ffsimulator | 4714 | 0.1252 | 0.4294 | 0.7972 | 1.5406 | 3.1607 | 2.1146 | 6.3214 | -2.4139 | 0.6784 | 14.5017 | 0 |
| xgboost_v2 | 4714 | 0.1052 | 0.3914 | 0.7902 | 1.5970 | 3.2850 | 2.1485 | 6.5701 | -3.2260 | 0.6850 | 15.2978 | 0 |

## Data quality gate

Gate status: **PASS_WITH_OUTCOME_WARNINGS**.
Top-player identity coverage: **100.00%**.
Top-player observed-outcome coverage: **98.41%**.
Top-player imputed-zero rows: **112**.
The missing-outcome rows and all identity conflict notes are in `outcome_errors.csv` and `identity_resolution_audit.csv`.

## Evaluation files

- `comparison_metrics.csv` contains the full position, season, season-position, and top-player slices.
- `quantile_crossings.csv` preserves raw XGBoost outputs for every crossing event.
- `predictions.parquet` contains the common XGBoost and ffsimulator row-level comparison data.
