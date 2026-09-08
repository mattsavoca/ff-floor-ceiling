# Web model replacement scope

## Use this scope

Read this file when a model candidate moves from backtest or review into the web application. Use it for a model artifact swap and for a change that affects features, endpoints, output fields, model roles, or scoring.

The web application has several model boundaries. A replacement is complete only when the training evidence, model assets, serving paths, feature rows, result contract, UI, exports, tests, deployment checks, and release records agree.

This file is a change scope. It does not approve a model for production.

## Current state in this repository

As of 2026-09-07:

- The active web workflow serves `forecast-ppr-v2`, feature version `fbg_rank_projection_v2`, and scoring contract `ppr_v1`.
- The workflow calls `ffsimulator` for diagnostics and calls one multi-quantile XGBoost endpoint for each populated QB, RB, WR, and TE position.
- The active web result contract is `forecast-result.v3`.
- The active asset pack is under `web/api/producer-assets/models/v2/`. The retained v1 asset pack supports rollback.
- The active release uses one booster per position and returns p15, p50, and p85 in one prediction call.
- `services/model-worker/predict_service_v2.py`, `web/lib/server/features-v2.ts`, `web/lib/server/forecast.ts`, and `web/api/producer.py` use the v2 contract.
- The v2 comparison report, calibration artifact, model card, outcome errors, and quantile crossing audit are stored with the release evidence.

## Classify the replacement before editing

| Change | Minimum scope |
| --- | --- |
| Same features, positions, endpoint, output shape, and product role | Update the release manifest, model assets, asset preparation, release constants, serving tests, deployment checks, and release documentation. |
| Feature names, source fields, or feature semantics change | Update the feature builder, upload and input validation, model metadata, producer validation, local worker, fixtures, tests, and feature documentation. |
| Endpoint, call count, quantile set, or response shape changes | Update the local worker, remote producer, TypeScript client, response validation, store types, result types, JSON contract, tests, and UI mapping. |
| Position coverage or final floor, average, median, or ceiling policy changes | Update orchestration, join logic, model status, source labels, methodology copy, model cards, calibration data, exports, and end-to-end assertions. |
| Scoring, target, metric definition, or training data policy changes | Create a new scoring or metric version, regenerate evidence, update the result contract when needed, preserve old records, and update all user-facing labels. |

Treat a change in more than one row as a contract migration. Use a new release ID and usually a new result schema version.

## Required change map

### 1. Establish one release manifest

Before changing application code, record these values in the model evidence and use the same values at every serving boundary:

- release ID, artifact ID, and build date
- target, scoring contract, and metric definition
- feature version and exact feature names for each position
- supported positions and model roles
- quantile labels and output column order
- endpoint and call shape
- prediction clipping, crossing, missing-value, and negative-value policy
- expected prediction count and ID rules
- training data cutoff and target season
- rollback release and asset location

For the current v2 candidate, the release manifest must cover `forecast-ppr-v2`, `fbg_rank_projection_v2`, `ppr_v1`, positions QB/RB/WR/TE, and output order p15/p50/p85.

Keep this manifest close to the artifact metadata. Do not make a release depend on a model name that exists only in UI text.

### 2. Validate the model evidence

Review the training and backtest outputs before wiring the web app:

- `backtest_fbg_2023_2025/scripts/15_xgb_v2_quantile_projection.py`
- `backtest_fbg_2023_2025/outputs/xgb_v2_quantile_projection/metadata.json`
- `backtest_fbg_2023_2025/outputs/xgb_v2_quantile_projection/comparison_report.md`
- `backtest_fbg_2023_2025/outputs/xgb_v2_quantile_projection/comparison_metrics.csv`
- `backtest_fbg_2023_2025/outputs/xgb_v2_quantile_projection/model_card.md`
- `docs/ml_model_card_xgb_v2.md`

Check that the evidence and the intended production policy use the same position set, target, scoring, features, and output semantics. Check held-out coverage, missing outcomes, identity quality, quantile crossings, negative predictions, and prediction counts.

The current v2 evidence reports 9,376 common held-out rows and zero raw quantile crossings. It also reports data-quality warnings. Treat both facts as release inputs. A zero crossing count in backtest does not remove the runtime crossing check.

Do not hand-edit generated calibration values. Update the generator or its input data, then rebuild the generated file.

### 3. Update source-controlled model assets

Update the asset preparation path and the committed asset pack together:

- `scripts/prepare_vercel_worker_assets.ps1`
- `web/api/producer-assets/metadata.json`
- `web/api/producer-assets/models/<release>/metadata.json`
- `web/api/producer-assets/models/<release>/models/`
- `web/api/producer-assets/models/<release>/model_card.md`
- any comparison or audit files required by the deployment process

The asset preparation script must copy all four v2 position boosters and the v2 metadata. It must fail when a required position, feature list, artifact, or metadata value is missing.

Keep the old asset pack for rollback. Do not replace old files in place when the new release changes the response contract.

### 4. Update the remote producer

`web/api/producer.py` is a separate production boundary. Update all of these together:

- release, feature, scoring, target, position, and quantile constants
- model root resolution and asset metadata loading
- model cache keys
- request validation and exact feature order
- output shape and response schema
- prediction count and stable ID checks
- finite-value, negative-value, and quantile-crossing handling
- route matching and route version
- response and error logging

The previous producer exposed `/v1/models/p15/predict` and `/v1/models/p85/predict`. The active v2 worker uses one `/v2/models/predict` request for all quantiles. Keep the route shape the same in the Vercel producer, local worker, TypeScript client, tests, and README.

If v2 remains the selected design, the producer must load `web/api/producer-assets/models/v2/`, accept QB/RB/WR/TE, and return p15/p50/p85 in the documented order.

### 5. Update the local worker and keep local and remote behavior equal

Update or replace:

- `services/model-worker/predict_service.py`
- `services/model-worker/predict_service_v2.py`
- `services/model-worker/README.md`
- `services/model-worker/test_predict_service.py`
- a new version-specific worker test when the response shape changes

The local worker must use the same release metadata, feature names, position list, output columns, validation rules, and failure behavior as the remote producer. Test the same request against both paths when possible.

The v2 service audits crossings but does not repair them. It does not apply the old v1 non-negative clamp. The active policy rejects negative or out-of-order output before publishing a result. The final range must satisfy finite values, non-negative values, and p15 <= p50 <= p85. Store raw audit values separately if the review process needs them.

### 6. Update feature assembly and source input requirements

Review these files whenever a feature version changes:

- `web/lib/server/features.ts`
- `web/lib/server/features-v2.ts`
- `web/lib/csv.ts`
- `web/lib/server/rank-reference.ts`
- `web/lib/server/forecast.ts`
- `web/lib/types.ts`

The feature builder must produce the exact names and order in the model metadata. It must reject missing required features. It must not invent training fields with default values unless the training pipeline used the same definition.

For the active v2 release, the feature rows use `week`, `ecr`, the raw player statistic fields, and `projection_fpts`. They remove the v1 rank-uncertainty and source-count fields. The v2 builder must remain imported by the serving path.

If the new model removes ffsimulator from the final range, decide whether rank snapshots and `rank-reference.ts` remain as diagnostic inputs. Remove them from the production dependency graph only after the result, tests, documentation, and deployment scripts no longer require them.

### 7. Update the TypeScript model call and run orchestration

`web/lib/server/forecast.ts` is the main replacement point. Review these items as one unit:

- `SCORING_CONTRACT_VERSION`, `METRIC_DEFINITION_VERSION`, and `MODEL_RELEASE`
- feature builder and model positions
- model endpoint, request body, and response validator
- one-call versus per-quantile call behavior
- model response fields and output count
- ffsimulator dependency and diagnostic calls
- model status and external call records
- combination logic in `makeCombinedRows`
- final floor, average, median, ceiling, range width, and value-source labels
- result schema version and persisted metadata

For the active v2 shape, the orchestration sends one prediction request per position and receives p15/p50/p85 for every row. It must verify that every requested ID appears once, that the returned position and release match the request, and that the output columns match metadata.

Choose the product policy for the final range before changing `makeCombinedRows`. A direct v2 policy would use model p15 for floor, model p50 for median, and model p85 for ceiling for all four positions. The v2 service does not return a mean, so the source of `average` needs an explicit decision. If the product keeps `csvProjection` as average, document that choice. Do not silently keep the old QB-only ffsimulator average while changing the other range fields.

If ffsimulator remains, label it as a baseline or diagnostic source when it is no longer part of the final range. If it is removed, remove its calls, result fields, producer route, rank dependency, tests, and documentation as one change.

Also review:

- `web/app/api/runs/route.ts`, which currently stores the v1 release and checks `ppr_v1`
- `web/app/api/runs/[runId]/route.ts`, which exposes release and external call metadata
- `web/app/api/runs/[runId]/result/route.ts`, which exposes the stored result
- `web/app/api/health/route.ts`, which should report enough service state to identify the active release during rollout
- `web/lib/server/store.ts`, including `ExternalModelCall` unions and position types

The run request must not allow a client to select an unapproved model release. The server should own the active release.

### 8. Version the result contract and persisted types

Review:

- `web/lib/types.ts`
- `contracts/forecast-result.v2.json`
- `contracts/model-job.v1.json`
- the run store and API response types

The historical `forecast-result.v2` contract requires ffsimulator, xgbP15, and xgbP85 fields. It also assumes the old QB versus skill-position policy. The active v2 multi-quantile release uses `forecast-result.v3.json` with xgbP15, xgbP50, and xgbP85 for every position.

The new contract should state:

- release, feature, scoring, and metric versions
- model positions and model status per component
- model quantile fields, including p50 when it is used
- whether ffsimulator fields are production values or diagnostics
- the source of average and median
- crossing and missing-output behavior
- stable ID and row-count guarantees
- whether old fields remain for compatibility

Keep the v2 schema and historical v2 results readable. Do not relabel old stored runs as the new release.

### 9. Update the UI, exports, and user-facing model claims

`web/components/FloorCeilingApp.tsx` contains both live result mapping and product claims. Review all of these areas:

- `forecastRowsFromResult`, including p50 and source labels
- run request metadata and displayed release
- CSV export column names and values
- overview text and position policy
- model cards, feature lists, metric labels, and recommendation text
- methodology output map
- calibration page labels and selected model names
- detail drawer explanations and model badges
- any text that says which model defines floor, median, or ceiling

Also review:

- `web/lib/calibration-data.ts`
- `backtest_fbg_2023_2025/scripts/10_build_calibration_page_data.py`
- `web/lib/project-data.ts`
- `web/lib/metrics.ts`
- `web/app/globals.css` if the new fields need presentation changes

The UI must use the result metadata and source labels. It must not show a new release name beside old model behavior. The export must contain enough fields to reproduce the displayed range and its source.

For v2, update the UI only after deciding whether the product shows ffsimulator as a diagnostic comparison or as part of the final range. The current v2 backtest winner table includes ffsimulator for some floor comparisons. That evidence does not by itself authorize a mixed production policy.

### 10. Regenerate calibration and documentation artifacts

Update the generator inputs or code, then rebuild generated artifacts:

- `backtest_fbg_2023_2025/scripts/10_build_calibration_page_data.py`
- `web/lib/calibration-data.ts`
- `docs/ml_model_card_xgb_v2.md` or the next model card
- `docs/PRD_forecast_workflow_real_inference.md`
- `docs/PRD_model_monitoring_site.md` when monitoring fields or release rules change
- `web/README.md`
- `services/model-worker/README.md`
- `field-guide/web-and-deployment.md`

Documentation must state the active release, feature version, model positions, endpoint, call shape, range policy, and rollback path. It must state when a candidate is staged and when it is active.

The PRD, README, services README, calibration data, and E2E script are all part of the replacement scope even when their code does not call the model directly. Keep them aligned with the active release and its rollback path.

### 11. Add tests at each boundary

At minimum, update or add tests for:

- artifact metadata and required model files
- exact feature names and order for every position
- all supported positions, including QB when the release supports it
- stable IDs, duplicate IDs, missing IDs, and prediction counts
- request release, feature, scoring, position, and endpoint validation
- p15/p50/p85 output shape and column order
- non-finite values, negative values, and quantile crossings
- local worker and remote producer parity
- one call per position versus one call per quantile
- final range source policy and value-source labels
- stored release and result schema metadata
- CSV export fields
- rollback to the previous release

Known repository test locations:

- `tests/test_producer.py`
- `services/model-worker/test_predict_service.py`
- `backtest_fbg_2023_2025/tests/test_xgb_v2_quantile_projection.py`
- `scripts/test_forecast_workflow.ps1`

The workflow script must assert that v2 serves all four positions and returns p15, p50, and p85.

Run the focused model and producer tests, then the web typecheck, lint, build, audit, and end-to-end workflow. The repository currently has no JavaScript unit-test command in the web package, so keep critical result-policy checks in a testable server or workflow path.

### 12. Verify deployment and observability

Before promotion:

- build the exact producer asset pack used by deployment
- check that local and remote workers report the same release and feature version
- call the health endpoint
- run a fixture with known IDs for QB, RB, WR, and TE
- verify counts, quantile order, source labels, and export columns
- inspect producer logs for release, endpoint, position, row count, and crossing count
- check a failed request for a useful validation error
- keep the previous deployment and asset pack available for rollback

The rollout record should include release ID, artifact ID, result schema, deployment ID, test fixture, test result, owner, and rollback target. Historical runs should retain the release that produced them.

## Current v2 cutover checklist

Use this list for the active `forecast-ppr-v2` implementation:

- [x] Complete the release manifest.
- [x] Decide the final range policy for p15, p50, p85, and average.
- [x] Decide the negative prediction and quantile crossing policy.
- [x] Import `features-v2.ts` into the active forecast path.
- [x] Wire the v2 model endpoint into `web/api/producer.py`.
- [x] Wire the v2 endpoint into the local worker path.
- [x] Update the asset preparation script for the v2 model root and four positions.
- [x] Update `forecast.ts` for one multi-quantile call per position.
- [x] Update store, run API, response types, and external call metadata.
- [x] Create and use the `forecast-result.v3` result contract.
- [x] Update `makeCombinedRows` and all source labels.
- [x] Regenerate calibration data from the selected production policy.
- [x] Update the UI, CSV export, methodology, model cards, README, and PRD.
- [x] Add v2 producer and worker tests.
- [x] Update the workflow assertions for all four positions and p50.
- [x] Run focused tests, typecheck, lint, build, audit, and end-to-end checks.
- [x] Retain the v1 rollback asset pack.
- [ ] Verify deployed health before promotion.

## Completion criteria

A replacement is ready for promotion when:

1. One release manifest describes the evidence, assets, serving code, result contract, UI, and deployment.
2. The model service rejects requests that do not match release metadata.
3. Local and remote paths return the same contract for the same fixture.
4. The app validates every returned ID, count, position, quantile, and numeric value.
5. The final range policy is explicit in code, tests, exports, and UI text.
6. Calibration and model-card values come from the approved release evidence.
7. Old runs remain readable and the previous release can be restored without rewriting stored results.
8. The focused tests and web build checks pass.

If any item fails, keep the candidate staged and keep the current release active.
