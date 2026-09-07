# Web preview and Vercel deployment

## Rule

Treat the Next.js app as a presentation and input-validation layer. Treat
each Vercel deployment as a versioned public artifact. Compare the live
artifact with the current source before you describe or promote it.

## Why

The repository and the public alias can point to different builds. The current
`web/` source bundles the Week 1 2026 output and keeps historical evaluation
pending until outcome rows load. An older deployment can contain historical
calibration tables, legacy labels, and a different accepted-row count.

A rollback restores the selected deployment exactly. Legacy FFFL labels in a
restored deployment describe that old artifact. They do not define the current
product scope.

## Apply this when

- Changing `web/`, `contracts/`, or `services/model-worker/`.
- Deploying, promoting, or rolling back the Vercel project.
- Comparing current source, a preview URL, and the stable public alias.
- Changing historical calibration data or public model evidence.

## Preferred shape

1. Run `npm ci`, `npm run typecheck`, `npm run lint`, and `npm run build` from
   `web/`.
2. List deployments with `npx vercel ls`.
3. Inspect the candidate with `npx vercel inspect <deployment-url>`.
4. Read the candidate page with `npx vercel curl / --deployment <deployment-url>`.
5. Compare visible anchors, such as the calibration tab, season range,
   accepted rows, and model metrics, with the intended release.
6. Promote a known Ready deployment with
   `npx vercel promote <deployment-url>`.
7. Inspect the stable alias after promotion. Record the deployment ID, URL,
   target, and visible data anchors in `.agent-sessions/`.
8. Keep GitHub unchanged during a Vercel-only rollback. Make a Git rollback
   only after the owner requests it.

The browser does not run model training or simulation. The real forecast tab
uploads a source file, creates a durable run record, and reads the complete
`forecast-result.v2` output. The server worker derives rank and uncertainty,
runs the rank-conditioned `ffsimulator` algorithm, calls the released p15 and
p85 services for RB, WR, and TE, checks the full join, and publishes no result
until all accepted IDs are present. Manual overrides remain in a separate
run-scoped set.

`/api/runs` creates a bounded queue request. The local preview starts the R
fallback and Python model process inside the web process and uses a local file
store. Production uses the Vercel Services Python producer at `/api/producer`
and private Vercel Blob state. The Next.js frontend and Python producer share
one Vercel project but build as separate services. `after()` keeps the run
worker alive after the 202 response. `FC_SESSION_SECRET`, `BLOB_READ_WRITE_TOKEN`,
`INFERENCE_SERVICE_URL`, and `INFERENCE_SERVICE_TOKEN` are required for the
production path. Do not use the local development secret for a deployed
session boundary.

## Limits

The public Vercel build is a serverless worker deployment. It uses private
Blob objects for temporary workspace state. It does not provide a long-lived
queue, and expired workspace cleanup still runs when a request touches that
workspace. Do not describe the deployment as a separate queue service.

Page content and data can change after a new deployment. Keep the exact
deployment record in a session log instead of treating a deployment ID as
permanent project policy.

## Related code or enforcement

- `web/README.md`
- `web/lib/project-data.ts`
- `web/package.json`
- `services/model-worker/README.md`
- `web/api/producer.py`
- `web/api/producer-assets/`
- `vercel.json`
- `contracts/model-job.v1.json`
- `contracts/forecast-result.v1.json`
- `contracts/forecast-result.v2.json`
- `contracts/forecast-overrides.v1.json`
- `scripts/test_forecast_workflow.ps1`
- `scripts/create_ffsimulator_snapshot.R`
- `scripts/prepare_vercel_worker_assets.ps1`
- `.agent-sessions/2026-09-06-model-monitoring-site-deploy-and-rollback.md`
- `npx vercel inspect <deployment-url>`
- `npx vercel curl / --deployment <deployment-url>`
