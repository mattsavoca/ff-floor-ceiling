# Floor and Ceiling web app

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
4. Calls the released XGBoost p15 and p85 models for RB, WR, and TE.
5. Validates IDs, counts, finite values, percentile order, and source order.
6. Publishes `forecast-result.v2` only after all checks pass.

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
POST /api/producer/v1/models/p15/predict
POST /api/producer/v1/models/p85/predict
```

The function loads the released `forecast-ppr-v1` XGBoost boosters and the exported `ffsimulator` outcome pool. It uses the newest released target-season model available for the requested season. It does not train or tune models during a request.

Rank values are 1-based domain values. The producer changes every sampled rank below 1 to 1 before it reads the outcome pool. It reports a positive rank that the pool does not cover.

Regenerate the checked-in assets after changing the model release or outcome pool:

```text
Rscript scripts/create_ffsimulator_snapshot.R
powershell -ExecutionPolicy Bypass -File scripts/prepare_vercel_worker_assets.ps1
```

The preparation script copies only the RB, WR, and TE p15 and p85 model files needed by the web producer. It also writes the asset metadata used by the function.

Run the producer regression test after a simulator or asset change:

```text
python -m pytest tests/test_producer.py -q
```

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
