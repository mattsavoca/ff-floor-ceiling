# XGBoost v2 web cutover

Date: 2026-09-07

## Objective

Implement the reviewed `forecast-ppr-v2` multi-quantile XGBoost release in the
web application. Keep the v1 path available for rollback. Stop before public
deployment.

## Release policy

- Release: `forecast-ppr-v2`
- Artifact: `xgb_v2_quantile_20260907`
- Feature version: `fbg_rank_projection_v2`
- Objective: `reg:quantileerror`
- Quantiles: p15, p50, p85 from one call per populated position
- Positions: QB, RB, WR, TE
- Target: `actual_score > 0` for training
- Scoring: PPR, `ppr_v1`
- Range: XGBoost p15, p50, p85 for floor, median, ceiling
- Average: the uploaded CSV PPR projection
- ffsimulator: diagnostic comparison output
- Result: `forecast-result.v3`
- Rollback: retained `forecast-ppr-v1` p15 and p85 asset pack

## Implementation

- Added shared release constants and the exact v2 feature builder.
- Added one multi-quantile local worker contract and one v2 producer route.
- Added strict release, feature, ID, count, finite-value, negative-value, and
  quantile-order checks at both model boundaries and in the TypeScript worker.
- Updated run orchestration to call one booster per populated position.
- Updated persisted result types, external model-call metadata, health output,
  CSV exports, UI source labels, methodology, calibration pages, README files,
  PRDs, and the v3 JSON contract.
- Rebuilt the Vercel asset pack with four v2 boosters and v2 evidence. The
  script now fails on missing runtime, validation, position, feature, or model
  metadata and rejects `n_projectors` in the active feature map.
- Kept `n_projectors` and rank-summary fields in the data-quality evidence only.

## Evidence

- Top-player identity coverage: 100% for QB 30, TE 30, WR 40, and RB 40.
- Top-player observed-outcome coverage: 98.41%.
- Missing top-player outcomes: 112 explicit imputed-zero rows in
  `outcome_errors.csv`.
- Serious linkage errors: 0.
- Invalid training rows: 0.
- Common held-out comparison rows: 9,376.
- Raw quantile crossings: 0.

High and median performance selected XGBoost for every position. Floor
pinball-loss winners were XGBoost for QB and RB, and ffsimulator for WR and
TE. The active web policy uses the consistent v2 XGBoost range for all four
positions.

## Verification

- Python tests: 43 passed.
- Root R tests: 47 passed.
- Backtest R tests: 71 passed.
- Web typecheck: passed.
- Web lint: passed with existing warnings only.
- Web build: passed.
- Production dependency audit: 0 vulnerabilities.
- Four-position local end-to-end workflow: passed with four v2 calls, four
  output rows, ordered p15/p50/p85 values, correct source labels, and override
  isolation checks.
- Persisted v3 result validation against `contracts/forecast-result.v3.json`:
  0 schema errors.
- Local production-style health check: reports the v2 release, artifact,
  feature version, objective, PPR contract, four positions, and three
  quantiles.

## Deployment state

The repository and local asset-backed workflow use v2. Public deployment and
deployed health verification were not performed. The v1 asset pack remains in
the repository for rollback.

## Reusable lessons

- Keep release constants in one TypeScript module and compare them with the
  Python asset metadata at every boundary.
- A local worker that supports one JSON request on stdin makes the local web
  path testable without a long-lived process.
- Store the raw quantile result and crossing audit before applying any product
  decision. The web path should reject a crossing rather than repair it.
- Generate calibration and model-card evidence from the release outputs. Do
  not hand-edit metric values in the generated TypeScript artifact.
