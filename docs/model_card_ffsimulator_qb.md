# Model card: `ffsimulator` floor and ceiling model

Card date: 2026-09-07  
Model status: Active QB range path, with a selector review noted in the caveats  
Model version: `ppr_v1` · `rank-conditioned simulation`  
Underlying package: `ffsimulator` 1.2.3.02  
Project package: `fffloorceiling` 0.1.0  

This card describes the `ffsimulator` path that supplies the quarterback
floor, middle estimate, and ceiling in the combined player range. It covers
the model, its evidence, and its limits. It does not approve the model for
uses outside the stated scope.

## Model details

- Developer: Matt Savoca for the `fffloorceiling` project. The underlying
  `ffsimulator` package is maintained by the ffverse project.
- Model type: rank-conditioned bootstrap resampling of historical weekly PPR
  outcomes. The model has no fitted tree, neural network, or regression weights.
- Release context: the current PPR run and web evidence build are dated
  2026-09-07.
- Input adapter: `R/01_rankings.R` normalizes provider rankings and
  `R/02_ffsimulator.R` sends them to the `ffsimulator` weekly sampler.
- Simulation settings in the held-out backtest: 1,000 simulations per
  player-week, rank standard-deviation multiplier 0.5, and QB conditioning
  strength 0.
- Output: a simulated weekly score distribution and its p15, p50, and p85
  values. The web Week 1 snapshot uses 10,000 draws. The held-out scorecard
  uses 1,000 draws.
- Scoring: PPR contract `ppr_v1`, with 1 point per reception, minus 2 points
  for a fumble lost, no tight-end reception bonus, and no receiving first-down
  points.
- License: the project uses the MIT license. The underlying `ffsimulator`
  package also uses the MIT license.
- Contact: `matts@users.noreply.github.com`.
- Technical sources: `R/01_rankings.R`, `R/02_ffsimulator.R`,
  `R/03_summaries.R`, `backtest_fbg_2023_2025/R/simulation.R`, and
  `backtest_fbg_2023_2025/outputs/player_backtest_metadata.json`.

The weekly sampler draws an integer rank from a normal distribution centered on
the expected rank. It uses half of the supplied rank standard deviation. It
then samples a historical weekly score for the position and nearby rank.

## Intended use

The intended users are fantasy football analysts, forecast reviewers, and
people who use the Floor and Ceiling app to compare weekly QB outcomes.

The primary use is to estimate a quarterback's weekly PPR range before the
game. The forward range uses the model for QB p15, p50, and p85. p15 is the
lower range marker. p50 is the median simulated score. p85 is the upper range
marker.

The output describes a distribution of possible scores. p85 is not a maximum
score, and p15 is not a guaranteed minimum.

### Out-of-scope use

- Do not use the output as a player health, talent, contract, or personnel
  decision.
- Do not use the output as a causal explanation of a player's performance.
- Do not use the output as a guarantee for a bet, contest entry, or financial
  return.
- Do not use the player range as a calibrated team score, game score, or win
  probability.
- Do not combine the QB range with independent player draws and call the result
  a shared game-state forecast.

## Factors

The model can change when the ranking source, rank uncertainty, scoring rules,
historical pool, target week, or simulation count changes.

| Factor | How it enters the model | Measured in the current evidence |
|---|---|---|
| Player position | Selects the historical outcome pool | Yes. The card reports QB only. |
| Expected rank | Sets the center of the sampled rank distribution | Yes. FBG rank summaries use the player rank across projectors. |
| Rank uncertainty | Sets the spread of sampled ranks | Yes. The backtest uses the standard deviation across projectors. The live FBG adapter uses a historical rank-uncertainty mapping when the export has no uncertainty field. |
| Target season | Determines the latest history that the outcome pool may use | Yes. Every target season uses earlier seasons only. |
| Target week | Selects the weekly forecast row | Yes. The backtest checks weeks 1 through 17. |
| Scoring contract | Changes the historical score in the pool | Yes. The active contract is PPR `ppr_v1`. |
| Projection source | Changes rank and uncertainty inputs | Yes. The backtest uses Footballguys Projections Consensus rows. |
| Simulation count and seed | Change Monte Carlo noise and repeatability | Yes. The backtest records 1,000 draws and a deterministic seed formula. |
| Injury, starter status, matchup, weather, scheme, and game state | May change the true score distribution without a direct model input | No. These factors are not measured as separate model features. |
| Demographic or protected-group labels | No model input or decision rule uses these labels | No group analysis was performed. |

The model does not infer a player's identity, health, ability, or personal
traits from the name or player ID. Those fields support joins and display.

## Metrics

The evaluation uses the final weekly PPR score as the observed value.

| Metric | Definition | Target or interpretation |
|---|---|---|
| p15 coverage | Share of rows where the final score is at or below predicted p15 | 15% for a calibrated lower percentile |
| p50 coverage | Share of rows where the final score is at or below predicted p50 | 50% for a calibrated median |
| p85 coverage | Share of rows where the final score is at or below predicted p85 | 85% for a calibrated upper percentile |
| p15 to p85 coverage | Share of rows where the final score falls inside the range | 70% for a calibrated interval |
| Pinball loss | Quantile error score for a selected percentile | Lower is better. The p85 score is the primary ceiling error measure. |
| Rank Spearman correlation | Rank correlation between the predicted p85 and final score | Higher values show better ordering. This is a diagnostic, not a calibration target. |

The scorecard reports point estimates. This card also reports an approximate
95% row-level bootstrap interval for the 1,444 QB rows in the extended
2023-2025 backtest. The bootstrap uses 2,000 resamples with replacement. It
does not account for dependence among rows from the same player, week, or
season.

| Aggregate metric | Estimate | Approximate 95% bootstrap interval |
|---|---:|---:|
| p15 coverage | 22.0% | 19.9% to 24.0% |
| p50 coverage | 54.6% | 52.1% to 57.3% |
| p85 coverage | 85.4% | 83.6% to 87.3% |
| p15 to p85 coverage | 63.7% | 61.2% to 66.2% |
| p85 pinball loss | 1.968 | 1.889 to 2.050 |

## Evaluation data

The evaluation joins Footballguys weekly Projections Consensus rows to
`nflreadr` regular-season player outcomes. The held-out target seasons are
2023, 2024, and 2025. The backtest contains 14,985 matched projection rows and
13,378 eligible player-week rows across QB, RB, WR, and TE. The QB slice has
1,444 rows.

The pipeline applies these filters before it evaluates the model:

- Keep QB, RB, WR, and TE rows.
- Remove free-agent team rows.
- Keep rows with a matched player identity and team.
- Keep rows with at least 3 projectors.
- Keep finite rank, rank uncertainty, and final-score values.
- Use regular-season weeks 1 through 17.

The label is `actual_score`, the realized weekly PPR score. A target season
never enters its own outcome pool. The 2023 target uses history through 2022.
The 2024 target uses history through 2023. The 2025 target uses history
through 2024.

This data fits the intended task because it pairs pregame ranking information
with the later weekly score. It does not represent future seasons, current
injury news, every projection provider, or every possible game state.

## Training data

This model has no supervised training step. The term "training data" means the
historical reference data used to build the rank and position outcome pools.

| Target season | History seasons | History rows | Latest history season |
|---:|---|---:|---:|
| 2023 | 2012 through 2022 | 59,572 | 2022 |
| 2024 | 2012 through 2023 | 65,036 | 2023 |
| 2025 | 2012 through 2024 | 70,557 | 2024 |

The pool builder joins historical weekly scores to historical FantasyPros
weekly ranks. It groups scores by position and rank, then samples from the
resulting score list. The current weekly pool builder uses weeks 1 through 16
of the historical seasons. The backtest evaluates target weeks 1 through 17.

The backtest rank spread is the standard deviation of projector ranks for the
same player-week. The live Footballguys adapter uses a median historical
FantasyPros rank standard deviation by position and rank when the export has
no uncertainty column. It applies a minimum uncertainty of 0.5.

## Quantitative analyses

The following table reports the independent `ffsimulator` baseline for the QB
slice. Each row contains one final weekly score and one frozen forecast range.

| Evaluation slice | Rows | p15 coverage | p50 coverage | p85 coverage | p15 to p85 coverage | p85 pinball loss | p85 rank rho |
|---|---:|---:|---:|---:|---:|---:|---:|
| 2023 through 2025 | 1,444 | 22.0% | 54.6% | 85.4% | 63.7% | 1.968 | 0.191 |
| 2023 | 457 | 23.9% | 59.5% | 88.4% | 65.4% | 1.930 | 0.321 |
| 2024 | 483 | 20.3% | 54.7% | 84.9% | 64.6% | 1.994 | 0.173 |
| 2025 | 504 | 21.8% | 50.2% | 83.1% | 61.3% | 1.979 | 0.084 |

The p85 estimate is close to its 85% target over the full slice. The p15
estimate covers too many final scores at 22.0% versus its 15% target. The full
range covers 63.7% of final scores versus its nominal 70% target. Results vary
by season, and the 2025 QB rank correlation is low.

No intersectional demographic analysis is available. The current evidence
uses season and position as evaluation slices. Rank bands, starter status,
injury status, team, and opponent need separate analysis before a user treats
the aggregate result as general across those conditions.

## Ethical considerations

The output can affect lineup choices, contest entries, and money. The model
should support a user's judgment. It should not make an automatic decision on
behalf of a user.

The model uses player names, IDs, teams, rankings, and historical football
outcomes. It does not use protected-group labels or personal user data. The
model does not infer health, personality, ability, or intent.

Historical football data can encode unequal opportunity, role changes, team
changes, injuries, and changes in the scoring environment. The model can carry
those patterns into a new forecast. The historical sample does not support a
claim of equal performance across demographic groups.

The app keeps user uploads and temporary session records separate from the
published calibration artifacts. Review the data contracts before adding new
sources to the model.

## Caveats and recommendations

- Keep `ffsimulator` as the QB baseline for the complete range until a new QB
  path passes the same walk-forward scorecard.
- Treat the p15 to p85 range as an estimate. Do not describe it as a promise
  or a hard bound.
- Use at least 10,000 simulations for a published forecast snapshot. More
  draws reduce Monte Carlo noise. They do not correct a biased outcome pool or
  a weak rank input.
- Monitor p15 coverage, p50 coverage, p85 coverage, interval coverage, and
  pinball loss by season, week, rank band, and starter status.
- Add grouped uncertainty intervals that resample by player and season. The
  current row bootstrap can make the evidence look more certain than it is.
- Add separate tests for current starter status, injury news, projection
  source changes, and changes in the PPR scoring rules.
- Keep team and game outputs outside this card. Independently sampled player
  scores do not create one shared game state.
- The generated floor comparison currently records XGBoost as the selected
  historical p15 reference for QB, while the combined forward range describes
  `ffsimulator` as the QB p15 path. Reconcile this selector with the serving
  contract before the next model release.

This card reports current evidence. It is not a full audit, fairness review,
deployment approval, or legal determination.
