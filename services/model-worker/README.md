# Model worker boundary

The forecast workflow runs model code on the server. The browser sends a checked upload and reads a durable run state.

## Local run

Start the web app from `web`:

```text
npm run dev
```

Without `INFERENCE_SERVICE_URL`, the web process starts `run_ffsimulator.R` and `predict_service.py` for each run. Set `RSCRIPT_EXECUTABLE`, `PYTHON_EXECUTABLE`, `FC_PROJECT_ROOT`, or `FC_OUTCOME_POOL` when the local tools use different paths.

The local model service also supports one request on standard input:

```text
python services/model-worker/predict_service.py --quantile p15 --once --release forecast-ppr-v1 < request.json
```

Use `--serve` to expose the batch endpoints at `/v1/models/p15/predict` and `/v1/models/p85/predict`. The service loads released XGBoost boosters. It does not train or tune a model during a request.

## Vercel producer

Production uses the Python function at `web/api/producer.py`. It serves the same model contracts and the weekly rank-conditioned simulator:

```text
POST /api/producer/v1/ffsimulator/predict
POST /api/producer/v1/models/p15/predict
POST /api/producer/v1/models/p85/predict
```

The function loads the checked-in assets under `web/api/producer-assets`. Those assets contain the `forecast-ppr-v1` RB, WR, and TE boosters and the JSON export of `ffsimulator::adp_outcomes`. The function does not train, tune, or download model data during a request.

Regenerate the assets with:

```text
Rscript scripts/create_ffsimulator_snapshot.R
powershell -ExecutionPolicy Bypass -File scripts/prepare_vercel_worker_assets.ps1
```

Set `INFERENCE_SERVICE_URL` and `INFERENCE_SERVICE_TOKEN` in Vercel. The Next.js worker sends the token in a bearer header. The producer rejects requests without the configured token.

## Producer checks

The simulator validates the accepted IDs, rank coverage, output count, simulation count, percentile order, activity probabilities, and finite values. The TypeScript worker checks the same response before it combines rows.

Rank values are 1-based domain values. Both producers change sampled ranks below 1 to 1 before outcome-pool lookup. A positive rank outside the approved pool remains a reported error.

The model service validates the release, feature version, scoring contract, supported position, stable IDs, and every model feature. A bad feature response names the fields and player IDs that need correction.

The worker calls `ffsimulator` for every accepted row. It calls both XGBoost services for each RB, WR, and TE row. It calls neither XGBoost service for QB.

## Result boundary

The worker publishes `contracts/forecast-result.v2.json` only after the full row set passes count, key, numeric, and range-order checks. The production producer keeps immutable model assets in the deployment bundle. The web state uses private Vercel Blob storage.

The result stores the input revision, seed, model release, rank snapshot, producer status, component values, and source label for each final range value. Manual overrides live in a separate run-scoped set.
