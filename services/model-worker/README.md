# Model worker boundary

The forecast workflow runs model code on the server. The browser sends a checked upload and reads a durable run state.

## Local run

Start the web app from `web`:

```text
npm run dev
```

The web process starts `run_ffsimulator.R` and `predict_service.py` for each run. Set `RSCRIPT_EXECUTABLE`, `PYTHON_EXECUTABLE`, `FC_PROJECT_ROOT`, or `FC_OUTCOME_POOL` when the local tools use different paths.

The local model service also supports one request on standard input:

```text
python services/model-worker/predict_service.py --quantile p15 --once --release forecast-ppr-v1 < request.json
```

Use `--serve` to expose the batch endpoints at `/v1/models/p15/predict` and `/v1/models/p85/predict`. The service loads released XGBoost boosters. It does not train or tune a model during a request.

## Producer checks

The R producer validates the accepted IDs, output count, simulation count, percentile order, and finite values. The TypeScript worker checks the same response before it combines rows.

The Python service validates the release, feature version, scoring contract, supported position, stable IDs, and every model feature. A bad feature response names the fields and player IDs that need correction.

The worker calls `ffsimulator` for every accepted row. It calls both XGBoost services for each RB, WR, and TE row. It calls neither XGBoost service for QB.

## Result boundary

The worker publishes `contracts/forecast-result.v2.json` only after the full row set passes count, key, numeric, and range-order checks. It keeps the R output and model responses in temporary files and removes them after the run.

The result stores the input revision, seed, model release, rank snapshot, producer status, component values, and source label for each final range value. Manual overrides live in a separate run-scoped set.

`/api/health` reports `persistentWorker: false` because the current local queue runs inside the web process. A production deployment needs a separately hosted worker and durable shared job storage. The browser still must not run R or Python code.
