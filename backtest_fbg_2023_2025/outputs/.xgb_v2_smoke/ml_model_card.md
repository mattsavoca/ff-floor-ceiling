# Model Card: XGBoost v2 PPR Floor, Median, and Ceiling

## 1. Model Details

- Developer: `ff_floor_ceiling` project.
- Development date: 2026-09-07.
- Model release: `forecast-ppr-v2`.
- Artifact version: `xgb_v2_quantile_20260907`.
- Model type: four serialized native XGBoost boosters, one each for QB, RB, WR, and TE.
- Objective: `reg:quantileerror` with `quantile_alpha=[0.15, 0.50, 0.85]`.
- Target: `actual_score`, under the PPR scoring contract.
- Output contract: one prediction call returns p15 in column 0, p50 in column 1, and p85 in column 2.
- XGBoost version: `3.4.1`.
- Feature version: `fbg_rank_projection_v2`.
- Feature names by position are stored in `.xgb_v2_smoke/metadata.json`.
- License and contact: repository owner and project documentation. This research artifact has no separate deployment license or support agreement.

## 2. Intended Use

The model estimates weekly PPR floor, median, and ceiling coverage for fantasy football players at the four modeled positions. It is intended for research, calibration review, and comparison with the rank-conditioned `ffsimulator` baseline.

Intended users are the project owner and reviewers who understand weekly fantasy projections and quantile error. The model is out of scope for player health, contract, betting, financial, or other real-world decisions, and it must not be treated as a guarantee of a player score or as an automated roster decision.

## 3. Factors

Relevant technical factors are position, season, week, team, projected PPR score, projected stat lines, and rank availability. Performance can also change when the projection provider, source set, player identity, scoring rules, or season mix changes.

The evaluation reports unitary slices by position and season, plus top projected players and season-position intersections. The data does not include demographic labels. No demographic or phenotypic inference is made, and no such group result is claimed.

## 4. Metrics

The primary model-selection and comparison measure is pinball loss at each requested quantile. Lower loss is better. Coverage is the share of actual scores at or below a predicted quantile. P50 mean absolute error and p50 bias describe median error. Interval coverage is the share of actual scores between p15 and p85. Interval width is p85 minus p15. Quantile crossings are raw violations of p15 <= p50 <= p85 and are never repaired before reporting.

The common held-out comparison has 9,376 rows. No confidence intervals were estimated in this run. The comparison uses the same keys and rows for XGBoost and `ffsimulator`.

## 5. Evaluation Data

Evaluation uses the approved Footballguys Projections Consensus source for regular-season weeks 1 through 17 of 2023 through 2025. The row universe is the existing `ffsimulator` output, which keeps the same source keys and at least three projectors. The corrected identity gate links each row to one GSIS ID and one weekly outcome where available. Missing weekly records are imputed to an actual score of zero and are listed in `outcome_errors.csv`.

The held-out seasons are 2024, 2025. The baseline and XGBoost comparisons use 9,376 matching rows. Important data-quality limits are the 112 top-player rows without an observed weekly stats record and any other rows listed in the error file.

## 6. Training Data

Training uses the same approved projection and corrected outcome sources. For each held-out season, the booster sees earlier seasons only. The inner validation window is weeks 14 through 17 of the most recent prior season. Every row passed to an XGBoost training DMatrix has `actual_score > 0`; zero and negative outcomes are excluded from training and remain eligible for held-out scoring when their identity is resolved.

Training rows after the positive-score rule: 10,622. Excluded non-positive candidate rows: 2,721. Invalid training rows after the rule: 0.

The model features contain the week, ecr, raw projected stat fields, and derived PPR projection score when variable for the position. Source-set count and source-set rank dispersion fields are retained in the data-quality report only. No fabricated source count is sent to the model.

## 7. Quantitative Analyses

### Model winner by position

Floor and ceiling winners below use lower p15 and p85 pinball loss, respectively.

| Position | Floor winner | Ceiling winner | Median winner |
| --- | --- | --- | --- |
| QB | ffsimulator | ffsimulator | ffsimulator |
| RB | ffsimulator | ffsimulator | ffsimulator |
| WR | ffsimulator | ffsimulator | ffsimulator |
| TE | ffsimulator | ffsimulator | ffsimulator |

### Held-out metrics by position

| Position | Model | N | p15 coverage | p50 coverage | p85 coverage | p15 loss | p50 loss | p85 loss | p50 MAE | p50 bias | Interval coverage | Width |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| QB | ffsimulator | 987 | 0.1733 | 0.4965 | 0.8278 | 1.7844 | 3.2436 | 1.9373 | 6.4872 | -0.4353 | 0.6545 | 15.6642 |
| QB | xgboost_v2 | 987 | 0.1722 | 0.5076 | 0.8349 | 1.8165 | 3.2896 | 1.9841 | 6.5791 | -0.1951 | 0.6626 | 16.1270 |
| RB | ffsimulator | 2478 | 0.3015 | 0.5981 | 0.8668 | 1.1330 | 2.6217 | 1.9027 | 5.2434 | -0.6952 | 0.6170 | 12.7824 |
| RB | xgboost_v2 | 2478 | 0.3172 | 0.6069 | 0.8902 | 1.4053 | 3.3326 | 2.3577 | 6.6652 | 0.2378 | 0.5730 | 16.9215 |
| TE | ffsimulator | 2282 | 0.3304 | 0.5855 | 0.8642 | 0.7592 | 1.8954 | 1.4624 | 3.7908 | -0.8566 | 0.7713 | 9.5212 |
| TE | xgboost_v2 | 2282 | 0.4075 | 0.6543 | 0.8900 | 1.0922 | 2.4060 | 1.7775 | 4.8119 | 0.5454 | 0.4825 | 11.2163 |
| WR | ffsimulator | 3629 | 0.2838 | 0.5966 | 0.8788 | 1.1836 | 2.6990 | 1.9466 | 5.3980 | -0.3142 | 0.6823 | 13.7363 |
| WR | xgboost_v2 | 3629 | 0.3125 | 0.6214 | 0.8837 | 1.4146 | 3.1809 | 2.2234 | 6.3618 | 0.4246 | 0.5712 | 15.8618 |

Season, season-position, and top-projected-player slices are in `comparison_metrics.csv`. The raw prediction rows are in `predictions.parquet`. The model produced
0 quantile crossing events across 0 affected stable player IDs.

## 8. Ethical Considerations

The output describes uncertain fantasy projection ranges. It can affect how a user values players, but it does not measure a person's worth, health, character, or future outside the fantasy scoring task. The pipeline uses public sports records and stable player identifiers. It records identity conflicts and manual overrides so reviewers can inspect them. It does not infer sensitive personal attributes.

The model can amplify errors in public projections, stale team labels, incomplete rosters, duplicate master records, and missing weekly stats. Reviewers should treat a quantile as a calibrated estimate for this historical data, not as a factual statement about a player.

## 9. Caveats and Recommendations

- The top-player identity gate resolved all selected top-player IDs in this run, including `GibbJa00` to `00-0039139` and `McCaCh00` to `00-0033280`.
- Top-player observed-outcome coverage was 98.41%. Missing records were allowed to proceed only as explicit imputed-zero errors.
- Serious top-player linkage errors: 0.
- Invalid training rows: 0.
- Raw quantile crossing events: 0. Inspect `quantile_crossings.csv` before any downstream use. The model outputs were not reordered or clipped.
- This release does not update or wire the web app. The four v2 boosters and v2 metadata are staged in the backend asset directory for review.
- Re-run the gate when source sets, scoring rules, weekly data, master players, or crosswalk files change. Add uncertainty intervals, longer historical evaluation, and an independent review before production use.

This card documents the release and its evidence. It is not a complete audit, deployment approval, or legal determination.
