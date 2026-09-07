# Model worker boundary

This folder defines the worker input boundary for the Floor and Ceiling site.

The web service must create a `model-job.v1` document. A persistent worker must then:

1. Validate the document against `contracts/model-job.v1.json`.
2. Load fixed R and Python artifacts by the version in the job.
3. Check the accepted-row count against the upload manifest, stable IDs, numeric fields, metric definition version, and model feature contract.
4. Run the requested simulation with the recorded seed.
5. Write temporary output and validate it against `contracts/forecast-result.v1.json`.
6. Publish the complete result in one atomic write.

The browser never runs model code. It only submits checked data and reads a job state.

The Vercel deployment in this repository is a public evidence preview. It has a bounded, idempotent web queue at `/api/run` and uses the saved Week 1 result for the public demo. `persistentWorker: false` in `/api/health` is deliberate. A production release needs a separately hosted worker, PostgreSQL job state, private artifact storage, retries, and cleanup for expired sessions.
