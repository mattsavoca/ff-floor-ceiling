# Web model replacement scope

Date: 2026-09-07

## Objective

Inspect the web application and define the full change surface for replacing the model. The scope must support the current v1 to v2 migration and later model releases.

## Findings

- The active web path is still v1. It uses `forecast-ppr-v1`, feature version `fbg_rank_projection_v1`, separate p15 and p85 model calls, and `forecast-result.v2`.
- The repository contains staged v2 evidence, assets, a v2 feature builder, and a v2 local worker. The active TypeScript forecast path and remote producer still use v1.
- A v2 cutover changes model positions, feature semantics, call shape, output quantiles, and likely final range policy. It requires a contract migration and UI, export, calibration, test, and deployment updates.

## Work completed

- Added [Web model replacement](../field-guide/web-model-replacement.md) to the field guide.
- Linked the scope from `field-guide/init.md`, `field-guide/web-and-deployment.md`, and `web/README.md`.
- Documented the current v1 and staged v2 state, file-by-file change map, v2 cutover checklist, acceptance criteria, rollback rules, and boundary tests.

## Verification

- Reviewed the field guide entries for architecture, testing, web deployment, and model experimentation before writing the scope.
- Preserved all pre-existing model and backtest changes in the worktree.
- The change is documentation-only. Application behavior was not changed in this session.
