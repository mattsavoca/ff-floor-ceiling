# Floor and Ceiling web app

This Next.js app runs the real forecast workflow described in `docs/PRD_forecast_workflow_real_inference.md`. It also keeps the bundled Week 1 output as an explicit Demo mode.

## Run locally

```text
npm install
npm run dev
```

The server stores each upload in the temporary workspace. The upload adapter selects a projection set, derives the PPR projection and positional rank, and reports rejected rows. The run worker joins the approved rank snapshot and schedule, runs `ffsimulator`, calls the released XGBoost p15 and p85 services for RB, WR, and TE, and publishes `forecast-result.v2` after validation.

## Check and build

```text
npm run typecheck
npm run build
npm audit --omit=dev
```

Set `FC_SESSION_SECRET` in production. The app creates a signed, temporary `fc_session` cookie and a separate CSRF cookie. `/api/runs` checks both before it accepts a bounded job request. The local store uses `.forecast-data/state.json`; set `FC_DATA_DIR` for another location.

## Deployment boundary

The browser does not run R or Python. The current web process starts the local producers described in `services/model-worker/README.md`. A production deployment needs a separately hosted worker and shared durable job storage. The app keeps the last complete result visible when a later run fails.
