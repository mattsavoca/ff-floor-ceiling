# Real forecast workflow

Date: 2026-09-07  
Branch: master  
Status: Complete

## Objective

Complete the real inference workflow in
`docs/PRD_forecast_workflow_real_inference.md`.

## Relevant field-guide entries

- `field-guide/architecture.md`, for the browser, worker, R, and Python
  boundaries.
- `field-guide/testing.md`, for fixture, simulation, and model checks.
- `field-guide/web-and-deployment.md`, for Next.js build checks and the
  deployment boundary.
- `field-guide/recurring-problems.md`, for rank uncertainty and small-count
  limits.

## Implementation

The workflow now uses the uploaded projection set as the source of truth. The
adapter selects a set, keeps stable IDs, removes unsupported and free-agent
rows, derives positional ECR when needed, calculates the approved PPR value,
and reports dynamic accepted, excluded, and position counts.

The server joins the checked rank snapshot and approved Week 1 schedule, runs
strict weekly `ffsimulator` draws, calls the released XGBoost p15 and p85
services for RB, WR, and TE, combines the outputs under
`forecast-result.v2`, and validates counts, IDs, numeric fields, and range
order before publishing. The browser does not run R or Python.

The run store keeps upload, run, result, producer-call, failure, runtime, and
session ownership records. Failed runs preserve the last complete result.
Manual overrides use a separate run-scoped set with required reasons,
revision history, named presets, direct range validation, explicit copy, and
stable-ID linkage. Demo state remains separate from live state.

Refresh restore now covers queued, running, failed, and last-complete runs. A
new upload clears the stored active-run pointer. Production sessions require
`FC_SESSION_SECRET`, and expired workspace records are persisted out of the
local store during cleanup.

## Verification

- `npm run typecheck` from `web`: passed.
- `npm run lint` from `web`: passed with existing warnings from unused legacy
  preview components.
- `npm run build` from `web`: passed.
- Main R package tests: 47 passed.
- Historical backtest tests: 71 passed.
- Python model and DST tests: 15 passed.
- `scripts/test_forecast_workflow.ps1`: passed with dynamic counts, PPR
  parity, positional rank sequences, nearest rank matching, six producer
  calls for the fixture, complete source labels, override precedence and
  reset, explicit copy, and cross-session isolation.
- Final measured fixture run: 5.373 seconds wall time and 441,257,984 bytes
  peak worker-process RSS. It accepted 4 rows and published 4 rows with one
  QB, RB, WR, and TE row. Every skill-position row used XGBoost p15, CSV PPR,
  `ffsimulator` p50, and XGBoost p85. The QB row used the complete
  `ffsimulator` range.
- `forecast-result.v2` and `forecast-overrides.v1` JSON Schema validation:
  passed for the final local result and override sets.
- `GET /api/health`: returned 200.

## Field-guide review

Added the real inference boundary and local-versus-production worker limit to
`field-guide/web-and-deployment.md`.

## Open questions

The local preview still runs the worker inside the Next.js process and uses a
file-backed store. A production deployment must supply the separately hosted
worker, shared durable job storage, and a cleanup scheduler described in the
web and worker READMEs.
