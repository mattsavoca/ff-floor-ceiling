# Provider-Neutral Rankings and Range Outputs

## Rule

Provider adapters must return the normalized BYOR schema and must state how
they obtain positional rank and rank uncertainty.

## Why

`ffsimulator` expects rank-conditioned inputs. Provider exports use different
column names and may omit rank uncertainty. A documented adapter boundary keeps
source-specific decisions out of the sampler.

## Apply This When

- Adding or changing a ranking adapter.
- Mapping weekly projections into `ffsimulator`.
- Adding fields to player, team, or game summaries.

## Preferred Shape

The normalized columns are:

```text
player_id, player_name, position, team, rank, rank_uncertainty,
bye_week, as_of, source
```

For the current Footballguys export, `byor_fbg()` must:

- select the offensive `Projections Consensus` set,
- keep only QB, RB, WR, and TE,
- remove missing teams and `team = "FA"`,
- use source row order within each position when no rank column exists, and
- map missing uncertainty to median historical FantasyPros weekly `sd` by
  position and rank, with a minimum uncertainty of `0.5`.

Weekly player summaries expose `p15` and `p85`. Snapshot scripts may copy them
to `floor` and `ceiling`. Active-game fields remain separate from the overall
distribution so missed games do not disappear from the model.

## Limits

The historical FantasyPros `sd` mapping is a proxy for Footballguys exports
that have no uncertainty field. It supports the v0 pipeline. It is not a
player-specific Footballguys uncertainty estimate and requires later
calibration.

The adapter currently consumes FBG ordering and does not convert the raw FBG
stat projections into a separate point-mean model.

## Related Code or Enforcement

- `R/01_rankings.R`, function `byor_fbg()`
- `R/03_summaries.R`, function `summarize_player_outcomes()`
- `tests/testthat/test-rankings.R`
- `outputs/week1_2026_fbg_player_ranges.csv`
