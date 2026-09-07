# User-selectable simulation count

Date: 2026-09-07  
Branch: master  
Status: Complete

## Objective

Allow a user to choose the simulation count for an uploaded CSV in the forecast workflow.

## Relevant Field-Guide Entries

- `field-guide/web-and-deployment.md` - applies to changes in the Next.js app and the run boundary.
- `field-guide/recurring-problems.md` - records the effect of small simulation counts.
- `field-guide/tooling.md` - defines the Windows commands for web checks.

## Inspection and Decisions

The run panel showed 100 and 1,000 simulations, but the request always sent 100. The API and `model-job.v1` contract accepted only those two values.

The new control accepts 100 through 1,000 simulations in steps of 100. The default is 1,000. The existing maximum stays in place because the public worker boundary has no runtime measurement for a higher limit.

## Meaningful Conversation and Decisions

### User

Requested a control for the number of simulations applied to an uploaded CSV in the forecast window.

### Agent

Added a numeric simulation control to the run panel. The selected value reaches `/api/run`, and the API validates the same bounded range as the job contract.

The control remains disabled while a job is checking, queued, or running. Invalid values show a field error and disable the run action.

Existing worktree changes in the calibration page and backtest script were preserved.

## Verification

- `npm run typecheck` from `web` - passed.
- `npm run lint` from `web` - passed.
- `npm run build` from `web` - passed after the existing local Next preview stopped holding `.next/dev/lock`.
- `GET /api/health` on the local preview - returned 200.
- `POST /api/run` with `simulationCount: 500` - returned 202 and echoed 500.
- `POST /api/run` with `simulationCount: 150` - returned 400 with the step-range message.
- `git diff --check` - passed.

The web boundary remains a demo queue. It accepts and returns the selected count. A persistent model worker still needs to execute the simulation.

## Commits

- No commit requested.

## Final Outcome

Users can select 100, 200, 300, up to 1,000 simulations for an uploaded CSV. The UI, API validation, and `model-job.v1` contract use the same limits.

## Open Questions

None.

## Field-Guide Review

No durable guidance added.
