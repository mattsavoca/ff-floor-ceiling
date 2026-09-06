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

The browser does not run model training or simulation. `/api/run` creates a
bounded, idempotent queue request. `services/model-worker` defines the separate
persistent worker boundary. `persistentWorker: false` in `/api/health` remains
deliberate for the preview.

## Limits

The public Vercel build is an evidence preview. It does not prove that a
persistent worker, database, private artifact store, or cleanup job exists.

Page content and data can change after a new deployment. Keep the exact
deployment record in a session log instead of treating a deployment ID as
permanent project policy.

## Related code or enforcement

- `web/README.md`
- `web/lib/project-data.ts`
- `web/package.json`
- `services/model-worker/README.md`
- `contracts/model-job.v1.json`
- `contracts/forecast-result.v1.json`
- `.agent-sessions/2026-09-06-model-monitoring-site-deploy-and-rollback.md`
- `npx vercel inspect <deployment-url>`
- `npx vercel curl / --deployment <deployment-url>`
