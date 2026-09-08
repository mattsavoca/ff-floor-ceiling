# Floor and Ceiling web app

When a model release changes, follow the [web model replacement scope](../field-guide/web-model-replacement.md). The scope includes the producer, local worker, feature assembly, result contract, UI, calibration data, tests, deployment assets, and rollback checks.

This Next.js app runs the real forecast workflow described in `docs/PRD_forecast_workflow_real_inference.md`. Demo mode remains available as a separate, bundled view.

## Run locally

```text
npm install
npm run dev
```

The local app uses `.forecast-data/state.json` for temporary state. Set `FC_DATA_DIR` to use another local directory. Without `INFERENCE_SERVICE_URL`, the worker starts the local R and Python producers described in `services/model-worker/README.md`.

For a local production-style run, set `INFERENCE_SERVICE_URL` to a reachable producer URL and set `INFERENCE_SERVICE_TOKEN` to the matching secret. The browser never runs R or Python code.

## Workflow boundary

The upload adapter selects a projection set, derives the PPR projection and positional rank, and reports rejected rows. The run worker then:

1. Loads the approved weekly rank snapshot.
2. Joins rank uncertainty and the approved schedule.
3. Calls `ffsimulator` for every accepted row.
4. Calls `/v2/models/predict` once for each populated position.
5. Receives p15, p50, and p85 from the position booster in one call.
6. Validates IDs, counts, finite values, quantile order, and source order.
7. Publishes `forecast-result.v3` only after all checks pass.

The active release is `forecast-ppr-v2`. XGBoost p15, p50, and p85 define the
floor, median, and ceiling for QB, RB, WR, and TE. The CSV PPR projection
supplies the separate `average` field. `ffsimulator` values remain diagnostics.

The worker keeps each run and override set inside the temporary session workspace. Production stores each workspace state object in private Vercel Blob storage. The state key contains the workspace ID, so separate sessions cannot read each other’s uploads or runs.

## Production setup

The Vercel project uses the repository root with two Vercel Services. The
`frontend` service serves the Next.js app from `web`. The `producer` service
serves the Python function from `web/api/producer.py` at `/api/producer`. Run
these commands from the repository root:

```text
npx vercel@latest blob create-store forecast-state --access private --yes --environment production --environment preview --environment development
npx vercel@latest env add INFERENCE_SERVICE_URL production
npx vercel@latest env add INFERENCE_SERVICE_TOKEN production
npx vercel@latest --prod --yes
```

Set these production environment variables:

| Variable | Purpose |
| --- | --- |
| `FC_SESSION_SECRET` | Signs temporary session cookies. |
| `BLOB_READ_WRITE_TOKEN` | Private durable state access. The Blob store connection creates this value. |
| `INFERENCE_SERVICE_URL` | The deployed producer base URL, for example `https://ff-floor-ceiling.vercel.app/api/producer`. |
| `INFERENCE_SERVICE_TOKEN` | Shared secret between the Next.js worker and the Python producer. |

Keep the token values out of Git. Production does not use `FC_DATA_DIR`, local Rscript, or the local model-worker process.

## Producer assets

The Python producer is `api/producer.py`. It serves both model quantiles and the weekly simulator:

```text
POST /api/producer/v1/ffsimulator/predict
POST /api/producer/v2/models/predict
POST /api/producer/v1/models/p15/predict       # rollback only
POST /api/producer/v1/models/p85/predict       # rollback only
```

The function loads the active `forecast-ppr-v2` model pack and the exported
`ffsimulator` outcome pool. It uses one booster for each supported position and
returns p15, p50, and p85 in the documented order. It does not train or tune
models during a request.

Rank values are 1-based domain values. The producer changes every sampled rank below 1 to 1 before it reads the outcome pool. It reports a positive rank that the pool does not cover.

Regenerate the checked-in assets after changing the model release or outcome pool:

```text
Rscript scripts/create_ffsimulator_snapshot.R
powershell -ExecutionPolicy Bypass -File scripts/prepare_vercel_worker_assets.ps1
```

The preparation script copies the QB, RB, WR, and TE v2 boosters, model card,
and comparison evidence. It retains the v1 p15 and p85 assets for rollback.
It also writes the asset metadata used by the function.

Run the producer regression test after a simulator or asset change:

```text
python -m pytest tests/test_producer.py tests/test_producer_v2.py -q
```

The v2 result contract is `contracts/forecast-result.v3.json`. It stores the
active release, feature version, target, objective, XGBoost version, training
seasons, validation result, quantile levels, range policy, and model status.
The rollback target is `forecast-ppr-v1` with the retained `models/p15` and
`models/p85` asset paths.

## Check and observe

```text
npm run typecheck
npm run lint
npm run build
npm audit --omit=dev
```

After deployment, check the health contract:

```text
curl https://ff-floor-ceiling.vercel.app/api/health
```

It reports the storage backend and whether the hosted producer is configured. Use Vercel logs to inspect stage changes and failures:

```text
npx vercel@latest logs --environment production --since 1h --level error --expand
```

The end-to-end fixture check accepts a base URL, so it can test local development or the production alias:

```text
powershell -ExecutionPolicy Bypass -File scripts/test_forecast_workflow.ps1 -BaseUrl https://ff-floor-ceiling.vercel.app
```

The check uses 1,000 simulations by default. Pass `-SimulationCount 100` for a shorter preview check.
