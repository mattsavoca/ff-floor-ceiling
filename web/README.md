# Floor and Ceiling web app

This Next.js app presents the public model-monitoring preview described in `docs/PRD_model_monitoring_site.md`.

## Run locally

```text
npm install
npm run dev
```

The app uses the saved public evidence artifacts in the repository. The upload parser runs in the browser for the preview. It checks the 10 MB file limit, the 50,000-row limit, required fields, supported positions, numeric projections, and duplicate player keys.

## Check and build

```text
npm run typecheck
npm run build
npm audit --omit=dev
```

Set `FC_SESSION_SECRET` in production. The app creates a signed, temporary `fc_session` cookie and a separate CSRF cookie. `/api/run` checks both before it accepts a bounded, idempotent job request.

## Deployment boundary

The Vercel build is a public output preview. It shows the owner-cleared Week 1 model output. Historical evaluation stays pending until completed outcome rows are loaded. A real 1,000-simulation run still needs the persistent worker described in `services/model-worker/README.md`. The browser does not train a model or claim that a preview request completed model inference.
