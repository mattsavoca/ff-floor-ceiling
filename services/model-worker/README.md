# Model worker boundary

The forecast workflow runs model code on the server. The browser sends a checked upload and reads a durable run state.

## Local run

Start the web app from `web`:

```text
npm run dev
```

Without `INFERENCE_SERVICE_URL`, the web process starts `run_ffsimulator.R` and
`predict_service_v2.py` for each run. Set `RSCRIPT_EXECUTABLE`,
`PYTHON_EXECUTABLE`, `FC_PROJECT_ROOT`, or `FC_OUTCOME_POOL` when the local
tools use different paths.

The local model service also supports one request on standard input:

```text
python services/model-worker/predict_service_v2.py --model-root backtest_fbg_2023_2025/outputs/xgb_v2_quantile_projection --release forecast-ppr-v2 --once < request.json
```

Use `--serve` to expose the v2 batch endpoint at `/v2/models/predict`. The
service loads one released XGBoost booster for each position. It returns p15,
p50, and p85 in one prediction call. It does not train or tune a model during
a request.

## Vercel producer

Production uses the Python function at `web/api/producer.py`. It serves the same model contracts and the weekly rank-conditioned simulator:

```text
POST /api/producer/v1/ffsimulator/predict
POST /api/producer/v2/models/predict
POST /api/producer/v1/models/p15/predict       # rollback only
POST /api/producer/v1/models/p85/predict       # rollback only
```

The function loads the checked-in assets under `web/api/producer-assets`.
Those assets contain the active v2 QB, RB, WR, and TE boosters, the v2 model
card and comparison evidence, the retained v1 rollback assets, and the JSON
export of `ffsimulator::adp_outcomes`. The function does not train, tune, or
download model data during a request.

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

The worker calls `ffsimulator` for every accepted row. It calls one v2 XGBoost
endpoint for each populated QB, RB, WR, and TE position. The response contains
all three quantiles for every row.

## Result boundary

The worker publishes `contracts/forecast-result.v3.json` only after the full
row set passes count, key, numeric, and quantile-order checks. The production
producer keeps immutable model assets in the deployment bundle. The web state
uses private Vercel Blob storage.

The result stores the input revision, seed, model release, feature contract,
model details, rank snapshot, producer status, component values, and source
label for each final range value. The active range uses XGBoost p15, p50, and
p85. The CSV PPR projection supplies average. Manual overrides live in a
separate run-scoped set.
