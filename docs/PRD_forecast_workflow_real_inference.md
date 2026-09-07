# PRD: Real forecast workflow

Status: Proposed

## 1. Product decision

Replace the preview behavior in the `FORECAST WORKFLOW` tab with a real forecast run. The user uploads a current projection set. The server derives positional rank and rank uncertainty, runs `ffsimulator`, calls the XGBoost prediction services, joins the results, and displays one range per player.

The output uses this position policy:

| Position | Floor, p15 | Average | Median, p50 | Ceiling, p85 |
| --- | --- | --- | --- | --- |
| QB | `ffsimulator` p15 | `ffsimulator` mean | `ffsimulator` p50 | `ffsimulator` p85 |
| RB, WR, TE | XGBoost floor service | CSV PPR projection | `ffsimulator` p50 | XGBoost ceiling service |

The XGBoost floor service is a release dependency for complete RB, WR, and TE ranges. Until it exists, the workflow must show a partial result with `Floor model pending`. It must not publish a complete range with a placeholder floor.

The browser must never run R or Python model code. The browser submits an upload and reads a server result.

## 2. Input file

The supplied file is the acceptance fixture:

`projection-set-weekly-all-2026-1-qb-rb-wr-te.csv`

The fixture contains 402 rows:

| Position | Rows |
| --- | ---: |
| QB | 32 |
| RB | 105 |
| WR | 167 |
| TE | 98 |

The fixture has one set, `set-id = 68371`, and includes the raw passing, rushing, receiving, and fumble projection fields. It has no explicit positional rank or XGBoost rank-summary columns.

The upload adapter must:

1. Read the selected set from `set-id` and `set-name`.
2. Normalize `id`, `name`, `pos`, and `team` to stable internal fields.
3. Uppercase positions and teams.
4. Keep QB, RB, WR, and TE rows.
5. Reject free-agent rows, duplicate player IDs, missing IDs, missing teams, and unsupported positions.
6. Preserve the original row order before it derives rank.

The adapter must use stable player IDs as the row key. It must not use player names as the primary key.

The run context must supply season and week. The fixture uses season 2026 and week 1. The worker must join each team to its opponent through the approved season-week schedule. The input file does not contain opponent values. The run must fail before inference if any accepted team has no schedule match.

## 3. Derive rank and projections

### 3.1 Positional rank and ECR

When the upload has no rank field, assign `ecr` by row order within each position. The first QB row has `ecr = 1`. The first RB row has `ecr = 1`. The same rule applies to WR and TE.

The adapter must also write `consensus_rank = ecr` for the XGBoost feature frame. The run must store the rank rule and the source row order in its metadata.

### 3.2 Rank uncertainty

Create a local reference snapshot with:

~~~r
rankings <- ffsimulator::ffs_latest_rankings(type = "week")
saveRDS(rankings, "artifacts/ffsimulator/ffs_latest_rankings_week.rds")
~~~

The snapshot must include its source URL, retrieval time, package version, and row count in a metadata file.

The snapshot returns `pos`, `ecr`, and `sd`. Normalize those fields to `position`, `rank`, and `rank_sd`. Join `rank_sd` to each uploaded row by position and positional rank.

Use an exact rank match first. Use the nearest rank in the same position when an exact match does not exist. Record the match type for every row. Apply the current minimum uncertainty of `0.5` unless a later model release changes that rule.

Fail the run if a position has no usable rank uncertainty. Do not use a hidden zero or a global default.

### 3.3 CSV PPR projection

Calculate `csv_projection` from the uploaded stat fields with the project PPR rules:

~~~text
pass_yds / 25
+ pass_td * 4
- pass_int
+ pass_2pt * 2
+ rush_yds / 10
+ rush_td * 6
+ rush_2pt * 2
+ rec_yds / 10
+ rec_td * 6
+ rec_2pt * 2
+ rec_rec
- fum_lost * 2
~~~

For RB, WR, and TE, set the user-facing `average` field to `csv_projection`. Preserve the raw stat fields and the calculated value in the result.

For QB, set `average` to the `ffsimulator` mean. Preserve `csv_projection` as a separate diagnostic field.

## 4. Run `ffsimulator`

Run `ffsimulator` for every accepted player row. Use the uploaded rows as the ranking input.

The worker must:

1. Convert the upload to the provider-neutral ranking format.
2. Pass the derived `ecr` and `rank_sd` values into the ranking adapter.
3. Load the approved weekly outcome pool.
4. Run the requested simulation count with a recorded seed.
5. Produce `ffsim_mean`, `ffsim_p15`, `ffsim_p50`, and `ffsim_p85`.
6. Preserve `n_simulations`, zero-score rate, active rate, and the rank inputs.

The initial run profile keeps the existing UI limits. The default is 1,000 simulations. The worker must support a lower preview count and a higher count only after a measured runtime and memory check.

The worker must preserve one output row per accepted upload row. It must report missing draws and unsupported rank draws before it publishes a result.

The QB range comes entirely from this output:

~~~text
floor   = ffsim_p15
average = ffsim_mean
median  = ffsim_p50
ceiling = ffsim_p85
~~~

## 5. XGBoost prediction services

The worker calls internal prediction services. The browser never calls them directly.

### 5.1 Ceiling service

Add a batch endpoint with this contract:

~~~text
POST /v1/models/p85/predict
~~~

The request includes:

- model release
- position
- season
- week
- scoring contract version
- one feature row per stable player ID

The response includes one `p85` value per input player ID. The service must return the model release, feature version, and prediction count.

Call the ceiling service for RB, WR, and TE. Use its result as `ceiling`.

Do not call this service for QB. The QB ceiling comes from `ffsimulator`.

### 5.2 Floor service

Add the matching endpoint when the floor models exist:

~~~text
POST /v1/models/p15/predict
~~~

Call the floor service for RB, WR, and TE. Use its result as `floor`.

Do not call this service for QB. The QB floor comes from `ffsimulator`.

### 5.3 Feature contract decision

The current XGBoost artifacts use these rank-summary fields:

~~~text
week, ecr, rank_sd, n_projectors, rank_min, rank_max,
consensus_rank, consensus_projected_score
~~~

The supplied CSV can provide `week`, `ecr`, `rank_sd`, `consensus_rank`, and `consensus_projected_score` after the adapter derives them. It does not provide `n_projectors`, `rank_min`, or `rank_max`.

The worker must not invent those missing fields. Before the XGBoost service goes live, choose one of these release paths:

1. Require those fields in the upload contract.
2. Train and export a new serving model with a feature contract that the supplied file can satisfy.

The first live release should use option 2 if this file remains the required input format. The existing backtest artifacts remain comparison evidence until their feature contract matches the serving input.

Every model service must reject a request with missing or invalid features. It must return the field names and affected player IDs.

## 6. Combine model outputs

Join all outputs on:

~~~text
stable_player_id, season, week, position, team
~~~

The combined row must contain:

~~~text
stable_player_id
player_name
position
team
opponent
ecr
rank_sd
csv_projection
ffsim_mean
ffsim_p15
ffsim_p50
ffsim_p85
xgb_p15
xgb_p85
floor
average
median
ceiling
range_width
~~~

Use these values:

~~~text
QB:
  floor   = ffsim_p15
  average = ffsim_mean
  median  = ffsim_p50
  ceiling = ffsim_p85

RB, WR, TE:
  floor   = xgb_p15
  average = csv_projection
  median  = ffsim_p50
  ceiling = xgb_p85
~~~

The worker must reject a row when any complete-range value is missing. It must also reject a row when `floor > median` or `median > ceiling`. The result must record the model source for each range value.

## 7. Forecast result contract

Extend the result contract so that the UI can explain each value. Each result must include:

- run ID
- upload ID
- season and week
- scoring contract version
- simulation count
- seed
- model release
- rank reference snapshot
- source input revision
- created and completed times
- accepted, excluded, and output row counts
- model status for `ffsimulator`, `xgb_p85`, and `xgb_p15`

Each row must include the model source for `floor`, `average`, `median`, and `ceiling`. The existing `forecast-result.v1` contract requires p15, p50, and p85, so the contract must gain an explicit version for the combined output.

The worker must publish the result only after schema, row count, key, numeric, and ordering checks pass. The UI must never read a partial file.

## 8. Web workflow

Replace the current demo queue with these server operations:

~~~text
POST /api/uploads
POST /api/runs
GET  /api/runs/:runId
GET  /api/runs/:runId/result
~~~

The upload endpoint stores the file and returns an `uploadId`. The run endpoint creates a durable job with the upload ID, model release, simulation count, seed, and input revision.

The page polls the run state. Client timers must not mark a run complete. A refresh must restore the active run and the last complete result.

Keep the bundled Week 1 output as an explicit Demo mode. Demo mode must not share state with a live run.

### Player Ranges

Update the range chart and table to use the combined result frame. Show these columns:

| Player | Pos | Team | Average | Floor | Median | Ceiling | Width |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |

The player detail view must show the source of each value. For example:

~~~text
Average  14.2  CSV projection
Floor     6.1  XGBoost p15
Median   10.8  ffsimulator p50
Ceiling  18.7  XGBoost p85
~~~

The export must include the raw projection, derived rank fields, all component model values, final range values, model sources, run ID, model release, and input revision.

## 9. Failure behavior

The workflow must keep the last complete result visible when a new run fails. A failed run must show:

- the failed stage
- the affected position or player IDs
- the external service response, if available
- the next action

The worker must retry transient XGBoost service failures. It must stop after a bounded retry count. It must never publish a partial result.

An older run must not replace a newer upload. A session must access only its own uploads, runs, and results. Expired session data must be removed by cleanup work.

## 10. Tests and release checks

Use the supplied 402-row fixture for the first end-to-end test.

The fixture test must show:

- 402 accepted rows
- 32 QB rows
- 105 RB rows
- 167 WR rows
- 98 TE rows
- no duplicate IDs
- no free-agent rows
- one derived ECR sequence per position
- one `ffsimulator` row per accepted player
- one XGBoost ceiling result per RB, WR, and TE player
- one XGBoost floor result per RB, WR, and TE player after the floor service ships
- 402 final rows for a complete run

Add tests for:

- PPR projection parity with the approved scoring formula
- exact and nearest rank uncertainty joins
- deterministic `ffsimulator` output for the same seed
- missing XGBoost features
- unknown and duplicate prediction IDs
- p15, p50, and p85 ordering
- worker retry and timeout behavior
- partial output rejection
- upload isolation between sessions
- result refresh and CSV export

Run one real fixture on the deployment target. Record wall time, peak worker memory, accepted rows, output rows, and each external model call.

## 11. Implementation order

1. Add the supplied CSV as a repository fixture.
2. Add the rank and PPR projection adapter.
3. Create and validate the local `ffsimulator` weekly ranking snapshot.
4. Build the real `ffsimulator` worker path.
5. Build the XGBoost p85 service and its serving feature contract.
6. Add the durable upload, run, and result APIs.
7. Replace the demo state machine with server job state and real result rows.
8. Add the XGBoost p15 service.
9. Turn on complete RB, WR, and TE ranges.
10. Run the fixture and deployment checks before release.

## 12. Out of scope

- Training models inside the web request.
- Automatic model retraining.
- User-selected model versions.
- Completed-game evaluation in this tab.
- DST and team-game forecasts.
- Manual overrides changing model outputs.

The first release should make one path correct: upload the current projection set, run the approved models, publish a complete player range, and show where every value came from.
