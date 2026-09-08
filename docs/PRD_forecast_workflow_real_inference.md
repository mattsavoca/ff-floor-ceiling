# PRD: Real forecast workflow

Status: Active implementation

Updated: 2026-09-07

## 1. Product decision

The active web release is `forecast-ppr-v2`. The user uploads a current projection set. The server derives positional rank and rank uncertainty, runs `ffsimulator` as a diagnostic, calls one multi-quantile XGBoost endpoint per populated position, joins the results, and displays one range per player.

The output uses this position policy:

| Position | Floor, p15 | Average | Median, p50 | Ceiling, p85 |
| --- | --- | --- | --- | --- |
| QB, RB, WR, TE | XGBoost p15 | CSV PPR projection | XGBoost p50 | XGBoost p85 |

One XGBoost booster serves each of QB, RB, WR, and TE. One prediction call returns p15, p50, and p85. The worker must reject a missing response, an unknown ID, a duplicate ID, a negative value, or a quantile crossing. It must never publish a partial result.

The active release uses the PPR `ppr_v1` contract, target `actual_score`, XGBoost `reg:quantileerror`, and `quantile_alpha = [0.15, 0.50, 0.85]`. It uses the corrected 2023 through 2025 training data and the walk-forward validation result. The app exposes its calibration evidence and model card.

The current result contract is `forecast-result.v3`. Historical `forecast-result.v2` runs remain readable and keep their original v1 release metadata. The retained `forecast-ppr-v1` producer assets provide rollback support.

The browser must never run R or Python model code. The browser submits an upload and reads a server result.

The workflow has two linked result layers. The model result stores the approved inference output. The manual override layer stores analyst changes for that result. The model result stays unchanged when an override is saved.

## 2. Input file

The supplied file is the acceptance fixture:

`projection-set-weekly-all-2026-1-qb-rb-wr-te.csv`

The fixture contains QB, RB, WR, and TE rows. Its current total and position mix
are sample metadata. They are not part of the input contract. The adapter and
tests must derive counts from each upload.

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

Set the user-facing `average` field to `csv_projection` for every position. Preserve the raw stat fields and the calculated value in the result.

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

The simulator output is diagnostic data. It does not define the active range:

~~~text
ffsim_mean, ffsim_p15, ffsim_p50, ffsim_p85 = diagnostic fields
~~~

## 5. XGBoost prediction services

The worker calls internal prediction services. The browser never calls them directly.

### 5.1 Multi-quantile service

The active batch endpoint is:

~~~text
POST /v2/models/predict
~~~

The request includes the release, feature version, scoring contract version,
position, season, week, and one feature row per stable player ID.

The service loads one booster for each of QB, RB, WR, and TE. It uses
`reg:quantileerror` with `quantile_alpha = [0.15, 0.50, 0.85]`. The response
maps prediction columns to p15, p50, and p85 in that order. It returns the
release, artifact version, feature names, output columns, prediction count,
prediction call count, crossing count, negative-value count, and stable IDs.

The worker sends one request for each populated position. It uses p15 as
`floor`, p50 as `median`, and p85 as `ceiling` for every supported position.
The worker rejects a crossing or a negative prediction. It stores raw model
outputs in the model prediction artifact before the comparison report.

### 5.2 Feature contract

The v2 feature rows use `week`, `ecr`, position-specific raw stat projections,
and `projection_fpts`.

~~~text
QB: week, ecr, passing, rushing, fumble, and projection_fpts fields
RB: week, ecr, passing, rushing, receiving, fumble, and projection_fpts fields
WR: week, ecr, passing, rushing, receiving, fumble, and projection_fpts fields
TE: week, ecr, rushing, receiving, fumble, and projection_fpts fields
~~~

The exact feature names and order live in
`web/api/producer-assets/models/v2/metadata.json` and
`web/lib/server/features-v2.ts`. The active feature list excludes
`n_projectors` and rank-summary fields whose meaning changes with the number
of projection sets. The serving path must reject missing, invalid, or extra
features and must report the affected field names and player IDs.

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
xgb_p50
xgb_p85
floor
average
median
ceiling
range_width
~~~

Use these active values:

~~~text
QB, RB, WR, TE:
  floor   = xgb_p15
  average = csv_projection
  median  = xgb_p50
  ceiling = xgb_p85
~~~

The worker must reject a row when any complete-range value is missing. It must also reject a row when `floor > median` or `median > ceiling`. The result must record the model source for each range value. The ffsimulator fields remain diagnostic fields.

For display and export, join the active override set after the model result passes validation. Preserve every model row in the join. If a row has no override, use its original values.

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
- model status for `ffsimulator` and `xgb`
- model target, objective, XGBoost version, training seasons, and validation result
- quantile levels, output endpoint, and range policy

Each row must include the model source for `floor`, `average`, `median`, and `ceiling`. The existing `forecast-result.v1` contract requires p15, p50, and p85, so the contract must gain an explicit version for the combined output.

Store manual overrides in a separate run-scoped override set. Link each override to `run_id`, `upload_id`, `source_input_revision`, and `stable_player_id`. Do not link an override by row order or player name.

Each override record must include:

- override set ID
- run ID and upload ID
- source input revision
- stable player ID
- revision number
- saved time and workspace ID
- required reason
- workload factor, if used
- direct range edits, if used
- inactive state
- export exclusion state

Keep the original model values in every result row. Derive adjusted values from the original values and the linked override record. Include original values, adjusted values, override status, override revision, and override reason in the export.

Apply overrides after the model join. Never send manual override values to `ffsimulator` or an XGBoost service. Never change model status, calibration evidence, or the original source values.

Use this precedence for adjusted range values:

1. Marking a player inactive sets floor, median, and ceiling to zero.
2. Apply the workload factor.
3. Apply a position-supported named preset.
4. Apply direct floor, median, and ceiling edits last.

Keep export exclusion separate from range values. Exclusion removes a row from the active export but does not change its adjusted range. Reject an override when a value is non-finite, `floor > median`, or `median > ceiling`. Require a reason before saving.

The worker must publish the result only after schema, row count, key, numeric, and ordering checks pass. The UI must never read a partial file.

## 8. Web workflow

Replace the current demo queue with these server operations:

~~~text
POST /api/uploads
POST /api/runs
GET  /api/runs/:runId
GET  /api/runs/:runId/result
GET  /api/runs/:runId/overrides
PUT  /api/runs/:runId/overrides/:stablePlayerId
DELETE /api/runs/:runId/overrides/:stablePlayerId
POST /api/runs/:runId/overrides/copy
~~~

The upload endpoint stores the file and returns an `uploadId`. The run endpoint creates a durable job with the upload ID, model release, simulation count, seed, and input revision.

The override endpoints must enforce workspace ownership and run membership. They must reject a stable player ID that is absent from the run result.

The page polls the run state. Client timers must not mark a run complete. A refresh must restore the active run and the last complete result.

Keep the bundled Week 1 output as an explicit Demo mode. Demo mode must not share state with a live run.

### Manual overrides

The `MANUAL OVERRIDES` tab must use the current complete result for the active run. It must use the same rows and stable IDs as `Player Ranges`.

- Load the override set by `run_id` and `source_input_revision`.
- Show the player identity, original range, adjusted range, override status, revision, and reason.
- Let a player detail view open the override editor for that player's stable ID.
- Apply saved overrides to `Player Ranges`, its chart, its table, the player detail view, and adjusted summaries.
- Keep the approved `average` value read-only. Apply manual range edits to `floor`, `median`, and `ceiling`.
- Keep an Original view and an Adjusted view. Original view is the default.
- Persist saved overrides across refreshes within the workspace.
- Keep override history for save, reset, and copy actions.
- Start a new completed run with an empty override set unless the user copies overrides.
- Copy prior overrides only after an explicit user action and only for matching stable IDs.
- Show unmatched prior IDs for review. Do not apply them by row position or player name.

The live override set must not use the bundled demo rows. Demo overrides and live overrides must remain separate.

### Methodology model cards

The Methodology tab must show the model cards used by the forecast workflow.

- Keep each card in a native foldable pane.
- Default every pane to folded. Do not add an `open` attribute or equivalent initial open state.
- Show the active v2 multi-quantile model card as an implemented model card.
- The card must state its p15, p50, and p85 targets, PPR contract, XGBoost objective, training split, input feature families, held-out evidence, limitations, and workflow position policy.
- State the active mix clearly: XGBoost supplies p15, p50, and p85 for QB, RB, WR, and TE. The CSV projection supplies average. `ffsimulator` supplies diagnostic values.

### Player Ranges

Update the range chart and table to use the combined result frame. Show these columns:

| Player | Pos | Team | Average | Floor | Median | Ceiling | Width |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |

The player detail view must show the source of each value. For example:

~~~text
Average  14.2  CSV PPR projection
Floor     6.1  XGBoost p15
Median   10.8  XGBoost p50
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

A missing or failed v2 response is a hard failure for every affected position row. The worker must not fall back to `ffsimulator`, zero, the CSV projection, or a copied value from another player.

An older run must not replace a newer upload. A session must access only its own uploads, runs, and results. Expired session data must be removed by cleanup work.

If a new run fails, keep the last complete result and its override set visible. Do not attach that override set to the failed run.

## 10. Tests and release checks

Use the supplied CSV as the first end-to-end fixture. Record accepted, excluded,
per-position, and output counts in the run report. Do not assert fixed totals.

The fixture test must show:

- accepted row count equals the parser's accepted row count
- output row count equals accepted row count
- output stable ID set equals the accepted input stable ID set
- no duplicate IDs
- no free-agent rows
- only `QB`, `RB`, `WR`, and `TE` rows remain
- one derived ECR sequence per position, with no gaps or duplicates
- one `ffsimulator` row per accepted player
- one XGBoost p15, p50, and p85 result per accepted player
- one v2 prediction call per populated position
- complete ranges for every final row

Add tests for:

- PPR projection parity with the approved scoring formula
- exact and nearest rank uncertainty joins
- deterministic `ffsimulator` output for the same seed
- missing XGBoost features
- missing v2 results fail the affected position rows
- unknown and duplicate prediction IDs
- p15, p50, and p85 ordering
- negative predictions and raw quantile crossing records
- worker retry and timeout behavior
- partial output rejection
- upload isolation between sessions
- result refresh and CSV export
- override linkage by run ID, input revision, and stable player ID
- override precedence, range validation, required reason, and reset behavior
- adjusted `Player Ranges` charts, tables, summaries, and exports
- original model values remain unchanged after an override
- failed runs keep the last complete result and its override set
- copying prior overrides requires an explicit action and reports unmatched IDs
- Methodology floor model card is present and folded on initial render

Run one real fixture on the deployment target. Record wall time, peak worker memory, accepted rows, output rows, and each external model call.

## 11. Implementation order

1. Add the supplied CSV as a repository fixture.
2. Add the rank and PPR projection adapter.
3. Create and validate the local `ffsimulator` weekly ranking snapshot.
4. Build the real `ffsimulator` worker path.
5. Build the multi-quantile XGBoost service and its serving feature contract.
6. Add the durable upload, run, and result APIs.
7. Replace the demo state machine with server job state and real result rows.
8. Wire the v2 multi-quantile XGBoost service into the combined result and enforce hard response checks.
9. Define the run-scoped manual override contract and persistence path.
10. Wire `MANUAL OVERRIDES` and `Player Ranges` to the same live result and override set.
11. Add the folded v2 model card and update the methodology source map.
12. Run the fixture and deployment checks before release.

## 12. Out of scope

- Training models inside the web request.
- Automatic model retraining.
- User-selected model versions.
- Completed-game evaluation in this tab.
- DST and team-game forecasts.
- Changing trained model artifacts or rerunning inference from a manual override.

The first release should make one path correct: upload the current projection set, run the approved models, publish a complete player range, and show where every value came from.
