# Vercel production inference repair

Date: 2026-09-07  
Branch: master  
Status: Complete

## Objective

Make the real forecast workflow run on the production Vercel deployment after
the valid CSV request failed in the upload state store.

## Evidence from the failed deployment

The production alias returned HTTP 500 for `POST /api/uploads` and `GET
/api/runs`. Vercel logs showed attempts to create:

```text
/var/task/web/.forecast-data
```

The deployment had `FC_SESSION_SECRET` only. It had no durable state token or
hosted inference endpoint. The Node.js function also could not run the local
Rscript fallback.

## Implementation

- Added private Vercel Blob state storage with one JSON object per workspace.
- Kept the local file store for development and fail closed in production when
  `BLOB_READ_WRITE_TOKEN` is absent.
- Added `web/api/producer.py`, which serves the ffsimulator and released p15
  and p85 XGBoost contracts behind `INFERENCE_SERVICE_TOKEN`.
- Added compact RB, WR, and TE p15/p85 model assets and the exported
  `adp_outcomes` pool to the web deployment bundle.
- Added `scripts/prepare_vercel_worker_assets.ps1` and extended
  `scripts/create_ffsimulator_snapshot.R` to regenerate those assets.
- Routed production model calls through `INFERENCE_SERVICE_URL` and used
  Next `after()` for post-response run processing.
- Added structured stage and failure logs and expanded `/api/health` with
  storage and producer configuration state.
- Added no-store mutable Blob writes plus ETag recovery that merges records by
  their logical workspace and run keys.
- Added Next output tracing for the bundled rank snapshot used by the run
  function.
- Replaced the Linux GPU-enabled XGBoost dependency with `xgboost-cpu` so the
  Python producer stays below the Vercel function bundle limit.
- Updated the root, web, and model-worker READMEs and the deployment field
  guide.

## Vercel resources and configuration

Created and connected the private `forecast-state` Blob store in `iad1`.
Configured these environment variable names for production, preview, and
development where appropriate:

- `BLOB_READ_WRITE_TOKEN`
- `INFERENCE_SERVICE_URL`
- `INFERENCE_SERVICE_TOKEN`

The existing production `FC_SESSION_SECRET` remains in place. Secret values
are not recorded in this log.

## Verification so far

- `npm run typecheck`: passed.
- `npm run lint`: passed with the existing 11 warnings in the legacy preview
  component.
- `npm run build`: passed.
- `npm audit --omit=dev`: passed with no reported vulnerabilities.
- Python producer asset load and direct p15 plus ffsimulator smoke calls:
  passed.
- Local `scripts/test_forecast_workflow.ps1 -BaseUrl http://localhost:3001`:
  passed after the rank lower-bound fix. The fixture accepted four rows,
  produced four rows, made six model calls, completed the second run, copied
  overrides explicitly, and isolated a second session.

## Production release checks

1. Deployment `dpl_GuPkxfvEfCb5vvSfoTKyQD3jZPxV` reached `READY` and was
   aliased to `https://ff-floor-ceiling.vercel.app`.
2. `/api/health` reported `storageBackend: vercel-blob`,
   `durableStorage: true`, and `inferenceServiceConfigured: true`.
3. The production fixture passed under both PowerShell 7 and Windows
   PowerShell 5.1. The final run accepted four rows, excluded zero rows,
   produced four rows, made six producer model calls, and completed in
   3.7 to 3.8 seconds with 118 to 122 MB peak memory.
4. The production checks passed override save, explicit copy, reset history,
   and cross-session isolation with HTTP 404.
5. Production logs showed successful HTTP 200 calls for
   `/api/producer/v1/ffsimulator/predict`, p15, and p85. No production error
   logs remained after the final deployment check.

## Follow-up: 1,000-simulation rank boundary

The production run `run_a0c19124-cfae-43b0-9de1-6bf6df12beca` returned HTTP
400 from the ffsimulator producer at `running_ffsimulator`. Local replay with
the acceptance fixture showed the same error: `QB rank -1` was outside the
outcome pool.

The rank is a 1-based domain value. The Python producer changed only sampled
rank `0` to `1`, while the R worker changed every sampled rank below `1` to
`1`. The Python producer now uses the same lower-bound rule. Unsupported
positive ranks still produce a visible producer error.

The failed-run banner now shows the affected position or player IDs and the
external service response. The web README and model-worker README document the
rank rule and the producer regression test.

## Follow-up verification

- `python -m pytest tests/test_producer.py -q`: 2 tests passed.
- `npm run typecheck`: passed.
- `npm run lint`: passed with the same 11 existing warnings.
- `npm run build`: passed.
- Deployment `dpl_FiLxWcp24X4wnPmktrLmbJqnGxvb` reached `READY` and was aliased
  to `https://ff-floor-ceiling.vercel.app`.
- Production E2E at 1,000 simulations passed. It accepted 4 rows, produced 4
  rows, made 6 model calls, completed in 5.1 seconds, and used 118 MB peak
  memory.
- Production logs showed HTTP 200 for both ffsimulator requests and all model
  requests. The error-level log query returned no entries.
